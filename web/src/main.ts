import { SparkControls, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import {
  isWorldName,
  type PhotoCamera,
  parseCameraFile,
  parseGlbMesh,
  parseWorldMeta,
  pickSplatFile,
  placeWorld,
  sourceCameraPosition,
  type WorldPlacement,
} from "@unpictured/core";
import * as THREE from "three";
import { buildPhotoFrame, fieldOfViewFor } from "./photoFrames.ts";
import { buildFloorOverlay, describeFloor } from "./walkableFloor.ts";

const statusLine = requireElement("status");
const positionLine = requireElement("position");
const noticeLine = requireElement("notice");
const walkableLine = requireElement("walkable");

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

// Scale references: a grid on the ground (y = 0) with 1-unit cells, and 1-unit axes
// (x red, y green, z blue). A unit is a metre only when the world has metric data.
scene.add(new THREE.GridHelper(20, 20));
scene.add(new THREE.AxesHelper(1));
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
  const name = new URLSearchParams(window.location.search).get("world");
  if (name === null || !isWorldName(name)) {
    statusLine.textContent =
      "Add ?world=<name> to the address, where <name> is a folder in worlds/.";
    return;
  }
  statusLine.textContent = `Loading ${name}...`;

  const response = await fetch(`/worlds/${name}/meta.json`);
  if (!response.ok) {
    throw new Error(`worlds/${name}/meta.json: HTTP ${response.status}`);
  }
  const meta = parseWorldMeta(await response.json());
  const splatFile = pickSplatFile(meta);
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
    scene.add(frame.outline, frame.overlay);
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
  const walkable = new WalkableFloorToggle(
    `/worlds/${name}/${colliderFile}`,
    placement,
    photoCameras,
  );
  window.addEventListener("keydown", (event) => {
    if (event.code === "KeyO") {
      for (const frame of frames) {
        frame.overlay.visible = !frame.overlay.visible;
      }
    }
    if (event.code === "KeyN" && colliderFile !== undefined) {
      void walkable.toggle();
    }
  });

  await splats.initialized;
  const photoHint = frames.length > 0 ? ", O shows the photo in its frame" : "";
  const floorHint = colliderFile !== undefined ? ", N shows the walkable floor" : "";
  statusLine.textContent = `${name} (${splatFile}): drag to look, W A S D to move, E up, Q down${photoHint}${floorHint}`;
}

/** Measures the walkable floor the first time it is asked for, then shows or hides it. */
class WalkableFloorToggle {
  private readonly colliderUrl: string;
  private readonly placement: WorldPlacement;
  private readonly photoCameras: PhotoCamera[];
  private overlay: THREE.Mesh | undefined;
  private description = "";
  private measuring = false;

  constructor(colliderUrl: string, placement: WorldPlacement, photoCameras: PhotoCamera[]) {
    this.colliderUrl = colliderUrl;
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
      const [{ measureWalkableFloor }, response] = await Promise.all([
        import("@unpictured/core/walkable"),
        fetch(this.colliderUrl),
      ]);
      if (!response.ok) {
        throw new Error(`${this.colliderUrl}: HTTP ${response.status}`);
      }
      const collider = parseGlbMesh(await response.arrayBuffer());
      const floor = await measureWalkableFloor(collider, this.placement, this.photoCameras);
      this.overlay = buildFloorOverlay(floor);
      scene.add(this.overlay);
      this.description = describeFloor(floor);
      walkableLine.textContent = this.description;
    } catch (error) {
      walkableLine.textContent = `Could not measure the walkable floor: ${errorMessage(error)}`;
    } finally {
      this.measuring = false;
    }
  }
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
