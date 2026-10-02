import { expect, test } from "vitest";
import { parseGlbMesh } from "./collider.ts";

interface Primitive {
  positions: number[];
  indices?: number[];
  mode?: number;
}

interface GlbParts {
  primitives: Primitive[];
  indexType?: 5121 | 5123 | 5125;
  positionType?: number;
  node?: Record<string, unknown>;
  positionStride?: number;
  /** Bytes to cut off the end of the file. */
  cut?: number;
}

/** Builds a small binary glTF file the way trimesh writes Marble's colliders. */
function makeGlb({
  primitives,
  indexType = 5123,
  positionType = 5126,
  node = { mesh: 0 },
  positionStride,
  cut = 0,
}: GlbParts): ArrayBuffer {
  const indexBytes = { 5121: 1, 5123: 2, 5125: 4 }[indexType];
  const chunks: number[] = []; // the binary chunk, byte by byte
  const accessors: Record<string, unknown>[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const add = (
    bytes: Uint8Array,
    view: Record<string, unknown>,
    accessor: Record<string, unknown>,
  ) => {
    while (chunks.length % 4 !== 0) chunks.push(0);
    bufferViews.push({ buffer: 0, byteOffset: chunks.length, byteLength: bytes.length, ...view });
    accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
    chunks.push(...bytes);
    return accessors.length - 1;
  };
  const meshPrimitives = primitives.map(({ positions, indices, mode }) => {
    const positionData = new DataView(new ArrayBuffer(positions.length * 4));
    positions.forEach((value, index) => {
      positionData.setFloat32(index * 4, value, true);
    });
    const stride = positionStride ? { byteStride: positionStride } : {};
    const position = add(new Uint8Array(positionData.buffer), stride, {
      componentType: positionType,
      count: positions.length / 3,
      type: "VEC3",
    });
    const primitive: Record<string, unknown> = { attributes: { POSITION: position } };
    if (mode !== undefined) primitive.mode = mode;
    if (indices !== undefined) {
      const indexData = new DataView(new ArrayBuffer(indices.length * indexBytes));
      indices.forEach((value, index) => {
        if (indexBytes === 1) indexData.setUint8(index, value);
        else if (indexBytes === 2) indexData.setUint16(index * 2, value, true);
        else indexData.setUint32(index * 4, value, true);
      });
      primitive.indices = add(
        new Uint8Array(indexData.buffer),
        {},
        {
          componentType: indexType,
          count: indices.length,
          type: "SCALAR",
        },
      );
    }
    return primitive;
  });
  while (chunks.length % 4 !== 0) chunks.push(0);
  const gltf = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [node],
    meshes: [{ primitives: meshPrimitives }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: chunks.length }],
  };
  let json = JSON.stringify(gltf);
  json += " ".repeat((4 - (json.length % 4)) % 4);
  const total = 12 + 8 + json.length + 8 + chunks.length;
  const out = new DataView(new ArrayBuffer(total));
  out.setUint32(0, 0x46546c67, true);
  out.setUint32(4, 2, true);
  out.setUint32(8, total, true);
  out.setUint32(12, json.length, true);
  out.setUint32(16, 0x4e4f534a, true);
  for (let index = 0; index < json.length; index++)
    out.setUint8(20 + index, json.charCodeAt(index));
  const binHeader = 20 + json.length;
  out.setUint32(binHeader, chunks.length, true);
  out.setUint32(binHeader + 4, 0x004e4942, true);
  new Uint8Array(out.buffer, binHeader + 8).set(chunks);
  return out.buffer.slice(0, total - cut);
}

const SQUARE = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
const square = (indices = [0, 1, 2, 0, 2, 3]) => ({ positions: SQUARE, indices });

test("reads positions and 16-bit indices", () => {
  const mesh = parseGlbMesh(makeGlb({ primitives: [square()] }));

  expect(Array.from(mesh.positions)).toEqual(SQUARE);
  expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3]);
});

test.each([5121, 5125] as const)("reads index type %i", (indexType) => {
  const mesh = parseGlbMesh(makeGlb({ primitives: [square([3, 2, 0])], indexType }));

  expect(Array.from(mesh.indices)).toEqual([3, 2, 0]);
});

test("numbers the vertices in order when there are no indices", () => {
  const mesh = parseGlbMesh(makeGlb({ primitives: [{ positions: SQUARE.slice(0, 9) }] }));

  expect(Array.from(mesh.indices)).toEqual([0, 1, 2]);
});

test("joins several parts, each one's indices pointing at its own vertices", () => {
  const mesh = parseGlbMesh(makeGlb({ primitives: [square([0, 1, 2]), square([2, 3, 0])] }));

  expect(mesh.positions).toHaveLength(SQUARE.length * 2);
  expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 6, 7, 4]);
});

test.each([
  ["a moved node", { node: { mesh: 0, translation: [0, 1, 0] } }, "node transforms"],
  ["a scaled node", { node: { mesh: 0, scale: [2, 2, 2] } }, "node transforms"],
  ["interleaved positions", { positionStride: 24 }, "interleaved"],
  ["positions that are not floats", { positionType: 5123 }, "not 32-bit float triples"],
  ["a line list", { primitives: [{ ...square(), mode: 1 }] }, "not a triangle list"],
  ["an index past the vertices", { primitives: [square([0, 1, 4])] }, "points past its vertices"],
  ["a part-triangle", { primitives: [square([0, 1, 2, 3])] }, "not whole triangles"],
  ["a file cut short", { cut: 8 }, "cut short"],
])("refuses %s", (_label, change, message) => {
  const glb = makeGlb({ primitives: [square()], ...change });

  expect(() => parseGlbMesh(glb)).toThrow(message);
});

test("refuses a file that is not binary glTF", () => {
  const text = '{ "asset": {} }';
  const notGlb = Uint8Array.from(text, (character) => character.charCodeAt(0)).buffer;

  expect(() => parseGlbMesh(notGlb)).toThrow("not a binary glTF 2.0 file");
});

test("refuses a file without its binary chunk", () => {
  const glb = makeGlb({ primitives: [square()] });
  const jsonLength = new DataView(glb).getUint32(12, true);

  expect(() => parseGlbMesh(glb.slice(0, 20 + jsonLength))).toThrow("no binary chunk");
});
