import { SparkControls, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import {
  isWorldName,
  type PhotoCamera,
  parseCameraFile,
  parseWorldMeta,
  pickSplatFile,
  placeWorld,
  sourceCameraPosition,
  type WorldPlacement,
} from "@unpictured/core";
import * as THREE from "three";
import { buildPhotoFrame, fieldOfViewFor } from "./photoFrames.ts";

const statusLine = requireElement("status");
const positionLine = requireElement("position");
const noticeLine = requireElement("notice");

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
  const message = error instanceof Error ? error.message : String(error);
  statusLine.textContent = `Could not load the world: ${message}`;
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

  const photoCameras = await loadPhotoCameras(name);
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
  window.addEventListener("keydown", (event) => {
    if (event.code === "KeyO") {
      for (const frame of frames) {
        frame.overlay.visible = !frame.overlay.visible;
      }
    }
  });

  await splats.initialized;
  const photoHint = frames.length > 0 ? ", O shows the photo in its frame" : "";
  statusLine.textContent = `${name} (${splatFile}): drag to look, W A S D to move, E up, Q down${photoHint}`;
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

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`index.html has no #${id}`);
  }
  return element;
}
