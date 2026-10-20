/**
 * The dream's watercolor wash (docs/DREAM_LOOK.md). As realness drops, a splat's color loses
 * saturation, takes on the wash (pigment in the darks, paper in the lights) and fades toward the
 * paper, like thinned paint. Colors are sRGB from 0 to 1, as the splats store them.
 */

import type { Vec3 } from "./frames.ts";

export interface DreamSettings {
  /** Share of a splat's saturation left at full dream intensity. */
  saturation: number;
  /** How far a splat's color moves toward the wash color at full dream intensity. */
  tint: number;
  /** How far a splat's color moves toward the paper at full dream intensity. */
  paperLift: number;
  /** The paper's color. */
  paper: Vec3;
  /** The wash color of the darkest splats; brighter ones get more of the paper. */
  pigment: Vec3;
}

/** A first guess from the brief's art direction (pastel watercolor); to be tuned by eye. */
export const DREAM_SETTINGS: DreamSettings = {
  saturation: 0.7,
  tint: 0.65,
  paperLift: 0.3,
  paper: [0.96, 0.94, 0.89],
  pigment: [0.27, 0.33, 0.6],
};

/** The viewer's dream strengths. In the game, the wake meter will scale the strength instead. */
export const DREAM_STRENGTHS = { strong: 1, subtle: 0.5, off: 0 } as const;
export type DreamStrength = keyof typeof DREAM_STRENGTHS;

/** Brightness weights (Rec. 709), used to take saturation out without changing brightness. */
export const LUMA: Vec3 = [0.2126, 0.7152, 0.0722];

/** How dreamed a splat looks, from 0 (as photographed) to 1: (1 - realness) times the strength,
 * at most 1. */
export function dreamIntensity(realness: number, strength: number): number {
  return Math.min(1, Math.max(0, (1 - realness) * strength));
}

/** A splat's color, washed at this dream intensity. */
export function washColor(
  rgb: Vec3,
  intensity: number,
  settings: DreamSettings = DREAM_SETTINGS,
): Vec3 {
  const luma = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
  const keep = mix(1, settings.saturation, intensity);
  const tint = settings.tint * intensity;
  const lift = settings.paperLift * intensity;
  const channel = (i: 0 | 1 | 2) => {
    const muted = mix(luma, rgb[i], keep);
    const wash = mix(settings.pigment[i], settings.paper[i], luma);
    return mix(mix(muted, wash, tint), settings.paper[i], lift);
  };
  return [channel(0), channel(1), channel(2)];
}

/** Settings outside 0 to 1 would push colors out of range, so they are refused. */
export function checkDreamSettings(settings: DreamSettings): void {
  const { saturation, tint, paperLift, paper, pigment } = settings;
  const values = [saturation, tint, paperLift, ...paper, ...pigment];
  if (!values.every((value) => value >= 0 && value <= 1)) {
    throw new Error("dream look: every dream setting and color must be 0 to 1");
  }
}

/** GLSL's mix, written the same way so both round alike. */
function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}
