import { dyno, PackedSplats, Readback } from "@sparkjsdev/spark";
import {
  cameraRealness,
  type PhotoCamera,
  parseCameraFile,
  type RealnessSettings,
  type Vec3,
} from "@unpictured/core";
import * as THREE from "three";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import vectors from "../../tests/realness_vectors.json" with { type: "json" };
import { realnessHeatmap, realnessOf } from "./realnessShader.ts";

type VectorCase = (typeof vectors.cases)[number] & {
  settings?: { margin: number; near_ok: number; far_limit: number };
};

const renderer = new THREE.WebGLRenderer({ antialias: false });
const readback = new Readback({ renderer });
afterAll(() => renderer.dispose());

// A shader that fails to compile reads back as zeros, which could pass for "imagined".
const shaderErrors: string[] = [];
renderer.debug.onShaderError = (gl, _program, vertexShader, fragmentShader) => {
  const logs = [vertexShader, fragmentShader].map((shader) => gl.getShaderInfoLog(shader));
  shaderErrors.push(logs.join("\n"));
};
afterEach(() => {
  expect(shaderErrors, "shader compile errors").toEqual([]);
});

/** Computes one float per index on the GPU and reads the exact 32-bit values back. */
async function gpuFloats(
  count: number,
  valueAt: (index: dyno.DynoVal<"int">) => dyno.DynoVal<"float">,
): Promise<number[]> {
  const reader = dyno.dynoBlock({ index: "int" }, { rgba8: "vec4" }, ({ index }) => {
    if (index === undefined) {
      throw new Error("readback: no index");
    }
    const packed = new dyno.Dyno({
      inTypes: { value: "float" },
      outTypes: { rgba8: "vec4" },
      inputs: { value: valueAt(index) },
      statements: ({ inputs, outputs }) => [`${outputs.rgba8} = floatToVec4(${inputs.value});`],
    });
    return { rgba8: packed.outputs.rgba8 };
  });
  const buffer = readback.ensureBuffer(count, new Float32Array(0));
  const values = await readback.renderReadback({ reader, count, renderer, readback: buffer });
  return Array.from(values.slice(0, count));
}

function photoCameras(entries: Record<string, unknown>[]): PhotoCamera[] {
  const cameras = entries.map((entry) => ({ photo: "source.jpg", match_score: 1, ...entry }));
  return parseCameraFile({ frame: "marble_raw_opencv", cameras });
}

describe.each(vectors.cases as VectorCase[])("shader realness: $label", (testCase) => {
  test("matches the shared vectors", async () => {
    const named = vectors.cameras as Record<string, Record<string, unknown>>;
    const cameras = photoCameras(testCase.cameras.map((name) => named[name] ?? {}));
    const { margin, near_ok, far_limit } = testCase.settings ?? vectors.settings;
    const settings = { margin, nearOk: near_ok, farLimit: far_limit };
    const [x = 0, y = 0, z = 0] = testCase.point;
    const point = dyno.dynoConst("vec3", [x, y, z]);
    const [realness] = await gpuFloats(1, () =>
      realnessOf(point, cameras, testCase.camera_height, settings),
    );
    // The GPU works in 32-bit floats.
    expect(realness).toBeCloseTo(testCase.realness, 5);
  });
});

test("the heatmap modifier colors sample splats by the reference realness", async () => {
  // Two photos facing apart, like a living room shot from both ends.
  const lens = { image_size: [4032, 3024], fx: 1955.35, fy: 1955.35, cx: 2016, cy: 1512 };
  const cameras = photoCameras([
    { yaw_deg: 0, pitch_deg: -10.75, position: [0, 0, 0], ...lens },
    { yaw_deg: 180, pitch_deg: -13, position: [0, 0, 0], ...lens },
  ]);
  const cameraHeight = 1.44;
  const settings: RealnessSettings = { margin: 0.05, nearOk: 3, farLimit: 10 };

  const count = 2000;
  const splats = new PackedSplats();
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31; // a fixed sequence, the same on every run
    return seed / 2 ** 31;
  };
  for (let i = 0; i < count; i++) {
    const reach = 16 * cameraHeight;
    const center = new THREE.Vector3(
      (random() * 2 - 1) * reach,
      (random() * 2 - 1) * reach * 0.3,
      (random() * 2 - 1) * reach,
    );
    const size = new THREE.Vector3(0.01, 0.01, 0.01);
    splats.pushSplat(center, size, new THREE.Quaternion(), 1, new THREE.Color(1, 1, 1));
  }

  // Centers as the GPU stores them (packed, so slightly rounded), for the reference.
  const splatAt = (index: dyno.DynoVal<"int">) => dyno.readPackedSplat(splats.dyno, index);
  const axis = (pick: "x" | "y" | "z") => (index: dyno.DynoVal<"int">) =>
    dyno.split(dyno.splitGsplat(splatAt(index)).outputs.center).outputs[pick];
  const [xs, ys, zs] = await Promise.all([
    gpuFloats(count, axis("x")),
    gpuFloats(count, axis("y")),
    gpuFloats(count, axis("z")),
  ]);

  // Realness back out of the heatmap's color. The splats are white, so the shading keeps the pure
  // heat color, whose red runs from 1 (imagined) to 0x4a / 255 (real).
  const heatmap = realnessHeatmap(cameras, cameraHeight, settings);
  const red = await gpuFloats(count, (index) => {
    const colored = heatmap.apply({ gsplat: splatAt(index) }).gsplat;
    return dyno.split(dyno.splitGsplat(colored).outputs.rgb).outputs.r;
  });

  let partly = 0;
  for (let i = 0; i < count; i++) {
    const center: Vec3 = [xs[i] ?? 0, ys[i] ?? 0, zs[i] ?? 0];
    const expected = cameraRealness(center, cameras, cameraHeight, settings);
    const shown = (1 - (red[i] ?? 0)) / (1 - 0x4a / 255);
    expect(shown, `splat ${i} at ${center.join(", ")}`).toBeCloseTo(expected, 4);
    if (expected > 0.01 && expected < 0.99) {
      partly += 1;
    }
  }
  // The sample must reach the soft edges, not only the plainly seen and plainly imagined.
  expect(partly).toBeGreaterThan(50);
});
