/**
 * Coordinate frames. Marble's splat files use `marble_raw_opencv`: x right, y down, z forward.
 * The game uses three.js axes (x right, y up, -z forward), in metres with the ground at y = 0
 * when the world has metric data.
 */

export type Vec3 = readonly [number, number, number];
/** A rotation as x, y, z, w. */
export type Quaternion = readonly [number, number, number, number];

export const RAW_FRAME = "marble_raw_opencv";

/** Camera height for worlds without metric data. A stand-in, not a measurement. */
export const FALLBACK_CAMERA_HEIGHT = 1.6;

/** 180 degrees about x: OpenCV's y down and z forward become y up and -z forward. */
const FLIP_ABOUT_X: Quaternion = [1, 0, 0, 0];

export interface FrameMetadata {
  frame: string;
  metricScaleFactor: number | null;
  groundPlaneOffset: number | null;
}

/** Scale, then rotate, then translate, the same order as a three.js Object3D. */
export interface WorldPlacement {
  scale: number;
  quaternion: Quaternion;
  position: Vec3;
  /** False when the world has no metric data, so its size and heights are not true to life. */
  metric: boolean;
}

export function placeWorld(meta: FrameMetadata): WorldPlacement {
  if (meta.frame !== RAW_FRAME) {
    throw new Error(`Unknown splat frame "${meta.frame}", expected "${RAW_FRAME}"`);
  }
  const { metricScaleFactor, groundPlaneOffset } = meta;
  if (metricScaleFactor !== null && groundPlaneOffset !== null) {
    return {
      scale: metricScaleFactor,
      quaternion: FLIP_ABOUT_X,
      position: [0, groundPlaneOffset, 0],
      metric: true,
    };
  }
  return {
    scale: 1,
    quaternion: FLIP_ABOUT_X,
    position: [0, FALLBACK_CAMERA_HEIGHT, 0],
    metric: false,
  };
}

export function toGameFrame(rawPoint: Vec3, placement: WorldPlacement): Vec3 {
  const s = placement.scale;
  const scaled: Vec3 = [s * rawPoint[0], s * rawPoint[1], s * rawPoint[2]];
  const [x, y, z] = rotate(placement.quaternion, scaled);
  const [px, py, pz] = placement.position;
  return [x + px, y + py, z + pz];
}

/** Marble's panorama camera sits at the raw origin (to be confirmed in M0). */
export function sourceCameraPosition(placement: WorldPlacement): Vec3 {
  return toGameFrame([0, 0, 0], placement);
}

function rotate([qx, qy, qz, qw]: Quaternion, [x, y, z]: Vec3): Vec3 {
  // v + 2w(q × v) + 2q × (q × v), for a unit quaternion q.
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}
