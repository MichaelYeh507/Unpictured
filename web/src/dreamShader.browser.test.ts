import { dyno, PackedSplats } from "@sparkjsdev/spark";
import {
  DREAM_SETTINGS,
  DREAM_SHAPE_SETTINGS,
  dreamColor,
  dreamDepth,
  dreamIntensity,
  dreamShape,
  floorFreedom,
  LUMA,
  type MemoryLight,
  parseCameraFile,
  REALNESS_SETTINGS,
  realness,
  smoothstep,
  toonColor,
  type Vec3,
} from "@unpictured/core";
import * as THREE from "three";
import { afterAll, afterEach, expect, test } from "vitest";
import { type DreamInputs, dreamLook } from "./dreamShader.ts";
import { floatReader, GpuReadback, seededRandom } from "./gpuReadback.ts";
import { RealnessLights } from "./realnessShader.ts";

const gpu = new GpuReadback();
afterAll(() => gpu.renderer.dispose());
afterEach(() => {
  expect(gpu.shaderErrors, "shader compile errors").toEqual([]);
});

// One photo looking straight ahead from the origin, and one light off to its left.
const cameras = parseCameraFile({
  frame: "marble_raw_opencv",
  cameras: [
    {
      photo: "source.jpg",
      match_score: 1,
      yaw_deg: 0,
      pitch_deg: 0,
      position: [0, 0, 0],
      image_size: [4000, 3000],
      fx: 2000,
      fy: 2000,
      cx: 2000,
      cy: 1500,
    },
  ],
});
const cameraHeight = 1.5;
const lightList: MemoryLight[] = [{ position: [-20, 0, 5], radius: 4 * cameraHeight }];

/** The dream look's inputs, with fresh uniforms for strength, seconds and coldness. */
type Uniform = ReturnType<typeof dyno.dynoFloat>;
function inputs(): DreamInputs & { strength: Uniform; seconds: Uniform; coldness: Uniform } {
  const lights = new RealnessLights();
  lights.set(lightList, REALNESS_SETTINGS);
  return {
    cameras,
    cameraHeight,
    realness: REALNESS_SETTINGS,
    lights,
    strength: dyno.dynoFloat(1),
    seconds: dyno.dynoFloat(0),
    coldness: dyno.dynoFloat(0),
  };
}

/** Random splats across the realness fade and the dream's depth, on the floor and above it, and
 * around the light, in the raw frame (the floor under the photo spot is at y = cameraHeight). */
function sampleSplats(): PackedSplats {
  const splats = new PackedSplats();
  const random = seededRandom(54321);
  const spread = () => random() * 2 - 1;
  const addSplat = (x: number, y: number, z: number) => {
    const size = new THREE.Vector3(0.005, 0.005, 0.005).addScalar(random() * 0.05);
    const color = new THREE.Color(random(), random(), random());
    const opacity = 0.1 + 0.9 * random();
    splats.pushSplat(new THREE.Vector3(x, y, z), size, new THREE.Quaternion(), opacity, color);
  };
  const reach = 30 * cameraHeight; // past farLimit and depthFar, so both fades are sampled
  for (let i = 0; i < 1500; i++) {
    addSplat(spread() * reach, spread() * reach * 0.3, spread() * reach);
  }
  for (let i = 0; i < 300; i++) {
    addSplat(spread() * reach, cameraHeight * (1 + spread() * 0.05), spread() * reach);
  }
  for (const { position, radius } of lightList) {
    const [x, y, z] = position;
    for (let i = 0; i < 100; i++) {
      addSplat(x + spread() * radius, y + spread() * radius, z + spread() * radius);
    }
  }
  return splats;
}

