/**
 * How the dream changes each splat's shape (docs/DREAM_LOOK.md): the less real it is, the more it
 * swells, and far from the photo spot it also drifts and dissolves toward dust. The floor at the
 * photo spot's level holds still, because the player stands on the collider, which does not move.
 * Points are in the raw splat frame (y down, the photo spot at the origin); distances are in
 * camera heights.
 */

import type { Vec3 } from "./frames.ts";
import { smoothstep } from "./realness.ts";

export interface DreamShapeSettings {
  /** Splat size at full dream intensity, as a multiple: swollen splats bleed into each other. */
  swell: number;
  /** Dream depth starts this far from the photo spot, in camera heights... */
  depthNear: number;
  /** ...and is full from this far. */
  depthFar: number;
  /** Farthest a splat drifts from its place at full depth, in camera heights. */
  drift: number;
  /** Farthest a floor splat drifts at full depth, in camera heights. */
  floorDrift: number;
  /** Splats up to this height above the floor at the photo spot are floor, in camera heights... */
  floorHold: number;
  /** ...and splats from this height up drift freely. */
  floorFree: number;
  /** Seconds for one slow breath of the drift. */
  period: number;
  /** Length of the wave the drift travels in, in camera heights. */
  waveLength: number;
  /** Dissolving starts at this depth and is complete at depth 1. */
  dissolveFrom: number;
  /** Share of a splat's size left when fully dissolved into dust. */
  dustSize: number;
  /** Share of a splat's opacity left when fully dissolved. */
  dustOpacity: number;
}

/** Floors hold still to about 2 cm (under the collider's 5 cm precision) at a 1.6 m camera
 * height, and the rest drifts up to about 25 cm (user's decisions, 2026-10-20). */
export const DREAM_SHAPE_SETTINGS: DreamShapeSettings = {
  swell: 1.2,
  depthNear: 2,
  depthFar: 25,
  drift: 0.15,
  floorDrift: 0.0125,
  floorHold: 0.1,
  floorFree: 0.25,
  period: 6,
  waveLength: 3,
  dissolveFrom: 0.6,
  dustSize: 0.5,
  dustOpacity: 0.6,
};

/** Breaths per period along x, y and z, so a splat drifts in a slow loop, not a line. */
export const DRIFT_RATES: Vec3 = [1, 0.75, 1.25];

/** After this many periods every axis has made whole turns, so the drift starts over. */
export const DRIFT_LOOP_PERIODS = 4;

/** The horizontal direction (x, z) the drift's wave travels in. */
export const WAVE_DIRECTION = [0.8, 0.6] as const;

export interface SplatShape {
  center: Vec3;
  scales: Vec3;
  opacity: number;
}

/** A splat's shape at this dream intensity (dreamIntensity in dreamLook.ts) and time. */
export function dreamShape(
  splat: SplatShape,
  index: number,
  intensity: number,
  seconds: number,
  cameraHeight: number,
  settings: DreamShapeSettings = DREAM_SHAPE_SETTINGS,
): SplatShape {
  const { center, scales, opacity } = splat;
  const depth = dreamDepth(intensity, center, cameraHeight, settings);
  const dissolve = smoothstep(settings.dissolveFrom, 1, depth);
  const freedom = floorFreedom(center, cameraHeight, settings);
  const reach = depth * mix(settings.floorDrift, settings.drift, freedom) * cameraHeight;
  const [waveX, waveZ] = WAVE_DIRECTION;
  const along = (center[0] * waveX + center[2] * waveZ) / (settings.waveLength * cameraHeight);
  const randoms = splatRandoms(index);
  // Each axis stays within reach / sqrt(3), so the whole drift stays within reach.
  const drift = (axis: 0 | 1 | 2) => {
    const breaths = (seconds / settings.period) * DRIFT_RATES[axis];
    const phase = breaths + along + dissolve * randoms[axis];
    return center[axis] + (reach / Math.sqrt(3)) * Math.sin(2 * Math.PI * phase);
  };
  const size = mix(1, settings.swell, intensity) * mix(1, settings.dustSize, dissolve);
  return {
    center: [drift(0), drift(1), drift(2)],
    scales: [scales[0] * size, scales[1] * size, scales[2] * size],
    opacity: opacity * mix(1, settings.dustOpacity, dissolve),
  };
}

/** How deep in the dream a splat is: its intensity, times how far it is from the photo spot. */
export function dreamDepth(
  intensity: number,
  rawPoint: Vec3,
  cameraHeight: number,
  settings: DreamShapeSettings = DREAM_SHAPE_SETTINGS,
): number {
  const away = Math.hypot(...rawPoint) / cameraHeight;
  return intensity * smoothstep(settings.depthNear, settings.depthFar, away);
}

/** 0 for floor splats (held still) to 1 for splats well above the floor at the photo spot, which
 * sits cameraHeight below the origin (raw y points down). */
export function floorFreedom(
  rawPoint: Vec3,
  cameraHeight: number,
  settings: DreamShapeSettings = DREAM_SHAPE_SETTINGS,
): number {
  const height = 1 - rawPoint[1] / cameraHeight;
  return smoothstep(settings.floorHold, settings.floorFree, height);
}

/** Three numbers from 0 to 1 that are fixed for each splat, from its index: chained PCG hashes,
 * each turned into a 32-bit float as GLSL's float(uint) does. */
export function splatRandoms(index: number): Vec3 {
  const first = pcgHash(index);
  const second = pcgHash(first);
  const third = pcgHash(second);
  return [toUnit(first), toUnit(second), toUnit(third)];
}

/** The PCG hash from Jarzynski and Olano's "Hash Functions for GPU Rendering" (2020), on
 * unsigned 32-bit numbers. */
export function pcgHash(value: number): number {
  const state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Settings the shader cannot use are refused (GLSL's smoothstep needs edge0 < edge1). */
export function checkDreamShapeSettings(settings: DreamShapeSettings): void {
  const { swell, depthNear, depthFar, drift, floorDrift, floorHold, floorFree } = settings;
  const { period, waveLength, dissolveFrom, dustSize, dustOpacity } = settings;
  if (!Object.values(settings).every(Number.isFinite)) {
    throw new Error("dream shape: every setting must be a finite number");
  }
  if (!(swell > 0 && period > 0 && waveLength > 0 && drift >= 0 && floorDrift >= 0)) {
    throw new Error("dream shape: swell, period and waveLength must be above 0, drifts at least 0");
  }
  if (!(depthNear >= 0 && depthFar > depthNear && floorFree > floorHold)) {
    throw new Error("dream shape: needs 0 <= depthNear < depthFar and floorHold < floorFree");
  }
  if (!(dissolveFrom >= 0 && dissolveFrom < 1)) {
    throw new Error("dream shape: dissolveFrom must be at least 0 and below 1");
  }
  if (!(dustSize >= 0 && dustSize <= 1 && dustOpacity >= 0 && dustOpacity <= 1)) {
    throw new Error("dream shape: dustSize and dustOpacity must be 0 to 1");
  }
}

function toUnit(hash: number): number {
  return Math.fround(hash) / 2 ** 32;
}

/** The same formula as GLSL's mix. */
function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}
