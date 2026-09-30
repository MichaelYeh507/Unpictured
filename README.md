# Unpictured

*Step into everything the photo left out.*

A first-person game that turns photos into dreams you can walk through. Early development.

Worlds are generated from photos with the World Labs Marble API and rendered in the browser with three.js.

## Layout

- `web/`: the game client (Vite, TypeScript, three.js)
- `pipeline/`: Python tools that generate and prepare world packages

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

`generate` defaults to the cheap draft model and refuses to pass a daily cap
(`UNPICTURED_DAILY_CAP_USD`, default $3). Every paid call is logged to one file per user,
`~/.unpictured/cost_log.jsonl` (`UNPICTURED_COST_LOG` to move it), so every clone shares the
same daily total. It uploads an upright JPEG copy with all metadata removed, since phone photos
usually carry GPS. Packages land in `worlds/`.
