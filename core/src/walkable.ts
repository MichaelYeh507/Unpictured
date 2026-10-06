/**
 * Where a person can walk in a world, and how much of that floor the photos saw. Uses Recast
 * (recast-navigation-js), so it is a separate entry point that the viewer loads only on demand.
 */

import {
  Detour,
  getNavMeshPositionsAndIndices,
  init,
  NavMeshQuery,
  statusDetail,
} from "@recast-navigation/core";
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
const VOXEL = 0.05; // metres per side of Recast's voxels, coarser only for very large worlds
const MAX_VOXELS_PER_SIDE = 2000; // keeps Recast's grid, and its memory, bounded
const CELL = 0.1; // metres per side of the grid the floor is measured and drawn on
const MAX_POLYGONS = 65535; // Detour's limit for one search
const MAX_CELLS = 200_000; // larger floors get coarser cells, so the overlay stays drawable
/** A floor beside a hole under the photo spot counts if it is this many times closer than deep. */
const NEAR_FLOOR_FACTOR = 2;

export interface FloorCell {
  /** The middle of the cell, on the floor, in the game frame. */
  center: Vec3;
  /** Connected to the floor the measurement starts from. */
  reachable: boolean;
  /** Reachable and inside at least one photo's frame (what furniture hides is not considered). */
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
  /** Metres in a straight line, seen from above, from the photo spot to the farthest reachable cell. */
  farthest: number;
  /** Metres, seen from above, from the photo spot to where the measurement starts: 0 unless the
   * collider has a hole under the photo spot. */
  startDistance: number;
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
  // A single photo never sees straight down, and outdoors Marble can leave a hole there.
  const floorY = heightBelow(positions, collider.indices, photoSpot);
  const floorPoint: Vec3 | undefined =
    floorY !== undefined
      ? [photoSpot[0], floorY, photoSpot[2]]
      : nearestFloor(positions, collider.indices, photoSpot);
  if (floorPoint === undefined) {
    throw new Error("the collider has no floor below or near the photo spot");
  }
  const heightInUnits = photoSpot[1] - floorPoint[1];
  const metresPerUnit = placement.metric ? 1 : ASSUMED_CAMERA_HEIGHT / heightInUnits;
  const startUnits = Math.hypot(floorPoint[0] - photoSpot[0], floorPoint[2] - photoSpot[2]);
  const voxel = Math.max(VOXEL, (widestSide(positions) * metresPerUnit) / MAX_VOXELS_PER_SIDE);

  // Recast takes the walker's sizes in voxels, rounded (0.3 / 0.05 is 5.999... in floating point).
  const built = generateSoloNavMesh(positions, collider.indices, {
    cs: voxel / metresPerUnit,
    ch: voxel / metresPerUnit,
    walkableHeight: Math.round(WALKER.height / voxel),
    walkableClimb: Math.round(WALKER.stepHeight / voxel),
    walkableRadius: Math.max(1, Math.round(WALKER.radius / voxel)),
    walkableSlopeAngle: WALKER.maxSlopeDeg,
  });
  if (!built.success) {
    throw new Error(`could not work out the walkable floor: ${built.error}`);
  }
  const navMesh = built.navMesh;
  let query: NavMeshQuery | undefined;
  try {
    query = new NavMeshQuery(navMesh, { maxNodes: MAX_POLYGONS });
    const reachable = reachablePolygons(query, floorPoint, metresPerUnit);
    const [navPositions, navIndices] = getNavMeshPositionsAndIndices(navMesh);
    const floorArea = projectedArea(navPositions, navIndices) * metresPerUnit ** 2;
    const cell = Math.max(CELL, 2 * voxel, Math.sqrt(floorArea / MAX_CELLS));
    const triangles = { positions: navPositions, indices: navIndices };
    const cells = floorCells(triangles, query, reachable, cell / metresPerUnit, (point) =>
      cameras.some((camera) => isInPhoto(camera, toRawFrame(point, placement))),
    );
    return {
      ...summarize(cells, cell, photoSpot, metresPerUnit, !placement.metric, heightInUnits),
      startDistance: startUnits * metresPerUnit,
    };
  } finally {
    query?.destroy();
    navMesh.destroy();
  }
}

/** Every polygon connected to the one at the floor point. */
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
  if (!start.success || start.nearestRef === 0) {
    throw new Error("there is no walkable floor within a metre of the photo spot");
  }
  const around = query.findPolysAroundCircle(start.nearestRef, start.nearestPoint, 1e6, {
    maxPolys: MAX_POLYGONS,
  });
  // Detour stops early but still reports success when it runs out of room.
  const ranOut =
    statusDetail(around.status, Detour.DT_OUT_OF_NODES) ||
    statusDetail(around.status, Detour.DT_BUFFER_TOO_SMALL);
  if (!around.success || ranOut) {
    throw new Error(
      `the floor has more than ${MAX_POLYGONS} pieces to search, too many to measure`,
    );
  }
  const reachable = new Set<number>();
  for (let index = 0; index < around.resultCount; index++) {
    reachable.add(around.resultRefs[index] ?? 0);
  }
  return reachable;
}

