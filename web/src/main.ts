import {
  dyno,
  type GsplatModifier,
  SparkControls,
  SparkRenderer,
  SplatMesh,
} from "@sparkjsdev/spark";
import {
  DREAM_SETTINGS,
  DREAM_STRENGTHS,
  type DreamStrength,
  isSplatDetail,
  isWorldName,
  MAX_LIGHTS,
  type MemoryLight,
  type PhotoCamera,
  parseCameraFile,
  parseGlbMesh,
  parseWorldMeta,
  photoSpotHeight,
  pickSplatFile,
  placeWorld,
  REALNESS_SETTINGS,
  SPLAT_DETAILS,
  sourceCameraPosition,
  type TriangleMesh,
  toRawFrame,
  type Vec3,
  type WorldPlacement,
} from "@unpictured/core";
import * as THREE from "three";
import { dreamLook } from "./dreamShader.ts";
import { buildPhotoFrame, fieldOfViewFor } from "./photoFrames.ts";
import { RealnessLights, realnessHeatmap } from "./realnessShader.ts";
import { buildFloorOverlay, describeFloor } from "./walkableFloor.ts";

const hud = requireElement("hud");
const statusLine = requireElement("status");
const positionLine = requireElement("position");
const noticeLine = requireElement("notice");
const walkableLine = requireElement("walkable");
const realnessLine = requireElement("realness");

// Spark renders splats without MSAA.
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);
scene.add(new SparkRenderer({ renderer }));

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 500);
const controls = new SparkControls({ canvas: renderer.domElement });

// Everything drawn that is not the world (grid, axes, photo frames, floor overlay), so H can
// hide it all for a clean view.
const helpers = new THREE.Group();
scene.add(helpers);

// Scale references: a grid on the ground (y = 0) with 1-unit cells, and 1-unit axes
// (x red, y green, z blue). A unit is a metre only when the world has metric data.
helpers.add(new THREE.GridHelper(20, 20), new THREE.AxesHelper(1));
let unitLabel = "m";

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update(camera);
  const { x, y, z } = camera.position;
  positionLine.textContent = `x ${x.toFixed(2)}  y ${y.toFixed(2)}  z ${z.toFixed(2)}  ${unitLabel}`;
  renderer.render(scene, camera);
});

loadWorld().catch((error: unknown) => {
  statusLine.textContent = `Could not load the world: ${errorMessage(error)}`;
});

