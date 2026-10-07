# Terrain program sampling

Terrain programs retain the **257 × 257** default sampling budget and support an explicit **513 × 513** field. On the terrain-only API's 500 m square these mean **1.953125 m** and **0.9765625 m** between samples respectively. Existing saved programs retain their exact `resolution` and `heights`; loading a 257 field does not run its source or resample it.

`POST /api/editor/worlds/generate` accepts optional `resolution` for `representation: "program"`:

```json
{"mode":"terrain-only","representation":"program","prompt":"A connected mountain ridge and valley","seed":47,"size":500,"resolution":513}
```

The request, model prompt, compiler, and program context use the same selected resolution. Programs can read `t.resolution` and `t.spacing`, with `t.spacing = t.size / (t.resolution - 1)`. Compiled clients use bilinear interpolation; a sub-cell feature can still be missed. This is a sampled height field, not support for overhangs or caves.

Limits:

- `resolution` must be an integer from 33 through 513, at most 263169 height samples. Malformed values produce `invalid_terrain_program_resolution`; larger integer values produce `terrain_program_resolution_out_of_budget` before any model call. No automatic downgrade occurs.
- Worker execution remains 12 seconds with a 128 MiB V8 old-generation heap limit. Compiled result JSON is limited to 8 MiB measured as UTF-8 bytes; excess produces `terrain_program_output_too_large`. Existing timeout and worker failures remain visible.
- A 513 field has almost four times as many samples as a 257 field. Expensive programs such as repeated erosion can exceed the unchanged execution budget at 513 even when they succeed at 257. Choose the higher resolution explicitly; the compiler never silently reduces resolution or erosion settings.
- The HTTP transaction body limit remains 16 MiB. A real rich 513 field is covered by the API transaction/reload/undo test.
- Requests for `representation: "recipe"` without the new field retain the old path. Supplying `resolution` to a recipe request produces `invalid_terrain_only_request` because recipe terrain does not use this program grid.

The settled 500 m editor renderer already uses 64 tiles of 62.5 m with 65 vertices per side, matching the new field spacing. This change does not increase its mesh budget or alter distant LOD. The initial temporary coarse preview is unchanged; wait for streaming to settle before comparing fine terrain.
