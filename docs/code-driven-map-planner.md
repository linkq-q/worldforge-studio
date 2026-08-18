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
- Transforms: `rotate2D`, `distance2D`, and `tangentYaw` for alignment and symmetry.
- Determinism: `api.random` replaces `Math.random` and derives from the persisted map seed.
- Asset declaration: `api.requireAsset` describes prompt-specific reusable asset families and variant counts.
- Asset binding: `api.asset` selects a generated variant deterministically, including modulo selection inside loops.

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

WorldForge executes the code once to discover requirements, generates all requested variants through the shared unbounded-concurrency asset pool, then replays the same code from the same map seed with real persisted asset IDs. Asset generation remains outside the sandboxed VM. The request's `maxNewAssets` value bounds the total number of variants, with the normal default of 16 and hard maximum of 32.

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
  "maxNewAssets": 16
}
```

The endpoint supports the same SSE progress stream used by normal map generation. The response uses the normal `MapAiSuggestion` shape: `suggestion.generatedAssets` lists newly persisted assets, while `suggestion.codePlan` contains the generated source, placement count, and API functions used. The map is not committed until the existing transaction endpoint receives the confirmed operations.
