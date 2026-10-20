/**
 * For the browser tests: runs small Spark shaders on the GPU and reads their results back as
 * exact 32-bit floats.
 */

import { dyno, type PackedSplats, Readback } from "@sparkjsdev/spark";
import type { Vec3 } from "@unpictured/core";
import * as THREE from "three";

type FloatAt = (index: dyno.DynoVal<"int">) => dyno.DynoVal<"float">;

/** A shader computing one float per index, packed so it reads back exactly. Spark compiles it on
 * its first read and reuses it after that. */
export function floatReader(valueAt: FloatAt) {
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

export class GpuReadback {
  readonly renderer = new THREE.WebGLRenderer({ antialias: false });
  /** A shader that fails to compile reads back as zeros, which can pass for a real result, so
   * tests check that this stays empty. */
  readonly shaderErrors: string[] = [];
  private readonly readback = new Readback({ renderer: this.renderer });

  constructor() {
    this.renderer.debug.onShaderError = (gl, _program, vertexShader, fragmentShader) => {
      const logs = [vertexShader, fragmentShader].map((shader) => gl.getShaderInfoLog(shader));
      this.shaderErrors.push(logs.join("\n"));
    };
  }

  /** Runs a reader on the GPU and reads its values back. */
  async readFloats(reader: ReturnType<typeof floatReader>, count: number): Promise<number[]> {
    const buffer = this.readback.ensureBuffer(count, new Float32Array(0));
    const renderer = this.renderer;
    const values = await this.readback.renderReadback({
      reader,
      count,
      renderer,
      readback: buffer,
    });
    return Array.from(values.slice(0, count));
  }

  /** Computes one float per index with a new shader and reads the values back. */
  floats(count: number, valueAt: FloatAt): Promise<number[]> {
    return this.readFloats(floatReader(valueAt), count);
  }

  /** Each splat's center and color as the GPU stores them: packing rounds them a little, so
   * reference values must start from these. */
  async splatsAsStored(splats: PackedSplats): Promise<{ centers: Vec3[]; colors: Vec3[] }> {
    const count = splats.numSplats;
    const part = (field: "center" | "rgb", pick: "x" | "y" | "z" | "r" | "g" | "b") =>
      this.floats(count, (index) => {
        const value = dyno.splitGsplat(dyno.readPackedSplat(splats.dyno, index)).outputs[field];
        return dyno.split(value).outputs[pick];
      });
    const [x, y, z, r, g, b] = await Promise.all([
      part("center", "x"),
      part("center", "y"),
      part("center", "z"),
      part("rgb", "r"),
      part("rgb", "g"),
      part("rgb", "b"),
    ]);
    const triple = (a: number[], b: number[], c: number[], i: number): Vec3 => [
      a[i] ?? 0,
      b[i] ?? 0,
      c[i] ?? 0,
    ];
    return {
      centers: x.map((_, i) => triple(x, y, z, i)),
      colors: r.map((_, i) => triple(r, g, b, i)),
    };
  }
}

/** A fixed sequence of numbers from 0 to 1, the same on every run. */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}
