import {
  type PhotoCamera,
  photoFrameCenter,
  photoFrameCorners,
  toGameFrame,
  type WorldPlacement,
} from "@unpictured/core";
import * as THREE from "three";

/** How far in front of its camera a photo's frame is drawn, in raw splat units. */
const FRAME_DEPTH = 1;
const FRAME_COLOR = 0xffd479;
// Splats draw with the transparent objects. Frames are transparent too, drawn after them and
// without depth testing, so nothing in the world hides them.
const DRAW_LAST = 10;

export interface PhotoFrame {
  /** Lines from the camera to the photo's corners, and around the photo. */
  outline: THREE.LineSegments;
  /** The photo itself, half transparent, filling the frame. Hidden until toggled. */
  overlay: THREE.Mesh;
  /** The middle of the photo, for pointing the view through it. */
  center: THREE.Vector3;
}

export function buildPhotoFrame(
  camera: PhotoCamera,
  placement: WorldPlacement,
  photoUrl: string,
): PhotoFrame {
  const inGame = (point: readonly [number, number, number]) =>
    new THREE.Vector3(...toGameFrame(point, placement));
  const corners = photoFrameCorners(camera, FRAME_DEPTH).map(inGame);
  const origin = inGame(camera.position);

  const linePoints: THREE.Vector3[] = [];
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % corners.length] ?? corner;
    linePoints.push(corner, next, origin, corner);
  });
  const outline = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(linePoints),
    new THREE.LineBasicMaterial({ color: FRAME_COLOR, transparent: true, depthTest: false }),
  );
  outline.renderOrder = DRAW_LAST;

  // Corners run top-left, top-right, bottom-right, bottom-left; texture v = 1 is the top.
  const quad = new THREE.BufferGeometry().setFromPoints(corners);
  quad.setIndex([0, 3, 1, 1, 3, 2]);
  quad.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
  const texture = new THREE.TextureLoader().load(photoUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const overlay = new THREE.Mesh(
    quad,
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
      side: THREE.DoubleSide,
    }),
  );
  overlay.renderOrder = DRAW_LAST + 1;
  overlay.visible = false;

  return { outline, overlay, center: inGame(photoFrameCenter(camera, FRAME_DEPTH)) };
}

/** A vertical field of view, in degrees, wide enough to show the whole photo with a margin. */
export function fieldOfViewFor(camera: PhotoCamera, aspect: number): number {
  const [width, height] = camera.imageSize;
  const halfWidth = width / 2 / camera.fx;
  const halfHeight = height / 2 / camera.fy;
  const neededHalfHeight = Math.max(halfHeight, halfWidth / aspect) * 1.1;
  return Math.min(110, (2 * Math.atan(neededHalfHeight) * 180) / Math.PI);
}
