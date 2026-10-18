import { dyno, PackedSplats, Readback } from "@sparkjsdev/spark";
import {
  type MemoryLight,
  type PhotoCamera,
  parseCameraFile,
  REALNESS_SETTINGS,
  type RealnessSettings,
  realness,
  type Vec3,
} from "@unpictured/core";
import * as THREE from "three";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import vectors from "../../tests/realness_vectors.json" with { type: "json" };
import { heatmapColor, RealnessLights, realnessHeatmap, realnessOf } from "./realnessShader.ts";

type VectorSettings = { margin: number; near_ok: number; far_limit: number; light_core: number };
type VectorCase = (typeof vectors.cases)[number] & {
  settings?: VectorSettings;
  lights?: { position: number[]; radius: number }[];
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

/** A shader computing one float per index, packed so it reads back exactly. Spark compiles it on
 * its first read and reuses it after that. */
function floatReader(valueAt: (index: dyno.DynoVal<"int">) => dyno.DynoVal<"float">) {
  return dyno.dynoBlock({ index: "int" }, { rgba8: "vec4" }, ({ index }) => {
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
}

/** Runs a reader on the GPU and reads the exact 32-bit values back. */
async function readFloats(
  reader: ReturnType<typeof floatReader>,
  count: number,
): Promise<number[]> {
  const buffer = readback.ensureBuffer(count, new Float32Array(0));
  const values = await readback.renderReadback({ reader, count, renderer, readback: buffer });
  return Array.from(values.slice(0, count));
}

/** Computes one float per index with a new shader and reads the values back. */
function gpuFloats(
  count: number,
  valueAt: (index: dyno.DynoVal<"int">) => dyno.DynoVal<"float">,
): Promise<number[]> {
  return readFloats(floatReader(valueAt), count);
}

function photoCameras(entries: Record<string, unknown>[]): PhotoCamera[] {
  const cameras = entries.map((entry) => ({ photo: "source.jpg", match_score: 1, ...entry }));
  return parseCameraFile({ frame: "marble_raw_opencv", cameras });
}

function vectorSettings(testCase: VectorCase): RealnessSettings {
  const { margin, near_ok, far_limit, light_core } = testCase.settings ?? vectors.settings;
  return { margin, nearOk: near_ok, farLimit: far_limit, lightCore: light_core };
}

function vectorLights(testCase: VectorCase): MemoryLight[] {
  return (testCase.lights ?? []).map(({ position: [x = 0, y = 0, z = 0], radius }) => ({
    position: [x, y, z],
    radius,
  }));
}

describe.each(vectors.cases as VectorCase[])("shader realness: $label", (testCase) => {
  test("matches the shared vectors", async () => {
    const named = vectors.cameras as Record<string, Record<string, unknown>>;
    const cameras = photoCameras(testCase.cameras.map((name) => named[name] ?? {}));
    const settings = vectorSettings(testCase);
    const lights = new RealnessLights();
    lights.set(vectorLights(testCase), settings);
    const [x = 0, y = 0, z = 0] = testCase.point;
    const point = dyno.dynoConst("vec3", [x, y, z]);
    const [shown] = await gpuFloats(1, () =>
      realnessOf(point, cameras, testCase.camera_height, settings, lights),
    );
    // The GPU works in 32-bit floats.
    expect(shown).toBeCloseTo(testCase.realness, 5);
  });
});

test("lights changed after the shader is built take effect without rebuilding it", async () => {
  const lights = new RealnessLights();
  const point = dyno.dynoConst("vec3", [0, 0, 5]);
  const reader = floatReader(() => realnessOf(point, [], 1, REALNESS_SETTINGS, lights));
  expect(await readFloats(reader, 1)).toEqual([0]);
  const programs = renderer.info.programs?.length;
  lights.set([{ position: [0, 0, 5.5], radius: 1 }], REALNESS_SETTINGS);
  expect(await readFloats(reader, 1)).toEqual([1]);
  // The removed light is still in its slot; the count must keep the shader from reading it.
  lights.set([], REALNESS_SETTINGS);
  expect(await readFloats(reader, 1)).toEqual([0]);
  expect(renderer.info.programs?.length, "shader programs").toBe(programs);
});

test("the heatmap refuses bad inputs when it is made, not later inside Spark's render", () => {
  const lights = new RealnessLights();
  expect(() => realnessHeatmap([], 0, REALNESS_SETTINGS, lights)).toThrow(/camera height/);
});

test("the heatmap modifier colors sample splats by the reference realness", async () => {
  // Two photos facing apart, like a living room shot from both ends.
  const lens = { image_size: [4032, 3024], fx: 1955.35, fy: 1955.35, cx: 2016, cy: 1512 };
  const cameras = photoCameras([
    { yaw_deg: 0, pitch_deg: -10.75, position: [0, 0, 0], ...lens },
    { yaw_deg: 180, pitch_deg: -13, position: [0, 0, 0], ...lens },
  ]);
  const cameraHeight = 1.44;
  const settings = REALNESS_SETTINGS; // what the viewer runs
  const lightList: MemoryLight[] = [
    { position: [3, 0.5, -4], radius: 2 * cameraHeight },
    { position: [-10, 1, 2], radius: 4 * cameraHeight },
    { position: [20, 0, 25], radius: cameraHeight },
  ];
  const lights = new RealnessLights();
  lights.set(lightList, settings);

  const splats = new PackedSplats();
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31; // a fixed sequence, the same on every run
    return seed / 2 ** 31;
  };
  const addSplat = (x: number, y: number, z: number) => {
    const size = new THREE.Vector3(0.01, 0.01, 0.01);
    const white = new THREE.Color(1, 1, 1);
    splats.pushSplat(new THREE.Vector3(x, y, z), size, new THREE.Quaternion(), 1, white);
  };
  const reach = 30 * cameraHeight; // past farLimit, so the whole fade is sampled
  for (let i = 0; i < 2000; i++) {
    addSplat(
      (random() * 2 - 1) * reach,
      (random() * 2 - 1) * reach * 0.3,
      (random() * 2 - 1) * reach,
    );
  }
  // And around each light, out to a little past its radius, so the lights' fades are sampled too.
  for (const { position, radius } of lightList) {
    for (let i = 0; i < 100; i++) {
      const [x, y, z] = position;
      const spread = 1.2 * radius;
      addSplat(
        x + (random() * 2 - 1) * spread,
        y + (random() * 2 - 1) * spread,
        z + (random() * 2 - 1) * spread,
      );
    }
  }
  const count = splats.numSplats;

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
  const heatmap = realnessHeatmap(cameras, cameraHeight, settings, lights);
  const red = await gpuFloats(count, (index) => {
    const colored = heatmap.apply({ gsplat: splatAt(index) }).gsplat;
    return dyno.split(dyno.splitGsplat(colored).outputs.rgb).outputs.r;
  });

  let partly = 0;
  let partlyLit = 0;
  for (let i = 0; i < count; i++) {
    const center: Vec3 = [xs[i] ?? 0, ys[i] ?? 0, zs[i] ?? 0];
    const expected = realness(center, cameras, cameraHeight, lightList, settings);
    const shown = (1 - (red[i] ?? 0)) / (1 - 0x4a / 255);
    expect(shown, `splat ${i} at ${center.join(", ")}`).toBeCloseTo(expected, 4);
    if (expected > 0.01 && expected < 0.99) {
      partly += 1;
      if (expected > realness(center, cameras, cameraHeight, [], settings)) {
        partlyLit += 1;
      }
    }
  }
  // The sample must reach the soft edges, not only the plainly seen and plainly imagined, and
  // some of them must come from the lights.
  expect(partly).toBeGreaterThan(50);
  expect(partlyLit).toBeGreaterThan(20);
});

test("the heatmap shades its color by the splat's own brightness", async () => {
  const real = [0x4a / 255, 0x9e / 255, 0xff / 255];
  const imagined = [0xff / 255, 0x5a / 255, 0xb4 / 255];
  const originals: [number, number, number][] = [
    [1, 1, 1],
    [0.5, 0.5, 0.5],
    [1, 0, 0],
    [0.2, 0.6, 0.9],
  ];
  for (const realness of [0, 0.5, 1]) {
    for (const original of originals) {
      const rgb = heatmapColor(dyno.dynoConst("float", realness), dyno.dynoConst("vec3", original));
      const { r, g, b } = dyno.split(rgb).outputs;
      const shown = await Promise.all([r, g, b].map((channel) => gpuFloats(1, () => channel)));
      const [red = 0, green = 0, blue = 0] = original;
      const brightness = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      [0, 1, 2].forEach((channel) => {
        const heat =
          (imagined[channel] ?? 0) + ((real[channel] ?? 0) - (imagined[channel] ?? 0)) * realness;
        const expected = heat * (0.35 + 0.65 * brightness);
        expect(shown[channel]?.[0], `realness ${realness}, color ${original}`).toBeCloseTo(
          expected,
          5,
        );
      });
    }
  }
});
