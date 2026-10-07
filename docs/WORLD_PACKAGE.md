# World package format

A world package is one folder holding everything a client needs to show one generated world.
This file is the contract between the code that writes packages (`pipeline/`) and the code that
reads them (`core/` and `web/` now, an Unreal Engine client later). Change the format here first.

Format version: `provisional-m0`. It is written as `package_format` in `meta.json` and `format` in
`camera.json`, and no reader checks it yet. It becomes `1` when `level.json` arrives (M3) or
when a second client starts reading packages, whichever comes first; from then on readers should
refuse versions they do not know.

## Folder

```
worlds/<name>/
  meta.json              required
  splats.spz             splat files: a reader needs at least one of the three
  splats_500k.spz
  splats_100k.spz
  collider.glb           optional: collision mesh
  pano.png               optional: the 360-degree panorama the world was built from
  thumbnail.webp         optional: preview image
  source.jpg             optional: the photo, or source_1.jpg, source_2.jpg and so on for several
  camera.json            optional: where each photo sits, written later by `locate`
```

Every file the writer can download is optional on its own: it writes whatever Marble offers. So
far every package has had all of them.

- `<name>` is lowercase letters, digits and hyphens, starting with a letter or digit
  (`^[a-z0-9][a-z0-9-]*$`). It appears in URLs. Draft worlds get `-draft` at the end by default.
- File names are plain: no folders, and no leading dot (`^[A-Za-z0-9_][A-Za-z0-9_.-]*$`).
- Find files through `meta.json`'s `files` rather than by these names, since the extensions of
  `collider`, `pano` and `thumbnail` come from Marble's download URLs (`.bin` when a URL has
  none). `camera.json` is the one exception: it is not listed in `files` and is always found by
  that name.
- The writer builds a package in `<name>.partial` and renames it when every download has
  finished. A folder ending in `.partial`, or a file ending in `.part`, is incomplete; ignore it.
- Reserved for later, not written yet: `level.json` (the level built on the world) and `pieces/`
  (one splat file per scattered object), both from M3 on. A folder breaks today's file-name rule,
  so `pieces/` will come with a rule change and the version bump.

## Frames and units

**Raw frame, `marble_raw_opencv`.** Every 3D position in the package is in Marble's raw frame:
x right, y down, z forward, in Marble's units. It is right-handed. This covers the splat files,
the collider and `camera.json`. The panorama was taken at the origin. Straight ahead (+z) is
azimuth 0, and a one-photo world puts its photo there.

**Metric data.** Worlds from `marble-1.1` come with two numbers in `meta.json`; drafts have
neither. Other standard models have not been tried yet.

- `metric_scale_factor`: raw units times this gives metres.
- `ground_plane_offset`: in metres, how far the floor lies below the panorama's camera. In the raw
  frame the floor is the plane y = `ground_plane_offset / metric_scale_factor`.

Both are Marble's estimates, not measurements. Rough checks against objects of known size found
one outdoor world about 1.5 times too large and one indoor world about 1.0 to 1.13 times.

**Game frame (the web client).** The web client uses three.js axes (x right, y up, -z forward).
It places a world like a three.js `Object3D`: scale, then rotate, then translate.

| | Scale | Rotation (x, y, z, w) | Translation | Units |
| --- | --- | --- | --- | --- |
| Both numbers present | `metric_scale_factor` | (1, 0, 0, 0) | (0, `ground_plane_offset`, 0) | metres, floor at y = 0 |
| Either one null | 1 | (1, 0, 0, 0) | (0, 1.6, 0) | raw units; 1.6 is a stand-in camera height |

The rotation is 180 degrees about x, which turns y down and z forward into y up and -z forward.
Quaternions here and in `tests/frame_vectors.json` are written in x, y, z, w order.
`tests/frame_vectors.json` holds worked examples that the web client reproduces.

