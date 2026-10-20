# Realness

Realness says how much of a world is real, from 1 to 0 (imagined by the world model): either a
source photo saw it, or a memory light (a piece the player restored) shines on it. It drives the
dream look (`docs/DREAM_LOOK.md`) and, later, the game's rules. The viewer can also show it as a
heatmap (key R): blue is real, pink is imagined.

This file is the contract for every implementation: the TypeScript reference
(`core/src/realness.ts`), the shader (`web/src/realnessShader.ts`), and a later Unreal Engine
port. They must all pass `tests/realness_vectors.json`.

Version 1 covers camera realness and memory light. Occlusion (a point hidden behind something in
the photo was not really seen) is planned for a later version; until then such points count as
seen.

## Inputs

- **The point**, in the raw splat frame (`marble_raw_opencv`: x right, y down, z forward), the
  frame of the splat files, the collider and `camera.json` (see `docs/WORLD_PACKAGE.md`).
- **The photos' cameras** from `camera.json`: position, yaw, pitch, and the pinhole `fx`, `fy`,
  `cx`, `cy` and `image_size`.
- **The camera height**: how far the photo spot (where the panorama was taken: the raw origin,
  where every photo's camera sits) is above the floor, in raw units. It is found in the collider
  the same way as for the walkable floor: the floor straight below the photo spot, or, where the
  collider has a hole there, the nearest floor beside it. Distances are measured in
  camera heights, so drafts (which have no scale) and standard worlds use the same numbers, and
  Marble's metric estimate (which can be off by half again) does not matter.
- **Memory lights**: up to 8, each a position in the raw frame and a radius in raw units. In the
  game a piece's own size will set its radius; the viewer's test lights (key L) are sized in
  camera heights.
- **Settings**: `margin`, `nearOk`, `farLimit` and `lightCore`, below.

## Formula

For one photo:

```
q        = the point turned into the camera's axes: subtract the camera's position, turn back by
           yaw, then tilt back by pitch (the reverse of camera.json's rotation)
if q.z <= 0: realness = 0                          beside or behind the camera

u        = (fx * q.x / q.z + cx) / width           0 to 1 across the photo, left to right
v        = (fy * q.y / q.z + cy) / height          0 to 1 down the photo, top to bottom
edge     = min(u, 1 - u, v, 1 - v)                 how far inside the frame; negative outside
inFrame  = smoothstep(-margin, margin, edge)

away     = |q| / cameraHeight                      distance from the camera, in camera heights
inRange  = 1 - smoothstep(nearOk, farLimit, away)

realness = inFrame * inRange
```

`smoothstep` is GLSL's: `t = clamp((x - edge0) / (edge1 - edge0), 0, 1)`, then `t * t * (3 - 2 * t)`.
It needs `edge0 < edge1`, so the settings must have `margin > 0` and `0 <= nearOk < farLimit`,
and the camera height must be above 0. Implementations refuse anything else.

So, within `nearOk` of the camera, a point exactly on the frame's edge is 0.5 real, fully real
`margin` inside it and fully imagined `margin` outside it; farther away, the range fade scales
all of that down. `margin` is a share of the photo's width for the left and right
edges and of its height for the top and bottom.

**Several photos:** a world made from several photos gives each point the highest realness any of
its photos gives it.

For one light:

```
away     = |point - light position|                in raw units
realness = 1 - smoothstep(lightCore * radius, radius, away)
```

So a point is fully real within `lightCore` of the light's radius and fades to imagined at the
radius. `lightCore` must be at least 0 and below 1, and each radius a finite number above 0.

**Altogether:** realness is the highest value over the photos and the lights. A world without
lights is just its camera realness.

## Settings

| Setting | Meaning | Value |
| --- | --- | --- |
| `margin` | Half the width of the fade across the frame's edge, as a share of the photo's width or height | 0.05 |
| `nearOk` | Fully real up to this distance from the camera, in camera heights | 6 |
| `farLimit` | Imagined from this distance on, in camera heights | 25 |
| `lightCore` | Share of a light's radius that is fully real | 0.7 |

Tuned by eye on the five test worlds: `living-room-kitchen` and `sunset-alley` (standard) and
`village-road-draft`, `riverside-path-draft` and `old-street-draft` (drafts).
For a phone photo, a camera height is about 1.5 m, so a point stays fully real to about 9 m and
is imagined from about 37 m. A shorter range (3 and 10) turned most of what an outdoor photo
clearly shows pink; indoors, a whole room lies within 6 camera heights either way. `lightCore`
keeps the brief's 0.7: a solid core with a short, visible fade, so it is clear where a light
ends (the game's rules about light will depend on that edge).

## Test vectors

`tests/realness_vectors.json` has `settings`, named `cameras` (camera.json fields), and `cases`.
Each case lists the cameras it uses (possibly none), a `camera_height`, any `lights` (raw
`position` and `radius`), a `point`, the expected `realness`, and its own `settings` where they
differ. The expected values come from a separate calculation with
explicit rotation matrices; the simple cases (straight ahead, on a frame edge, halfway through a
fade) can be checked by hand.

- The TypeScript reference must match them to 8 decimal places.
- The shader works in 32-bit floats and must match them to 5 decimal places. A browser test runs
  it in headless Chromium, reads the results back from the GPU, and also checks 2,300 sample
  splats (some placed around three lights) through the viewer's heatmap against the reference,
  that lights changed after the shader is built take effect without compiling it again, and the
  heatmap's colors.
