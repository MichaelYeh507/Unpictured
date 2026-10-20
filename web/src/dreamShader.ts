/**
 * The dream look on the GPU: the same steps as core/src/dreamLook.ts (toon bands, then the wash)
 * and core/src/dreamShape.ts (swelling, drift and dissolve), as a Spark modifier that reads each
 * splat's realness.
 */

import { dyno, type GsplatModifier } from "@sparkjsdev/spark";
import {
  checkDreamSettings,
  checkDreamShapeSettings,
  checkRealnessInputs,
  DARKEST,
  DREAM_SETTINGS,
  DREAM_SHAPE_SETTINGS,
  DRIFT_RATES,
  type DreamSettings,
  type DreamShapeSettings,
  LUMA,
  type PhotoCamera,
  type RealnessSettings,
  WAVE_DIRECTION,
} from "@unpictured/core";
import { glslFloat, type RealnessLights, realnessOf, requireName, vec } from "./realnessShader.ts";

/** What the dream look reads besides each splat. Strength and seconds are uniforms: after
 * changing one, call updateVersion() on the SplatMesh. */
export interface DreamInputs {
  cameras: readonly PhotoCamera[];
  /** The photo spot's height above the floor, in raw units. */
  cameraHeight: number;
  realness: RealnessSettings;
  lights: RealnessLights;
  /** How strongly the dream shows: 1 strong, 0.5 subtle. */
  strength: dyno.DynoVal<"float">;
  /** Seconds, for the drift. */
  seconds: dyno.DynoVal<"float">;
}

/** A modifier for a SplatMesh in the raw frame (objectModifier) that draws each splat in the
 * dream look. Inputs are checked here, because Spark builds the shader later, inside its render. */
export function dreamLook(
  inputs: DreamInputs,
  look: DreamSettings = DREAM_SETTINGS,
  shape: DreamShapeSettings = DREAM_SHAPE_SETTINGS,
): GsplatModifier {
  const { cameras, cameraHeight, realness: settings, lights, strength, seconds } = inputs;
  checkRealnessInputs(cameraHeight, settings);
  checkDreamSettings(look);
  checkDreamShapeSettings(shape);
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (gsplat === undefined) {
      throw new Error("dream look: no splat to draw");
    }
    const { center, rgb, scales, opacity, index } = dyno.splitGsplat(gsplat).outputs;
    const realness = realnessOf(center, cameras, cameraHeight, settings, lights);
    const depth = dreamDepthOf(center, realness, strength, cameraHeight, shape);
    return {
      gsplat: dyno.combineGsplat({
        gsplat,
        rgb: dreamColorOf(rgb, realness, strength, look),
        center: driftedCenterOf(center, index, depth, seconds, cameraHeight, shape),
        scales: swollenScalesOf(scales, realness, strength, depth, shape),
        opacity: dissolvedOpacityOf(opacity, depth, shape),
      }),
    };
  });
}

/** A color in the dream look at intensity (1 - realness) times the strength, at most 1
 * (dreamColor in core). */
export function dreamColorOf(
  rgb: dyno.DynoVal<"vec3">,
  realness: dyno.DynoVal<"float">,
  strength: dyno.DynoVal<"float">,
  dream: DreamSettings,
): dyno.DynoVal<"vec3"> {
  checkDreamSettings(dream);
  const node = new dyno.Dyno({
    inTypes: { rgb: "vec3", realness: "float", strength: "float" },
    outTypes: { color: "vec3" },
    inputs: { rgb, realness, strength },
    statements: ({ inputs, outputs }) => {
      const color = requireName(inputs.rgb);
      const bands = glslFloat(dream.bands);
      const soft = glslFloat(dream.bandSoftness);
      return [
        // The toon step: brightness in soft bands, then livelier color.
        `float brightness = dot(${color}, ${vec(LUMA)});`,
        `float steps = brightness * ${bands};`,
        "float band = floor(steps);",
        `float edge = smoothstep(0.5 - ${soft}, 0.5 + ${soft}, steps - band);`,
        `float level = mix(${glslFloat(dream.shadowFloor)}, 1.0, (band + edge) / ${bands});`,
        `vec3 banded = clamp(${color} * (level / max(brightness, ${glslFloat(DARKEST)})), 0.0, 1.0);`,
        `float bandedLuma = dot(banded, ${vec(LUMA)});`,
        `vec3 toon = clamp(mix(vec3(bandedLuma), banded, ${glslFloat(dream.vivid)}), 0.0, 1.0);`,
        // The wash, by how dreamed the splat is.
        `float intensity = ${intensityOf(inputs.realness, inputs.strength)};`,
        `float toonLuma = dot(toon, ${vec(LUMA)});`,
        `float keep = mix(1.0, ${glslFloat(dream.saturation)}, intensity);`,
        "vec3 muted = mix(vec3(toonLuma), toon, keep);",
        `vec3 palette = mix(${vec(dream.pigment)}, ${vec(dream.paper)}, toonLuma);`,
        `vec3 tinted = mix(muted, palette, ${glslFloat(dream.tint)} * intensity);`,
        `float lift = ${glslFloat(dream.paperLift)} * intensity;`,
        `${requireName(outputs.color)} = mix(tinted, ${vec(dream.paper)}, lift);`,
      ];
    },
  });
  return node.outputs.color;
}

/** How deep in the dream a splat is: its intensity times how far it is from the photo spot at
 * the origin (dreamDepth in core). */
