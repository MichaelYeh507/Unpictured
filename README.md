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
uv run --env-file <key file> unpictured credits                    # balance, free
uv run --env-file <key file> unpictured generate photo.jpg         # dry run: shows the price
uv run --env-file <key file> unpictured generate photo.jpg --yes   # spends credits
```

`generate` defaults to the cheap draft model, logs every paid call to `worlds/cost_log.jsonl`
and refuses to pass a daily cap (`UNPICTURED_DAILY_CAP_USD`, default $3). Packages land in `worlds/`.
