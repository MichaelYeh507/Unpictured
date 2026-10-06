import type { WalkableFloor } from "@unpictured/core/walkable";
import * as THREE from "three";

const PICTURED = new THREE.Color(0x4a9eff);
const UNPICTURED = new THREE.Color(0xff5ab4);
const OUT_OF_REACH = new THREE.Color(0x8a8a8a);
// Like the photo frames: drawn after the splats, without depth testing, so the floor shows.
const DRAW_LAST = 9;

/** The measured floor as small colored squares, just above the floor. */
export function buildFloorOverlay(floor: WalkableFloor): THREE.Mesh {
  const half = floor.cellSize * 0.45; // a small gap between squares keeps the grid readable
  const lift = 0.02 / floor.metresPerUnit;
  const positions: number[] = [];
  const colors: number[] = [];
  for (const { center, reachable, pictured } of floor.cells) {
    const [x, y, z] = center;
    const color = !reachable ? OUT_OF_REACH : pictured ? PICTURED : UNPICTURED;
    const corners = [
      [x - half, z - half],
      [x - half, z + half],
      [x + half, z + half],
      [x - half, z - half],
      [x + half, z + half],
      [x + half, z - half],
    ];
    for (const [cornerX = 0, cornerZ = 0] of corners) {
      positions.push(cornerX, y + lift, cornerZ);
      colors.push(color.r, color.g, color.b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const overlay = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      side: THREE.DoubleSide,
    }),
  );
  overlay.renderOrder = DRAW_LAST;
  return overlay;
}

export function describeFloor(floor: WalkableFloor): string {
  const about = floor.estimated ? "about " : "";
  const share = floor.reachableArea > 0 ? (100 * floor.unpicturedArea) / floor.reachableArea : 0;
  const estimate = floor.estimated
    ? " Sizes are estimated: this world has no scale, so the photo is assumed to be 1.5 m up."
    : "";
  const start =
    floor.startDistance > 0
      ? ` The collider has a hole under the photo spot, so this is measured from the nearest ` +
        `floor, ${about}${floor.startDistance.toFixed(1)} m away.`
      : "";
  return (
    `Walkable floor: ${about}${floor.reachableArea.toFixed(1)} m² reachable, ` +
    `${floor.unpicturedArea.toFixed(1)} m² of it unpictured (${share.toFixed(0)}%), ` +
    `farthest ${floor.farthest.toFixed(1)} m away. ` +
    `Blue: in a photo. Pink: unpictured. Gray: out of reach.${start}${estimate}`
  );
}
