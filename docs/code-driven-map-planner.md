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
- Curve frames: `bezierPoint` and `sampleBezierFrames` expose `{ point, tangent, normal }`. Path pieces use `facing: { tangent: frame.tangent }`; wall facades use `facing: { normal: frame.normal }`. The normal is the left-side unit normal as curve `t` increases, and `offsetY: api.TAU / 2` flips it.
- Repeated module spacing: `sampleBezierFramesBySpacing(..., spacing, gapRatio?)` resamples by approximate arc length instead of parameter `t`; its default `gapRatio` is `0.08`, leaving a small intentional spacing between repeated modules.
- Endpoint connection: `placeBetween({ start, end, dimensions, spanAxis })` derives the midpoint and rotation from two computed points, then fits only the declared long axis to the endpoint distance. It can coexist with ordinary `place({ facing })` and accepts an optional facing override.
- Determinism: `api.random` replaces `Math.random` and derives from the persisted map seed.
- Asset declaration: `api.requireAsset` describes prompt-specific reusable asset families and variant counts.
- Asset binding: `api.asset` selects a generated variant deterministically, including modulo selection inside loops.
- Point compatibility: generated points support both `[0]/[1]` and `.x/.z`, matching common procedural-code styles.

These choices mirror the recurring building blocks in procedural environment systems: spline sampling, coherent noise, point scattering with minimum separation, grids/radial layouts, and scalar masks. The planner intentionally does not expose raw terrain mutation or direct map writes.

## Indoor Code planning

When the map was created with scene mode `indoor`, the same Code generation endpoint switches to a room-native planning contract instead of the outdoor environment contract. The parameterized room remains structural map data; Code generation creates furniture, fixtures, doors, windows, wall-mounted objects, ceiling-mounted objects, and functional relationships inside it.

Indoor programs receive these additional APIs:

- `api.room`: current room position, size, wall thickness, and openings.
- `api.roomPoint(localX, localZ, height?)`: converts room-centred floor coordinates into a fixed world `[x, y, z]` position.
- `api.wallFrame(wall, offset?, bottom?, inset?)`: returns `{ point, inward, outward, tangent }` for wall-mounted placement.
- `api.ceilingPoint(localX, localZ, objectHeight?, drop?)`: positions an object immediately below the room ceiling.
- `api.opening({ id, kind, wall, offset?, bottom?, width?, height? })`: adds a parameterized door/window opening and returns the opening ID.
- `api.place({ roomOpeningId, dimensions, ... })`: binds a generated door/window model to an opening; room position and rotation are resolved automatically.

Example:

```js
function plan(api) {
  const board = api.requireAsset({
    key: 'board',
    name: 'Classroom board',
    prompt: 'Standalone wall board with visible face toward local Z+',
    dimensions: [3, 1.4, 0.12],
    tags: ['board', 'wall-mounted'],
    variants: 1
  });
  const frame = api.wallFrame('north', 0, 1.1);
  api.place({
    assetId: api.asset(board, 0),
    position: frame.point,
    dimensions: [3, 1.4, 0.12],
    facing: { direction: frame.inward }
  });

  const openingId = api.opening({
    id: 'door-main', kind: 'door', wall: 'south', offset: 3, width: 1.2, height: 2.1
  });
  const door = api.requireAsset({
    key: 'door',
    name: 'Classroom door',
    prompt: 'Standalone interior door facing local Z+',
    dimensions: [1.2, 2.1, 0.12],
    tags: ['door'],
    variants: 1
  });
  api.place({ assetId: api.asset(door, 0), roomOpeningId: openingId, dimensions: [1.2, 2.1, 0.12] });
}
```

Indoor Code generation uses fixed-height placements and adds `room.set` plus object operations in one preview transaction. It does not generate terrain, water, roads, outdoor vegetation, building exteriors, or a whole-room model. The prompt instructs the model to preserve at least a `0.8` world-unit route from each door to the main activity area and to build functional furniture groups before adding decor.

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

For any repeated modular element, the generated asset prompt also states the span/connection axis explicitly: side-by-side modules span local `X` with their front/depth on local `Z`; traversal modules span local `Z`. `requireAsset({ dimensions: [width, height, depth] })` adds the same canonical dimensions to the model-generation prompt, so generation and placement share one size contract.

For uninterrupted connected scenery, use one asset family with `variants: 1` unless a visible transition is intentional. Alternating variants along the same run can produce incompatible connection shapes even when their nominal sizes match.

Curved wall example:

```js
function plan(api) {
  const wall = api.requireAsset({
    key: 'garden-wall',
    name: 'Garden wall segment',
    prompt: 'Standalone modular garden wall, decorative facade toward local Z+, seamless ends; span local X',
    dimensions: [6, 3, 0.5],
    tags: ['wall', 'garden'],
    variants: 1
  });
  const frames = api.sampleBezierFramesBySpacing(
    [-32, -12], [-18, 24], [18, -24], [32, 12], 6, 0.06
  );
  for (let index = 0; index < frames.length - 1; index += 1) {
    api.placeBetween({
      assetId: api.asset(wall, 0),
      start: frames[index].point,
      end: frames[index + 1].point,
      dimensions: [6, 3, 0.5],
      spanAxis: 'x'
    });
  }
}
```

With `spanAxis: 'x'`, the ordered `start -> end` line becomes local `X+`, and local `Z+` automatically faces the line's left side. Reverse the endpoints to flip the facade. Use `spanAxis: 'z'` when the asset's forward/traversal axis itself should connect the endpoints.

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
