# Code-Driven Map Planner

WorldForge's first procedural planning slice keeps the existing transaction architecture:

```text
prompt -> AI JavaScript -> discovery VM pass -> declared asset requirements
       -> concurrent model generation -> deterministic VM replay
       -> placement intents -> MapOperation[] -> map lint/repairs
       -> preview -> transaction
```

The generated code cannot access files, network, timers, imports, `eval`, `Function`, or host globals. It only receives a frozen `api` object, runs synchronously with a timeout, and can emit at most 2,000 placements.

## Initial function set

The first set focuses on the operations most often repeated in procedural environment workflows:

- Control flow: ordinary JavaScript `for`, `for...of`, `while`, and `if/else`.
- Curves: `linePoint`, `bezierPoint`, and `sampleBezier` for roads, rivers, borders, walls, hedges, and sight lines.
- Fields and masks: deterministic `noise2D` and `fbm2D` for terrain-aware density and variation.
- Natural distribution: `poissonDisk` for non-overlapping trees, rocks, props, and landmarks.
- Structured distribution: `gridPoints` and `circlePoint` for settlements, farms, plazas, courtyards, and radial compositions.
- Transitions: `clamp`, `lerp`, `remap`, and `smoothstep` for falloff and density blending.
- Transforms: `rotate2D`, `distance2D`, `tangentYaw`, and `faceYaw` for path alignment, target-facing, and symmetry.
- Facing contract: generated models use local `Y+` up, `Z+` front/forward, and `X+` right; `place({ facing: { target } })` or `place({ facing: { direction } })` resolves the world `rotationY`.
- Determinism: `api.random` replaces `Math.random` and derives from the persisted map seed.
- Asset declaration: `api.requireAsset` describes prompt-specific reusable asset families and variant counts.
- Asset binding: `api.asset` selects a generated variant deterministically, including modulo selection inside loops.
- Point compatibility: generated points support both `[0]/[1]` and `.x/.z`, matching common procedural-code styles.

These choices mirror the recurring building blocks in procedural environment systems: spline sampling, coherent noise, point scattering with minimum separation, grids/radial layouts, and scalar masks. The planner intentionally does not expose raw terrain mutation or direct map writes.

## Generated assets

Code planning can generate new assets instead of only composing existing ones. The generated program declares what it needs:

```js
function plan(api) {
  const pine = api.requireAsset({
    key: 'pine',
    name: 'Tall pine',
    prompt: 'Standalone low-poly tall pine tree, no ground or background',
    tags: ['tree', 'pine'],
    variants: 4
  });

  const points = api.poissonDisk({ minDistance: 5, maxPoints: 30 });
  for (let index = 0; index < points.length; index += 1) {
    api.place({ assetId: api.asset(pine, index), position: points[index] });
  }
}
```

Directional placement example:

```js
function plan(api) {
  const gate = api.requireAsset({
    key: 'gate',
    name: 'Arena gate',
    prompt: 'Standalone arena gate with entrance toward local Z+, no ground or background',
    tags: ['arena', 'gate'],
    variants: 1
  });
  const center = [0, 0];
  for (let index = 0; index < 8; index += 1) {
    const point = api.circlePoint(index, 8, 28, center);
    api.place({ assetId: api.asset(gate, 0), position: point, facing: { target: center } });
  }
}
```

The Code Planner automatically appends the same local-axis contract to each newly generated asset prompt, so model orientation and scene placement use the same convention.

WorldForge executes the code once to discover requirements, generates all requested variants through the shared unbounded-concurrency asset pool, then replays the same code from the same map seed with real persisted asset IDs. Asset generation remains outside the sandboxed VM. The request's `minNewAssets` and `maxNewAssets` values constrain the generated variant count; if a valid first program declares too few new assets, the planner requests one asset-focused revision before continuing.

Code execution allows two AI repair passes for invalid coordinates, array bounds, vector shapes, and other non-finite calculations. Invented reusable asset IDs no longer abort the whole plan: WorldForge first attempts an exact name match, then degrades unresolved placements to editor proxies with a warning while preserving valid generated assets.

## API endpoint

```text
POST /api/editor/maps/:mapId/code-generate
```

Body:

```json
{
  "prompt": "Create a winding path with sparse trees on both sides",
  "provider": "gpt",
  "baseOperations": [],
  "minNewAssets": 2,
  "maxNewAssets": 16
}
```

The endpoint supports the same SSE progress stream used by normal map generation. The response uses the normal `MapAiSuggestion` shape: `suggestion.generatedAssets` lists newly persisted assets, while `suggestion.codePlan` contains the generated source, placement count, and API functions used. The map is not committed until the existing transaction endpoint receives the confirmed operations.
