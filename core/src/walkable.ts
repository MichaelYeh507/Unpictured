/**
 * Where a person can walk in a world, and how much of that floor the photos saw. Uses Recast
 * (recast-navigation-js), so it is a separate entry point that the viewer loads only on demand.
 */

import { getNavMeshPositionsAndIndices, init, NavMeshQuery } from "@recast-navigation/core";
import { generateSoloNavMesh } from "@recast-navigation/generators";
import { isInPhoto, type PhotoCamera } from "./camera.ts";
import type { TriangleMesh } from "./collider.ts";
import {
  sourceCameraPosition,
  toGameFrame,
  toRawFrame,
  type Vec3,
  type WorldPlacement,
} from "./frames.ts";

/** A person-sized walker, in metres and degrees. */
export const WALKER = { height: 1.6, stepHeight: 0.3, radius: 0.2, maxSlopeDeg: 40 };
/** Drafts have no scale, so assume the photo was taken this many metres above the floor. */
export const ASSUMED_CAMERA_HEIGHT = 1.5;
const VOXEL = 0.05; // metres per side of Recast's voxels
const CELL = 0.1; // metres per side of the grid the floor is measured and drawn on

export interface FloorCell {
  /** The middle of the cell, on the floor, in the game frame. */
  center: Vec3;
  /** Connected to the floor below the photo spot. */
  reachable: boolean;
  /** Inside at least one photo's frame (what furniture hides is not considered). */
  pictured: boolean;
}

export interface WalkableFloor {
  cells: FloorCell[];
  /** The side of a cell in game units. */
  cellSize: number;
  metresPerUnit: number;
  /** True when the world has no scale and sizes come from ASSUMED_CAMERA_HEIGHT. */
  estimated: boolean;
  /** Metres from the floor up to the photo spot. */
  cameraHeight: number;
  /** Square metres. */
  walkableArea: number;
  reachableArea: number;
  picturedArea: number;
  unpicturedArea: number;
  /** Metres along the floor from below the photo spot to the farthest reachable cell. */
  farthest: number;
}

let recastReady: Promise<void> | undefined;

export async function measureWalkableFloor(
  collider: TriangleMesh,
  placement: WorldPlacement,
  cameras: PhotoCamera[],
): Promise<WalkableFloor> {
  recastReady ??= init();
  await recastReady;
  const positions = new Float32Array(collider.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const point = vertex(collider.positions, i / 3);
    positions.set(toGameFrame(point, placement), i);
  }
  const photoSpot = sourceCameraPosition(placement);
  const floorY = heightBelow(positions, collider.indices, photoSpot);
  if (floorY === undefined) {
    throw new Error("the collider has no floor below the photo spot");
  }
  const heightInUnits = photoSpot[1] - floorY;
  const metresPerUnit = placement.metric ? 1 : ASSUMED_CAMERA_HEIGHT / heightInUnits;

  // Recast's walker sizes are in voxels, so they do not depend on the world's units.
  const built = generateSoloNavMesh(positions, collider.indices, {
    cs: VOXEL / metresPerUnit,
    ch: VOXEL / metresPerUnit,
    walkableHeight: Math.ceil(WALKER.height / VOXEL),
    walkableClimb: Math.floor(WALKER.stepHeight / VOXEL),
    walkableRadius: Math.ceil(WALKER.radius / VOXEL),
    walkableSlopeAngle: WALKER.maxSlopeDeg,
  });
  if (!built.success) {
    throw new Error(`could not work out the walkable floor: ${built.error}`);
  }
  const query = new NavMeshQuery(built.navMesh);
  try {
    const reachable = reachablePolygons(query, [photoSpot[0], floorY, photoSpot[2]], metresPerUnit);
    const cells = floorCells(built.navMesh, query, reachable, metresPerUnit, (point) =>
      cameras.some((camera) => isInPhoto(camera, toRawFrame(point, placement))),
    );
    return summarize(cells, photoSpot, metresPerUnit, !placement.metric, heightInUnits);
  } finally {
    query.destroy();
    built.navMesh.destroy();
  }
}

/** Every polygon connected to the one under the photo spot. */
function reachablePolygons(
  query: NavMeshQuery,
  floorPoint: Vec3,
  metresPerUnit: number,
): Set<number> {
  const [x, y, z] = floorPoint;
  const extent = 1 / metresPerUnit; // search a metre around the spot
  const start = query.findNearestPoly(
    { x, y, z },
    { halfExtents: { x: extent, y: extent / 2, z: extent } },
  );
  const reachable = new Set<number>();
  if (!start.success || start.nearestRef === 0) {
    return reachable;
  }
  const around = query.findPolysAroundCircle(start.nearestRef, start.nearestPoint, 1e6, {
    maxPolys: 65536,
  });
  for (let index = 0; index < around.resultCount; index++) {
    reachable.add(around.resultRefs[index] ?? 0);
  }
  return reachable;
}