**Other engines.** The raw frame is the contract; the game frame above is the web client's
choice. An engine with other axes moves raw data into its own frame with one transform, applied
alike to splat positions, rotations and sizes, collider vertices, and camera rays. If that
transform is a reflection (raw to a left-handed frame, such as Unreal's), splat rotations must be
mirrored too, and the collider's triangle winding flips. Import `collider.glb` without the usual
glTF axis conversion: it does not follow glTF's +y up. `tests/frame_vectors.json`'s raw points,
mapped through the engine's own transform, make a check for it.

## meta.json

UTF-8 JSON, written by `generate` and `fetch`.

| Field | Type | Meaning |
| --- | --- | --- |
| `package_format` | string | `"provisional-m0"` |
| `world_id` | string | World Labs world ID. Required. |
| `display_name` | string or null | The world's name in Marble |
| `model` | string or null | For example `"marble-1.0-draft"` or `"marble-1.1"` |
| `seed` | integer or null | The seed sent with the generation; null for packages built by `fetch` |
| `operation_id` | string or null | The generation's operation; null when fetched by world ID |
| `credits` | number or null | What the generation cost, once settled; null when unknown |
| `created_at` | string or null | When Marble created the world (ISO 8601, UTC) |
| `downloaded_at` | string | When the package was written (ISO 8601, local time with offset) |
| `world_marble_url` | string or null | The world's page in Marble |
| `caption` | string or null | Marble's description of the scene |
| `frame` | string | Always `"marble_raw_opencv"`. Required; readers reject anything else. |
| `metric_scale_factor` | number above 0, or null | See "Frames and units". Required key; null for drafts. |
| `ground_plane_offset` | number or null | See "Frames and units". Required key; null for drafts. |
| `photo_azimuths` | list of numbers, or null | See below. Older packages may lack it; treat that as null. |
| `files` | object | File name by role, below. Required. |

`photo_azimuths` gives one direction per photo for worlds made from several photos, in degrees
from 0 up to 360, in the order `source_photo_1`, `source_photo_2` and so on. 0 is the front and
180 the back; 90 is taken to be the right and 270 the left, but so far only 0 and 180 have been
tried. It is null for a one-photo world, and for any package fetched without its photos.

Roles in `files`:

| Role | File | Notes |
| --- | --- | --- |
| `splats_full_res` | `splats.spz` | The most detailed splat file |
| `splats_500k` | `splats_500k.spz` | About 500,000 splats |
| `splats_100k` | `splats_100k.spz` | About 100,000 splats |
| `collider` | `collider.glb` | |
| `pano` | `pano.png` | |
| `thumbnail` | `thumbnail.webp` | |
| `source_photo` | `source.jpg` | One-photo worlds |
| `source_photo_1`, `source_photo_2`, ... | `source_1.jpg`, `source_2.jpg`, ... | Worlds made from 2 to 4 photos |

A role appears only when its file exists. Readers skip roles they do not know, but every value
in `files`, known role or not, must be a plain file name or the package is rejected.

## Splat files

[SPZ](https://github.com/nianticlabs/spz) files exactly as Marble serves them: a gzip stream
whose decompressed data starts with the `NGSP` header. Every package so far is SPZ version 2 with
spherical-harmonics degree 0 (no view-dependent colour). Read the data as stored, with no axis
conversion even if an SPZ library offers one: it is in the raw frame. The web client gives
Spark 2.2 only the placement under "Game frame".

A client loads the most detailed file unless it is asked for less. When the package lacks the
level asked for, it loads the next smaller file, or the smallest file when nothing is that small.
The levels from most to least detail are `full_res`, `500k`, `100k`.

## collider.glb

A binary glTF 2.0 triangle mesh for collision only, in the raw frame (y down) and Marble's units.
Vertices are placed directly: readers reject a file whose nodes carry `matrix`, `translation`,
`rotation` or `scale`. For a triangle (a, b, c), the normal (b - a) x (c - a) points out of the
surface, so floors face up (toward -y in the raw frame); this was checked on the floors of two
standard worlds. Marble's files so far are written by trimesh, with one mesh of one primitive and
31,000 to 187,000 triangles. The collision floor can have holes, for example under furniture or,
outdoors, right under the photo spot.

## pano.png

The equirectangular panorama Marble built the world from, twice as wide as it is tall (2304 by
1152 for drafts so far, 4608 by 2304 for standard worlds). For a direction (x, y, z) in the raw
frame, with W and H the image's width and height:

```
longitude = atan2(x, z)                  0 straight ahead, positive to the right
latitude  = atan2(-y, sqrt(x^2 + z^2))   positive up
column    = W * (0.5 + longitude / (2 pi))
row       = H * (0.5 - latitude / pi)
```

So the middle column looks straight ahead (+z), the right half looks right (+x), the left and
right edges look straight back, and the top row looks straight up (-y). `locate` matches the
source photos against it.

## Source photos

The cleaned JPEG copies that `generate` uploads to Marble: turned upright, with all EXIF, XMP and
comments removed, and the colour profile kept. `fetch` cleans the photos it is given the same way.
The originals never enter a package.

## camera.json

Written by `locate`, which finds each source photo inside `pano.png`. Optional: a client without it
simply has no photo frames.

```json
{
  "format": "provisional-m0",
  "frame": "marble_raw_opencv",
  "convention": "Rays use the frame's axes (x right, y down, z forward). ...",
  "cameras": [
    {
      "photo": "source.jpg",
      "position": [0.0, 0.0, 0.0],
      "yaw_deg": 0.0,
      "pitch_deg": -10.75,
      "hfov_deg": 91.75,
      "vfov_deg": 75.43,
      "image_size": [4032, 3024],
      "fx": 1955.35,
      "fy": 1955.35,
      "cx": 2016.0,
      "cy": 1512.0,
      "match_score": 0.865
    }
  ]
}
```

- `frame` must be `"marble_raw_opencv"`. `convention` is a short note for people: the axes, the
  rotation order and the origin. The rules below are the full version.
- One entry per source photo, in role order: `source_photo`, or `source_photo_1`,
  `source_photo_2` and so on. `photo` is that photo's file name; match entries to photos by it.
- `position` is in the raw frame. `locate` always writes the origin, where Marble's panorama
  camera sits; the photos have lined up with the world from there.
- `image_size` is [width, height] in pixels. With `fx`, `fy`, `cx` and `cy` it makes a pinhole
  camera in the photo's pixels: u to the right and v down from the image's top-left corner, so the
  middle of the first pixel is (0.5, 0.5). A pixel's ray in camera axes is
  ((u - cx) / fx, (v - cy) / fy, 1).
- To turn that ray into the raw frame, tilt it up by `pitch_deg` (about the x axis, toward -y),
  then turn it right by `yaw_deg` (about the y axis, from +z toward +x). Yaw uses the same
  convention as Marble's azimuth; a located photo lands within about a degree of the azimuth it
  was generated with. `tests/camera_vectors.json` holds worked examples that every client must
  reproduce.
- `hfov_deg` and `vfov_deg` are the same lens as angles, for people to read; `fx` and `fy` are
  what code uses.
- `match_score` is how well the photo's edges matched the panorama (a correlation, at most 1).
  Real photos have scored about 0.6 to 0.87. Below 0.4, `locate` warns that the placement is
  unreliable.
- The pinhole is where Marble placed the photo inside its panorama, not the phone's real lens,
  which is usually wider.
