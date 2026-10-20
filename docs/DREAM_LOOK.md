# Dream look

The dream look is how a world looks in the game: what the photos saw keeps its true colors, and
the less real a splat is, the more it washes toward the paper, like thinned watercolor. It is
driven by realness (`docs/REALNESS.md`), so a memory light repaints the dream around it.

This file is the contract for every implementation: the TypeScript reference
(`core/src/dreamLook.ts`), the shader (`web/src/dreamShader.ts`), and a later Unreal Engine
port.

Version 1 is the color wash only. Later versions add splat swelling, bleed and dissolve, and the
blank paper where the world runs out.

## Inputs

- **The splat's color**: sRGB from 0 to 1, as the splat files store it.
- **Its realness**, from 0 (imagined) to 1 (real).
- **The strength**: how strongly the dream shows. The viewer has three: strong 1, subtle 0.5 and
  off. In the game the wake meter will scale it (the brief's `wakeMeterScale`), so the dream
  deepens as the meter rises.
- **Settings**: `saturation`, `paperLift` and `paper`, below.

## Formula

```
intensity = clamp((1 - realness) * strength, 0, 1)
luma      = 0.2126 r + 0.7152 g + 0.0722 b                  brightness (Rec. 709 weights)
keep      = mix(1, saturation, intensity)                   share of the saturation kept
muted     = mix(luma, color, keep)                          each channel
lift      = paperLift * intensity
washed    = mix(muted, paper, lift)                         each channel
```

`mix(a, b, t)` is GLSL's `a (1 - t) + b t`. Taking out saturation keeps a color's brightness,
since the weights add up to 1. At intensity 0 the color is unchanged. Off removes the effect
altogether, so the splats show exactly as Marble made them.

All settings must be from 0 to 1, which keeps every color in range.

## Settings

| Setting | Meaning | Value |
| --- | --- | --- |
| `saturation` | Share of a splat's saturation left at full intensity | 0.4 |
| `paperLift` | How far a color moves toward the paper at full intensity | 0.5 |
| `paper` | The paper's color (sRGB) | 0.96, 0.94, 0.89 |

These are placeholders until they are tuned against reference images on the five test worlds.

## Viewer

The dream look is the viewer's default view. V switches it between strong, subtle and off (true
colors); R swaps to the realness heatmap and back; L, [ and ] place and size test lights, which
show in both. H hides all text and helper lines (grid, axes, photo frames, floor overlay) for
clean screenshots and clips.

## Tests

- The TypeScript reference has hand-worked cases: no change at intensity 0, saturation and paper
  lift on their own and together, brightness kept, and bad settings refused.
- A browser test runs the shader in headless Chromium on 1,600 sample splats with random colors
  (100 of them around a light) at strengths 1, 0.5 and 2 (clamped to 1). Each washed color must
  match the reference to 5 decimal places, and over 50 splats per strength must be partly
  washed, so the soft middle of the fade is covered. The strength changes between reads of one
  compiled shader. At strength 0 the colors come back unchanged to 6 decimal places (the GPU's
  `mix` can round in the last place).
