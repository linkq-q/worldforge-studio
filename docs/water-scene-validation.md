# Water scene regression

The water authoring API now preserves per-control-point `levels` and `widths`. `bankHeight` / `bankWidth` explicitly shape supporting banks; they are opt-in so existing terrain is not raised unexpectedly. `carveTerrain:false` keeps structure-supported water from excavating terrain. Such intersections are diagnostic-only, not reported as repaired.

Connected non-ocean bodies with compatible contact elevations share one tessellated water surface, including sloped rivers. Lakes own overlap regions. The grid is bounded to 192 subdivisions per side; small distant features beyond that resolution still need visual inspection. River flow follows the centerline. Shading retains the authored slope and uses a fixed four-metre shore-distance scale, so connecting a large lake does not spread the shore effect across the entire river.

## Reproduce the supplied hydropower scene

Use an isolated checkout and its own installed local render-runtime dependency. A node_modules link to another checkout can resolve the wrong vendored shader.

```powershell
npm.cmd exec tsx -- scripts/waterQa.ts '<generation JSONL containing generation.input, asset.ready and generation.result>'
npm.cmd exec tsx -- scripts/waterQaRepair.ts
npm.cmd exec vite -- --host 127.0.0.1 --port 5181 --strictPort
```

Open `/tests/manual/water.html?map=before`, `?map=after`, or `?map=river`. The page uses the production `createMapViewer` rendering path and the same neutral look for comparisons. `window.step(seconds)` advances animation deterministically; `window.viewer` exposes the viewer camera for close-ups.

The scripts import the trace through MapStore into `data/water-qa` and apply one undoable refinement transaction to a copy. They make no model calls. The repair keeps the actual generated dam, power house and equipment, replaces the three voxel water assets with explicit sloping water profiles, and builds three earth banks while keeping the dam footprint open. Portable maps, refinement operations and captures live in ignored `output/water-qa`.

## Checks

- `npm.cmd test` and `npm.cmd run build`.
- Hydropower: supported reservoir shore, three spillways ending at the receiving surface, no water exposure/unsupported-shore diagnostics, and an undoable transaction.
- Curving river: varying width, sloping upstream surface and a single rendered river/lake junction.
- Compare overview and dam close-up; advance time for a pair of frames. Check the browser console for runtime errors.
- Verify `/api/health`, `/api/maps`, the repaired map and `/api/editor/maps/:id/transactions` using an API server pointed at the isolated data directory.

These deterministic fixtures establish geometry and renderer behavior. New LLM generations and final artistic water colors remain separate acceptance checks. This does not add volumetric fluid simulation or a spray particle system.

Validated on 2026-09-24: 944 tests across 119 files and the production build passed. The isolated editor loaded the final 61-object/5-water hydropower copy; its 9-operation agent transaction was available through HTTP. Two dam close-up frames 0.35 seconds apart differ visibly. No new runtime exception was observed; the existing shader compiler warning and missing favicon remain.
