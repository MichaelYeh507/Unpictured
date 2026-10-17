import { describe, expect, test } from "vitest";
import vectors from "../../tests/realness_vectors.json" with { type: "json" };
import { type PhotoCamera, parseCameraFile } from "./camera.ts";
import type { Vec3 } from "./frames.ts";
import {
  cameraRealness,
  checkRealnessInputs,
  REALNESS_SETTINGS,
  type RealnessSettings,
  smoothstep,
} from "./realness.ts";

type VectorCase = (typeof vectors.cases)[number] & {
  settings?: { margin: number; near_ok: number; far_limit: number };
};

/** The case's cameras, read through the same parser as a package's camera.json. */
function casePhotoCameras(names: string[]): PhotoCamera[] {
  const named = vectors.cameras as Record<string, Record<string, unknown>>;
  const cameras = names.map((name) => ({ photo: "source.jpg", match_score: 1, ...named[name] }));
  return parseCameraFile({ frame: "marble_raw_opencv", cameras });
}

function caseSettings(testCase: VectorCase): RealnessSettings {
  const { margin, near_ok, far_limit } = testCase.settings ?? vectors.settings;
  return { margin, nearOk: near_ok, farLimit: far_limit };
}

describe.each(vectors.cases as VectorCase[])("realness: $label", (testCase) => {
  test("matches the shared vectors", () => {
    const [x = 0, y = 0, z = 0] = testCase.point;
    const point: Vec3 = [x, y, z];
    const cameras = casePhotoCameras(testCase.cameras);
    const realness = cameraRealness(point, cameras, testCase.camera_height, caseSettings(testCase));
    expect(realness).toBeCloseTo(testCase.realness, 8);
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
    { margin: 0, nearOk: 3, farLimit: 10 },
    { margin: 0.05, nearOk: -1, farLimit: 10 },
    { margin: 0.05, nearOk: 10, farLimit: 10 },
    { margin: 0.05, nearOk: 3, farLimit: Number.NaN },
    { margin: 0.05, nearOk: 3, farLimit: Number.POSITIVE_INFINITY },
    { margin: Number.POSITIVE_INFINITY, nearOk: 3, farLimit: 10 },
  ];
  for (const settings of bad) {
    expect(() => checkRealnessInputs(1, settings)).toThrow(/margin/);
  }
});