async function loadWorld(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const name = params.get("world");
  if (name === null || !isWorldName(name)) {
    statusLine.textContent =
      "Add ?world=<name> to the address, where <name> is a folder in worlds/.";
    return;
  }
  const requested = params.get("splats");
  if (requested !== null && !isSplatDetail(requested)) {
    statusLine.textContent = `?splats=${requested} is not a splat level (${SPLAT_DETAILS.join(
      ", ",
    )}).`;
    return;
  }
  statusLine.textContent = `Loading ${name}...`;

  const response = await fetch(`/worlds/${name}/meta.json`);
  if (!response.ok) {
    throw new Error(`worlds/${name}/meta.json: HTTP ${response.status}`);
  }
  const meta = parseWorldMeta(await response.json());
  const splatFile = pickSplatFile(meta, requested ?? undefined);
  statusLine.textContent = `Loading ${name} (${splatFile})...`;

  const placement = placeWorld(meta.frame);
  if (!placement.metric) {
    unitLabel = "raw units";
    noticeLine.textContent =
      "Raw scale: this world has no metric data (drafts don't), so sizes and heights " +
      "are not true to life. The camera starts at a stand-in height.";
  }
  const splats = new SplatMesh({ url: `/worlds/${name}/${splatFile}` });
  applyPlacement(splats, placement);
  scene.add(splats);
  camera.position.set(...sourceCameraPosition(placement));

  let photoCameras: PhotoCamera[] = [];
  try {
    photoCameras = await loadPhotoCameras(name);
  } catch (error) {
    // The world still works without its photo frames.
    const problem = `Photo frames unavailable: ${errorMessage(error)}`;
    noticeLine.textContent = `${noticeLine.textContent} ${problem}`.trim();
  }
  const frames = photoCameras.map((photoCamera) =>
    buildPhotoFrame(photoCamera, placement, `/worlds/${name}/${photoCamera.photo}`),
  );
  for (const frame of frames) {
    helpers.add(frame.outline, frame.overlay);
  }
  const [firstCamera] = photoCameras;
  const [firstFrame] = frames;
  if (firstCamera !== undefined && firstFrame !== undefined) {
    // Start looking through the first photo, with all of it on screen.
    camera.fov = fieldOfViewFor(firstCamera, camera.aspect);
    camera.updateProjectionMatrix();
    camera.lookAt(firstFrame.center);
  }
  const colliderFile = meta.files.collider;
  const loadCollider = colliderLoader(`/worlds/${name}/${colliderFile}`);
  const walkable = new WalkableFloorToggle(loadCollider, placement, photoCameras);
  const realness = new RealnessViews(splats, loadCollider, placement, photoCameras);
  const canShowRealness = colliderFile !== undefined && photoCameras.length > 0;
  if (canShowRealness) {
    void realness.start();
  } else {
    const problem = "No dream look: it needs the photo frames (camera.json) and a collider.";
    noticeLine.textContent = `${noticeLine.textContent} ${problem}`.trim();
  }
  window.addEventListener("keydown", (event) => {
    if (event.repeat) {
      return; // a held key toggles once
    }
    if (event.code === "KeyH") {
      helpers.visible = !helpers.visible;
      hud.style.visibility = helpers.visible ? "visible" : "hidden";
    }
    if (event.code === "KeyO") {
      for (const frame of frames) {
        frame.overlay.visible = !frame.overlay.visible;
      }
    }
    if (event.code === "KeyN" && colliderFile !== undefined) {
      void walkable.toggle();
    }
    if (event.code === "KeyR" && canShowRealness) {
      void realness.toggleHeatmap();
    }
    if (event.code === "KeyV" && canShowRealness) {
      void realness.nextDreamStrength();
    }
    if (event.code === "KeyL" && canShowRealness) {
      if (event.shiftKey) {
        realness.clearLights();
      } else {
        void dropLightWhereLooking(realness, splats, placement);
      }
    }
    if ((event.code === "BracketLeft" || event.code === "BracketRight") && canShowRealness) {
      realness.resizeLight(event.code === "BracketRight" ? 2 : 0.5);
    }
  });

  await splats.initialized;
  const photoHint = frames.length > 0 ? ", O shows the photo in its frame" : "";
  const floorHint = colliderFile !== undefined ? ", N shows the walkable floor" : "";
  const realnessHint = canShowRealness
    ? ", V changes the dream look, R shows how real each splat is, L drops a light where you look"
    : "";
  statusLine.textContent = `${name} (${splatFile}): drag to look, W A S D to move, E up, Q down${photoHint}${floorHint}${realnessHint}, H hides all text and lines`;
}

/** Measures the walkable floor the first time it is asked for, then shows or hides it. */
class WalkableFloorToggle {
  private readonly loadCollider: () => Promise<TriangleMesh>;
  private readonly placement: WorldPlacement;
  private readonly photoCameras: PhotoCamera[];
  private overlay: THREE.Mesh | undefined;
  private description = "";
  private measuring = false;

  constructor(
    loadCollider: () => Promise<TriangleMesh>,
    placement: WorldPlacement,
    photoCameras: PhotoCamera[],
  ) {
    this.loadCollider = loadCollider;
    this.placement = placement;
    this.photoCameras = photoCameras;
  }

