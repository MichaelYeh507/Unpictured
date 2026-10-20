/**
 * The dream look on the GPU: the same steps as core/src/dreamLook.ts (toon bands, then the wash),
 * as a Spark modifier that reads each splat's realness.
 */

import { dyno, type GsplatModifier } from "@sparkjsdev/spark";
import {
  checkDreamSettings,
  checkRealnessInputs,
  DARKEST,
  type DreamSettings,
  LUMA,
  type PhotoCamera,
  type RealnessSettings,
} from "@unpictured/core";
import { glslFloat, type RealnessLights, realnessOf, requireName, vec } from "./realnessShader.ts";

/** A modifier for a SplatMesh in the raw frame (objectModifier) that draws each splat in the
 * dream look. The strength is a uniform: after changing it, call updateVersion() on the
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
      throw new Error("dream look: no splat to draw");
    }
    const { center, rgb } = dyno.splitGsplat(gsplat).outputs;
    const realness = realnessOf(center, cameras, cameraHeight, settings, lights);
    const color = dreamColorOf(rgb, realness, strength, dream);
    return { gsplat: dyno.combineGsplat({ gsplat, rgb: color }) };
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
      const notReal = `1.0 - ${requireName(inputs.realness)}`;
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
        `float intensity = clamp((${notReal}) * ${requireName(inputs.strength)}, 0.0, 1.0);`,
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
