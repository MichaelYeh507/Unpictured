import { dyno, PackedSplats } from "@sparkjsdev/spark";
import {
  DREAM_SETTINGS,
  dreamColor,
  dreamIntensity,
  type MemoryLight,
  parseCameraFile,
  REALNESS_SETTINGS,
  realness,
  toonColor,
} from "@unpictured/core";
import * as THREE from "three";
import { afterAll, afterEach, expect, test } from "vitest";
import { dreamLook } from "./dreamShader.ts";
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

/** Splats with random colors across the realness fade (and around the light), in the raw frame. */
function sampleSplats(): PackedSplats {
  const splats = new PackedSplats();
  const random = seededRandom(54321);
  const spread = () => random() * 2 - 1;
  const addSplat = (x: number, y: number, z: number) => {
    const size = new THREE.Vector3(0.01, 0.01, 0.01);
    const color = new THREE.Color(random(), random(), random());
    splats.pushSplat(new THREE.Vector3(x, y, z), size, new THREE.Quaternion(), 1, color);
  };
  const reach = 30 * cameraHeight; // past farLimit, so the whole fade is sampled
  for (let i = 0; i < 1500; i++) {
    addSplat(spread() * reach, spread() * reach * 0.3, spread() * reach);
  }
  for (const { position, radius } of lightList) {
    const [x, y, z] = position;
    for (let i = 0; i < 100; i++) {
      addSplat(x + spread() * radius, y + spread() * radius, z + spread() * radius);
    }
  }
  return splats;
}

test("the dream look washes sample splats as the reference does, at every strength", async () => {
  const splats = sampleSplats();
  const count = splats.numSplats;
  const { centers, colors } = await gpu.splatsAsStored(splats);
  const lights = new RealnessLights();
  lights.set(lightList, REALNESS_SETTINGS);
  const strength = dyno.dynoFloat(1);
  const look = dreamLook(
    cameras,
    cameraHeight,
    REALNESS_SETTINGS,
    lights,
    strength,
    DREAM_SETTINGS,
  );

  // One reader per channel, built once: the strength changes between reads without a rebuild.
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

  for (const level of [1, 0.5, 2]) {
    strength.value = level;
    const shown = await readColors();
    let partly = 0;
    for (const [i, center] of centers.entries()) {
      const seen = realness(center, cameras, cameraHeight, lightList, REALNESS_SETTINGS);
      const intensity = dreamIntensity(seen, level);
      const expected = dreamColor(colors[i] ?? [0, 0, 0], intensity, DREAM_SETTINGS);
      expected.forEach((value, channel) => {
        expect(shown[i]?.[channel], `strength ${level}, splat ${i}`).toBeCloseTo(value, 5);
      });
      if (intensity > 0.01 && intensity < 0.99) {
        partly += 1;
      }
    }
    // The sample must reach the soft edges, not only the plainly seen and plainly dreamed.
    expect(partly, `strength ${level}`).toBeGreaterThan(50);
  }

  // Strength 0 leaves only the toon step (the viewer's "off" removes the modifier instead).
  strength.value = 0;
  const toonOnly = await readColors();
  for (const [i, color] of colors.entries()) {
    toonColor(color, DREAM_SETTINGS).forEach((value, channel) => {
      expect(toonOnly[i]?.[channel], `strength 0, splat ${i}`).toBeCloseTo(value, 5);
    });
  }
});

test("the dream look refuses bad inputs when it is made, not later inside Spark's render", () => {
  const lights = new RealnessLights();
  const strength = dyno.dynoFloat(1);
  expect(() => dreamLook(cameras, 0, REALNESS_SETTINGS, lights, strength, DREAM_SETTINGS)).toThrow(
    /camera height/,
  );
  const badDream = { ...DREAM_SETTINGS, paperLift: 2 };
  expect(() =>
    dreamLook(cameras, cameraHeight, REALNESS_SETTINGS, lights, strength, badDream),
  ).toThrow(/0 to 1/);
});
