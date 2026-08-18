# Code-Driven Map Planner

WorldForge's first procedural planning slice keeps the existing transaction architecture:

```text
prompt -> AI JavaScript -> bounded VM runtime -> placement intents
       -> MapOperation[] -> map lint/repairs -> preview -> transaction
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

These choices mirror the recurring building blocks in procedural environment systems: spline sampling, coherent noise, point scattering with minimum separation, grids/radial layouts, and scalar masks. The planner intentionally does not expose raw terrain mutation or direct map writes.

## API endpoint

```text
POST /api/editor/maps/:mapId/code-generate
```

Body:

```json
{
  "prompt": "Create a winding path with sparse trees on both sides",
  "provider": "gpt",
  "baseOperations": []
}
```

The response uses the normal `MapAiSuggestion` shape. `suggestion.codePlan` contains the generated source, placement count, and the API functions used. The map is not committed until the existing transaction endpoint receives the confirmed operations.
