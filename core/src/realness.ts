/**
 * How real a point of a world is: how squarely a source photo saw it, or how close it is to a
 * memory light (docs/REALNESS.md). Points are in the raw splat frame. Camera distances are in
 * camera heights: raw units divided by the photo spot's height above the floor, so drafts and
 * standard worlds use the same numbers.
 */

import { type PhotoCamera, toCameraRay } from "./camera.ts";
import type { Vec3 } from "./frames.ts";

export interface RealnessSettings {
  /** Half the width of the fade across the photo's frame, as a share of its width or height. */
  margin: number;
  /** Fully real up to this distance from the camera, in camera heights. */
  nearOk: number;
  /** Not real at all from this distance on, in camera heights. */
  farLimit: number;
  /** A light makes everything within this share of its radius fully real. */
  lightCore: number;
}

export const REALNESS_SETTINGS: RealnessSettings = {
  margin: 0.05,
  nearOk: 6,
  farLimit: 25,
  lightCore: 0.7,
};

/** A memory light: a restored piece makes everything near it real. */
export interface MemoryLight {
  /** In the raw splat frame. */
  position: Vec3;
  /** In raw units: the light reaches this far. */
  radius: number;
}

/** The shader holds this many lights at once. */
export const MAX_LIGHTS = 8;

/** Realness at a point, from 0 (imagined) to 1 (real): the higher of what the photos saw and
 * what the lights restore. */
export function realness(
  rawPoint: Vec3,
  cameras: readonly PhotoCamera[],
  cameraHeight: number,
  lights: readonly MemoryLight[],
  settings: RealnessSettings = REALNESS_SETTINGS,
): number {
  const seen = cameraRealness(rawPoint, cameras, cameraHeight, settings);
  return Math.max(seen, lightRealness(rawPoint, lights, settings));
}

/** The highest realness any of the photos gives a point. */
export function cameraRealness(
  rawPoint: Vec3,
  cameras: readonly PhotoCamera[],
  cameraHeight: number,
  settings: RealnessSettings = REALNESS_SETTINGS,
): number {
  checkRealnessInputs(cameraHeight, settings);
  let highest = 0;
  for (const camera of cameras) {
    highest = Math.max(highest, photoRealness(rawPoint, camera, cameraHeight, settings));
  }
  return highest;
}

/** The highest realness any of the lights gives a point: full within lightCore of a light's
 * radius, fading to nothing at its radius. */
export function lightRealness(
  rawPoint: Vec3,
  lights: readonly MemoryLight[],
  settings: RealnessSettings = REALNESS_SETTINGS,
): number {
  checkLights(lights, settings);
  let highest = 0;
  for (const { position, radius } of lights) {
    const away = Math.hypot(
      rawPoint[0] - position[0],
      rawPoint[1] - position[1],
      rawPoint[2] - position[2],
    );
    highest = Math.max(highest, 1 - smoothstep(settings.lightCore * radius, radius, away));
  }
  return highest;
}

/** One photo's realness for a point: inside its frame (with a soft edge) times near enough. */
function photoRealness(
  rawPoint: Vec3,
  camera: PhotoCamera,
  cameraHeight: number,
  settings: RealnessSettings,
): number {
  const [x, y, z] = toCameraRay(camera, rawPoint);
  if (z <= 0) {
    return 0; // beside or behind the camera
  }
  const [width, height] = camera.imageSize;
  const u = (camera.fx * (x / z) + camera.cx) / width;
  const v = (camera.fy * (y / z) + camera.cy) / height;
  const edge = Math.min(u, 1 - u, v, 1 - v); // negative outside the frame
  const inFrame = smoothstep(-settings.margin, settings.margin, edge);
  const distance = Math.hypot(x, y, z) / cameraHeight;
  const inRange = 1 - smoothstep(settings.nearOk, settings.farLimit, distance);
  return inFrame * inRange;
}

/** GLSL's smoothstep, which needs edge0 < edge1. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** The shader has no way to report bad inputs, so they are refused here instead. */
export function checkRealnessInputs(cameraHeight: number, settings: RealnessSettings): void {
  if (!(cameraHeight > 0) || !Number.isFinite(cameraHeight)) {
    throw new Error("realness: the camera height must be a finite number above 0");
  }
  const { margin, nearOk, farLimit, lightCore } = settings;
  const finite = [margin, nearOk, farLimit].every(Number.isFinite);
  if (!finite || !(margin > 0) || !(nearOk >= 0) || !(farLimit > nearOk)) {
    throw new Error("realness: needs finite settings with margin > 0 and 0 <= nearOk < farLimit");
  }
  checkLightCore(lightCore);
}

/** At most MAX_LIGHTS lights, each with a finite position and a finite radius above 0, and a
 * lightCore the shader can use. */
export function checkLights(lights: readonly MemoryLight[], settings: RealnessSettings): void {
  if (lights.length > MAX_LIGHTS) {
    throw new Error(`realness: at most ${MAX_LIGHTS} lights, not ${lights.length}`);
  }
  for (const { position, radius } of lights) {
    if (!position.every(Number.isFinite) || !(radius > 0) || !Number.isFinite(radius)) {
      throw new Error("realness: each light needs a finite position and a finite radius above 0");
    }
  }
  checkLightCore(settings.lightCore);
}

/** Below 1, so the light's fade has a width (GLSL's smoothstep needs edge0 < edge1). */
function checkLightCore(lightCore: number): void {
  if (!(lightCore >= 0 && lightCore < 1)) {
    throw new Error("realness: lightCore must be at least 0 and below 1");
  }
}