  async toggle(): Promise<void> {
    if (this.overlay !== undefined) {
      this.overlay.visible = !this.overlay.visible;
      walkableLine.textContent = this.overlay.visible ? this.description : "";
      return;
    }
    if (this.measuring) {
      return;
    }
    this.measuring = true;
    walkableLine.textContent = "Measuring the walkable floor...";
    try {
      // Loaded only now: the navigation library is about 760 kB.
      const [{ measureWalkableFloor }, collider] = await Promise.all([
        import("@unpictured/core/walkable"),
        this.loadCollider(),
      ]);
      const floor = await measureWalkableFloor(collider, this.placement, this.photoCameras);
      this.overlay = buildFloorOverlay(floor);
      helpers.add(this.overlay);
      this.description = describeFloor(floor);
      walkableLine.textContent = this.description;
    } catch (error) {
      walkableLine.textContent = `Could not measure the walkable floor: ${errorMessage(error)}`;
    } finally {
      this.measuring = false;
    }
  }
}

/** Shows the world through the dream look (the default) or as a realness heatmap. Both read the
 * same realness, so test lights show in either; they are sized in camera heights and placed in
 * the raw frame. The photo spot's height above the floor is worked out first. */
class RealnessViews {
  private readonly splats: SplatMesh;
  private readonly loadCollider: () => Promise<TriangleMesh>;
  private readonly placement: WorldPlacement;
  private readonly photoCameras: PhotoCamera[];
  private readonly lights = new RealnessLights();
  private readonly strength = dyno.dynoFloat(DREAM_STRENGTHS.strong);
  private dream: GsplatModifier | undefined;
  private heatmap: GsplatModifier | undefined;
  private showHeatmap = false;
  private dreamStrength: DreamStrength = "strong";
  private cameraHeight = 1;
  private preparing = false;
  /** The newest light's radius, and the next one's, in camera heights. */
  private lightSize = 1;

  constructor(
    splats: SplatMesh,
    loadCollider: () => Promise<TriangleMesh>,
    placement: WorldPlacement,
    photoCameras: PhotoCamera[],
  ) {
    this.splats = splats;
    this.loadCollider = loadCollider;
    this.placement = placement;
    this.photoCameras = photoCameras;
  }

  /** Shows the dream look once it is ready. */
  async start(): Promise<void> {
    if (await this.prepare()) {
      this.show();
    }
  }

  async toggleHeatmap(): Promise<void> {
    if (await this.prepare()) {
      this.showHeatmap = !this.showHeatmap;
      this.show();
    }
  }

  /** Strong, then subtle, then off (true colors), and round again; back to the dream look. */
  async nextDreamStrength(): Promise<void> {
    if (await this.prepare()) {
      const order: DreamStrength[] = ["strong", "subtle", "off"];
      const next = (order.indexOf(this.dreamStrength) + 1) % order.length;
      this.dreamStrength = order[next] ?? "strong";
      this.showHeatmap = false;
      this.show();
    }
  }

  /** Adds a light at a raw-frame point. When all MAX_LIGHTS are in use, the oldest one goes. */
  async dropLight(rawPoint: Vec3): Promise<void> {
    if (!(await this.prepare())) {
      return;
    }
    const light: MemoryLight = { position: rawPoint, radius: this.lightSize * this.cameraHeight };
    this.lights.set([...this.lights.lights, light].slice(-MAX_LIGHTS), REALNESS_SETTINGS);
    this.splats.updateVersion();
    this.describe();
  }

  clearLights(): void {
    this.lights.set([], REALNESS_SETTINGS);
    this.splats.updateVersion();
    this.describe();
  }

  /** Resizes the newest light at once, so the change shows, and sizes the lights after it. */
  resizeLight(factor: number): void {
    this.lightSize = Math.min(8, Math.max(1 / 8, this.lightSize * factor));
    const lights = [...this.lights.lights];
    const newest = lights.pop();
    if (newest !== undefined) {
      const radius = this.lightSize * this.cameraHeight;
      this.lights.set([...lights, { ...newest, radius }], REALNESS_SETTINGS);
      this.splats.updateVersion();
    }
    this.describe();
  }

