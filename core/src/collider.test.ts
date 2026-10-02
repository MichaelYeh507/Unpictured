import { expect, test } from "vitest";
import { parseGlbMesh } from "./collider.ts";

interface GlbParts {
  positions: number[];
  indices?: number[];
  indexType?: 5121 | 5123 | 5125;
  node?: Record<string, unknown>;
  positionStride?: number;
}

/** Builds a small binary glTF file the way trimesh writes Marble's colliders. */
function makeGlb({
  positions,
  indices,
  indexType = 5123,
  node = { mesh: 0 },
  positionStride,
}: GlbParts) {
  const indexBytes = { 5121: 1, 5123: 2, 5125: 4 }[indexType];
  const positionBytes = positions.length * 4;
  const indexStart = positionBytes;
  const binLength = Math.ceil((positionBytes + (indices?.length ?? 0) * indexBytes) / 4) * 4;
  const bin = new DataView(new ArrayBuffer(binLength));
  positions.forEach((value, index) => {
    bin.setFloat32(index * 4, value, true);
  });
  indices?.forEach((value, index) => {
    const at = indexStart + index * indexBytes;
    if (indexBytes === 1) bin.setUint8(at, value);
    else if (indexBytes === 2) bin.setUint16(at, value, true);
    else bin.setUint32(at, value, true);
  });
  const primitive: Record<string, unknown> = { attributes: { POSITION: 0 } };
  const accessors: Record<string, unknown>[] = [
    { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3" },
  ];
  const bufferViews: Record<string, unknown>[] = [
    {
      buffer: 0,
      byteOffset: 0,
      byteLength: positionBytes,
      ...(positionStride ? { byteStride: positionStride } : {}),
    },
  ];
  if (indices !== undefined) {
    primitive.indices = 1;
    accessors.push({
      bufferView: 1,
      componentType: indexType,
      count: indices.length,
      type: "SCALAR",
    });
    bufferViews.push({
      buffer: 0,
      byteOffset: indexStart,
      byteLength: indices.length * indexBytes,
    });
  }
  const gltf = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [node],
    meshes: [{ primitives: [primitive] }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };
  let json = JSON.stringify(gltf);
  json += " ".repeat((4 - (json.length % 4)) % 4);
  const total = 12 + 8 + json.length + 8 + binLength;
  const out = new DataView(new ArrayBuffer(total));
  out.setUint32(0, 0x46546c67, true);
  out.setUint32(4, 2, true);
  out.setUint32(8, total, true);
  out.setUint32(12, json.length, true);
  out.setUint32(16, 0x4e4f534a, true);
  for (let index = 0; index < json.length; index++)
    out.setUint8(20 + index, json.charCodeAt(index));
  const binHeader = 20 + json.length;
  out.setUint32(binHeader, binLength, true);
  out.setUint32(binHeader + 4, 0x004e4942, true);
  new Uint8Array(out.buffer, binHeader + 8).set(new Uint8Array(bin.buffer));
  return out.buffer;
}

const SQUARE = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];

test("reads positions and 16-bit indices", () => {
  const mesh = parseGlbMesh(makeGlb({ positions: SQUARE, indices: [0, 1, 2, 0, 2, 3] }));

  expect(Array.from(mesh.positions)).toEqual(SQUARE);
  expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3]);
});

test.each([5121, 5125] as const)("reads index type %i", (indexType) => {
  const mesh = parseGlbMesh(makeGlb({ positions: SQUARE, indices: [3, 2, 0], indexType }));

  expect(Array.from(mesh.indices)).toEqual([3, 2, 0]);
});

test("numbers the vertices in order when there are no indices", () => {
  const mesh = parseGlbMesh(makeGlb({ positions: SQUARE.slice(0, 9) }));

  expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
});

test.each([
  ["a moved node", { node: { mesh: 0, translation: [0, 1, 0] } }, "node transforms"],
  ["a scaled node", { node: { mesh: 0, scale: [2, 2, 2] } }, "node transforms"],
  ["interleaved positions", { positionStride: 24 }, "interleaved"],
])("refuses %s", (_label, change, message) => {
  const glb = makeGlb({ positions: SQUARE, indices: [0, 1, 2], ...change });

  expect(() => parseGlbMesh(glb)).toThrow(message);
});

test("refuses a file that is not binary glTF", () => {
  const notGlb = new TextEncoderLike().encode('{ "asset": {} }');

  expect(() => parseGlbMesh(notGlb)).toThrow("not a binary glTF 2.0 file");
});

/** Plain text as bytes, without relying on a DOM or Node type. */
class TextEncoderLike {
  encode(text: string): ArrayBuffer {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes.buffer;
  }
}
