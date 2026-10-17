import { expect, test } from "vitest";
import type { TriangleMesh } from "./collider.ts";
import { photoSpotHeight } from "./floor.ts";
import { type FrameMetadata, placeWorld } from "./frames.ts";

const METRIC: FrameMetadata = {
  frame: "marble_raw_opencv",
  metricScaleFactor: 2,
  groundPlaneOffset: 2.4,
};
const DRAFT: FrameMetadata = {
  frame: "marble_raw_opencv",
  metricScaleFactor: null,
  groundPlaneOffset: null,
};

/** A flat floor patch `depth` below the photo spot in the raw frame (y down), facing up, from
 * x = fromX to toX and z = -5 to 5. */
function floorPatch(depth: number, fromX: number, toX: number): TriangleMesh {
  // Wound so that (b - a) x (c - a) points toward raw -y, which is up.
  const corners = [
    [fromX, depth, -5],
    [toX, depth, -5],
    [toX, depth, 5],
    [fromX, depth, 5],
  ];
  return {
    positions: new Float32Array(corners.flat()),
    indices: new Uint32Array([0, 2, 3, 0, 1, 2]),
  };
}

test("the photo spot's height is in raw units, whatever the world's scale", () => {
  const collider = floorPatch(1.2, -5, 5);
  expect(photoSpotHeight(collider, placeWorld(METRIC))).toBeCloseTo(1.2, 6);
  expect(photoSpotHeight(collider, placeWorld(DRAFT))).toBeCloseTo(1.2, 6);
});

test("with a hole under the photo spot, the height comes from the floor beside it", () => {
  const collider = floorPatch(1, 0.5, 5);
  expect(photoSpotHeight(collider, placeWorld(METRIC))).toBeCloseTo(1, 6);
});

test("without a floor below or near the photo spot there is no height", () => {
  expect(photoSpotHeight(floorPatch(1, 50, 60), placeWorld(METRIC))).toBeUndefined();
});
