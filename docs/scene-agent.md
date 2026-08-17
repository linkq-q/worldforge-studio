# Scene Agent and Guide Layout

WorldForge has two complementary map-generation paths:

- The composition workflow is a fixed director/specialist/reviewer pipeline.
- Scene Agent is a bounded model-directed loop for outdoor authored environments.

Scene Agent is intentionally not an unrestricted code agent. The model chooses whether to request assets, write or revise a Scene Program, or finish. Local code parses and interprets the program, applies physical constraints, runs map lint, and returns execution evidence to the model. The user still receives an ordinary preview and must approve the same atomic `MapOperation[]` transaction before the map changes.

## Guide layout kernel

`MapGuide` is a persisted, reusable spatial relationship. A guide has a stable ID, polyline or Catmull-Rom geometry, width, tags and optional generation ownership. The same geometry supports:

- curved park and waterfront paths;
- campus and settlement circulation spines;
- road-edge buildings and street furniture;
- polygon-clipped farm, orchard or garden rows.

This is deliberately one geometric vocabulary rather than separate hard-coded “park”, “campus” and “farm” generators. Scene semantics choose the guide shape, spacing, offsets and assets; the shared kernel owns sampling and polygon clipping.

Guides are changed with `guide.upsert` and `guide.remove`, so they participate in preview, save, undo and redo with the rest of the map transaction.

## Scene Program

The program is TypeScript-like source but supports only a small interpreted subset:

- `const` declarations;
- arrays, objects and bounded expressions;
- `if`;
- `for (const item of items)`;
- calls to the `scene` capability object.

It cannot import modules, declare functions, assign globals, use `while`, access the DOM or filesystem, or execute arbitrary JavaScript. Step, loop and operation budgets stop runaway programs.

Available capabilities are:

- `scene.terrain(...)`, `scene.modifyTerrain(...)`, `scene.refineTerrain(...)`
- `scene.guide(...)`
- `scene.parallelGuides(...)`
- `scene.streetGrid(...)`
- `scene.surface(...)`, `scene.surfaceRegion(...)`
- `scene.water(...)`, `scene.grass(...)`
- `scene.placeAlong(...)`
- `scene.scatter(...)`
- `scene.placeAt(...)`
- `scene.spawn(...)`, `scene.renderSuggestion(...)`
- `scene.range(...)`, `scene.polar(...)`
- `scene.note(...)`

For example, a farm is not selected from a `farm` enum. The model can create parallel guides inside a chosen polygon and use a loop to place crop assets along every valid row. A park can use a closed curved guide and place benches at a path-relative offset.

For a town or campus, `streetGrid` adds one explicit hierarchy level: it returns both the crossing street skeleton and buildable block polygons inset from the road width. The model can loop over streets to apply paving, then loop over blocks to choose courtyards, lawns, buildings or public facilities. Blocks are transient planning values; the accepted result persists as guides, shaped surfaces and objects through the normal operation transaction.

Terrain surfaces preserve their real circle, path or polygon masks. They are not reduced to a bounding circle, so a curved road changes only its own corridor. Dense curves are deterministically resampled to the persisted 64-point terrain-region limit, and a map can retain up to 96 semantic surface zones for road and field networks.

Surface semantics include grass, sand, rock, soil and paving. Farms can therefore keep visible soil between crops, while roads and plazas suppress ordinary grass and use a distinct paved tint instead of borrowing the rock treatment.

`placeAlong`, `scatter` and `placeAt` all use the shared placement kernels. They report underfilled requests instead of silently forcing objects through bounds, water, steep terrain or occupied footprints.

## Agent completion checks

Each successful program is executed in memory and returned to the model with lint results plus outcome requirements. A finish action is rejected when requested water, terrain, vegetation, buildings, authored guides or surface treatment is missing; when an ocean leaves almost no playable land; when structural terrain or water is added after object placement; or when a generated asset was never placed. Invalid action JSON is returned as a repairable tool error instead of terminating the run.

Existing/global assets are visible only when reuse is explicitly enabled and their IDs are in the allowed library set. Map-owned assets and newly generated assets remain available. This keeps the Scene Agent on the same permission boundary as the established workflow.

## Responsibility boundary

The model owns spatial intent: hierarchy, guide shape, repetition logic, asset-role selection, offsets and when the result is complete.

Local deterministic code owns non-negotiable facts: map bounds, terrain height, collision, slope, water clearance, normalized schema, execution budgets, lint, atomic transactions, undo and redo.

This division gives the model meaningful generative freedom without asking it to reproduce geometry, safety and persistence code token by token.

## Current integration boundary

Scene Agent is selectable for new outdoor-map generation. Indoor generation and refine retain the established composition workflow while Scene Program coverage is expanded. The preview exposes the agent trace and generated program for inspection.

DeepSeek Harness packaging is intentionally deferred. The agent uses WorldForge's existing model-provider adapter, keeping the execution contract model-neutral so it can later be exposed through a Harness, Codex skill, Claude Code integration or another host without changing map semantics.
