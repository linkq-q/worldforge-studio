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


## Flow continuity polish (2026-09-24)

Based on accepted commit `e7596e0`, this round only changes the terrain river's dual-normal crossfade. Lake normals, water colours, geometry and reflection tuning remain on the accepted path.

- A smooth spatial phase offset prevents the entire river from crossfading at the same instant. Smoothstep weights keep the derivative continuous when a hidden flow layer resets.
- Blend normal slopes with a variance correction: independent fields otherwise lose half their variance at equal weights, making the whole river alternately flatten and roughen. This is a statistical correction, not a fluid simulation; correlated samples can still vary naturally.
- `/tests/manual/waterFlow.html` runs the actual material helper on the GPU. With two orthogonal 0.2 slopes, the old crossfade falls from 0.195 to 0.140 at equal weights; the new decoded slope stays between 0.195 and 0.198 across nine weights (8-bit readback). It tests both the old failure and the corrected behavior.
- Recorded 64 frames at 8 fps, 0..7.875 seconds, spanning a complete flow cycle. Compare the curved-river fixture at [26,16,-26] looking at [0,0,0], and recheck the accepted hydropower reservoir view. Recording loops reset time; the runtime does not reset on that GIF boundary.
- `npm.cmd test`: 953 tests / 121 files passed. Production build passed. Browser GPU regression passed. Final human visual acceptance is separate from these checks.


## Lake wind patch polish (2026-09-24)

Based on accepted commit `b61554a`, terrain-backed realistic/hybrid lakes now vary detail-normal strength gently across broad, slowly advecting wind patches. The multiplier stays between 0.65 and 1.2, preserving visible ripples in calm patches. This is an artistic roughness variation within the existing material, not a wind or fluid simulation. No texture, capture pass, authoring API, geometry, water colour or depth changes were added. Flowing river samples and cartoon/legacy surfaces retain their prior path.

`/tests/manual/waterWind.html` compiles the actual material block and noise chunk on the GPU. With base strength 0.8, sampled strength is 0.522..0.961 (8-bit readback), remains spatially varied, moves over time, and is zero when strength is zero. Terrain-invalid, non-scene-lit, river and cartoon cases all preserve the original constant strength.

Validation: 953 tests across 121 files and the production build passed. Captured 64 frames at 8 fps with identical camera/light/time for both variants; inspected nonadjacent frames plus close, distant and grazing views. The GIF wraps time at its end; this is only a recording boundary. This is a subtle artistic adjustment awaiting user acceptance, not a claim of complete photorealism.


## Self-audit: normal orientation (2026-09-24)

The previously added scene-water tangent frame used `cross(+Z, normal)`, which points toward -X on flat water although the normal texture is sampled on world +X/+Z. It inverted the texture's X lighting response. The frame also collapsed for a vertical normal parallel to +Z.

Replace that frame with world-X/Z height-gradient composition, scaled by the base normal's Y component. This keeps authored slopes and avoids normalization of a zero tangent on vertical faces. It does not change legacy non-scene-water composition.

`/tests/manual/waterNormals.html` compiles the actual material block on the GPU. Before the fix, a positive-X test normal returned X=-0.192 and the vertical case rendered invalid black values. After the fix, X=+0.192, positive-Z also stays positive, a vertical surface retains [0,0,1] within byte readback precision, and an unperturbed sloped surface remains unchanged. The test was observed failing before the fix and passing afterwards.

Reviewed 48 matched frames of the reservoir plus a close spillway view. This corrects the orientation of glints; it does not add missing spray or scene-object reflections. Full tests (953 across 121 files) and the production build passed.


## Self-audit: normal texture bake cost (2026-09-24)

The 256-square/64-mode bake previously called trigonometric functions and recomputed mode normalization inside every pixel/mode pair. The replacement evaluates sine/cosine per row/column and applies the cosine addition identity while accumulating the same modes. About 1 MiB of temporary Float64 slope buffers is used per bake; there is no persistent texture cache or extra per-frame work.

Same-machine browser timings for five successive bakes: before [158.6,148.8,147.9,139.4,138.4] ms; after [14.3,11.7,11.5,11.9,11.4] ms. Median falls from 147.9 to 11.7 ms. This measures texture initialization only, not frame time or a cross-device performance guarantee.

All texture bytes retain SHA-256 `811fc0c3cbae1fbc1b8698b3836f826a164ef5935e37b4bd1d6f33772bb1b321`; the accepted texture hash is now guarded in the existing unit test. Full tests/build passed, all three manual GPU regressions passed, lake/river/cartoon browser fixtures compiled without shader failures, and local API health returned OK. Existing shader compiler warnings and missing scene-object reflection/spray remain outside these two fixes.

## Fixed-camera lake glint repair: surface sampling (2026-09-24)

Standalone lakes now reuse the existing bounded water grid and shoreline mask instead of interpolating waves from boundary-only triangles. The grid remains capped at 192 segments per axis. Its local vertex shore lookup uses the actual plane size. Lake-only grids omit the river-flow attribute so they retain lake waves rather than being classified as rivers. River strips subdivide both longitudinal spans and width by world distance, preserving authored edges, levels and flow while bounding the sampling budget.

The new regression first failed for a four-corner lake (56.57 m triangle edge) and a 60 m river span. After the fix, all 59 related geometry/authoring/depth/renderer tests pass. The real garden fixture has 2,401 vertices, retains shore waves, and has matching geometry/uniform dimensions of 47.4713 m. In the same fixed-camera bright-water ROI, 120 samples at 0.1 s intervals gave a maximum mean absolute luma change of 0.00131; the prior implementation was about 0.0749. This ROI comparison is not a whole-screen stability or performance guarantee. The periodic shore-height seam is handled in the next change.
