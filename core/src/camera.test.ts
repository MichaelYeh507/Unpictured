import { describe, expect, test } from "vitest";
import vectors from "../../tests/camera_vectors.json" with { type: "json" };
import {
  type PhotoCamera,
  parseCameraFile,
  photoFrameCenter,
  photoFrameCorners,
  rotateCameraRay,
} from "./camera.ts";
import type { Vec3 } from "./frames.ts";

function vec3(values: number[]): Vec3 {
  const [x, y, z] = values;
  if (values.length !== 3 || x === undefined || y === undefined || z === undefined) {
    throw new Error(`expected 3 numbers, got ${values.length}`);
  }
  return [x, y, z];
}

function expectClose(actual: Vec3, expected: Vec3): void {
  actual.forEach((value, axis) => {
    expect(value).toBeCloseTo(expected[axis] ?? Number.NaN, 6);
  });
}

/** A 4 x 3 photo seen 90 degrees wide: at depth 1 its corners are 1 across and 0.75 up or down. */
function camera(change: Partial<PhotoCamera> = {}): PhotoCamera {
  return {
    photo: "source.jpg",
    position: [0, 0, 0],
    yawDeg: 0,
    pitchDeg: 0,
    imageSize: [4, 3],
    fx: 2,
    fy: 2,
    cx: 2,
    cy: 1.5,
    matchScore: 0.9,
    ...change,
  };
}

describe.each(vectors.cases)("camera ray: $label", ({ yaw, pitch, ray, raw }) => {
  test("turns as the shared vectors say", () => {
    expectClose(rotateCameraRay(yaw, pitch, vec3(ray)), vec3(raw));
  });
});

test("a level camera's frame corners", () => {
  const corners = photoFrameCorners(camera(), 1);

  expect(corners).toHaveLength(4);
  [
    [-1, -0.75, 1],
    [1, -0.75, 1],
    [1, 0.75, 1],
    [-1, 0.75, 1],
  ].forEach((expected, index) => {
    expectClose(corners[index] ?? [Number.NaN, 0, 0], vec3(expected));
  });
});

test("a camera turned right sees a frame on its right, at twice the depth", () => {
  const [topLeft, topRight] = photoFrameCorners(camera({ yawDeg: 90 }), 2);

  expectClose(topLeft ?? [Number.NaN, 0, 0], [2, -1.5, 2]);
  expectClose(topRight ?? [Number.NaN, 0, 0], [2, -1.5, -2]);
  expectClose(photoFrameCenter(camera({ yawDeg: 90 }), 2), [2, 0, 0]);
});

test("the frame moves with the camera's position", () => {
  expectClose(photoFrameCenter(camera({ position: [0.5, -1, 2] }), 1), [0.5, -1, 3]);
});

/** The shape `locate` writes, shortened. */
function cameraFile(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "provisional-m0",
    frame: "marble_raw_opencv",
    cameras: [
      {
        photo: "source_1.jpg",
        position: [0, 0, 0],
        yaw_deg: 0,
        pitch_deg: -10.75,
        hfov_deg: 91.75,
        image_size: [4032, 3024],
        fx: 1950.53,
        fy: 1950.53,
        cx: 2016,
        cy: 1512,
        match_score: 0.865,
        ...change,
      },
    ],
  };
}

test("reads camera.json", () => {
  const [first] = parseCameraFile(cameraFile());

  expect(first).toEqual({
    photo: "source_1.jpg",
    position: [0, 0, 0],
    yawDeg: 0,
    pitchDeg: -10.75,
    imageSize: [4032, 3024],
    fx: 1950.53,
    fy: 1950.53,
    cx: 2016,
    cy: 1512,
    matchScore: 0.865,
  });
});

test.each([
  ["a path for the photo", { photo: "../secret.jpg" }, "not a plain file name"],
  ["a missing angle", { yaw_deg: undefined }, "yaw_deg must be a number"],
  ["an angle given as text", { pitch_deg: "-10" }, "pitch_deg must be a number"],
  ["a short position", { position: [0, 0] }, "position must be 3 numbers"],
  ["a zero focal length", { fx: 0 }, "positive image size and focal length"],
  ["a negative image width", { image_size: [-4032, 3024] }, "positive image size"],
])("refuses %s", (_label, change, message) => {
  expect(() => parseCameraFile(cameraFile(change))).toThrow(message);
});

test("refuses another frame", () => {
  expect(() => parseCameraFile({ ...cameraFile(), frame: "opengl" })).toThrow("frame must be");
});
