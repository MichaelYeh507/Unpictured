import { expect, test } from "vitest";
import {
  checkDreamSettings,
  DREAM_SETTINGS,
  type DreamSettings,
  dreamColor,
  dreamIntensity,
  LUMA,
  toonColor,
  washColor,
} from "./dreamLook.ts";
import type { Vec3 } from "./frames.ts";

const PAPER: Vec3 = [0.96, 0.94, 0.89];
const PIGMENT: Vec3 = [0.3, 0.36, 0.56];
/** For the wash tests: only the step a test is about does anything. */
const NONE: DreamSettings = {
  ...DREAM_SETTINGS,
  saturation: 1,
  tint: 0,
  paperLift: 0,
  paper: PAPER,
  pigment: PIGMENT,
};
/** The toon settings the worked toon cases use, whatever the defaults become. */
const TOON: DreamSettings = {
  ...DREAM_SETTINGS,
  bands: 4,
  bandSoftness: 0.04,
  shadowFloor: 0.2,
  vivid: 1.5,
};

function expectColor(actual: Vec3, expected: Vec3): void {
  actual.forEach((value, i) => {
    expect(value, `channel ${i}`).toBeCloseTo(expected[i] ?? Number.NaN, 9);
  });
}

test("dream intensity is (1 - realness) times the strength, from 0 to 1", () => {
  expect(dreamIntensity(1, 1)).toBe(0);
  expect(dreamIntensity(0, 1)).toBe(1);
  expect(dreamIntensity(0.25, 0.5)).toBe(0.375);
  expect(dreamIntensity(0, 2)).toBe(1);
  expect(dreamIntensity(0.3, 0)).toBe(0);
});

test("the toon step snaps brightness to bands (worked separately)", () => {
  // 4 bands with the darkest at 0.2: levels 0.2, 0.4, 0.6, 0.8 and 1.
  expectColor(toonColor([0.5, 0.5, 0.5], TOON), [0.6, 0.6, 0.6]);
  expectColor(toonColor([0.25, 0.25, 0.25], TOON), [0.4, 0.4, 0.4]);
  expectColor(toonColor([0.3, 0.3, 0.3], TOON), [0.4, 0.4, 0.4]);
  // Just under and at a band's start give the same color: no jump there.
  expectColor(toonColor([0.2499999, 0.2499999, 0.2499999], TOON), [0.4, 0.4, 0.4]);
  // Exactly halfway between two bands (2.5 steps) sits halfway between their levels, and just
  // past it (2.52 steps) is still on the soft edge: smoothstep gives 0.84375 of the way up.
  expectColor(toonColor([0.625, 0.625, 0.625], TOON), [0.7, 0.7, 0.7]);
  expectColor(toonColor([0.63, 0.63, 0.63], TOON), [0.76875, 0.76875, 0.76875]);
});

test("the toon step keeps the hue and makes the color livelier (worked separately)", () => {
  expectColor(toonColor([0.5, 0.25, 0.25], TOON), [0.7896091044, 0.2948045522, 0.2948045522]);
  // Out-of-range channels are clipped: pure red, white and black stay as they are.
  expectColor(toonColor([1, 0, 0], TOON), [1, 0, 0]);
  expectColor(toonColor([1, 1, 1], TOON), [1, 1, 1]);
  expectColor(toonColor([0, 0, 0], TOON), [0, 0, 0]);
});

test("the dream color is the wash of the toon color", () => {
  const rgb: Vec3 = [0.7, 0.4, 0.2];
  expect(dreamColor(rgb, 0.6)).toEqual(washColor(toonColor(rgb), 0.6));
  expect(dreamColor(rgb, 0)).toEqual(toonColor(rgb));
});

test("at intensity 0 the wash leaves a color exactly as it was", () => {
  const colors: Vec3[] = [
    [0.8, 0.2, 0.1],
    [0, 0, 0],
    [1, 1, 1],
    [0.123, 0.456, 0.789],
  ];
  for (const rgb of colors) {
    expect(washColor(rgb, 0)).toEqual(rgb);
  }
});