/** The longer of the collider's two sides seen from above, in game units. */
function widestSide(positions: Float32Array): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const z = positions[i + 2] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return Math.max(maxX - minX, maxZ - minZ);
}

/** The walkable floor on a grid of squares `cell` units wide, one per grid point inside it. */
function floorCells(
  { positions: navPositions, indices: navIndices }: { positions: number[]; indices: number[] },
  query: NavMeshQuery,
  reachable: Set<number>,
  cell: number,
  isPictured: (point: Vec3) => boolean,
): FloorCell[] {
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
  cellMetres: number,
  photoSpot: Vec3,
  metresPerUnit: number,
  estimated: boolean,
  heightInUnits: number,
): Omit<WalkableFloor, "startDistance"> {
  const cellArea = cellMetres * cellMetres;
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
    cellSize: cellMetres / metresPerUnit,
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

/** The highest walkable surface straight below a point: facing up, no steeper than a walker
 * can climb. Ceilings, walls and stray downward fragments are skipped. */
export function heightBelow(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  point: Vec3,
): number | undefined {
  const steepest = Math.cos((WALKER.maxSlopeDeg * Math.PI) / 180);
  let highest: number | undefined;
  for (let i = 0; i < indices.length; i += 3) {
    const a = vertex(positions, indices[i] ?? 0);
    const b = vertex(positions, indices[i + 1] ?? 0);
    const c = vertex(positions, indices[i + 2] ?? 0);
    if (upwardness(a, b, c) < steepest) {
      continue;
    }
    const y = heightInTriangle(a, b, c, point[0], point[2]);
    if (y !== undefined && y < point[1] && (highest === undefined || y > highest)) {
      highest = y;
    }
  }
  return highest;
}

/** The nearest point of any walkable floor below a point, seen from above, for when the floor
 * has a hole straight under it. A floor farther away than NEAR_FLOOR_FACTOR times its depth
 * below the point doesn't count. */
export function nearestFloor(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  point: Vec3,
): Vec3 | undefined {
  const steepest = Math.cos((WALKER.maxSlopeDeg * Math.PI) / 180);
  let nearest: Vec3 | undefined;
  let nearestDistance = Infinity;
  for (let i = 0; i < indices.length; i += 3) {
    const a = vertex(positions, indices[i] ?? 0);
    const b = vertex(positions, indices[i + 1] ?? 0);
    const c = vertex(positions, indices[i + 2] ?? 0);
    if (upwardness(a, b, c) < steepest) {
      continue;
    }
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const candidate = nearestOnEdge(from, to, point[0], point[2]);
      const distance = Math.hypot(candidate[0] - point[0], candidate[2] - point[2]);
      const depth = point[1] - candidate[1];
      if (depth > 0 && distance <= NEAR_FLOOR_FACTOR * depth && distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
  }
  return nearest;
}

/** The point on the edge from `from` to `to` nearest to (x, z) seen from above, with its height. */
function nearestOnEdge(from: Vec3, to: Vec3, x: number, z: number): Vec3 {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const lengthSquared = dx * dx + dz * dz;
  const along = lengthSquared === 0 ? 0 : ((x - from[0]) * dx + (z - from[2]) * dz) / lengthSquared;
  const t = Math.min(1, Math.max(0, along));
  return [from[0] + t * dx, from[1] + t * (to[1] - from[1]), from[2] + t * dz];
}

/** How much a triangle faces up, from 1 (flat, facing up) to -1 (facing down), as Recast sees it. */
function upwardness(a: Vec3, b: Vec3, c: Vec3): number {
  const e0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const [e0x = 0, e0y = 0, e0z = 0] = e0;
  const [e1x = 0, e1y = 0, e1z = 0] = e1;
  const normal = [e0y * e1z - e0z * e1y, e0z * e1x - e0x * e1z, e0x * e1y - e0y * e1x];
  const length = Math.hypot(...normal);
  return length === 0 ? -1 : (normal[1] ?? 0) / length;
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

/** The area of the triangles seen from above, in game units squared. */
function projectedArea(positions: number[], indices: number[]): number {
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = vertex(positions, indices[i] ?? 0);
    const b = vertex(positions, indices[i + 1] ?? 0);
    const c = vertex(positions, indices[i + 2] ?? 0);
    area += Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2;
  }
  return area;
}

/** Grid indices whose cell centers fall between min and max. */
function gridRange(min: number, max: number, cell: number): [number, number] {
  return [Math.ceil(min / cell - 0.5), Math.floor(max / cell - 0.5)];
}

function vertex(positions: ArrayLike<number>, index: number): Vec3 {
  return [positions[index * 3] ?? 0, positions[index * 3 + 1] ?? 0, positions[index * 3 + 2] ?? 0];
}
