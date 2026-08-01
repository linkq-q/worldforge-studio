# WorldForge Studio Agent Guide

## Scope

This repository is a standalone Three.js scene editor. Do not add game rooms, multiplayer state, WebSocket gameplay, or Electron unless the user explicitly changes the product scope.

## Architecture

- `src/client/`: editor UI and Three.js rendering
- `src/shared/`: map schema, math, bounds, and normalization
- `src/server/`: local HTTP API, file store, model backend adapter, and CLI
- `data/map-editor/`: runtime data; never commit it

Client, server, and CLI must use the same types and normalization rules. Prefer a small direct change over a speculative abstraction.

## Agent Editing

Use `/api/editor`, `npm run map`, or the project skill. Do not directly rewrite files under `data/`. Submit one generation/refine result as one `MapOperation[]` transaction. The server applies it atomically and persists one undo snapshot; a later direct/manual save clears that snapshot.

Map generation and render generation are separate stages. Do not put final rendering style into map data. Do not apply a render scheme before the user confirms the map.

Map AI should express repeated placement as bounded `scatters`; the server expands them into deterministic `object.add` operations before preview. Keep map-size quotas derived from bounds, and preserve stored terrain resolution when loading older maps.

Render schemes own their `RenderPlan` and `accessPolicy`. Developer edits must preview live and save as a new scheme; do not overwrite built-in presets. AI and developer permissions/ranges are validated separately. Scoped material, water, and effect changes must stay under `modelsRoot`.

## Safety

- Y-up; `y=0` is sea level. Terrain heights may go negative down to `TERRAIN_MIN_HEIGHT`: adding or updating a lake carves its basin into the height field so the water plane sits inside the terrain.
- External agents must not modify core source by default.
- New Shader code must follow the permission ladder in `docs/architecture.md`.
- Do not push, publish, or contact external services unless the user explicitly asks.

## Verification

Run:

```bash
npm test
npm run build
```

For editor changes, also verify the local API and the visible browser flow.