test("at full intensity, saturation drops to its setting (worked by hand)", () => {
  const noPaper: DreamSettings = { ...NONE, saturation: 0.4 };
  // Red: brightness 0.2126; each channel keeps 0.4 of its distance from that.
  expectColor(washColor([1, 0, 0], 1, noPaper), [0.52756, 0.12756, 0.12756]);
  const gray: Vec3 = [0.5, 0.5, 0.5];
  expectColor(washColor(gray, 1, noPaper), gray);
});

test("at full intensity, a color moves paperLift of the way to the paper (worked by hand)", () => {
  const noSaturationLoss: DreamSettings = { ...NONE, paperLift: 0.5 };
  expectColor(washColor([0.5, 0.5, 0.5], 1, noSaturationLoss), [0.73, 0.72, 0.695]);
  expectColor(washColor([0, 0, 0], 1, noSaturationLoss), [0.48, 0.47, 0.445]);
});

test("at full intensity, a color moves tint of the way to the palette (worked by hand)", () => {
  // The palette runs from the pigment (black) to the paper (white) by brightness.
  const fullTint: DreamSettings = { ...NONE, tint: 1 };
  expectColor(washColor([0, 0, 0], 1, fullTint), PIGMENT);
  expectColor(washColor([1, 1, 1], 1, fullTint), PAPER);
  expectColor(washColor([0.5, 0.5, 0.5], 1, fullTint), [0.63, 0.65, 0.725]);
  const halfTint: DreamSettings = { ...NONE, tint: 0.5 };
  expectColor(washColor([0, 0, 0], 1, halfTint), [0.15, 0.18, 0.28]);
});

test("halfway, both effects are halfway (worked by hand)", () => {
  const settings: DreamSettings = { ...NONE, saturation: 0.4, paperLift: 0.5 };
  // keep = 0.7 of the saturation, then a quarter of the way to the paper.
  const red = 0.2126 * 0.3 + 1 * 0.7;
  const other = 0.2126 * 0.3;
  const expected: Vec3 = [
    red * 0.75 + 0.96 * 0.25,
    other * 0.75 + 0.94 * 0.25,
    other * 0.75 + 0.89 * 0.25,
  ];
  expectColor(washColor([1, 0, 0], 0.5, settings), expected);
});

test("taking out saturation keeps a color's brightness", () => {
  const noPalette: DreamSettings = { ...DREAM_SETTINGS, tint: 0, paperLift: 0 };
  const brightness = (rgb: Vec3) => rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
  const rgb: Vec3 = [0.9, 0.3, 0.6];
  expect(brightness(washColor(rgb, 0.8, noPalette))).toBeCloseTo(brightness(rgb), 12);
});

test("settings the shader cannot use are refused", () => {
  expect(() => checkDreamSettings(DREAM_SETTINGS)).not.toThrow();
  const bad: [Partial<DreamSettings>, RegExp][] = [
    [{ bands: 0 }, /bands/],
    [{ bands: 2.5 }, /bands/],
    [{ bands: Number.POSITIVE_INFINITY }, /bands/],
    [{ bandSoftness: 0 }, /bandSoftness/],
    [{ bandSoftness: 0.6 }, /bandSoftness/],
    [{ vivid: -1 }, /vivid/],
    [{ vivid: Number.NaN }, /vivid/],
    [{ shadowFloor: 1.2 }, /0 to 1/],
    [{ saturation: -0.1 }, /0 to 1/],
    [{ tint: 1.5 }, /0 to 1/],
    [{ paperLift: Number.NaN }, /0 to 1/],
    [{ paper: [0.9, 1.2, 0.9] }, /0 to 1/],
    [{ pigment: [-0.1, 0.3, 0.5] }, /0 to 1/],
  ];
  for (const [change, message] of bad) {
    expect(() => checkDreamSettings({ ...DREAM_SETTINGS, ...change })).toThrow(message);
  }
});
