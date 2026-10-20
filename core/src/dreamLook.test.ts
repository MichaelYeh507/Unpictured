import { expect, test } from "vitest";
import {
  checkDreamSettings,
  DREAM_SETTINGS,
  type DreamSettings,
  dreamIntensity,
  LUMA,
  washColor,
} from "./dreamLook.ts";
import type { Vec3 } from "./frames.ts";

const PAPER: Vec3 = [0.96, 0.94, 0.89];
const PIGMENT: Vec3 = [0.3, 0.36, 0.56];
/** Only the step a test is about; the others do nothing. */
const NONE: DreamSettings = {
  saturation: 1,
  tint: 0,
  paperLift: 0,
  paper: PAPER,
  pigment: PIGMENT,
};

function expectColor(actual: Vec3, expected: Vec3): void {
  actual.forEach((value, i) => {
    expect(value, `channel ${i}`).toBeCloseTo(expected[i] ?? Number.NaN, 10);
  });
}

test("dream intensity is (1 - realness) times the strength, from 0 to 1", () => {
  expect(dreamIntensity(1, 1)).toBe(0);
  expect(dreamIntensity(0, 1)).toBe(1);
  expect(dreamIntensity(0.25, 0.5)).toBe(0.375);
  expect(dreamIntensity(0, 2)).toBe(1);
  expect(dreamIntensity(0.3, 0)).toBe(0);
});

test("at intensity 0 a color is left exactly as it was", () => {
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

test("at full intensity, a color moves tint of the way to the wash (worked by hand)", () => {
  // The wash runs from the pigment (black) to the paper (white) by brightness.
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
  const noPaper: DreamSettings = { ...DREAM_SETTINGS, tint: 0, paperLift: 0 };
  const brightness = (rgb: Vec3) => rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
  const rgb: Vec3 = [0.9, 0.3, 0.6];
  expect(brightness(washColor(rgb, 0.8, noPaper))).toBeCloseTo(brightness(rgb), 12);
});

test("settings outside 0 to 1 are refused", () => {
  expect(() => checkDreamSettings(DREAM_SETTINGS)).not.toThrow();
  const bad: DreamSettings[] = [
    { ...DREAM_SETTINGS, saturation: -0.1 },
    { ...DREAM_SETTINGS, saturation: Number.NaN },
    { ...DREAM_SETTINGS, paperLift: 1.5 },
    { ...DREAM_SETTINGS, paper: [0.9, 1.2, 0.9] },
    { ...DREAM_SETTINGS, tint: 1.5 },
    { ...DREAM_SETTINGS, pigment: [-0.1, 0.3, 0.5] },
  ];
  for (const settings of bad) {
    expect(() => checkDreamSettings(settings)).toThrow(/0 to 1/);
  }
});
