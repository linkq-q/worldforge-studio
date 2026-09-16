# Scene art controls

These are render-scheme controls. They do not rewrite map geometry or source assets, and they run in both the editor and `createMapViewer`. Map confirmation is still required before render generation. Existing maps are not automatically relit or recolored.

## AI context and permissions

`RenderSceneProfile.targets` supplies bounded object IDs, tagged part IDs, positions, zone IDs and grass-layer IDs. Render AI must use these IDs rather than inventing targets. Refine retains the current plan. The four modules below are repeatable, require a unique `key`, omit `scope`, and carry a JSON **string** in `params.config`. They participate in the existing per-scheme `accessPolicy`; a developer can disable each configuration channel. Existing explicit permission restrictions remain intact.

| Module | Limit | Config |
| --- | --- | --- |
| `runtime.color-field` | 4 | `zoneId?`, `target` (`ground-and-grass`, `terrain`, `grass`), `axis` (`x`, `z`, `radial`), `center`, `start`, `end`, `feather`, `strength`, `stops` |
| `runtime.local-light` | 8 | `objectId`, `kind`, `color`, `intensity`, `range`, local `offset`, optional `targetId`, `enabled` |
| `runtime.surface-detail` | 8 | `objectId`, optional `partId`, `color`, `roughness`, `metalness`, `transmission`, `colorExpression`, `emissionExpression` |
| `runtime.wet-surface` | 1 | `zoneId`, `strength`, `distortion` |

Only supply fields needed for the requested change. Missing/invalid IDs fail validation; unsupported material overrides are rejected and the render-only changes are cleared. An empty developer config is an inactive draft; AI cannot submit an empty config. No arbitrary executable JavaScript is accepted.

## Grass and shared ground colors

Explicit grass root/tip colors now override preset hues. Unspecified colors retain the preset fallback. `rootDarken` and `gradientBias` are open to AI by default; density/instance budgets and distance quality controls remain restricted. `colorStops` is a JSON string containing 2–4 `[height, hexColor]` entries with strictly increasing positions, first `0`, last `1`. It describes actual blade-height colors rather than a number of interpolated bands. Removing a ramp restores the regular two-color grass behavior.

For example, the value of `runtime.grass-style.params.colorStops` can be:

```json
"[[0,\"#344d40\"],[0.35,\"#65856b\"],[1,\"#c0cc87\"]]"
```

A `runtime.color-field` config can be:

```json
{"zoneId":"code:shore","target":"ground-and-grass","axis":"x","start":-12,"end":12,"feather":1.5,"strength":0.8,"stops":[[0,"#3e6773"],[0.55,"#6b9978"],[1,"#b5b477"]]}
```

X/Z intervals use world metres; radial gradients use distance from `center`. Region boundaries reuse the map's circle/path/polygon semantics. The host composes bounded 128² color textures shared by grass and terrain. Grass retains its blade-ramp variation around the regional base color. Rules blend in plan order, with later rules on top. An enabled user palette constrains selected colors to that palette; explicit grass choices are snapped to nearest allowed role colors rather than replaced by a random role choice.

## Lights, surfaces and wet roads

Scene Code `requireAsset` now accepts `light` using the existing `MapAssetLight` shape. The metadata travels to asset generation/storage and may not change during post-generation layout adaptation. This makes newly generated functional lamps usable by the actual light system, not just bright meshes.

Render local-light rules override the designated instance in a transient map view. They retain the existing shared point/spot budgets (they do not add an independent unbounded light pool). Offsets follow the object's scale/rotation; targets use object world positions. Clearing the scheme restores original light metadata. Existing lamps without metadata can be lit through these render rules.

Surface overrides use `RuntimeIndex` identities and per-slot masks for both instanced and batched meshes. They clone render materials/geometry as needed, leave neighbors and source assets untouched, and restore originals on clear. Transmission is available only on existing physical glass. Water and custom ShaderMaterials are not accepted by this module.

Wet roads use one 512² planar capture, blended only inside the selected zone. The first version accepts flat **terrain** regions (not sloping terrain or room-shell floors); a height spread over 0.12m is rejected. Reflection strength is capped at 0.65. This is a local reflection layer, not screen-space reflections or a new general water system. Editor helpers are hidden during capture. The capture is render-scheme-owned and disposed on scheme changes.

## Simple shader expressions: permission ladder level 2

AI can write a `vec3` expression inside a fixed, lit material template. It cannot write a whole shader. Example:

```glsl
color * (0.85 + 0.15 * sin(position.x * 2.0 + time))
```

Available values: `color` (linear base color), world `position`, world `normal`, `uv`, `time`. Allowed operators: `+`, `-`, `*`. Allowed functions: `vec2`, `vec3`, `sin`, `cos`, `abs`, `fract`, `min`, `max`, `clamp`, `mix`, `smoothstep`. Smoothstep edges must be increasing numeric constants. RGB/XYZ swizzles are type checked.

The parser enforces vector/scalar types, length, node/depth limits and bounded arithmetic. It rejects statements, loops, comments, macros, division, textures, uniforms, imports and user-defined functions. The fixed template limits output colors/emission and preserves the existing light/shadow chain. The old developer-only full-GLSL extension remains storage-only, not executable by AI.

## Verification

Run `npm test` and `npm run build`. The HTTP test uses a temporary store and mocked model reply to cover generate → validate → save → reload without contacting an external model.

Open `/tests/fixtures/scene-art-preview.html` on the Vite server for GPU checks. Compare the same scene before/after, check the isolated second pillar, light pool, road reflection and grass gradient; test Cel and repeated restoration. This is a capability fixture, not visual acceptance of a finished user scene. Screenshot-based automatic art review is not part of this batch.
