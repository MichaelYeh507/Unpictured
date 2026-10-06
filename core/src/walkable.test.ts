import { expect, test } from "vitest";
import type { PhotoCamera } from "./camera.ts";
import type { TriangleMesh } from "./collider.ts";
import { placeWorld, toRawFrame, type Vec3, type WorldPlacement } from "./frames.ts";
import { heightBelow, measureWalkableFloor, nearestFloor, WALKER } from "./walkable.ts";

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
  expect(floor.startDistance).toBe(0);
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

test("a world with no floor below or near the photo spot is refused", async () => {
  const elsewhere = rectangle(8, 10, -1, 1, 0);

  await expect(measureWalkableFloor(collider(elsewhere, METRIC), METRIC, [])).rejects.toThrow(
    "no floor below or near the photo spot",
  );
});

/** A square floor `half` units out from the middle, with a square hole `hole` units out. */
function floorWithHole(half: number, hole: number, y: number): Vec3[][] {
  return [
    ...rectangle(-half, half, -half, -hole, y),
    ...rectangle(-half, half, hole, half, y),
    ...rectangle(-half, -hole, -hole, hole, y),
    ...rectangle(hole, half, -hole, hole, y),
  ];
}

test("a hole under the photo spot is measured from the nearest floor", async () => {
  // The photo spot is 1.5 m up and the hole's edge is 1 m away.
  const ground = floorWithHole(5, 1, 0);

  const floor = await measureWalkableFloor(collider(ground, METRIC), METRIC, []);

  expect(floor.startDistance).toBeCloseTo(1, 6);
  expect(floor.cameraHeight).toBeCloseTo(1.5, 6);
  // 9.6 m square less a 2.4 m hole (86.4 m2) once the clearance is taken off; Recast drops up
  // to a voxel more along each edge.
  expect(floor.reachableArea).toBeGreaterThan(82);
  expect(floor.reachableArea).toBeLessThan(87);
  expect(floor.reachableArea).toBeCloseTo(floor.walkableArea, 6);
});

test("a floor counts as near when it is no farther away than twice its depth below", async () => {
  // The photo spot is 1.5 m up, so a floor up to 3 m away counts.
  const near = collider(floorWithHole(6, 2.8, 0), METRIC);
  const far = collider(floorWithHole(6, 3.2, 0), METRIC);

  const floor = await measureWalkableFloor(near, METRIC, []);

  expect(floor.startDistance).toBeCloseTo(2.8, 6);
  await expect(measureWalkableFloor(far, METRIC, [])).rejects.toThrow(
    "no floor below or near the photo spot",
  );
});

test("a stray sliver in the hole is not taken for the floor", async () => {
  // A 10 cm piece 0.45 m away: 0.3 m or 0.9 m down inside a 1 m hole, or 0.9 m down hanging
  // over the ground beside a 0.6 m hole.
  const sliver = (y: number) => rectangle(0.45, 0.55, -0.05, 0.05, y);
  const cases = [
    { ground: [...floorWithHole(5, 1, 0), ...sliver(1.2)], edge: 1 },
    { ground: [...floorWithHole(5, 1, 0), ...sliver(0.6)], edge: 1 },
    { ground: [...floorWithHole(5, 0.6, 0), ...sliver(0.6)], edge: 0.6 },
  ];

  for (const { ground, edge } of cases) {
    const floor = await measureWalkableFloor(collider(ground, METRIC), METRIC, []);

    expect(floor.startDistance).toBeCloseTo(edge, 6);
    expect(floor.cameraHeight).toBeCloseTo(1.5, 6);
  }
});

test("a draft with a hole takes its scale from the nearest floor", async () => {
  // The floor is 1 unit down, so a unit counts as 1.5 m; the hole's edge is 0.5 units away.
  const ground = floorWithHole(4, 0.5, 0.6);

  const floor = await measureWalkableFloor(collider(ground, DRAFT), DRAFT, []);

  expect(floor.metresPerUnit).toBeCloseTo(1.5, 6);
  expect(floor.startDistance).toBeCloseTo(0.75, 6);
});

/** The nearest floor to a point 1.5 up from the middle, among loose triangles. */
function nearestAmong(pieces: Vec3[][]): Vec3 | undefined {
  const triangles = pieces.flat();
  const indices = triangles.map((_, index) => index);
  return nearestFloor(triangles.flat(), indices, [0, 1.5, 0]);
}

test("the nearest floor is walkable and below the point", () => {
  // A 45 degree step down to the floor, too steep to stand on.
  const steepStep: Vec3[][] = [
    [
      [0.8, 0.2, -1],
      [0.8, 0.2, 1],
      [1, 0, 1],
    ],
    [
      [0.8, 0.2, -1],
      [1, 0, 1],
      [1, 0, -1],
    ],
  ];
  const pieces = [
    ...rectangle(0.5, 1, -1, 1, 2), // a ledge above the point
    ...rectangle(0, 0.7, -1, 1, 1.5), // level with the point, so not below it
    ...steepStep,
    ...rectangle(1, 3, -1, 1, 0),
  ];

  const nearest = nearestAmong(pieces);

  expect(nearest?.[0]).toBeCloseTo(1, 6);
  expect(nearest?.[1]).toBeCloseTo(0, 6);
  expect(nearest?.[2]).toBeCloseTo(0, 6);
});

