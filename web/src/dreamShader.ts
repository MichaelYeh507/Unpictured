/**
 * The dream look on the GPU: the same wash as core/src/dreamLook.ts, as a Spark modifier that
 * reads each splat's realness and washes its color toward pigment and paper.
 */

import { dyno, type GsplatModifier } from "@sparkjsdev/spark";
import {
  checkDreamSettings,
  checkRealnessInputs,
  type DreamSettings,
  LUMA,
  type PhotoCamera,
  type RealnessSettings,
} from "@unpictured/core";
import { glslFloat, type RealnessLights, realnessOf, requireName, vec } from "./realnessShader.ts";

/** A modifier for a SplatMesh in the raw frame (objectModifier) that washes each splat by how
 * dreamed it is. The strength is a uniform: after changing it, call updateVersion() on the
 * SplatMesh. Inputs are checked here, because Spark builds the shader later, inside its render. */
export function dreamLook(
  cameras: readonly PhotoCamera[],
  cameraHeight: number,
  settings: RealnessSettings,
  lights: RealnessLights,
  strength: dyno.DynoVal<"float">,
  dream: DreamSettings,
): GsplatModifier {
  checkRealnessInputs(cameraHeight, settings);
  checkDreamSettings(dream);
  return dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (gsplat === undefined) {
      throw new Error("dream look: no splat to wash");
    }
    const { center, rgb } = dyno.splitGsplat(gsplat).outputs;
    const realness = realnessOf(center, cameras, cameraHeight, settings, lights);
    const washed = washedColor(rgb, realness, strength, dream);
    return { gsplat: dyno.combineGsplat({ gsplat, rgb: washed }) };
  });
}

/** A color washed at intensity (1 - realness) times the strength, at most 1 (washColor in core). */
export function washedColor(
  rgb: dyno.DynoVal<"vec3">,
  realness: dyno.DynoVal<"float">,
  strength: dyno.DynoVal<"float">,
  dream: DreamSettings,
): dyno.DynoVal<"vec3"> {
  checkDreamSettings(dream);
  const node = new dyno.Dyno({
    inTypes: { rgb: "vec3", realness: "float", strength: "float" },
    outTypes: { washed: "vec3" },
    inputs: { rgb, realness, strength },
    statements: ({ inputs, outputs }) => {
      const color = requireName(inputs.rgb);
      const notReal = `1.0 - ${requireName(inputs.realness)}`;
      return [
        `float intensity = clamp((${notReal}) * ${requireName(inputs.strength)}, 0.0, 1.0);`,
        `float luma = dot(${color}, ${vec(LUMA)});`,
        `float keep = mix(1.0, ${glslFloat(dream.saturation)}, intensity);`,
        `vec3 muted = mix(vec3(luma), ${color}, keep);`,
        `vec3 wash = mix(${vec(dream.pigment)}, ${vec(dream.paper)}, luma);`,
        `vec3 tinted = mix(muted, wash, ${glslFloat(dream.tint)} * intensity);`,
        `float lift = ${glslFloat(dream.paperLift)} * intensity;`,
        `${requireName(outputs.washed)} = mix(tinted, ${vec(dream.paper)}, lift);`,
      ];
    },
  });
  return node.outputs.washed;
}
