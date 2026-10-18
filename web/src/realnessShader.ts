/**
 * Realness on the GPU: the same steps as core/src/realness.ts, as a Spark modifier that colors
 * each splat from pink (imagined) to blue (seen by a photo or near a memory light).
 */

import { dyno, type GsplatModifier } from "@sparkjsdev/spark";
import {
  checkLights,
  checkRealnessInputs,
  MAX_LIGHTS,
  type MemoryLight,
  type PhotoCamera,
  type RealnessSettings,
} from "@unpictured/core";

/** The walkable floor's colors (walkableFloor.ts), as sRGB like the splats' own colors. */
const REAL_RGB = [0x4a / 255, 0x9e / 255, 0xff / 255];
const IMAGINED_RGB = [0xff / 255, 0x5a / 255, 0xb4 / 255];

/** turnTilt holds cos and sin of yaw, then cos and sin of pitch; lens holds fx, fy, cx, cy. */
const PHOTO_REALNESS_GLSL = `
float photoRealness(vec3 point, vec3 position, vec4 turnTilt, vec4 lens, vec2 imageSize,
                    float cameraHeight, vec3 settings) {
  vec3 offset = point - position;
  float unturnedX = offset.x * turnTilt.x - offset.z * turnTilt.y;
  float unturnedZ = offset.x * turnTilt.y + offset.z * turnTilt.x;
  vec3 ray = vec3(
    unturnedX,
    offset.y * turnTilt.z + unturnedZ * turnTilt.w,
    -offset.y * turnTilt.w + unturnedZ * turnTilt.z
  );
  if (ray.z <= 0.0) {
    return 0.0;
  }
  float u = (lens.x * (ray.x / ray.z) + lens.z) / imageSize.x;
  float v = (lens.y * (ray.y / ray.z) + lens.w) / imageSize.y;
  float edge = min(min(u, 1.0 - u), min(v, 1.0 - v));
  float inFrame = smoothstep(-settings.x, settings.x, edge);
  float away = length(ray) / cameraHeight;
  float inRange = 1.0 - smoothstep(settings.y, settings.z, away);
  return inFrame * inRange;
}
`;

/** The memory lights as shader uniforms: up to MAX_LIGHTS of (x, y, z, radius) in the raw
 * frame. Lights change while the world is shown, so unlike the cameras they are not compiled in;
 * after set(), the SplatMesh needs updateVersion() to redraw. */
export class RealnessLights {
  private readonly values = new Float32Array(MAX_LIGHTS * 4);
  readonly array = new dyno.DynoUniform({
    key: "lights",
    type: "vec4",
    count: MAX_LIGHTS,
    value: this.values,
  });
  readonly count = dyno.dynoInt(0);
  private current: MemoryLight[] = [];

  get lights(): readonly MemoryLight[] {
    return this.current;
  }

  /** Slots past the count keep old lights: the shader stops at the count, which a test checks. */
  set(lights: readonly MemoryLight[], settings: RealnessSettings): void {
    checkLights(lights, settings);
    lights.forEach(({ position, radius }, index) => {
      this.values.set([...position, radius], index * 4);
    });
    this.count.value = lights.length;
    this.current = [...lights];
  }
}

/** Realness of a raw-frame point (a splat's center in its own frame) for these photos and
 * lights. */
