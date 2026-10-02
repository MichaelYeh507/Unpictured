import { expect, test } from "vitest";
import type { PhotoCamera } from "./camera.ts";
import type { TriangleMesh } from "./collider.ts";
import { placeWorld, toRawFrame, type Vec3, type WorldPlacement } from "./frames.ts";
import { heightBelow, measureWalkableFloor, WALKER } from "./walkable.ts";

/** A metric world whose photo spot is 1.5 m above the floor at y = 0. */
const METRIC = placeWorld({
  frame: "marble_raw_opencv",
  metricScaleFactor: 1,
  groundPlaneOffset: 1.5,
});
/** A draft: no scale, photo spot at the stand-in height of 1.6 units. */
const DRAFT = placeWorld({
  frame: "marble_raw_opencv",
  metricScaleFactor: null,
  groundPlaneOffset: null,
});

/** A level rectangle in the game frame, facing up (or down, for a ceiling). */
function rectangle(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y: number,
  facingUp = true,
): Vec3[][] {
  const corners: [Vec3, Vec3, Vec3, Vec3] = [
    [x0, y, z0],
    [x0, y, z1],
    [x1, y, z1],
    [x1, y, z0],
  ];
  const [a, b, c, d] = corners;
  return facingUp
    ? [
        [a, b, c],
        [a, c, d],
      ]
    : [
        [a, c, b],
        [a, d, c],
      ];
}

/** Triangles given in the game frame, stored the way a collider is: in the raw frame. */
function collider(triangles: Vec3[][], placement: WorldPlacement): TriangleMesh {
  const positions = triangles.flat().flatMap((point) => toRawFrame(point, placement));
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(positions.map((_, index) => index).slice(0, positions.length / 3)),
  };
}

/** A 400 x 300 photo, 90 degrees wide, looking straight down from the photo spot. */
const LOOKING_DOWN: PhotoCamera = {
  photo: "source.jpg",
  position: [0, 0, 0],
  yawDeg: 0,
  pitchDeg: -90,
  imageSize: [400, 300],
  fx: 200,
  fy: 200,
  cx: 200,
  cy: 150,
  matchScore: 1,
};

/**
 * A width x depth floor less WALKER.radius of clearance at every edge. Recast can drop about
 * one more 5 cm voxel at an edge that does not line up with its grid, so allow that much less.
 */
function expectFloorArea(actual: number, width: number, depth: number): void {
  const clearWidth = width - 2 * WALKER.radius;
  const clearDepth = depth - 2 * WALKER.radius;
  const ideal = clearWidth * clearDepth;
  expect(actual).toBeLessThanOrEqual(ideal + 0.2);
  expect(actual).toBeGreaterThanOrEqual(ideal - 2 * (clearWidth + clearDepth) * 0.075);
}

test("measures the reachable floor and how much of it the photo saw", async () => {
  const room = [...rectangle(-3, 3, -2, 2, 0), ...rectangle(8, 10, -1, 1, 0)];

  const floor = await measureWalkableFloor(collider(room, METRIC), METRIC, [LOOKING_DOWN]);

  expect(floor.estimated).toBe(false);
  expect(floor.cameraHeight).toBeCloseTo(1.5, 3);
  expectFloorArea(floor.reachableArea, 6, 4);
  expectFloorArea(floor.walkableArea - floor.reachableArea, 2, 2); // the patch out of reach
  // From 1.5 m up, a 90 degree, 4:3 photo sees 3 m by 2.25 m (6.75 m2) of floor. Recast's
  // walking surface sits about a voxel above the floor, which shrinks that a little.
  expect(floor.picturedArea).toBeGreaterThan(6.75 * 0.85);
  expect(floor.picturedArea).toBeLessThanOrEqual(6.75 + 0.2);
  expect(floor.unpicturedArea).toBeCloseTo(floor.reachableArea - floor.picturedArea, 6);
  // The far corner of the room, 2.8 m by 1.8 m away once the clearance is taken off.
  expect(floor.farthest).toBeGreaterThan(3.1);
  expect(floor.farthest).toBeLessThan(3.4);
});

test("floor without headroom for a person is not walkable", async () => {
  const lowCeiling = rectangle(1, 3, -2, 2, 1.2, false);
  const room = [...rectangle(-3, 3, -2, 2, 0), ...lowCeiling];

  const floor = await measureWalkableFloor(collider(room, METRIC), METRIC, []);

  // Only the 4 m by 4 m from x = -3 to x = 1 is left.
  expectFloorArea(floor.reachableArea, 4, 4);
  expect(floor.picturedArea).toBe(0);
});

test("a draft's sizes come from the assumed camera height", async () => {
  // The floor is 1 unit below the photo spot, so a unit counts as 1.5 m.
  const room = rectangle(-3, 3, -2, 2, 0.6);

  const floor = await measureWalkableFloor(collider(room, DRAFT), DRAFT, []);

  expect(floor.estimated).toBe(true);
  expect(floor.metresPerUnit).toBeCloseTo(1.5, 6);
  expect(floor.cameraHeight).toBeCloseTo(1.5, 6);
  expectFloorArea(floor.reachableArea, 9, 6);
});

test("a world with no floor under the photo spot is refused", async () => {
  const elsewhere = rectangle(8, 10, -1, 1, 0);

  await expect(measureWalkableFloor(collider(elsewhere, METRIC), METRIC, [])).rejects.toThrow(
    "no floor below the photo spot",
  );
});

test("the floor below a point is the highest surface under it", () => {
  const stacked = [
    ...rectangle(-1, 1, -1, 1, 0),
    ...rectangle(-1, 1, -1, 1, 0.8),
    ...rectangle(-1, 1, -1, 1, 2),
  ];
  const mesh = collider(stacked, METRIC);
  const positions = Array.from({ length: mesh.positions.length / 3 }, (_, index) =>
    Array.from(mesh.positions.slice(index * 3, index * 3 + 3)),
  ).flatMap((point) => [point[0] ?? 0, -(point[1] ?? 0) + 1.5, -(point[2] ?? 0)]);

  expect(heightBelow(positions, mesh.indices, [0, 1.5, 0])).toBeCloseTo(0.8, 6);
  expect(heightBelow(positions, mesh.indices, [5, 1.5, 0])).toBeUndefined();
});
