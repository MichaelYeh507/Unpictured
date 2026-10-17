import { describe, expect, test } from "vitest";
import vectors from "../../tests/realness_vectors.json" with { type: "json" };
import { type PhotoCamera, parseCameraFile } from "./camera.ts";
import type { Vec3 } from "./frames.ts";
import {
  cameraRealness,
  checkLights,
  checkRealnessInputs,
  MAX_LIGHTS,
  type MemoryLight,
  REALNESS_SETTINGS,
  type RealnessSettings,
  realness,
  smoothstep,
} from "./realness.ts";

type VectorSettings = { margin: number; near_ok: number; far_limit: number; light_core: number };
type VectorCase = (typeof vectors.cases)[number] & {
  settings?: VectorSettings;
  lights?: { position: number[]; radius: number }[];
};

/** The case's cameras, read through the same parser as a package's camera.json. */
function casePhotoCameras(names: string[]): PhotoCamera[] {
  const named = vectors.cameras as Record<string, Record<string, unknown>>;
  const cameras = names.map((name) => ({ photo: "source.jpg", match_score: 1, ...named[name] }));
  return parseCameraFile({ frame: "marble_raw_opencv", cameras });
}

function caseSettings(testCase: VectorCase): RealnessSettings {
  const { margin, near_ok, far_limit, light_core } = testCase.settings ?? vectors.settings;
  return { margin, nearOk: near_ok, farLimit: far_limit, lightCore: light_core };
}

function caseLights(testCase: VectorCase): MemoryLight[] {
  return (testCase.lights ?? []).map(({ position: [x = 0, y = 0, z = 0], radius }) => ({
    position: [x, y, z],
    radius,
  }));
}

describe.each(vectors.cases as VectorCase[])("realness: $label", (testCase) => {
  test("matches the shared vectors", () => {
    const [x = 0, y = 0, z = 0] = testCase.point;
    const point: Vec3 = [x, y, z];
    const cameras = casePhotoCameras(testCase.cameras);
    const lights = caseLights(testCase);
    const value = realness(point, cameras, testCase.camera_height, lights, caseSettings(testCase));
    expect(value).toBeCloseTo(testCase.realness, 8);
  });
});

test("a world without photos is imagined everywhere", () => {
  expect(cameraRealness([0, 0, 1], [], 1)).toBe(0);
});

test("smoothstep follows GLSL: clamped, with zero slope at both edges", () => {
  expect(smoothstep(2, 6, 1)).toBe(0);
  expect(smoothstep(2, 6, 4)).toBe(0.5);
  expect(smoothstep(2, 6, 7)).toBe(1);
  expect(smoothstep(-0.1, 0.1, -0.05)).toBeCloseTo(0.15625, 12);
});

test("inputs the shader cannot handle are refused", () => {
  expect(() => checkRealnessInputs(1, REALNESS_SETTINGS)).not.toThrow();
  expect(() => checkRealnessInputs(0, REALNESS_SETTINGS)).toThrow(/camera height/);
  expect(() => checkRealnessInputs(Number.NaN, REALNESS_SETTINGS)).toThrow(/camera height/);
  expect(() => checkRealnessInputs(Number.POSITIVE_INFINITY, REALNESS_SETTINGS)).toThrow(
    /camera height/,
  );
  const bad: RealnessSettings[] = [
    { ...REALNESS_SETTINGS, margin: 0 },
    { ...REALNESS_SETTINGS, nearOk: -1 },
    { ...REALNESS_SETTINGS, nearOk: 10, farLimit: 10 },
    { ...REALNESS_SETTINGS, farLimit: Number.NaN },
    { ...REALNESS_SETTINGS, farLimit: Number.POSITIVE_INFINITY },
    { ...REALNESS_SETTINGS, margin: Number.POSITIVE_INFINITY },
  ];
  for (const settings of bad) {
    expect(() => checkRealnessInputs(1, settings)).toThrow(/margin/);
  }
  for (const lightCore of [-0.1, 1, Number.NaN]) {
    expect(() => checkRealnessInputs(1, { ...REALNESS_SETTINGS, lightCore })).toThrow(/lightCore/);
  }
});

test("lights the shader cannot hold are refused", () => {
  const light: MemoryLight = { position: [0, 0, 1], radius: 1 };
  expect(() => checkLights(Array(MAX_LIGHTS).fill(light), REALNESS_SETTINGS)).not.toThrow();
  expect(() => checkLights(Array(MAX_LIGHTS + 1).fill(light), REALNESS_SETTINGS)).toThrow(
    /at most/,
  );
  const badLights: MemoryLight[] = [
    { position: [0, 0, 1], radius: 0 },
    { position: [0, 0, 1], radius: Number.POSITIVE_INFINITY },
    { position: [0, Number.NaN, 1], radius: 1 },
  ];
  for (const bad of badLights) {
    expect(() => checkLights([bad], REALNESS_SETTINGS)).toThrow(/finite/);
  }
});

test("without lights, realness is what the photos saw", () => {
  const cameras = casePhotoCameras(["ahead"]);
  const settings = caseSettings(vectors.cases[0] as VectorCase);
  expect(realness([0, 0, 3], cameras, 1, [], settings)).toBe(
    cameraRealness([0, 0, 3], cameras, 1, settings),
  );
});
