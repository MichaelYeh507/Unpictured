# Unpictured

*Step into everything the photo left out.*

A first-person game that turns photos into dreams you can walk through. Early development.

Worlds are generated from photos with the World Labs Marble API and rendered in the browser with three.js.

## Layout

- `web/`: the game client (Vite, TypeScript, three.js, Spark)
- `core/`: engine-agnostic TypeScript (no three.js, Spark or DOM), such as coordinate frames
- `pipeline/`: Python tools that generate and prepare world packages
- `tests/`: language-neutral test vectors that every engine's code must pass
- `docs/`: specifications, starting with the world package format (`docs/WORLD_PACKAGE.md`)

## Develop

Requires Node 26 and [uv](https://docs.astral.sh/uv/).

```
npm install
npm run dev      # the game at http://localhost:5173
npm run check    # every check that CI runs
```

Generated worlds, photos and API keys are never committed.

## Generate a world

Put a World Labs API key in a file outside the repo (one line, `WLT_API_KEY=...`), then from `pipeline/`:

```
uv run --env-file <key file> python -m unpictured_pipeline credits                 # balance, free
uv run --env-file <key file> python -m unpictured_pipeline generate photo.jpg      # dry run: price
uv run --env-file <key file> python -m unpictured_pipeline generate photo.jpg --yes
```

Two to four photos of one place make a single world. Give each photo's direction in the same
order (0 front, 90 right, 180 back, 270 left):

```
uv run --env-file <key file> python -m unpictured_pipeline generate front.jpg back.jpg --azimuth 0 --azimuth 180
```

To find where each photo sits in its world, run `locate` (free and local, about 10 seconds per
photo). It matches each photo against the world's panorama and writes `camera.json`:

```
uv run python -m unpictured_pipeline locate --name <name>
```

To walk around a world, run `npm run dev` and open `http://localhost:5173/?world=<name>`, where
`<name>` is a folder in `worlds/`. Drag to look, W A S D to move, E up, Q down. The viewer loads
the most detailed splat file the world has. Draft worlds have no metric data, so they show at raw
scale with a notice on screen. When a world has `camera.json`, the viewer draws each photo's frame
in yellow, starts looking through the first photo, and O lays the photo over the world. N measures
where a person can walk from the photo spot and colors that floor: blue inside a photo, pink
unpictured, gray out of reach, with the areas on screen. Outdoors the world often has a hole
right under the photo spot, which the photo never saw; then N measures from the nearest floor and
says how far away that is.

With `camera.json` and a collider, the world shows in the dream look (`docs/DREAM_LOOK.md`): soft
bands of color everywhere, and the less real a part is (`docs/REALNESS.md`), the more it fades into
the dream's pastel and swells; the pastel turns from warm to cold and back once a minute. Far from
the photo spot, unreal parts also drift slowly and dissolve toward the paper behind them; the
floor at the photo spot's level holds still. V switches it between strong, subtle and off (the
splats as Marble made them). R shows realness as a heatmap instead, blue real and pink imagined. L drops a test memory light on
whatever is in the middle of the screen, [ and ] shrink or grow it, and Shift+L clears them. H
hides everything but the world, for clean screenshots.

Phones need a lighter splat file: add `&splats=500k` or `&splats=100k` to the address
(`&splats=full_res` asks for the most detailed). If the world lacks that size, the viewer takes the
next smaller file, or its smallest file when nothing is that small. The status line names the file
it loaded.

`generate` defaults to the cheap draft model and refuses to pass a daily cap
(`UNPICTURED_DAILY_CAP_USD`, default $3). Every paid call is logged to one file per user,
`~/.unpictured/cost_log.jsonl` (`UNPICTURED_COST_LOG` to move it), so every clone shares the
same daily total. It uploads an upright JPEG copy with its metadata removed (only the colour
profile is kept), since phone photos usually carry GPS. Packages land in `worlds/`.
