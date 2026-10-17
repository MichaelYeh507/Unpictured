/**
 * Camera realness on the GPU: the same steps as photoRealness in core/src/realness.ts, as a
 * Spark modifier that colors each splat from pink (imagined) to blue (seen by a photo).
 */

import { dyno, type GsplatModifier } from "@sparkjsdev/spark";
import { checkRealnessInputs, type PhotoCamera, type RealnessSettings } from "@unpictured/core";

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

/** Realness of a raw-frame point (a splat's center in its own frame) for these photos. */
export function realnessOf(
  center: dyno.DynoVal<"vec3">,
  cameras: readonly PhotoCamera[],
  cameraHeight: number,
  settings: RealnessSettings,
): dyno.DynoVal<"float"> {
  checkRealnessInputs(cameraHeight, settings);
  const node = new dyno.Dyno({
    inTypes: { center: "vec3" },
    outTypes: { realness: "float" },
    inputs: { center },
    globals: () => [PHOTO_REALNESS_GLSL],
    statements: ({ inputs, outputs }) => {
      const point = requireName(inputs.center);
      const realness = requireName(outputs.realness);
      const perPhoto = cameras.map((camera) => photoCall(point, camera, cameraHeight, settings));
      return [
        `${realness} = 0.0;`,
        ...perPhoto.map((call) => `${realness} = max(${realness}, ${call});`),
      ];
    },
  });
  return node.outputs.realness;
}

/** A modifier for a SplatMesh in the raw frame (objectModifier) that shows realness as color. */
export function realnessHeatmap(
  cameras: readonly PhotoCamera[],
  cameraHeight: number,
  settings: RealnessSettings,
): GsplatModifier {
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (gsplat === undefined) {
      throw new Error("realness heatmap: no splat to color");
    }
    const { center } = dyno.splitGsplat(gsplat).outputs;
    const realness = realnessOf(center, cameras, cameraHeight, settings);
    return { gsplat: dyno.combineGsplat({ gsplat, rgb: heatmapColor(realness) }) };
  });
}

/** Pink for imagined through to blue for real. */
export function heatmapColor(realness: dyno.DynoVal<"float">): dyno.DynoVal<"vec3"> {
  const node = new dyno.Dyno({
    inTypes: { realness: "float" },
    outTypes: { rgb: "vec3" },
    inputs: { realness },
    statements: ({ inputs, outputs }) => [
      `${requireName(outputs.rgb)} = mix(${vec(IMAGINED_RGB)}, ${vec(REAL_RGB)}, ${requireName(inputs.realness)});`,
    ],
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
