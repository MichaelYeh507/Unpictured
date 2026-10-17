/** Finding the floor under a point in a collider mesh, for the walkable floor and realness. */

import type { TriangleMesh } from "./collider.ts";
import { sourceCameraPosition, toGameFrame, type Vec3, type WorldPlacement } from "./frames.ts";

/** A person-sized walker, in metres and degrees. */
export const WALKER = { height: 1.6, stepHeight: 0.3, radius: 0.2, maxSlopeDeg: 40 };
/** A floor beside a hole under the photo spot counts if it is no farther away than this many
 * times its depth below the photo spot. */
const NEAR_FLOOR_FACTOR = 2;
/** It must also go on at about the same height beyond its edge, for this share of its distance or
 * depth (the larger), so a stray sliver of collider in the hole doesn't count. */
const STANDING_ROOM = 0.25;

/** The photo spot's height above the floor under it, in the world's raw units (see
 * floorUnderPhotoSpot). Undefined when the collider has no floor there. */
export function photoSpotHeight(
  collider: TriangleMesh,
  placement: WorldPlacement,
): number | undefined {
  const positions = new Float32Array(collider.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions.set(toGameFrame(vertex(collider.positions, i / 3), placement), i);
  }
  const photoSpot = sourceCameraPosition(placement);
  const floorPoint = floorUnderPhotoSpot(positions, collider.indices, photoSpot);
  return floorPoint === undefined ? undefined : (photoSpot[1] - floorPoint[1]) / placement.scale;
}

/** The floor straight below the photo spot, or the nearest floor beside it when the collider
 * has a hole there (a single photo never sees straight down, and outdoors Marble can leave one).
 * Positions are in the game frame, y up. */
export function floorUnderPhotoSpot(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  photoSpot: Vec3,
): Vec3 | undefined {
  const floorY = heightBelow(positions, indices, photoSpot);
  return floorY !== undefined
    ? [photoSpot[0], floorY, photoSpot[2]]
    : nearestFloor(positions, indices, photoSpot);
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

/** For a floor with a hole straight under a point: the nearest point, seen from above, on the
 * edge of a walkable floor below it that is near enough (NEAR_FLOOR_FACTOR) and goes on beyond
 * that edge (STANDING_ROOM). */
export function nearestFloor(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  point: Vec3,
): Vec3 | undefined {
  const edges = floorEdgesNear(positions, indices, point);
  edges.sort((first, second) => first.distance - second.distance);
  for (const { position, distance } of edges) {
    const room = STANDING_ROOM * Math.max(distance, point[1] - position[1]);
    const outward = room / distance;
    const beyond: Vec3 = [
      position[0] + (position[0] - point[0]) * outward,
      point[1],
      position[2] + (position[2] - point[2]) * outward,
    ];
    const beyondY = heightBelow(positions, indices, beyond);
    if (beyondY !== undefined && Math.abs(beyondY - position[1]) <= room) {
      return position;
    }
  }
  return undefined;
}

/** The point nearest to `point`, seen from above, on each edge of the walkable floor, keeping
 * those no farther away than NEAR_FLOOR_FACTOR times their depth (so they are below it). */
function floorEdgesNear(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  point: Vec3,
): { position: Vec3; distance: number }[] {
  const steepest = Math.cos((WALKER.maxSlopeDeg * Math.PI) / 180);
  const edges: { position: Vec3; distance: number }[] = [];
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
      const position = nearestOnEdge(from, to, point[0], point[2]);
      const distance = Math.hypot(position[0] - point[0], position[2] - point[2]);
      const depth = point[1] - position[1];
      if (distance > 0 && distance <= NEAR_FLOOR_FACTOR * depth) {
        edges.push({ position, distance });
      }
    }
  }
  return edges;
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
export function heightInTriangle(
  a: Vec3,
  b: Vec3,
  c: Vec3,
  x: number,
  z: number,
): number | undefined {
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

export function vertex(positions: ArrayLike<number>, index: number): Vec3 {
  return [positions[index * 3] ?? 0, positions[index * 3 + 1] ?? 0, positions[index * 3 + 2] ?? 0];
}
