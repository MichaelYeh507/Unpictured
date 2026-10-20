# Dream look

The dream look is how a world looks in the game. Every splat is drawn in soft bands of
brightness with livelier color, so the world reads as illustrated rather than photographed (the
toon step). Then, the less real a splat is, the more it takes on the dream's pastel palette and
fades toward the paper (the wash). The less real a splat is, the more it also swells, so edges
bleed into each other; far from the photo spot it drifts slowly and dissolves toward the paper
behind the world (the shape). Floors hold still, because the player stands on the collider, which
does not move. Realness comes from `docs/REALNESS.md`, so a memory light repaints the dream and
calms it around it.

This file is the contract for every implementation: the TypeScript reference
(`core/src/dreamLook.ts` for color, `core/src/dreamShape.ts` for shape), the shader
(`web/src/dreamShader.ts`), and a later Unreal Engine port.

Version 2 adds the shape and the paper background. The edge of the world (pigment where the
world runs out) comes later.

## Inputs

- **The splat**: its color (sRGB from 0 to 1, as the splat files store it), center, scales,
  opacity and index, in the raw splat frame (y down; every source photo was taken at the origin,
  the photo spot).
- **Its realness**, from 0 (imagined) to 1 (real).
- **The strength**: how strongly the dream shows. The viewer has three: strong 1, subtle 0.5 and
  off. In the game the wake meter will scale it (the brief's `wakeMeterScale`), so the dream
  deepens as the meter rises.
- **The camera height**: the photo spot's height above the floor below it, in raw units.
  Distances below are in camera heights, as in `docs/REALNESS.md`.
- **The time** in seconds, for the drift.
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
banded     = clamp(color * (level / max(brightness, 0.02)), 0, 1)
toon       = clamp(mix(brightness of banded, banded, vivid), 0, 1)
```

Brightness rounds to the nearest of `bands + 1` levels (0, 1/bands, ... 1, then lifted by the
shadow floor), with a soft edge halfway between two levels, so the result has no jumps (a value
just under a whole step gives the same color as one at it). The color keeps its hue; `vivid`
above 1 pushes it away from gray.

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

`bands` must be a whole number, at least 1 (otherwise the top level passes 1),
`bandSoftness` above 0 and at most 0.5 (GLSL's smoothstep needs a real width), `vivid` at
least 0, and every other setting and color from 0 to 1.

## Shape

The shape uses the same intensity as the wash. Swelling follows the intensity alone, but drift
and dissolve follow the dream's depth, which also grows with distance from the photo spot: just
outside the photo's frame realness is already 0, and the deep dream should start far away, not
one step behind the photo spot.

```
h         = camera height
depth     = intensity * smoothstep(depthNear, depthFar, length(center) / h)
dissolve  = smoothstep(dissolveFrom, 1, depth)
height    = 1 - center.y / h                        above the floor under the photo spot
freedom   = smoothstep(floorHold, floorFree, height) 0 on the floor, 1 well above it
reach     = depth * mix(floorDrift, drift, freedom) * h
along     = (0.8 center.x + 0.6 center.z) / (waveLength * h)
random    = three numbers from 0 to 1 per splat, from its index (below)
phase     = seconds / period * (1, 0.75, 1.25) + along + dissolve * random     per axis
center'   = center + reach / sqrt(3) * sin(2 pi phase)                         per axis
scales'   = scales * mix(1, swell, intensity) * mix(1, dustSize, dissolve)
opacity'  = opacity * mix(1, dustOpacity, dissolve)
```

- **Drift**: every splat moves in a slow loop around its place, never farther than `reach`
  (each axis stays within `reach / sqrt(3)`). `along` makes neighbors move together, so surfaces
  breathe as one wave; as a splat dissolves, `random` scatters it like dust. The axes turn at
  rates 1, 0.75 and 1.25, so the drift repeats every 4 periods (the viewer wraps its clock there,
  which keeps the shader's time small and precise).
- **Floors hold still**: splats less than `floorHold` above the floor under the photo spot (or
  below it) move at most `floorDrift`, under the collider's precision of about 5 cm, so feet meet
  the floor that is drawn. On slopes and stairs away from the photo spot's floor height, floor
  splats may drift a little more.
- **Dissolve**: deep in the dream, splats shrink toward dust and thin out, and the paper
  background shows through. Floors dissolve too, but they never move more than `floorDrift`.
- **Random numbers**: `first = pcg(index)`, `second = pcg(first)`, `third = pcg(second)`, each
  turned into a 32-bit float and divided by 2^32, where `pcg` is the PCG hash from Jarzynski and
  Olano, "Hash Functions for GPU Rendering" (2020), on unsigned 32-bit numbers:

  ```
  state = value * 747796405 + 2891336453
  word  = ((state >> ((state >> 28) + 4)) ^ state) * 277803737
  pcg   = (word >> 22) ^ word
  ```

At intensity 0 the shape is unchanged; within `depthNear` of the photo spot a dreamed splat only
swells. Every setting must be finite; `swell`, `period` and `waveLength` above 0; `drift` and
`floorDrift` at least 0; `0 <= depthNear < depthFar`; `floorHold < floorFree`;
`0 <= dissolveFrom < 1`; `dustSize` and `dustOpacity` from 0 to 1.

## Settings

| Setting | Meaning | Value |
| --- | --- | --- |
| `bands` | Whole bands of brightness: `bands + 1` levels | 4 |
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

The shape's settings (distances in camera heights; at a 1.6 m camera height, 0.0125 is 2 cm and
0.15 is 24 cm):

| Setting | Meaning | Value |
| --- | --- | --- |
| `swell` | Splat size at full intensity, as a multiple | 1.2 |
| `depthNear` | Depth starts this far from the photo spot | 2 |
| `depthFar` | Depth is full from this far (realness's `farLimit`) | 25 |
| `drift` | Farthest drift at full depth | 0.15 |
| `floorDrift` | Farthest drift of a floor splat at full depth | 0.0125 |
| `floorHold` | Splats up to this height above the floor are floor | 0.1 |
| `floorFree` | Splats from this height up drift freely | 0.25 |
| `period` | Seconds for one breath | 6 |
| `waveLength` | Length of the drift's wave | 3 |
| `dissolveFrom` | Depth where dissolving starts | 0.6 |
| `dustSize` | Size left when fully dissolved | 0.5 |
| `dustOpacity` | Opacity left when fully dissolved | 0.6 |

Decided on 2026-10-20: the swelling from the same look-development screenshots; floors holding
to about 2 cm and the rest drifting up to about 25 cm, with depth from distance; and, from
screenshots of `sunset-alley` and a short animation, the paper background and the drift kept
subtle.

## Viewer

The dream look is the viewer's default view. V switches it between strong, subtle and off (and
from the heatmap, back to the dream look); R swaps to the realness heatmap and back; L, [ and ]
place and size test lights, which show in the dream look and the heatmap but not with the dream
off. H hides everything but the world (text, grid, axes, photo frames and overlays, floor
overlay) for clean screenshots and clips.

While the dream look is shown, the background is the dream's paper color, so dissolving splats
fade into paper; off and the heatmap keep the dark gray background. The drift moves on every
frame, so every splat is recomputed every frame: on a laptop's integrated GPU (AMD Radeon 780M,
1.92 million splats at 1536 x 1152) the median frame went from 20.5 ms still to 25.8 ms drifting,
and recomputing without moving took 25.7 ms, so nearly all of the cost is the recomputing. The
heatmap and the dream off do not move.

## Tests

- The TypeScript reference has worked cases. For the toon step: grays snapping to their band, no
  jump at a band's start, hue kept and color made livelier, clipping at the ends. For the wash: no
  change at intensity 0, saturation, palette and paper lift on their own and together, brightness
  kept. Bad settings are refused.
- A browser test runs the shader in headless Chromium on 1,600 sample splats with random colors
  (100 of them around a light) at strengths 1, 0.5 and 2 (clamped to 1). Each color must match
  the reference to 5 decimal places, and over 50 splats per strength must be partly washed, so
  the soft middle of the fade is covered. The strength changes between reads of one compiled
  shader, and no new shader program appears. At strength 0 only the toon step remains. Over 20
  of the random colors must sit on a soft edge between two toon bands, where the step is
  steepest.
- The shape's reference has worked cases from an independent Python calculation (a splat in the
  middle distance, one far away and fully dissolved, one far away on the floor), plus checks
  that floors hold, the drift stays within its reach and uses it, nothing changes at intensity 0,
  only swelling near the photo spot, the loop repeats after 4 periods and not before, and bad
  settings are refused. The PCG hash has worked values.
- A browser test runs the shader on 1,900 sample splats (300 of them on the floor, 100 around
  the light) with random sizes and opacities, at strengths 1 and 0.5 and at 0, 7.3 and 23.9
  seconds. Centers must match the reference to 4 decimal places, sizes to 5 (as a ratio), and
  opacities to 5. At strength 1 over 30 splats must be partly dissolved and over 30 deep floor
  splats must stay within the floor drift. Time and strength change between reads of one
  compiled shader.
