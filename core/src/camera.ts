/** Where each source photo sits in its world, from the camera.json written by `locate`. */

import { RAW_FRAME, type Vec3 } from "./frames.ts";
import { isPlainFileName } from "./worldPackage.ts";

/** One photo's camera, in the raw splat frame (x right, y down, z forward). */
export interface PhotoCamera {
  photo: string;
  position: Vec3;
  /** Degrees turned right from straight ahead (+z toward +x), like Marble's azimuth. */
  yawDeg: number;
  /** Degrees tilted up. */
  pitchDeg: number;
  /** The photo's width and height in pixels, and its pinhole intrinsics in those pixels. */
  imageSize: readonly [number, number];
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  matchScore: number;
}

export function parseCameraFile(json: unknown): PhotoCamera[] {
  const file = asRecord(json, "camera.json");
  if (file.frame !== RAW_FRAME) {
    throw new Error(`camera.json: frame must be "${RAW_FRAME}"`);
  }
  if (!Array.isArray(file.cameras)) {
    throw new Error("camera.json: cameras is not a list");
  }
  return file.cameras.map((entry: unknown, index: number) => {
    const camera = asRecord(entry, `camera.json cameras[${index}]`);
    const photo = camera.photo;
    if (typeof photo !== "string" || !isPlainFileName(photo)) {
      throw new Error(`camera.json: cameras[${index}].photo is not a plain file name`);
    }
    const [width = 0, height = 0] = numberList(camera, "image_size", 2);
    const [x = 0, y = 0, z = 0] = numberList(camera, "position", 3);
    const fx = number(camera, "fx");
    const fy = number(camera, "fy");
    if (width <= 0 || height <= 0 || fx <= 0 || fy <= 0) {
      throw new Error(
        `camera.json: cameras[${index}] needs a positive image size and focal length`,
      );
    }
    return {
      photo,
      position: [x, y, z],
      yawDeg: number(camera, "yaw_deg"),
      pitchDeg: number(camera, "pitch_deg"),
      imageSize: [width, height],
      fx,
      fy,
      cx: number(camera, "cx"),
      cy: number(camera, "cy"),
      matchScore: number(camera, "match_score"),
    };
  });
}

/** Turns a camera ray into the raw frame: tilt up by pitch, then turn right by yaw. */
export function rotateCameraRay(yawDeg: number, pitchDeg: number, [x, y, z]: Vec3): Vec3 {
  const tilt = (pitchDeg * Math.PI) / 180;
  const turn = (yawDeg * Math.PI) / 180;
  const tiltedY = y * Math.cos(tilt) - z * Math.sin(tilt);
  const tiltedZ = y * Math.sin(tilt) + z * Math.cos(tilt);
  return [
    x * Math.cos(turn) + tiltedZ * Math.sin(turn),
    tiltedY,
    -x * Math.sin(turn) + tiltedZ * Math.cos(turn),
  ];
}

/** The photo's corners `depth` in front of its camera: top-left, top-right, bottom-right, bottom-left. */
export function photoFrameCorners(camera: PhotoCamera, depth: number): Vec3[] {
  const [width, height] = camera.imageSize;
  const pixels: [number, number][] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
  return pixels.map(([u, v]) => pointThroughPixel(camera, u, v, depth));
}

/** The point `depth` in front of the camera through the photo's center. */
export function photoFrameCenter(camera: PhotoCamera, depth: number): Vec3 {
  return pointThroughPixel(camera, camera.cx, camera.cy, depth);
}

function pointThroughPixel(camera: PhotoCamera, u: number, v: number, depth: number): Vec3 {
  const ray: Vec3 = [
    ((u - camera.cx) / camera.fx) * depth,
    ((v - camera.cy) / camera.fy) * depth,
    depth,
  ];
  const [x, y, z] = rotateCameraRay(camera.yawDeg, camera.pitchDeg, ray);
  const [px, py, pz] = camera.position;
  return [x + px, y + py, z + pz];
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function number(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`camera.json: ${key} must be a number`);
  }
  return value;
}

function numberList(record: Record<string, unknown>, key: string, count: number): number[] {
  const value = record[key];
  const isNumber = (item: unknown) => typeof item === "number" && Number.isFinite(item);
  if (!Array.isArray(value) || value.length !== count || !value.every(isNumber)) {
    throw new Error(`camera.json: ${key} must be ${count} numbers`);
  }
  return value;
}
