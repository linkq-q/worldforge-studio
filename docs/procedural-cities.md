# Procedural urban layouts

The active outdoor Scene Code planner exposes `api.urbanLayout(options)` in main and standard modes. It returns seeded **geometry**, leaving GPT responsible for meaning, districts, terrain, landmarks, asset families, density and height. DeepSeek remains the separately selected asset provider. Ordinary `route` and `place` calls turn that geometry into the existing preview and atomic transaction; no new map schema or render style is introduced.

## Sources and interpretation

- [Watabou TownGeneratorOS](https://github.com/watabou/TownGeneratorOS): streets, wards, inward setbacks and recursive subdivision. The implementation here is original; it does not copy GPL source or reproduce the complete Voronoi generator.
- [Blender iCity buildings](https://icity3d.com/4-1-section-one-procedural-buildings/) and [iCity lots](https://parametra.net/docs/draft/lots): keep city layout and replaceable assets separate; derive lots from road regions.
- [Chen et al., Interactive Procedural Street Modeling, SIGGRAPH 2008](https://www2.cs.uh.edu/~chengu/Publications/streetModeling/street_modeling.html) and [ProbableTrain algorithm](https://github.com/ProbableTrain/MapGenerator/blob/master/docs/algorithmoverview.md): direction fields motivate differing road grammars and hierarchy. This implementation does not claim a full tensor-field solver.
- [CityEngine block parameters](https://doc.arcgis.com/en/cityengine/latest/help/help-layers-block-parameters.htm): street-facing parcels, setbacks and bounded subdivision.
- [WaveFunctionCollapse](https://github.com/mxgmn/WaveFunctionCollapse): circuit examples illustrate transferable adjacency rules. WFC is not needed for the current global road graph.

Circuit boards, campuses, ports and markets are design analogies: routes form a network, blocks reserve functional areas, parcels hold repeatable components. These mappings are GPT decisions, not keyword routing or claims made by the source projects.

## API

```js
const city = api.urbanLayout({
  id: 'district', pattern: 'grid', center: [0, 0], size: [100, 100],
  blockSize: 28, roadWidth: 3, arterialWidth: 5,
  irregularity: 0.5, parcelWidth: 7, parcelDepth: 9, setback: 0.8
});
for (const road of city.roads) api.route({...road, surface:'paving', material:'asphalt'});
for (const parcel of city.parcels) {
  api.place({assetId:api.asset('building'), position:parcel.center,
    rotationY:parcel.rotationY, dimensions:[parcel.width, 8, parcel.depth]});
}
```

Planar `pattern` is `grid`, `radial`, `branching` or `organic`. Grid intersections share warped nodes. Radial streets connect concentric polygon rings to spokes and reserve a central void. Branching repeatedly cuts convex blocks, connecting each new street to existing boundaries. Organic uses seeded spatial sampling and original Voronoi half-plane clipping, with deduplicated shared edges and three-way junctions. Its seed changes block adjacency and polygon side counts; it is not a displaced grid. Parameters also include `rotation` in degrees, convex `region` vertices, `[width,depth]` block size, `rings`, `spokes` and `seed` (defaults to the persisted map seed).

Returned roads have `id`, `points`, `width`, `kind` and `closed`. Closed paths repeat their first point so the existing surface renderer paints the last segment. Blocks have `id`, inset `points` and `center`. Parcels have `id`, `blockId`, `roadId`, `center`, `width`, `depth`, `rotationY` in radians, `front` on the access road and rectangle `points`. Local Z+ faces the access road. Use fitted dimensions no larger than the parcel; otherwise the asset may cross its footprint.

The planar generator bounds each call to 80 roads, 64 blocks (26 in organic mode) and 512 parcels; actual counts derive from site size and requested dimensions. The map currently retains 96 guides, so composing districts must respect that aggregate limit. Tiny or unbuildable sites can return no parcels. Concave regions are rejected; split such sites into convex districts and connect them explicitly.

These four patterns produce planar geometry. GPT must sample actual terrain/water, choose suitable districts, inspect full footprints, reserve water and open space, and add appropriate support/crossings. They do not flatten terrain or silently avoid water. The prompt asks settlement and town-ruin requests to start with this street/block/parcel skeleton; bounded custom code remains available for topology outside the supported patterns. It does not guarantee arbitrary prompts will produce acceptable art without review.

### River banks

`api.urbanLayout({pattern:'waterfront', waterId, bankSide:'both', bankDepth:80, waterSetback:2, roadWidth:2.2, arterialWidth:3.5, blockSize:38, parcelWidth:6, parcelDepth:8, setback:0.3})` reads the declared river's smoothed banks, width and current terrain. Declare the river before calling it. On a Y=0 plain, set water `level:0` explicitly: the water API's default 0.2 can leave banks submerged. `environmentSample.waterDistance` is nonnegative (zero inside water); use `water.inside` to identify submerged positions.

Unlike planar patterns, waterfront calls do not accept `center`, `size`, `rotation` or `region`. `bankDepth` limits development measured from the shore; a whole city needs a band spanning its usable land. Roads and parcels carry `bank` labels. Full footprints are checked against water, road setbacks, terrain and map edges. The generator does not grade terrain or create bridges. Each bank is connected independently; cross-river connectivity needs explicit bridges and approaches.

Work is bounded to 12 frontage rows, 80 roads, 512 parcels and an area-derived block budget capped at 128. Guide capacity is shared fairly between banks, including connections for clipped road fragments. Bounded parcel fitting and frontage packing reduce unnecessary empty lots. These safety and density checks do not detect every bad road shape: deep offsets around tight bends currently produce loops and sharp reversals. See the [open issues and handoff](procedural-cities-issues.md).

### Road appearance

Road material recipes remain map semantics; final appearance belongs to the render scheme. `runtime.terrain-materials` now exposes eight base colors (`compactedEarthColor`, `gardenStoneColor`, `asphaltColor`, `concreteColor`, `brickPaverColor`, `cobblestoneColor`, `gravelColor`, `mudColor`), `roadDetailStrength` (0–1), and `roadTextureScale` (0.5–2). The developer panel and AI access policy use the same validated parameters. Scene profiles include surface material recipes so render AI can select the corresponding colors.

Terrain-painted roads, brick meshes and instanced stones all refresh from the same style. Brick UVs use world-space dimensions; stones are shallow rather than boulder-like. The material tests cover update/reset, refresh, resource disposal and map immutability. Colors are lit base colors, not exact final screen RGB.

## Reproducible visual study

`scripts/urbanCityCases.ts` records current Codex GPT-authored plans for different urban metaphors. Run in this isolated worktree:

```powershell
npm.cmd exec tsx -- scripts/runUrbanCityStudy.ts
npm.cmd exec tsx -- scripts/runUrbanCityStudy.ts --generate
# After adjusting only layout, reuse the purchased assets:
npm.cmd exec tsx -- scripts/runUrbanCityStudy.ts --replay --id=modern-grid
```

The default emits graybox drafts. `--generate` explicitly calls the DeepSeek backend and saves new test maps with undoable transactions. `--replay` reuses recorded asset bindings, saving a new iteration instead of replacing a previous map. The generated ledger and screenshots belong under `output/urban-city-study`; runtime map data remains uncommitted. The study is evidence for the selected plans, not an independent end-to-end benchmark of arbitrary model prompts.

Verify kernel determinism, connectivity, finite bounds, rectangle overlap and road setback in `tests/mapUrbanLayout.test.ts`; verify the real main/standard Scene Code path in `tests/urbanSceneCode.test.ts`. Run `npm test` and `npm run build`. Visual acceptance additionally requires top, oblique and near views using the real `createMapViewer` runtime, plus the editor flow. A passing geometry test is not visual acceptance.

`node scripts/testUrbanPrompt.mjs 庞贝城` tests an unchanged user prompt through the actual editor HTTP generation endpoint, using GPT planning and DeepSeek assets. It preserves first-pass code, records the request, suggestion, diagnostics and transaction in `output/urban-city-study/prompt-<mapId>.json`, and creates a new test map. Unlike the authored study fixtures, this exercises whether the planner selects the helper itself. Paid model calls are made only when explicitly running this script.

### Earlier prompt test: 庞贝城

Two runs used exactly this prompt with GPT planning and DeepSeek assets. The first produced 83 objects from 13 assets but did not call `urbanLayout`: it arranged individual courtyard ruins around a forum. After strengthening the general settlement instruction (without adding Pompeii-specific rules), the second called the helper for two grid districts, then connected them to its forum and temple. Its saved map, `map-26ad9d6d-60f5-421e`, contains 113 objects, 13 assets and 34 distinct road guides; 41 guide-upsert operations include repeated IDs. Both runs interpreted the prompt as archaeological ruins. The second completed without code-repair attempts; declaration normalization still occurred.

Top, oblique, near and camera-motion views were captured through the native viewer with no render scheme. The main editor also loaded the second map with no browser runtime errors. Full validation passed: 135 test files / 1070 tests and the production build. Software-rendered browser captures establish rendering and loading, not hardware frame-rate performance or final art acceptance.

The result is a recognizable ruin district, with street-facing courtyard houses, food shops, mills, colonnades and a temple. Visual limitations remain: coarse road texture, broad streets, repeated houses, sparse parcels and a weak terrain backdrop. Diagnostics retain six building/foundation overlap pairs, two small fountains and one terrain-amplitude limit. They were preserved for inspection, not silently repaired or presented as a historically accurate reconstruction. Exact requests, code, diagnostics and screenshots remain in the local `output/urban-city-study` ledgers.

### September 29 handoff

Later unchanged-prompt runs produced `map-1fa79824-e62e-4e90` (庞贝城: 51 complete buildings, 87 objects, 9 assets, 22 roads) and `map-1a5cc7ed-7550-43d3` (上海: 60 complete buildings, 97 objects, 10 assets, 29 roads). Object counts include trees and architectural components and must not be reported as house counts. GPT supplied the plans; DeepSeek supplied the assets. The latest geometry kernel was used when replaying the unchanged plans.

The separate controlled river study preserves a 160m map, seed 901, S-shaped river and four purchased building assets. Increasing the development band from 38m to 80m expanded the result from 107 to 185 buildings (`map-8e903b9d-c986-4b18`), but exposed unrealistic outer road folds. This is a Codex-authored layout experiment, not an unchanged natural-language prompt result, and its visual layout has **not** been accepted.

The saved custom scheme `render-ced7b5a2-9dcf-4483` contains GPT-selected road colors. The raw GPT proposal also touched unrelated soil/sand parameters; those were excluded during review before preview/save. No built-in scheme was overwritten. Preview with `/scripts/urbanCityPreview.html?map=map-8e903b9d-c986-4b18&view=top&scheme=render-ced7b5a2-9dcf-4483` while the local dev service is running. These IDs refer to local runtime data and are not portable repository fixtures.

At the user's stop request, all 1,102 tests passed and the production build had passed. Native top/oblique/near views and camera motion were captured; the editor loaded the latest map without browser runtime errors. Software GPU captures do not establish hardware frame rates. No further road-shape fix was applied after the stop request. The remaining problems, reproduction settings and evidence are recorded in [procedural-cities-issues.md](procedural-cities-issues.md).