test("the dream look washes sample splats as the reference does, at every strength and coldness", async () => {
  const splats = sampleSplats();
  const count = splats.numSplats;
  const { centers, colors } = await gpu.splatsAsStored(splats);
  const dream = inputs();
  const look = dreamLook(dream, DREAM_SETTINGS);

  // One reader per channel, built once: strength and coldness change between reads without a
  // rebuild.
  const channelReader = (pick: "r" | "g" | "b") =>
    floatReader((index) => {
      const splat = dyno.readPackedSplat(splats.dyno, index);
      const washed = look.apply({ gsplat: splat }).gsplat;
      return dyno.split(dyno.splitGsplat(washed).outputs.rgb).outputs[pick];
    });
  const readers = [channelReader("r"), channelReader("g"), channelReader("b")];
  const readColors = async () => {
    const [r, g, b] = await Promise.all(readers.map((reader) => gpu.readFloats(reader, count)));
    return colors.map((_, i) => [r?.[i], g?.[i], b?.[i]]);
  };

  let programs: number | undefined;
  const settings: [number, number][] = [
    [1, 0],
    [0.5, 0.3],
    [2, 1],
    [1, 0.75],
  ];
  for (const [level, coldness] of settings) {
    dream.strength.value = level;
    dream.coldness.value = coldness;
    const shown = await readColors();
    programs ??= gpu.renderer.info.programs?.length;
    let partly = 0;
    for (const [i, center] of centers.entries()) {
      const seen = realness(center, cameras, cameraHeight, lightList, REALNESS_SETTINGS);
      const intensity = dreamIntensity(seen, level);
      const rgb = colors[i] ?? [0, 0, 0];
      const expected = dreamColor(rgb, intensity, DREAM_SETTINGS, coldness);
      const label = `strength ${level}, coldness ${coldness}, splat ${i}`;
      expected.forEach((value, channel) => {
        expect(shown[i]?.[channel], label).toBeCloseTo(value, 5);
      });
      if (intensity > 0.01 && intensity < 0.99) {
        partly += 1;
      }
    }
    // The sample must reach the soft edges, not only the plainly seen and plainly dreamed.
    expect(partly, `strength ${level}, coldness ${coldness}`).toBeGreaterThan(50);
  }

  // Strength 0 leaves only the toon step (the viewer's "off" removes the modifier instead).
  dream.strength.value = 0;
  const toonOnly = await readColors();
  for (const [i, color] of colors.entries()) {
    toonColor(color, DREAM_SETTINGS).forEach((value, channel) => {
      expect(toonOnly[i]?.[channel], `strength 0, splat ${i}`).toBeCloseTo(value, 5);
    });
  }
  expect(gpu.renderer.info.programs?.length, "shader programs").toBe(programs);

  // Some colors must sit on the soft edge between two toon bands, where the step is steepest.
  const { bands, bandSoftness } = DREAM_SETTINGS;
  const onEdge = colors.filter(([r, g, b]) => {
    const steps = (r * LUMA[0] + g * LUMA[1] + b * LUMA[2]) * bands;
    return Math.abs(steps - Math.floor(steps) - 0.5) < bandSoftness;
  }).length;
  expect(onEdge).toBeGreaterThan(20);
});