export function realnessOf(
  center: dyno.DynoVal<"vec3">,
  cameras: readonly PhotoCamera[],
  cameraHeight: number,
  settings: RealnessSettings,
  lights: RealnessLights,
): dyno.DynoVal<"float"> {
  checkRealnessInputs(cameraHeight, settings);
  const node = new dyno.Dyno({
    inTypes: { center: "vec3", lights: "vec4", lightCount: "int" },
    outTypes: { realness: "float" },
    inputs: { center, lights: lights.array, lightCount: lights.count },
    globals: () => [PHOTO_REALNESS_GLSL],
    statements: ({ inputs, outputs }) => {
      const point = requireName(inputs.center);
      const realness = requireName(outputs.realness);
      const array = requireName(inputs.lights);
      const count = requireName(inputs.lightCount);
      const perPhoto = cameras.map((camera) => photoCall(point, camera, cameraHeight, settings));
      const core = glslFloat(settings.lightCore);
      return [
        `${realness} = 0.0;`,
        ...perPhoto.map((call) => `${realness} = max(${realness}, ${call});`),
        `for (int i = 0; i < ${MAX_LIGHTS}; i++) {`,
        `  if (i >= ${count}) {`,
        "    break;",
        "  }",
        `  vec4 light = ${array}[i];`,
        `  float away = length(${point} - light.xyz);`,
        `  ${realness} = max(${realness}, 1.0 - smoothstep(${core} * light.w, light.w, away));`,
        "}",
      ];
    },
  });
  return node.outputs.realness;
}

/** A modifier for a SplatMesh in the raw frame (objectModifier) that shows realness as color.
 * The inputs are checked here, because Spark builds the shader later, inside its render. */
export function realnessHeatmap(
  cameras: readonly PhotoCamera[],
  cameraHeight: number,
  settings: RealnessSettings,
  lights: RealnessLights,
): GsplatModifier {
  checkRealnessInputs(cameraHeight, settings);
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (gsplat === undefined) {
      throw new Error("realness heatmap: no splat to color");
    }
    const { center, rgb } = dyno.splitGsplat(gsplat).outputs;
    const realness = realnessOf(center, cameras, cameraHeight, settings, lights);
    return { gsplat: dyno.combineGsplat({ gsplat, rgb: heatmapColor(realness, rgb) }) };
  });
}

/** Pink for imagined through to blue for real, shaded by the splat's own brightness so the
 * scene stays readable (white keeps the pure heat color). */
export function heatmapColor(
  realness: dyno.DynoVal<"float">,
  original: dyno.DynoVal<"vec3">,
): dyno.DynoVal<"vec3"> {
  const node = new dyno.Dyno({
    inTypes: { realness: "float", original: "vec3" },
    outTypes: { rgb: "vec3" },
    inputs: { realness, original },
    statements: ({ inputs, outputs }) => {
      const heat = `mix(${vec(IMAGINED_RGB)}, ${vec(REAL_RGB)}, ${requireName(inputs.realness)})`;
      const brightness = `dot(${requireName(inputs.original)}, vec3(0.2126, 0.7152, 0.0722))`;
      return [`${requireName(outputs.rgb)} = ${heat} * (0.35 + 0.65 * ${brightness});`];
    },
  });
  return node.outputs.rgb;
}

/** Spark names only the inputs and outputs something uses; a missing one would write the word
 * "undefined" into the shader, which then fails to compile and reads back as zeros. */
function requireName(name: string | undefined): string {
  if (name === undefined) {
    throw new Error("realness shader: an input or output was not connected");
  }
  return name;
}

function photoCall(
  point: string,
  camera: PhotoCamera,
  cameraHeight: number,
  settings: RealnessSettings,
): string {
  const turn = (camera.yawDeg * Math.PI) / 180;
  const tilt = (camera.pitchDeg * Math.PI) / 180;
  const turnTilt = [Math.cos(turn), Math.sin(turn), Math.cos(tilt), Math.sin(tilt)];
  const lens = [camera.fx, camera.fy, camera.cx, camera.cy];
  const parts = [
    point,
    vec(camera.position),
    vec(turnTilt),
    vec(lens),
    vec(camera.imageSize),
    glslFloat(cameraHeight),
    vec([settings.margin, settings.nearOk, settings.farLimit]),
  ];
  return `photoRealness(${parts.join(", ")})`;
}

function vec(values: readonly number[]): string {
  return `vec${values.length}(${values.map(glslFloat).join(", ")})`;
}

/** A GLSL float literal: integers need a decimal point ("2.0"), and JavaScript's shortest
 * round-trip form ("0.1", "1e-7") is otherwise valid GLSL. */
export function glslFloat(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`cannot write ${value} into a shader`);
  }
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
