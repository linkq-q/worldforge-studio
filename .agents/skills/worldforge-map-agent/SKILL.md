---
name: worldforge-map-agent
description: Create or refine WorldForge Studio maps through the project HTTP API or CLI, including terrain, paint, reusable voxel assets, hierarchy, lighting, and object placement. Use when an Agent is asked to build or revise a scene in this repository.
---

# WorldForge Map Agent

## Boundaries

This skill edits map-stage content only: heightfield, painted surfaces, lighting reference, vegetation, buildings, props, hierarchy, and object placement. Do not apply final rendering style. Save any visual or atmosphere language from the request as suggestions for the later render prompt.

Use project HTTP APIs, CLI commands, or `MapStore`. Never edit files under `data/` directly. Current APIs save immediately and do not yet provide transactional undo, so state this limitation before a large mutation and keep changes focused.

## Asset Workflow

Read `docs/model-backend.md`, inspect existing assets, and reuse a suitable `assetId` before generating duplicates. Generate new assets through `/api/editor/assets/generate` or `npm run map -- generateAsset`.

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
5. Sculpt terrain with smooth radial raise/lower/flatten brushes.
6. Add painted surfaces and place objects with clear hierarchy and transforms.
7. Set sun direction and the scene reference point when useful.
8. Save through the API/CLI and reload the map.
9. Visually inspect the complete scene. Make focused corrections and stop early when it satisfies the request; use at most three validation rounds unless the user requests otherwise.

Do not count scripts, object totals, or JSON inspection as visual validation. If browser inspection is unavailable, report that visual validation remains incomplete.

## Verification

- Confirm the map appears in `GET /api/maps` or the CLI list.
- Reload it and inspect object count, terrain stats, paint strokes, linked assets, hierarchy, and lighting.
- If code changed, run `npm test` and `npm run build`.
- Summarize the map ID, assets used/generated, key edits, validation performed, and unresolved failures.
