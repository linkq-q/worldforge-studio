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


## Terrain-aware water material acceptance (2026-09-24)

- Terrain-backed lakes/rivers use a separate 16-bit packed column-depth texture (0..64 m). Shore distance still clips/blends the boundary. Hidden indoor terrain, outside-map samples and structure-supported spillway sections retain the old fallback. Mixed connected meshes carry a validity mask. Brushing refreshes the same texture; disposal releases it.
- The existing dual-normal slots share one 128-square, mipmapped periodic normal field. River normals use two short cross-faded flow phases. The scene sun drives direction, colour and intensity. The old decorative contour-line pattern stays off in the new terrain-water path; global model-water defaults are unchanged.
- Existing WaterSceneCapture supplies one half-resolution opaque colour/depth capture per frame, through the existing frame coordinator/graph. All terrain water shares it. Refraction rejects foreground samples and fades with shallow depth. No per-lake planar reflection pass was added.
- Optional `recipe=calm-lake` and `recipe=stylized` on the manual water page create new custom schemes with the same neutral lighting. The accepted hydropower geometry is unchanged. Default comparison uses no recipe, with camera [-38,31,45] looking at [0,3,-5]; the sun-reflection view uses [38,25,-50].
- Browser checks: hydropower and curved river, alternate view, two animation frames 0.35 seconds apart, cartoon/realistic schemes, and five scheme resets. Texture count stayed at 15 on the river fixture; compiled water programs report no shader errors. The earlier shader compiler warning and missing favicon remain unrelated.
- One local synchronous frame comparison at 1280x820 measured median 0.8 ms without the new capture and 1.0 ms with it (20 samples each after warm-up, CPU wall time including a WebGL finish request). This is only a local relative check, not a cross-device GPU performance guarantee.
- Both material schemes were saved as new custom entries through the isolated server API. No built-in preset, original map or main checkout was overwritten.

Remaining artistic scope: no volumetric spray/mist, no geometric obstacle-aware fluid simulation, and no new planar reflections. The depth field describes terrain, not arbitrary submerged mesh surfaces. Final visual preference remains human acceptance.

Final material validation: 952 tests across 121 files and the production build passed. The isolated production editor loaded the 61-object hydropower scene and selected the saved calm-lake scheme. Scheme IDs: render-43b8a181-e340-420d (calm-lake), render-b3385422-7fe3-475c (stylized).


## Crosshatch correction (2026-09-24)

The earlier material screenshots did not establish natural surface motion. In the same backlit camera, disabling vertex displacement left the crosshatch intact; disabling detail normals removed it. The primary cause was the eight equal-amplitude periodic modes in the newly generated detail texture, amplified by a broad specular lobe. This correction does not change terrain depth, water colour, geometry or vertex displacement.

- Keep the existing dual-normal material inputs; bake one shared 256-square normal field with 64 deterministic, wind-biased modes. The broader spectrum and unequal phases/amplitudes remove the dominant crossed stripes. Two nonmatching scales drift in broadly aligned directions rather than crossing as rigid sheets.
- Narrow the direct sun highlight and use untinted, Fresnel-weighted environment reflection with unit normal influence. No new reflection capture or renderer was added. The unchanged vertex waves remain a separate, subtle displacement layer.
- The spectrum regression rejects the previous normal field (one mode contributed 12.52% of its slope energy; limit 8%) and passes the replacement. This numeric test guards repetition, not artistic realism.
- Compare identical camera/light/time at [38,25,-50] looking at [0,3,-2], plus front and low angles. Record 48 frames at 8 fps with shader time 0..5.875 seconds. The GIF loop resets time; the loop boundary is an artifact of the review recording, not a runtime animation reset.
- References studied: [NVIDIA GPU Gems, geometric waves versus texture waves](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models), [Alex Tardif, scrolling normals and specular breakup](https://alextardif.com/Water.html), and [Catlike Coding, wavelength versus mesh resolution](https://catlikecoding.com/unity/tutorials/flow/waves/). These inform the changes; no external shader source/assets were copied. ShaderToy Ms2SD1 and llsXD2 could not be retrieved and are not claimed as inspected references.

Remaining visual limits: the neutral fixture has no HDRI and uses the existing sky-gradient fallback; it does not provide dam/tree reflections. Spillway spray and impact turbulence are also not addressed by this normal-field fix. A regression pass is not human visual acceptance.

Validation: 953 tests across 121 files passed; production typecheck/build passed. Local API health returned OK. The production viewer compiled the updated water shader without errors in hydropower, stylized water and curved-river fixtures.