test("the dream look swells, drifts and dissolves sample splats as the reference does", async () => {
  const splats = sampleSplats();
  const count = splats.numSplats;
  const stored = await gpu.splatsAsStored(splats);
  const dream = inputs();
  const shape = DREAM_SHAPE_SETTINGS;
  const look = dreamLook(dream, DREAM_SETTINGS, shape);

  // One reader per value, built once: strength and time change between reads without a rebuild.
  const shaped = (index: dyno.DynoVal<"int">) =>
    dyno.splitGsplat(look.apply({ gsplat: dyno.readPackedSplat(splats.dyno, index) }).gsplat)
      .outputs;
  const vectorReader = (field: "center" | "scales", pick: "x" | "y" | "z") =>
    floatReader((index) => dyno.split(shaped(index)[field]).outputs[pick]);
  const readers = [
    vectorReader("center", "x"),
    vectorReader("center", "y"),
    vectorReader("center", "z"),
    vectorReader("scales", "x"),
    vectorReader("scales", "y"),
    vectorReader("scales", "z"),
    floatReader((index) => shaped(index).opacity),
  ];
  const at = (values: (number[] | undefined)[], first: number, i: number): Vec3 => [
    values[first]?.[i] ?? Number.NaN,
    values[first + 1]?.[i] ?? Number.NaN,
    values[first + 2]?.[i] ?? Number.NaN,
  ];

  let programs: number | undefined;
  for (const level of [1, 0.5]) {
    for (const seconds of [0, 7.3, 23.9]) {
      dream.strength.value = level;
      dream.seconds.value = seconds;
      const values = await Promise.all(readers.map((reader) => gpu.readFloats(reader, count)));
      programs ??= gpu.renderer.info.programs?.length;
      const label = `strength ${level}, ${seconds} s`;
      let deepening = 0;
      let dissolving = 0;
      let mostDissolved = 0;
      let heldFloor = 0;
      for (const [i, center] of stored.centers.entries()) {
        const splat = {
          center,
          scales: stored.scales[i] ?? [0, 0, 0],
          opacity: stored.opacities[i] ?? 0,
        };
        const seen = realness(center, cameras, cameraHeight, lightList, REALNESS_SETTINGS);
        const intensity = dreamIntensity(seen, level);
        const expected = dreamShape(splat, i, intensity, seconds, cameraHeight, shape);
        const shownCenter = at(values, 0, i);
        expected.center.forEach((value, axis) => {
          expect(shownCenter[axis], `${label}, splat ${i} center`).toBeCloseTo(value, 4);
        });
        expected.scales.forEach((value, axis) => {
          const ratio = (at(values, 3, i)[axis] ?? Number.NaN) / value;
          expect(ratio, `${label}, splat ${i} scales`).toBeCloseTo(1, 5);
        });
        expect(values[6]?.[i], `${label}, splat ${i} opacity`).toBeCloseTo(expected.opacity, 5);

        const depth = dreamDepth(intensity, center, cameraHeight, shape);
        deepening += depth > 0.01 && depth < 0.99 ? 1 : 0;
        const dissolve = smoothstep(shape.dissolveFrom, 1, depth);
        dissolving += dissolve > 0.01 && dissolve < 0.99 ? 1 : 0;
        mostDissolved = Math.max(mostDissolved, dissolve);
        if (floorFreedom(center, cameraHeight, shape) === 0 && depth > 0.5) {
          heldFloor += 1;
          const [dx, dy, dz] = shownCenter.map((value, axis) => value - (center[axis] ?? 0));
          const moved = Math.hypot(dx ?? 0, dy ?? 0, dz ?? 0);
          expect(moved, `${label}, floor splat ${i}`).toBeLessThan(
            shape.floorDrift * cameraHeight + 1e-5,
          );
        }
      }
      // The sample must cover the soft parts of both ramps, and deep floor splats. At half
      // strength the depth stays below dissolveFrom, so nothing dissolves.
      expect(deepening, label).toBeGreaterThan(100);
      if (level === 1) {
        expect(dissolving, label).toBeGreaterThan(30);
        expect(heldFloor, label).toBeGreaterThan(30);
      } else {
        expect(mostDissolved, label).toBe(0);
      }
    }
  }
  expect(gpu.renderer.info.programs?.length, "shader programs").toBe(programs);
});

test("the dream look refuses bad inputs when it is made, not later inside Spark's render", () => {
  expect(() => dreamLook({ ...inputs(), cameraHeight: 0 })).toThrow(/camera height/);
  const badLook = { ...DREAM_SETTINGS, paperLift: 2 };
  expect(() => dreamLook(inputs(), badLook)).toThrow(/0 to 1/);
  const badShape = { ...DREAM_SHAPE_SETTINGS, floorFree: DREAM_SHAPE_SETTINGS.floorHold };
  expect(() => dreamLook(inputs(), DREAM_SETTINGS, badShape)).toThrow(/floorHold/);
});
