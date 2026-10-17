/**
 * How real a point of a world is: how squarely a source photo saw it (docs/REALNESS.md).
 * Points are in the raw splat frame. Distances are in camera heights: raw units divided by the
 * photo spot's height above the floor, so drafts and standard worlds use the same numbers.
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
}

export const REALNESS_SETTINGS: RealnessSettings = { margin: 0.05, nearOk: 6, farLimit: 25 };

/** The highest realness any of the photos gives a point, from 0 (imagined) to 1 (seen). */
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

/** One photo's realness for a point: inside its frame (with a soft edge) times near enough. */
export function photoRealness(
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
  if (!(cameraHeight > 0)) {
    throw new Error("realness: the camera height must be above 0");
  }
  if (!(settings.margin > 0) || !(settings.nearOk >= 0) || !(settings.farLimit > settings.nearOk)) {
    throw new Error("realness: needs margin > 0 and 0 <= nearOk < farLimit");
  }
}