  /** Builds both views the first time; false (with the reason on screen) if it cannot. */
  private async prepare(): Promise<boolean> {
    if (this.dream !== undefined) {
      return true;
    }
    if (this.preparing) {
      return false;
    }
    this.preparing = true;
    realnessLine.textContent = "Working out how real each splat is...";
    try {
      const cameraHeight = photoSpotHeight(await this.loadCollider(), this.placement);
      if (cameraHeight === undefined) {
        throw new Error("the collider has no floor below or near the photo spot");
      }
      this.cameraHeight = cameraHeight;
      const cameras = this.photoCameras;
      const settings = REALNESS_SETTINGS;
      this.heatmap = realnessHeatmap(cameras, cameraHeight, settings, this.lights);
      this.dream = dreamLook(
        cameras,
        cameraHeight,
        settings,
        this.lights,
        this.strength,
        DREAM_SETTINGS,
      );
      return true;
    } catch (error) {
      realnessLine.textContent = `Could not show the dream look or realness: ${errorMessage(error)}`;
      return false;
    } finally {
      this.preparing = false;
    }
  }

  /** The heatmap, the dream look, or (with the dream off) the splats as Marble made them. */
  private show(): void {
    const dreamOff = this.dreamStrength === "off";
    const modifier = this.showHeatmap ? this.heatmap : dreamOff ? undefined : this.dream;
    if (this.splats.objectModifier !== modifier) {
      this.splats.objectModifier = modifier;
      this.splats.updateGenerator();
    }
    this.strength.value = DREAM_STRENGTHS[this.dreamStrength];
    this.splats.updateVersion();
    this.describe();
  }

  /** The legend for what is shown. Until the views are ready, the line keeps any message. */
  private describe(): void {
    if (this.dream === undefined) {
      return;
    }
    const size = this.lightSize === 1 ? "1 camera height" : `${this.lightSize} camera heights`;
    const lights =
      `L drops a light where you look, [ and ] shrink or grow the newest one (now ${size}, ` +
      `from 1/8 to 8), Shift+L clears. Lights: ${this.lights.lights.length} of ${MAX_LIGHTS}.`;
    if (this.showHeatmap) {
      const { nearOk, farLimit } = REALNESS_SETTINGS;
      realnessLine.textContent =
        `Realness: blue was in a photo or is near a light, pink is imagined. Real up to ` +
        `${nearOk} camera heights from the photo spot, imagined from ${farLimit}. ${lights} ` +
        "R goes back to the dream look.";
      return;
    }
    const look =
      this.dreamStrength === "off"
        ? "Dream look off: true colors."
        : `Dream look, ${this.dreamStrength}: what the photos saw keeps its colors, and the ` +
          "rest washes toward paper the less real it is.";
    realnessLine.textContent = `${look} V: strong, subtle or off. ${lights}`;
  }
}

/** Drops a test light on the splat at the middle of the screen. */
async function dropLightWhereLooking(
  realness: RealnessViews,
  splats: SplatMesh,
  placement: WorldPlacement,
): Promise<void> {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const [hit] = raycaster.intersectObject(splats, false);
  if (hit === undefined) {
    realnessLine.textContent = "Nothing in the middle of the screen to light.";
    return;
  }
  await realness.dropLight(toRawFrame([hit.point.x, hit.point.y, hit.point.z], placement));
}

/** Fetches and parses the collider once, for whichever view asks first. A failed attempt is
 * forgotten, so the next key press tries again. */
function colliderLoader(url: string): () => Promise<TriangleMesh> {
  let collider: Promise<TriangleMesh> | undefined;
  return () => {
    collider ??= fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${url}: HTTP ${response.status}`);
        }
        return parseGlbMesh(await response.arrayBuffer());
      })
      .catch((error: unknown) => {
        collider = undefined;
        throw error;
      });
    return collider;
  };
}

/** The world's camera.json, or no cameras when `locate` has not been run for it. */
async function loadPhotoCameras(name: string): Promise<PhotoCamera[]> {
  const response = await fetch(`/worlds/${name}/camera.json`);
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`worlds/${name}/camera.json: HTTP ${response.status}`);
  }
  return parseCameraFile(await response.json());
}

function applyPlacement(object: THREE.Object3D, placement: WorldPlacement): void {
  object.scale.setScalar(placement.scale);
  object.quaternion.set(...placement.quaternion);
  object.position.set(...placement.position);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`index.html has no #${id}`);
  }
  return element;
}
