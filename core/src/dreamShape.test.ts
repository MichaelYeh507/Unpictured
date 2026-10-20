import { expect, test } from "vitest";
import {
  checkDreamShapeSettings,
  DREAM_SHAPE_SETTINGS,
  DRIFT_LOOP_PERIODS,
  DRIFT_RATES,
  type DreamShapeSettings,
  dreamDepth,
  dreamShape,
  floorFreedom,
  pcgHash,
  type SplatShape,
  splatRandoms,
} from "./dreamShape.ts";
import type { Vec3 } from "./frames.ts";

/** The settings the worked cases use, whatever the defaults become. */
const WORKED: DreamShapeSettings = {
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
const HEIGHT = 1.5;

function expectVec(actual: Vec3, expected: Vec3, digits = 9): void {
  actual.forEach((value, i) => {
    expect(value, `axis ${i}`).toBeCloseTo(expected[i] ?? Number.NaN, digits);
  });
}

function driftOf(splat: SplatShape, shaped: SplatShape): number {
  return Math.hypot(...shaped.center.map((value, i) => value - (splat.center[i] ?? 0)));
}

/** Drift at 200 moments across one whole loop. */
function drifts(splat: SplatShape, index: number, intensity: number): number[] {
  const loop = DRIFT_LOOP_PERIODS * WORKED.period;
  return Array.from({ length: 200 }, (_, step) =>
    driftOf(splat, dreamShape(splat, index, intensity, (step / 200) * loop, HEIGHT, WORKED)),
  );
}

// The worked cases come from an independent Python calculation of the documented formula.
test("the PCG hash and the per-splat random numbers match worked values", () => {
  expect(pcgHash(0)).toBe(129708002);
  expect(pcgHash(1)).toBe(2831084092);
  expect(pcgHash(123456)).toBe(2257990255);
  expectVec(splatRandoms(42), [0.28497618436813354, 0.6485052108764648, 0.932361364364624], 15);
});

test("a splat partly dreamed in the middle distance swells and breathes a little", () => {
  const splat: SplatShape = { center: [6, -1.2, 9], scales: [0.02, 0.03, 0.01], opacity: 0.8 };
  const shaped = dreamShape(splat, 42, 0.9, 2.5, HEIGHT, WORKED);
  expect(dreamDepth(0.9, splat.center, HEIGHT, WORKED)).toBeCloseTo(0.11949167268310293, 12);
  expectVec(shaped.center, [5.985819560417069, -1.2074066604072313, 8.984906462187398]);
  expectVec(shaped.scales, [0.0236, 0.0354, 0.0118]);
  expect(shaped.opacity).toBeCloseTo(0.8, 12); // not dissolving yet
});

test("a fully dreamed splat far away drifts its widest and dissolves to dust", () => {
  const splat: SplatShape = { center: [30, 0.5, -28], scales: [0.05, 0.05, 0.02], opacity: 1 };
  const shaped = dreamShape(splat, 7, 1, 17.25, HEIGHT, WORKED);
  expectVec(shaped.center, [29.974665211728045, 0.6297054479527929, -27.944043860752355]);
  expectVec(shaped.scales, [0.03, 0.03, 0.012]); // swollen 1.2, then dust 0.5
  expect(shaped.opacity).toBeCloseTo(0.6, 12);
  const all = drifts(splat, 7, 1);
  const reach = WORKED.drift * HEIGHT;
  expect(Math.max(...all)).toBeLessThanOrEqual(reach + 1e-12);
  expect(Math.max(...all)).toBeGreaterThan(0.6 * reach); // it does use its reach
});

test("a floor splat far away and partly dissolved is held to the floor drift", () => {
  const splat: SplatShape = { center: [-20, 1.45, 35], scales: [0.04, 0.01, 0.04], opacity: 0.9 };
  const shaped = dreamShape(splat, 99999, 0.85, 9, HEIGHT, WORKED);
  expectVec(shaped.center, [-19.99079891384978, 1.456423197236414, 35.006284795338395]);
  expectVec(shaped.scales, [0.03080390625, 0.0077009765625, 0.03080390625]);
  expect(shaped.opacity).toBeCloseTo(0.65390625, 12);
  // Fully dreamed, it still never leaves the floor by more than the floor drift.
  expect(Math.max(...drifts(splat, 99999, 1))).toBeLessThanOrEqual(WORKED.floorDrift * HEIGHT);
});

test("floors hold still, and a splat a little above them drifts more", () => {
  const index = 5;
  const floorReach = WORKED.floorDrift * HEIGHT;
  // The floor under the photo spot is at raw y = HEIGHT (y points down); also under it.
  for (const y of [HEIGHT, HEIGHT - 0.1 * HEIGHT, HEIGHT + 0.3]) {
    const floor: SplatShape = { center: [25, y, 30], scales: [0.01, 0.01, 0.01], opacity: 1 };
    expect(Math.max(...drifts(floor, index, 1)), `y ${y}`).toBeLessThanOrEqual(floorReach);
  }
  const raised: SplatShape = {
    center: [25, HEIGHT - 0.3 * HEIGHT, 30],
    scales: [1, 1, 1],
    opacity: 1,
  };
  expect(Math.max(...drifts(raised, index, 1))).toBeGreaterThan(5 * floorReach);
});

test("floor freedom ramps softly from the floor to the free height", () => {
  const at = (height: number): Vec3 => [0, (1 - height) * HEIGHT, 0];
  expect(floorFreedom(at(0), HEIGHT, WORKED)).toBe(0);
  expect(floorFreedom(at(0.1), HEIGHT, WORKED)).toBeCloseTo(0, 12);
  expect(floorFreedom(at(0.15), HEIGHT, WORKED)).toBeCloseTo(7 / 27, 12); // off the middle
  expect(floorFreedom(at(0.25), HEIGHT, WORKED)).toBeCloseTo(1, 12);
  expect(floorFreedom(at(1), HEIGHT, WORKED)).toBe(1); // the photo spot itself
});

test("dream depth grows with distance from the photo spot, scaled by intensity", () => {
  const out = (cameraHeights: number): Vec3 => [0, 0, cameraHeights * HEIGHT];
  expect(dreamDepth(1, out(1), HEIGHT, WORKED)).toBe(0);
  expect(dreamDepth(1, out(2), HEIGHT, WORKED)).toBe(0);
  const x = 6 / 23; // 8 camera heights, off the middle of the ramp
  expect(dreamDepth(1, out(8), HEIGHT, WORKED)).toBeCloseTo(x * x * (3 - 2 * x), 12);
  expect(dreamDepth(0.5, out(8), HEIGHT, WORKED)).toBeCloseTo(0.5 * x * x * (3 - 2 * x), 12);
  expect(dreamDepth(1, out(25), HEIGHT, WORKED)).toBe(1);
  expect(dreamDepth(0.7, out(40), HEIGHT, WORKED)).toBeCloseTo(0.7, 12);
});

test("near the photo spot a dreamed splat only swells: no drift, no dissolving", () => {
  const splat: SplatShape = { center: [-1, 0.5, 2], scales: [0.1, 0.2, 0.3], opacity: 0.7 };
  for (const seconds of [0, 1.7, 13]) {
    const shaped = dreamShape(splat, 3, 1, seconds, HEIGHT, WORKED);
    expectVec(shaped.center, splat.center, 15);
    expectVec(shaped.scales, [0.12, 0.24, 0.36]);
    expect(shaped.opacity).toBe(0.7);
  }
});

test("a real splat (intensity 0) keeps its shape anywhere, at any time", () => {
  const splat: SplatShape = { center: [40, -3, 40], scales: [0.1, 0.2, 0.3], opacity: 0.5 };
  for (const seconds of [0, 4.2, 20]) {
    const shaped = dreamShape(splat, 11, 0, seconds, HEIGHT, WORKED);
    expectVec(shaped.center, splat.center, 15);
    expectVec(shaped.scales, splat.scales, 15);
    expect(shaped.opacity).toBe(0.5);
  }
});

test("the drift starts over after DRIFT_LOOP_PERIODS periods, and not before", () => {
  const splat: SplatShape = { center: [20, -2, 25], scales: [0.1, 0.1, 0.1], opacity: 1 };
  const loop = DRIFT_LOOP_PERIODS * WORKED.period;
  const at = (seconds: number) => dreamShape(splat, 21, 0.8, seconds, HEIGHT, WORKED).center;
  expectVec(at(3.3 + loop), at(3.3));
  for (const rate of DRIFT_RATES) {
    expect(Number.isInteger(rate * DRIFT_LOOP_PERIODS), `rate ${rate}`).toBe(true);
  }
  // No shorter whole number of periods brings it back.
  for (let periods = 1; periods < DRIFT_LOOP_PERIODS; periods++) {
    const later = at(3.3 + periods * WORKED.period);
    expect(Math.hypot(...later.map((v, i) => v - (at(3.3)[i] ?? 0))), `${periods}`).toBeGreaterThan(
      1e-3,
    );
  }
});

test("the defaults are valid, and bad settings are refused", () => {
  expect(() => checkDreamShapeSettings(DREAM_SHAPE_SETTINGS)).not.toThrow();
  const bad: Partial<DreamShapeSettings>[] = [
    { swell: Number.NaN },
    { drift: Number.POSITIVE_INFINITY },
    { swell: 0 },
    { period: 0 },
    { waveLength: -1 },
    { drift: -0.1 },
    { floorDrift: -0.1 },
    { depthNear: -1 },
    { depthFar: 2 }, // equal to depthNear
    { floorFree: 0.1 }, // equal to floorHold
    { dissolveFrom: 1 },
    { dissolveFrom: -0.1 },
    { dustSize: 1.5 },
    { dustOpacity: -0.2 },
  ];
  for (const change of bad) {
    expect(() => checkDreamShapeSettings({ ...WORKED, ...change }), JSON.stringify(change)).toThrow(
      /dream shape/,
    );
  }
});
