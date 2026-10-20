# Dream look

The dream look is how a world looks in the game. Every splat is drawn in soft bands of
brightness with livelier color, so the world reads as illustrated rather than photographed (the
toon step). Then, the less real a splat is, the more it takes on the dream's pastel palette and
fades toward the paper (the wash). Realness comes from `docs/REALNESS.md`, so a memory light
repaints the dream around it.

This file is the contract for every implementation: the TypeScript reference
(`core/src/dreamLook.ts`), the shader (`web/src/dreamShader.ts`), and a later Unreal Engine
port.

Version 1 changes color only. Later versions add splat swelling, bleed and dissolve, and the
blank paper where the world runs out.

## Inputs

- **The splat's color**: sRGB from 0 to 1, as the splat files store it.
- **Its realness**, from 0 (imagined) to 1 (real).
- **The strength**: how strongly the dream shows. The viewer has three: strong 1, subtle 0.5 and
  off. In the game the wake meter will scale it (the brief's `wakeMeterScale`), so the dream
  deepens as the meter rises.
- **Settings**, below.

## Formula

`mix(a, b, t)` is GLSL's `a (1 - t) + b t`, and `smoothstep` is GLSL's.

The toon step, the same for every splat:

```
brightness = 0.2126 r + 0.7152 g + 0.0722 b                 Rec. 709 weights
steps      = brightness * bands
band       = floor(steps)
edge       = smoothstep(0.5 - bandSoftness, 0.5 + bandSoftness, steps - band)
level      = mix(shadowFloor, 1, (band + edge) / bands)      the band's brightness
banded     = clamp(color * level / max(brightness, 0.02), 0, 1)
toon       = clamp(mix(brightness of banded, banded, vivid), 0, 1)
```

Brightness snaps to the middle of its band, with a soft edge halfway between bands, so the
result has no jumps (a value just under a band's start gives the same color as one at it). The
color keeps its hue; `vivid` above 1 pushes it away from gray.

The wash, by how dreamed the splat is:

```
intensity = clamp((1 - realness) * strength, 0, 1)
luma      = brightness of toon
keep      = mix(1, saturation, intensity)                   share of the saturation kept
muted     = mix(luma, toon, keep)                           each channel
palette   = mix(pigment, paper, luma)                       dark splats get pigment, light paper
tinted    = mix(muted, palette, tint * intensity)
washed    = mix(tinted, paper, paperLift * intensity)
```

At intensity 0 the wash changes nothing, so what the photos saw shows the toon colors. Off
removes the whole effect, so the splats show exactly as Marble made them.

`bands` must be at least 1, `bandSoftness` above 0 and at most 0.5 (GLSL's smoothstep needs a
real width), `vivid` at least 0, and every other setting and color from 0 to 1.

## Settings

| Setting | Meaning | Value |
| --- | --- | --- |
| `bands` | Bands of brightness | 4 |
| `bandSoftness` | Half the width of the soft edge between bands, as a share of a band | 0.04 |
| `shadowFloor` | The darkest band's brightness | 0.2 |
| `vivid` | Color strength after banding | 1.5 |
| `saturation` | Share of the saturation kept at full intensity | 0.8 |
| `tint` | How far a color moves toward the palette at full intensity | 0.6 |
| `paperLift` | How far a color moves toward the paper at full intensity | 0.25 |
| `paper` | The palette's light end (sRGB) | 1, 0.9, 0.96 |
| `pigment` | The palette's dark end (sRGB) | 0.6, 0.3, 0.65 |

Chosen by eye on 2026-10-20 from look-development screenshots of `sunset-alley` and
`village-road-draft`: the toon settings were the strongest version that kept the photo's view
recognizable, and the palette ("cotton candy", pink to orchid) was picked from six. The brief
plans a palette per level later.

## Viewer

The dream look is the viewer's default view. V switches it between strong, subtle and off; R
swaps to the realness heatmap and back; L, [ and ] place and size test lights, which show in
both. H hides all text and helper lines (grid, axes, photo frames, floor overlay) for clean
screenshots and clips.

## Tests

- The TypeScript reference has worked cases. For the toon step: grays snapping to their band, no
  jump at a band's start, hue kept and color made livelier, clipping at the ends. For the wash: no
  change at intensity 0, saturation, palette and paper lift on their own and together, brightness
  kept. Bad settings are refused.
- A browser test runs the shader in headless Chromium on 1,600 sample splats with random colors
  (100 of them around a light) at strengths 1, 0.5 and 2 (clamped to 1). Each color must match
  the reference to 5 decimal places, and over 50 splats per strength must be partly washed, so
  the soft middle of the fade is covered. The strength changes between reads of one compiled
  shader. At strength 0 only the toon step remains.