test("only points on a floor's edges count, not on the lines through them", () => {
  // The far piece's edge along x = 0.5 points at the middle, 3 m away.
  const pieces = [...rectangle(0.8, 3, -1, 1, 0), ...rectangle(0.5, 0.9, 3, 4, 0)];

  expect(nearestAmong(pieces)?.[0]).toBeCloseTo(0.8, 6);
});

test("the nearest floor's height is the floor's height at that point", () => {
  // A gentle slope whose nearest edge, along x = 1, rises from 0 to 0.4.
  const slope: Vec3[] = [
    [1, 0, -1],
    [1, 0.4, 1],
    [3, 0, 0],
  ];

  const nearest = nearestFloor(slope.flat(), [0, 1, 2], [0, 1.5, 0]);

  expect(nearest?.[0]).toBeCloseTo(1, 6);
  expect(nearest?.[1]).toBeCloseTo(0.2, 6);
  expect(nearest?.[2]).toBeCloseTo(0, 6);
});

test("the floor below a point is the highest walkable surface under it", () => {
  const stacked = [
    ...rectangle(-1, 1, -1, 1, 0),
    ...rectangle(-1, 1, -1, 1, 0.8),
    ...rectangle(-1, 1, -1, 1, 1.2, false), // a downward-facing fragment: not a floor
    ...rectangle(-1, 1, -1, 1, 2),
  ];
  const triangles = stacked.flat();
  const positions = triangles.flat();
  const indices = triangles.map((_, index) => index);

  expect(heightBelow(positions, indices, [0, 1.5, 0])).toBeCloseTo(0.8, 6);
  expect(heightBelow(positions, indices, [5, 1.5, 0])).toBeUndefined();
});

/** A vertical wall along x = `x`, from `bottom` to `top`, so a raised floor has a side. */
function wall(x: number, z0: number, z1: number, bottom: number, top: number): Vec3[][] {
  const corners: [Vec3, Vec3, Vec3, Vec3] = [
    [x, bottom, z0],
    [x, bottom, z1],
    [x, top, z1],
    [x, top, z0],
  ];
  const [a, b, c, d] = corners;
  return [
    [a, b, c],
    [a, c, d],
  ];
}

test("a person can step up 0.3 m but not 0.4 m", async () => {
  // Recast measures steps in 5 cm voxels, so a step can read up to a voxel lower than it is:
  // 0.32 m still counts as a 0.3 m step.
  const withStep = (height: number) => [
    ...rectangle(-3, 1, -2, 2, 0),
    ...rectangle(1, 3, -2, 2, height),
    ...wall(1, -2, 2, 0, height),
  ];

  const low = await measureWalkableFloor(collider(withStep(0.32), METRIC), METRIC, []);
  const high = await measureWalkableFloor(collider(withStep(0.4), METRIC), METRIC, []);

  expect(low.reachableArea).toBeCloseTo(low.walkableArea, 6);
  expect(high.reachableArea).toBeLessThan(high.walkableArea - 4);
});

test("a large, cluttered floor is searched to the end", async () => {
  // 30 m square with a post every metre: thousands of floor pieces, all connected.
  const posts: Vec3[][] = [];
  for (let x = -14; x <= 14; x++) {
    for (let z = -14; z <= 14; z++) {
      if (x === 0 && z === 0) {
        continue; // keep the floor below the photo spot clear
      }
      posts.push(
        ...wall(x - 0.05, z - 0.05, z + 0.05, 0, 2),
        ...wall(x + 0.05, z - 0.05, z + 0.05, 0, 2),
      );
    }
  }
  const room = [...rectangle(-15, 15, -15, 15, 0), ...posts];

  const floor = await measureWalkableFloor(collider(room, METRIC), METRIC, []);

  expect(floor.walkableArea).toBeGreaterThan(500);
  expect(floor.reachableArea).toBeCloseTo(floor.walkableArea, 6);
});

test("a draft's photo covers the same floor once sizes are estimated", async () => {
  // The photo spot is 1 unit (1.5 m) up: the photo sees 2 by 1.5 units, 3 m by 2.25 m.
  const room = rectangle(-3, 3, -2, 2, 0.6);

  const floor = await measureWalkableFloor(collider(room, DRAFT), DRAFT, [LOOKING_DOWN]);

  expect(floor.picturedArea).toBeGreaterThan(6.75 * 0.85);
  expect(floor.picturedArea).toBeLessThanOrEqual(6.75 + 0.2);
});

test("a photo spot whose floor is too small to stand on is refused", async () => {
  // A 0.3 m square under the camera is narrower than a person; the real floor is far away.
  const room = [...rectangle(-0.15, 0.15, -0.15, 0.15, 0), ...rectangle(8, 12, -2, 2, 0)];

  await expect(measureWalkableFloor(collider(room, METRIC), METRIC, [])).rejects.toThrow(
    "no walkable floor within a metre of where the measurement starts",
  );
});
