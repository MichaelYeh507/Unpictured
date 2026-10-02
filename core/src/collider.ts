/** Reads the triangles of a world's collider.glb (binary glTF 2.0), in the file's own frame. */

export interface TriangleMesh {
  /** x, y, z for each vertex. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const TRIANGLES = 4;
const FLOAT = 5126;
const INDEX_TYPES: Record<number, { bytes: number; read: (view: DataView, at: number) => number }> =
  {
    5121: { bytes: 1, read: (view, at) => view.getUint8(at) },
    5123: { bytes: 2, read: (view, at) => view.getUint16(at, true) },
    5125: { bytes: 4, read: (view, at) => view.getUint32(at, true) },
  };

interface Gltf {
  nodes?: Record<string, unknown>[];
  meshes?: {
    primitives: { attributes: { POSITION?: number }; indices?: number; mode?: number }[];
  }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  bufferViews?: { byteOffset?: number; byteLength: number; byteStride?: number }[];
}

export function parseGlbMesh(bytes: ArrayBuffer): TriangleMesh {
  const view = new DataView(bytes);
  if (
    bytes.byteLength < 20 ||
    view.getUint32(0, true) !== GLB_MAGIC ||
    view.getUint32(4, true) !== 2
  ) {
    throw new Error("collider.glb is not a binary glTF 2.0 file");
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK) {
    throw new Error("collider.glb has no JSON chunk");
  }
  const binHeader = 20 + jsonLength;
  if (binHeader + 8 > bytes.byteLength || view.getUint32(binHeader + 4, true) !== BIN_CHUNK) {
    throw new Error("collider.glb has no binary chunk");
  }
  const gltf = JSON.parse(bytesToText(new Uint8Array(bytes, 20, jsonLength))) as Gltf;
  const bin = { start: binHeader + 8, end: binHeader + 8 + view.getUint32(binHeader, true) };
  if (bin.end > bytes.byteLength) {
    throw new Error("collider.glb is cut short");
  }
  // Marble's colliders place vertices directly; a moved, turned or scaled node would be misplaced.
  const transformKeys = ["matrix", "translation", "rotation", "scale"];
  if ((gltf.nodes ?? []).some((node) => transformKeys.some((key) => key in node))) {
    throw new Error("collider.glb moves its mesh with node transforms, which are not supported");
  }

  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (
        (primitive.mode ?? TRIANGLES) !== TRIANGLES ||
        primitive.attributes.POSITION === undefined
      ) {
        throw new Error("collider.glb has a primitive that is not a triangle list with positions");
      }
      const first = positions.length / 3;
      const vertexCount = readPositions(gltf, view, bin, primitive.attributes.POSITION, positions);
      if (primitive.indices === undefined) {
        for (let index = 0; index < vertexCount; index++) {
          indices.push(first + index);
        }
      } else {
        for (const index of readIndices(gltf, view, bin, primitive.indices)) {
          if (index >= vertexCount) {
            throw new Error("collider.glb has a triangle that points past its vertices");
          }
          indices.push(first + index);
        }
      }
    }
  }
  if (indices.length % 3 !== 0) {
    throw new Error("collider.glb has a triangle list that is not whole triangles");
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** Where the binary chunk's data starts and ends in the file. */
interface BinChunk {
  start: number;
  end: number;
}

function readPositions(
  gltf: Gltf,
  view: DataView,
  bin: BinChunk,
  accessorIndex: number,
  out: number[],
): number {
  const { accessor, start } = locate(gltf, bin, accessorIndex, 12);
  if (accessor.componentType !== FLOAT || accessor.type !== "VEC3") {
    throw new Error("collider.glb positions are not 32-bit float triples");
  }
  for (let value = 0; value < accessor.count * 3; value++) {
    out.push(view.getFloat32(start + value * 4, true));
  }
  return accessor.count;
}

function readIndices(gltf: Gltf, view: DataView, bin: BinChunk, accessorIndex: number): number[] {
  const componentType = gltf.accessors?.[accessorIndex]?.componentType ?? 0;
  const indexType = INDEX_TYPES[componentType];
  if (indexType === undefined) {
    throw new Error("collider.glb indices are not unsigned integers");
  }
  const { accessor, start } = locate(gltf, bin, accessorIndex, indexType.bytes);
  const result: number[] = [];
  for (let item = 0; item < accessor.count; item++) {
    result.push(indexType.read(view, start + item * indexType.bytes));
  }
  return result;
}

/** Finds where an accessor's data starts in the file, and refuses interleaved data. */
function locate(gltf: Gltf, bin: BinChunk, accessorIndex: number, elementBytes: number) {
  const accessor = gltf.accessors?.[accessorIndex];
  const bufferView =
    accessor?.bufferView === undefined ? undefined : gltf.bufferViews?.[accessor.bufferView];
  if (accessor === undefined || bufferView === undefined) {
    throw new Error("collider.glb refers to data that is not there");
  }
  if (bufferView.byteStride !== undefined && bufferView.byteStride !== elementBytes) {
    throw new Error("collider.glb has interleaved vertex data, which is not supported");
  }
  const viewStart = bin.start + (bufferView.byteOffset ?? 0);
  const start = viewStart + (accessor.byteOffset ?? 0);
  const end = start + accessor.count * elementBytes;
  if (end > viewStart + bufferView.byteLength || end > bin.end) {
    throw new Error("collider.glb data runs past its buffer");
  }
  return { accessor, start };
}

/** glTF's JSON is UTF-8. Only its keys and numbers are read here, and UTF-8 never uses ASCII
 * bytes inside other characters, so reading it byte by byte keeps the JSON intact. */
function bytesToText(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}