/** The walkable floor on a grid of CELL-sized squares, one cell per grid point inside it. */
function floorCells(
  navMesh: Parameters<typeof getNavMeshPositionsAndIndices>[0],
  query: NavMeshQuery,
  reachable: Set<number>,
  metresPerUnit: number,
  isPictured: (point: Vec3) => boolean,
): FloorCell[] {
  const [navPositions, navIndices] = getNavMeshPositionsAndIndices(navMesh);
  const cell = CELL / metresPerUnit;
  const cells: FloorCell[] = [];
  for (let i = 0; i < navIndices.length; i += 3) {
    const a = vertex(navPositions, navIndices[i] ?? 0);
    const b = vertex(navPositions, navIndices[i + 1] ?? 0);
    const c = vertex(navPositions, navIndices[i + 2] ?? 0);
    const middle = {
      x: (a[0] + b[0] + c[0]) / 3,
      y: (a[1] + b[1] + c[1]) / 3,
      z: (a[2] + b[2] + c[2]) / 3,
    };
    const owner = query.findNearestPoly(middle, { halfExtents: { x: cell, y: cell, z: cell } });
    const isReachable = reachable.has(owner.nearestRef);
    const [firstX, lastX] = gridRange(Math.min(a[0], b[0], c[0]), Math.max(a[0], b[0], c[0]), cell);
    const [firstZ, lastZ] = gridRange(Math.min(a[2], b[2], c[2]), Math.max(a[2], b[2], c[2]), cell);
    for (let gx = firstX; gx <= lastX; gx++) {
      for (let gz = firstZ; gz <= lastZ; gz++) {
        const x = (gx + 0.5) * cell;
        const z = (gz + 0.5) * cell;
        const y = heightInTriangle(a, b, c, x, z);
        if (y !== undefined) {
          const center: Vec3 = [x, y, z];
          cells.push({
            center,
            reachable: isReachable,
            pictured: isReachable && isPictured(center),
          });
        }
      }
    }
  }
  return cells;
}

function summarize(
  cells: FloorCell[],
  photoSpot: Vec3,
  metresPerUnit: number,
  estimated: boolean,
  heightInUnits: number,
): WalkableFloor {
  const cellArea = CELL * CELL;
  let reachableCount = 0;
  let picturedCount = 0;
  let farthest = 0;
  for (const { center, reachable, pictured } of cells) {
    if (!reachable) {
      continue;
    }
    reachableCount++;
    picturedCount += pictured ? 1 : 0;
    const across = Math.hypot(center[0] - photoSpot[0], center[2] - photoSpot[2]) * metresPerUnit;
    farthest = Math.max(farthest, across);
  }
  return {
    cells,
    cellSize: CELL / metresPerUnit,
    metresPerUnit,
    estimated,
    cameraHeight: heightInUnits * metresPerUnit,
    walkableArea: cells.length * cellArea,
    reachableArea: reachableCount * cellArea,
    picturedArea: picturedCount * cellArea,
    unpicturedArea: (reachableCount - picturedCount) * cellArea,
    farthest,
  };
}

/** The highest surface below a point, straight down, or undefined if there is none. */
export function heightBelow(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  point: Vec3,
): number | undefined {
  let highest: number | undefined;
  for (let i = 0; i < indices.length; i += 3) {
    const y = heightInTriangle(
      vertex(positions, indices[i] ?? 0),
      vertex(positions, indices[i + 1] ?? 0),
      vertex(positions, indices[i + 2] ?? 0),
      point[0],
      point[2],
    );
    if (y !== undefined && y < point[1] && (highest === undefined || y > highest)) {
      highest = y;
    }
  }
  return highest;
}

/** The triangle's height at (x, z) seen from above, or undefined outside it. */
function heightInTriangle(a: Vec3, b: Vec3, c: Vec3, x: number, z: number): number | undefined {
  const area = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
  if (area === 0) {
    return undefined;
  }
  const wb = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / area;
  const wc = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / area;
  const wa = 1 - wb - wc;
  if (wa < 0 || wb < 0 || wc < 0) {
    return undefined;
  }
  return wa * a[1] + wb * b[1] + wc * c[1];
}

/** Grid indices whose cell centers fall between min and max. */
function gridRange(min: number, max: number, cell: number): [number, number] {
  return [Math.ceil(min / cell - 0.5), Math.floor(max / cell - 0.5)];
}

function vertex(positions: ArrayLike<number>, index: number): Vec3 {
  return [positions[index * 3] ?? 0, positions[index * 3 + 1] ?? 0, positions[index * 3 + 2] ?? 0];
}