export function dreamDepthOf(
  center: dyno.DynoVal<"vec3">,
  realness: dyno.DynoVal<"float">,
  strength: dyno.DynoVal<"float">,
  cameraHeight: number,
  shape: DreamShapeSettings,
): dyno.DynoVal<"float"> {
  const node = new dyno.Dyno({
    inTypes: { center: "vec3", realness: "float", strength: "float" },
    outTypes: { depth: "float" },
    inputs: { center, realness, strength },
    statements: ({ inputs, outputs }) => {
      const away = `length(${requireName(inputs.center)}) / ${glslFloat(cameraHeight)}`;
      const ramp = `smoothstep(${glslFloat(shape.depthNear)}, ${glslFloat(shape.depthFar)}, ${away})`;
      const intensity = intensityOf(inputs.realness, inputs.strength);
      return [`${requireName(outputs.depth)} = ${intensity} * ${ramp};`];
    },
  });
  return node.outputs.depth;
}

/** The PCG hash on the GPU, under its own name so it cannot clash with Spark's. */
const DREAM_HASH_GLSL = `
uint dreamHash(uint value) {
  uint state = value * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
`;

/** A splat's center drifting in a slow wave, held near the floor (dreamShape in core). */
export function driftedCenterOf(
  center: dyno.DynoVal<"vec3">,
  index: dyno.DynoVal<"int">,
  depth: dyno.DynoVal<"float">,
  seconds: dyno.DynoVal<"float">,
  cameraHeight: number,
  shape: DreamShapeSettings,
): dyno.DynoVal<"vec3"> {
  const node = new dyno.Dyno({
    inTypes: { center: "vec3", index: "int", depth: "float", seconds: "float" },
    outTypes: { center: "vec3" },
    inputs: { center, index, depth, seconds },
    globals: () => [DREAM_HASH_GLSL],
    statements: ({ inputs, outputs }) => {
      const point = requireName(inputs.center);
      const depthName = requireName(inputs.depth);
      const height = glslFloat(cameraHeight);
      const [waveX, waveZ] = WAVE_DIRECTION;
      return [
        `float dissolve = smoothstep(${glslFloat(shape.dissolveFrom)}, 1.0, ${depthName});`,
        `float freedom = smoothstep(${glslFloat(shape.floorHold)}, ${glslFloat(shape.floorFree)}, 1.0 - ${point}.y / ${height});`,
        `float reach = ${depthName} * mix(${glslFloat(shape.floorDrift)}, ${glslFloat(shape.drift)}, freedom) * ${height};`,
        `float along = (${point}.x * ${glslFloat(waveX)} + ${point}.z * ${glslFloat(waveZ)}) / (${glslFloat(shape.waveLength)} * ${height});`,
        `uint first = dreamHash(uint(${requireName(inputs.index)}));`,
        "uint second = dreamHash(first);",
        "vec3 randoms = vec3(float(first), float(second), float(dreamHash(second))) / 4294967296.0;",
        `vec3 breaths = ${requireName(inputs.seconds)} / ${glslFloat(shape.period)} * ${vec(DRIFT_RATES)};`,
        "vec3 phase = breaths + along + dissolve * randoms;",
        `${requireName(outputs.center)} = ${point} + reach / ${glslFloat(Math.sqrt(3))} * sin(${glslFloat(2 * Math.PI)} * phase);`,
      ];
    },
  });
  return node.outputs.center;
}

/** Scales swollen by intensity and shrunk toward dust by dissolving (dreamShape in core). */
export function swollenScalesOf(
  scales: dyno.DynoVal<"vec3">,
  realness: dyno.DynoVal<"float">,
  strength: dyno.DynoVal<"float">,
  depth: dyno.DynoVal<"float">,
  shape: DreamShapeSettings,
): dyno.DynoVal<"vec3"> {
  const node = new dyno.Dyno({
    inTypes: { scales: "vec3", realness: "float", strength: "float", depth: "float" },
    outTypes: { scales: "vec3" },
    inputs: { scales, realness, strength, depth },
    statements: ({ inputs, outputs }) => {
      const intensity = intensityOf(inputs.realness, inputs.strength);
      const dissolve = `smoothstep(${glslFloat(shape.dissolveFrom)}, 1.0, ${requireName(inputs.depth)})`;
      return [
        `float size = mix(1.0, ${glslFloat(shape.swell)}, ${intensity}) * mix(1.0, ${glslFloat(shape.dustSize)}, ${dissolve});`,
        `${requireName(outputs.scales)} = ${requireName(inputs.scales)} * size;`,
      ];
    },
  });
  return node.outputs.scales;
}

/** Opacity thinned by dissolving (dreamShape in core). */
export function dissolvedOpacityOf(
  opacity: dyno.DynoVal<"float">,
  depth: dyno.DynoVal<"float">,
  shape: DreamShapeSettings,
): dyno.DynoVal<"float"> {
  const node = new dyno.Dyno({
    inTypes: { opacity: "float", depth: "float" },
    outTypes: { opacity: "float" },
    inputs: { opacity, depth },
    statements: ({ inputs, outputs }) => {
      const dissolve = `smoothstep(${glslFloat(shape.dissolveFrom)}, 1.0, ${requireName(inputs.depth)})`;
      const kept = `mix(1.0, ${glslFloat(shape.dustOpacity)}, ${dissolve})`;
      return [`${requireName(outputs.opacity)} = ${requireName(inputs.opacity)} * ${kept};`];
    },
  });
  return node.outputs.opacity;
}

/** GLSL for dreamIntensity in core: (1 - realness) times the strength, from 0 to 1. */
function intensityOf(realness: string | undefined, strength: string | undefined): string {
  return `clamp((1.0 - ${requireName(realness)}) * ${requireName(strength)}, 0.0, 1.0)`;
}
