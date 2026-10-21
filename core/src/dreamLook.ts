/**
 * The dream look (docs/DREAM_LOOK.md): soft bands of brightness with livelier color (the toon
 * step), then the less real a splat is, the more it takes on the dream's palette, which cycles
 * from warm to cold, and fades toward the paper (the wash). Colors are sRGB from 0 to 1.
 */

import type { Vec3 } from "./frames.ts";
import { smoothstep } from "./realness.ts";

export interface DreamSettings {
  /** Whole bands of brightness: a color snaps to one of bands + 1 levels. */
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
  /** The palette at the warm end of the cycle... */
  warm: DreamPalette;
  /** ...and at the cold end. */
  cold: DreamPalette;
  /** Seconds from warm to cold and back. */
  cycleSeconds: number;
}

export interface DreamPalette {
  /** The light end, which is also the paper behind the world. */
  paper: Vec3;
  /** The dark end; brighter splats get more of the paper. */
  pigment: Vec3;
}

/** Picked by eye from look-development screenshots and animations (2026-10-20): soft toon
 * bands, and a palette that turns from peach to sky blue and back once a minute. */
export const DREAM_SETTINGS: DreamSettings = {
  bands: 4,
  bandSoftness: 0.04,
  shadowFloor: 0.2,
  vivid: 1.5,
  saturation: 0.8,
  tint: 0.6,
  paperLift: 0.25,
  warm: { paper: [1, 0.9, 0.78], pigment: [0.7, 0.35, 0.4] },
  cold: { paper: [0.9, 0.96, 1], pigment: [0.15, 0.3, 0.7] },
  cycleSeconds: 60,
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

/** How far the palette has turned toward cold at this time: 0 (warm) at the start of each
 * cycle, 1 (cold) halfway, easing in and out. */
export function coldnessAt(seconds: number, settings: DreamSettings = DREAM_SETTINGS): number {
  return (1 - Math.cos((2 * Math.PI * seconds) / settings.cycleSeconds)) / 2;
}

/** The palette this far from warm (0) to cold (1). */
export function paletteAt(
  coldness: number,
  settings: DreamSettings = DREAM_SETTINGS,
): DreamPalette {
  const { warm, cold } = settings;
  const channel = (from: Vec3, to: Vec3, i: 0 | 1 | 2) => mix(from[i], to[i], coldness);
  const blend = (from: Vec3, to: Vec3): Vec3 => [
    channel(from, to, 0),
    channel(from, to, 1),
    channel(from, to, 2),
  ];
  return { paper: blend(warm.paper, cold.paper), pigment: blend(warm.pigment, cold.pigment) };
}

/** A splat's color in the dream look: the toon step, then the wash at this intensity and
 * coldness. */
export function dreamColor(
  rgb: Vec3,
  intensity: number,
  settings: DreamSettings = DREAM_SETTINGS,
  coldness = 0,
): Vec3 {
  return washColor(toonColor(rgb, settings), intensity, settings, coldness);
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
  coldness = 0,
): Vec3 {
  const { paper, pigment } = paletteAt(coldness, settings);
  const brightness = luma(rgb);
  const keep = mix(1, settings.saturation, intensity);
  const tint = settings.tint * intensity;
  const lift = settings.paperLift * intensity;
  const channel = (i: 0 | 1 | 2) => {
    const muted = mix(brightness, rgb[i], keep);
    const palette = mix(pigment[i], paper[i], brightness);
    return mix(mix(muted, palette, tint), paper[i], lift);
  };
  return [channel(0), channel(1), channel(2)];
}

/** Settings the shader cannot use, or that would push colors out of range, are refused. */
export function checkDreamSettings(settings: DreamSettings): void {
  const { bands, bandSoftness, shadowFloor, vivid } = settings;
  const { saturation, tint, paperLift, warm, cold, cycleSeconds } = settings;
  if (!Number.isInteger(bands) || bands < 1) {
    throw new Error("dream look: bands must be a whole number, at least 1");
  }
  // GLSL's smoothstep needs a real width, and the edges of a band must not overlap.
  if (!(bandSoftness > 0 && bandSoftness <= 0.5)) {
    throw new Error("dream look: bandSoftness must be above 0 and at most 0.5");
  }
  if (!(vivid >= 0) || !Number.isFinite(vivid)) {
    throw new Error("dream look: vivid must be a finite number, at least 0");
  }
  if (!(cycleSeconds > 0) || !Number.isFinite(cycleSeconds)) {
    throw new Error("dream look: cycleSeconds must be a finite number above 0");
  }
  const colors = [...warm.paper, ...warm.pigment, ...cold.paper, ...cold.pigment];
  const shares = [shadowFloor, saturation, tint, paperLift, ...colors];
  if (!shares.every((value) => value >= 0 && value <= 1)) {
    throw new Error("dream look: the other settings and every palette color must be 0 to 1");
  }
}

function luma(rgb: Vec3): number {
  return rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The same formula as GLSL's mix. */
function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}
