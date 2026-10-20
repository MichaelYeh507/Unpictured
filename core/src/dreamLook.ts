/**
 * The dream look (docs/DREAM_LOOK.md). Every splat is drawn in soft bands of brightness with
 * livelier color (the toon step); then, the less real it is, the more it takes on the dream's
 * palette and fades toward the paper (the wash). Colors are sRGB from 0 to 1, as splats store them.
 */

import type { Vec3 } from "./frames.ts";
import { smoothstep } from "./realness.ts";

export interface DreamSettings {
  /** How many bands of brightness the toon step leaves. */
  bands: number;
  /** Half the width of the soft edge between two bands, as a share of a band. */
  bandSoftness: number;
  /** The darkest band's brightness, so shadows keep some color. */
  shadowFloor: number;
  /** Color strength after banding: 1 keeps it, above 1 makes it livelier. */
  vivid: number;
  /** Share of a splat's saturation left at full dream intensity. */
  saturation: number;
  /** How far a splat's color moves toward the palette at full dream intensity. */
  tint: number;
  /** How far a splat's color moves toward the paper at full dream intensity. */
  paperLift: number;
  /** The dream palette's light end. */
  paper: Vec3;
  /** The dream palette's dark end; brighter splats get more of the paper. */
  pigment: Vec3;
}

/** Look "B3" with the cotton-candy palette, picked by eye (2026-10-20). */
export const DREAM_SETTINGS: DreamSettings = {
  bands: 4,
  bandSoftness: 0.04,
  shadowFloor: 0.2,
  vivid: 1.5,
  saturation: 0.8,
  tint: 0.6,
  paperLift: 0.25,
  paper: [1, 0.9, 0.96],
  pigment: [0.6, 0.3, 0.65],
};

/** The viewer's dream strengths. In the game, the wake meter will scale the strength instead. */
export const DREAM_STRENGTHS = { strong: 1, subtle: 0.5, off: 0 } as const;
export type DreamStrength = keyof typeof DREAM_STRENGTHS;

/** Brightness weights (Rec. 709). */
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

/** Below this brightness, banding scales a color as if it were this bright (no division by 0). */
export const DARKEST = 0.02;

/** How dreamed a splat looks, from 0 (as photographed) to 1: (1 - realness) times the strength,
 * at most 1. */
export function dreamIntensity(realness: number, strength: number): number {
  return Math.min(1, Math.max(0, (1 - realness) * strength));
}

/** A splat's color in the dream look: the toon step, then the wash at this intensity. */
export function dreamColor(
  rgb: Vec3,
  intensity: number,
  settings: DreamSettings = DREAM_SETTINGS,
): Vec3 {
  return washColor(toonColor(rgb, settings), intensity, settings);
}

/** Brightness snapped to soft bands (the hue kept), then the color made livelier. */
export function toonColor(rgb: Vec3, settings: DreamSettings = DREAM_SETTINGS): Vec3 {
  const { bands, bandSoftness, shadowFloor, vivid } = settings;
  const brightness = luma(rgb);
  const steps = brightness * bands;
  const band = Math.floor(steps);
  const soft = smoothstep(0.5 - bandSoftness, 0.5 + bandSoftness, steps - band);
  const level = mix(shadowFloor, 1, (band + soft) / bands);
  const scale = level / Math.max(brightness, DARKEST);
  const banded: Vec3 = [clamp01(rgb[0] * scale), clamp01(rgb[1] * scale), clamp01(rgb[2] * scale)];
  const bandedLuma = luma(banded);
  const channel = (i: 0 | 1 | 2) => clamp01(mix(bandedLuma, banded[i], vivid));
  return [channel(0), channel(1), channel(2)];
}

/** The wash: less saturation, a move toward the palette, and a fade toward the paper. */
export function washColor(
  rgb: Vec3,
  intensity: number,
  settings: DreamSettings = DREAM_SETTINGS,
): Vec3 {
  const brightness = luma(rgb);
  const keep = mix(1, settings.saturation, intensity);
  const tint = settings.tint * intensity;
  const lift = settings.paperLift * intensity;
  const channel = (i: 0 | 1 | 2) => {
    const muted = mix(brightness, rgb[i], keep);
    const palette = mix(settings.pigment[i], settings.paper[i], brightness);
    return mix(mix(muted, palette, tint), settings.paper[i], lift);
  };
  return [channel(0), channel(1), channel(2)];
}

/** Settings the shader cannot use, or that would push colors out of range, are refused. */
export function checkDreamSettings(settings: DreamSettings): void {
  const { bands, bandSoftness, shadowFloor, vivid } = settings;
  const { saturation, tint, paperLift, paper, pigment } = settings;
  if (!(bands >= 1) || !Number.isFinite(bands)) {
    throw new Error("dream look: bands must be a finite number, at least 1");
  }
  // GLSL's smoothstep needs a real width, and the edges of a band must not overlap.
  if (!(bandSoftness > 0 && bandSoftness <= 0.5)) {
    throw new Error("dream look: bandSoftness must be above 0 and at most 0.5");
  }
  if (!(vivid >= 0) || !Number.isFinite(vivid)) {
    throw new Error("dream look: vivid must be a finite number, at least 0");
  }
  const shares = [shadowFloor, saturation, tint, paperLift, ...paper, ...pigment];
  if (!shares.every((value) => value >= 0 && value <= 1)) {
    throw new Error("dream look: the other settings and both colors must be 0 to 1");
  }
}

function luma(rgb: Vec3): number {
  return rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** GLSL's mix, written the same way so both round alike. */
function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}
