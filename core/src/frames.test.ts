import { describe, expect, test } from "vitest";
import vectors from "../../tests/frame_vectors.json" with { type: "json" };
import { placeWorld, sourceCameraPosition, toGameFrame, toRawFrame, type Vec3 } from "./frames.ts";

function vec3(values: number[]): Vec3 {
  const [x, y, z] = values;
  if (values.length !== 3 || x === undefined || y === undefined || z === undefined) {
    throw new Error(`expected 3 numbers, got ${values.length}`);
  }
  return [x, y, z];
}

function expectClose(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value, 9);
  });
}

describe.each(vectors.cases)("$name", (vector) => {
  const placement = placeWorld({
    frame: vector.meta.frame,
    metricScaleFactor: vector.meta.metric_scale_factor,
    groundPlaneOffset: vector.meta.ground_plane_offset,
  });

  test("placement", () => {
    expect(placement.scale).toBeCloseTo(vector.placement.scale, 9);
    expectClose(placement.quaternion, vector.placement.quaternion);
    expectClose(placement.position, vector.placement.position);
    expect(placement.metric).toBe(vector.placement.metric);
  });

  test.each(vector.points)("$label", ({ raw, game }) => {
    expectClose(toGameFrame(vec3(raw), placement), game);
  });

  test.each(vector.points)("$label, back to raw", ({ raw, game }) => {
    expectClose(toRawFrame(vec3(game), placement), raw);
  });
});

test("the source camera starts at the placement's position", () => {
  const placement = placeWorld({
    frame: "marble_raw_opencv",
    metricScaleFactor: 2,
    groundPlaneOffset: 0.9,
  });

  expectClose(sourceCameraPosition(placement), [0, 0.9, 0]);
});

test("an unknown frame is refused", () => {
  const meta = { frame: "some_other_frame", metricScaleFactor: 1, groundPlaneOffset: 0 };

  expect(() => placeWorld(meta)).toThrow('Unknown splat frame "some_other_frame"');
});
