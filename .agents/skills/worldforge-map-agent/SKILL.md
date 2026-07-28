---
name: worldforge-map-agent
description: Create or refine WorldForge Studio maps through the project HTTP API or CLI, including terrain, paint, reusable voxel assets, hierarchy, lighting, and object placement. Use when an Agent is asked to build or revise a scene in this repository.
---

# WorldForge Map Agent

## Boundaries

This skill edits map-stage content only: heightfield, painted surfaces, lighting reference, vegetation, buildings, props, hierarchy, and object placement. Do not apply final rendering style. Save any visual or atmosphere language from the request as suggestions for the later render prompt.

Use the shared transaction contract in `docs/map-transactions.md`. Never edit files under `data/` directly and do not assemble a second mutation format. Build the complete `MapOperation[]`, then submit it once through HTTP, CLI, or `MapStore`; the server validates all operations before saving and keeps the latest transaction undoable.

## Asset Workflow

Read `docs/model-backend.md`, inspect existing assets, and reuse a suitable `assetId` before generating duplicates. Generate new assets through `/api/editor/assets/generate` or `npm run map -- generate-asset`.

For repeated organic or prominent objects, create visually distinct variants:

- 1-5 instances: usually 1 variant
- 6-20 instances: 2-3 variants
- 21-60 instances: 4-6 variants
- 60+ instances: 6-10 variants

Prompts should name the object, its silhouette, scale, intended placement, voxel constraints, and meaningful variant differences. Do not silently replace a failed backend result with handwritten primitive geometry.

## Map Workflow

1. Inspect current maps, assets, CLI help, and the requested scene.
2. Plan dimensions, terrain masses, routes, landmarks, object groups, and repeated-asset variants.
3. Generate or select assets.
4. Create or load the map.
5. Build one ordered operation list for terrain, paint, objects, sun, and the scene reference point.
6. Submit the list as one labeled `agent` transaction.
7. Reload the map and verify that the transaction appears as undoable.
8. Visually inspect the complete scene. Make focused corrections and stop early when it satisfies the request; use at most three validation rounds unless the user requests otherwise.

Do not count scripts, object totals, or JSON inspection as visual validation. If browser inspection is unavailable, report that visual validation remains incomplete.

## Verification

- Confirm the map appears in `GET /api/maps` or the CLI list.
- Reload it and inspect object count, terrain stats, paint strokes, linked assets, hierarchy, and lighting.
- Confirm `GET /api/editor/maps/:id/transactions` returns the committed transaction.
- If code changed, run `npm test` and `npm run build`.
- Summarize the map ID, assets used/generated, key edits, validation performed, and unresolved failures.
