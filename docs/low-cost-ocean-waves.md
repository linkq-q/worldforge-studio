# Low-cost ocean waves

## Goal

Give the editor ocean coherent fluid-like motion without running a global fluid solver. The implementation must remain adjustable through the existing water controls, preserve rivers and lakes, and keep one ocean draw call.

## Source findings

- Unreal's Water Waves asset uses GPU-driven Gerstner waves for the default ocean surface. Its generator exposes wave count, wavelength and amplitude falloff, wind direction/spread, and steepness. Fewer waves are explicitly cheaper. Source: <https://dev.epicgames.com/documentation/en-us/unreal-engine/simulating-waves-using-the-water-waves-asset?application_version=4.27>
- Unreal's water mesh concentrates tessellation around the camera with quadtree LOD tiles and morphs between levels; distant water uses progressively coarser geometry. Source: <https://dev.epicgames.com/documentation/unreal-engine/water-meshing-system-and-surface-rendering-in-unreal-engine>
- Unreal's Niagara shallow-water solver is a height-field technique for local pools, wakes, and interactions. A full 3D FLIP simulation is a substantially more expensive tier and is not the default global-ocean solution. Source: <https://dev.epicgames.com/documentation/unreal-engine/fluid-simulation-in-unreal-engine---overview?lang=en-US>
- Unreal 5.8 describes the Water system as a shared rendering/meshing pipeline that supports local gameplay ripples and boat wakes, while its scalability controls separately tune mesh LOD density and morphing. Sources: <https://dev.epicgames.com/documentation/unreal-engine/water-system-in-unreal-engine> and <https://dev.epicgames.com/documentation/en-us/unreal-engine/water-debugging-and-scalability-options-in-unreal-engine>
- The original GPU Gems water model likewise combines a small Gerstner sum for macro geometry with finer normal-map motion. It recommends only a few geometry waves and bounds steepness to avoid loops. Source: <https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models>

## WorldForge implementation

### Macro surface

The vertex shader sums four authored directional components. For wave number `k`, direction `D`, amplitude `A`, and phase `phi`:

```text
omega = sqrt(g * k)
phase = dot(worldXZ, D) * k + omega * time + phi
y     = A * sin(phase)
xz    = D * A * steepness * cos(phase)
```

The horizontal displacement is the important difference from a stack of scrolling height-only sine waves: vertices follow a bounded orbital path and form sharper crests. The existing `waveStrength`, `waveSpeed`, `waveScale`, `waveDirection`, and `waveSharpness` controls remain the public parameter surface. River flow keeps its previous height-only path.

Ocean terrain depth attenuates lateral displacement near land before the existing swash function takes over. The existing world-space normal maps still provide micro ripples, so high-frequency geometry waves are unnecessary.

### Geometry budget

The previous ocean was one uniform 4096 m plane with `192 x 192` cells. On a 96 m map this put neighboring vertices about 21.3 m apart, too coarse for the default macro wavelength.

The replacement is one indexed geometry and one draw call composed of three aligned square rings:

| Ring | Half extent | Spacing on a 96 m map | Purpose |
| --- | ---: | ---: | --- |
| Near | 128 m | 4 m | playable map, shore, readable crests |
| Mid | 512 m | 16 m | transition water |
| Far | 2048 m | 64 m | horizon coverage |

Ring boundaries share the same world coordinates, so the shader displacement remains continuous. For larger maps the three extents scale together and always keep the playable map inside the near ring. This is a map-centered adaptation of Unreal's near-dense/far-coarse water mesh; it is deliberately simpler than a camera-following quadtree because WorldForge maps are centered and bounded.

Geometry cost changed from 37,249 vertices / 73,728 triangles to 12,675 vertices / 23,552 triangles. The higher-quality near field therefore costs less geometry overall.

### Bounded interaction height field

WorldForge adds the fluid-like tier only while a player is moving through water:

- The first gameplay impulse lazily allocates one `32 x 32` scalar height field for that water surface. Rain retains the existing analytic decal path and does not allocate or wake the solver.
- A fixed 30 Hz damped wave equation propagates each impulse through four-neighbour height differences. The frame loop performs at most three catch-up steps, clamps height to `+-0.25 m`, absorbs the outer three cells, and sleeps three seconds after the final impulse.
- The simulated domain is only `16 x 16 m`. It recentres and clears when the interaction leaves the central 60% region, so cost does not grow with map or ocean size.
- The height texture displaces the water mesh. Because the simulation grid can be denser than lake or ocean geometry, the fragment shader also samples its four-neighbour gradient for the reflection/highlight normal. This preserves readable concentric ripples without another draw call or a second simulation.
- Rain and player interaction have independent cooldown keys, so a rain shower cannot suppress a player's local wake.

This is deliberately a local 2D wave equation rather than a global Navier-Stokes or FLIP solve. It gives impacts memory, outward propagation, troughs, damping, and interference while inactive water pays only a uniform branch and the shared neutral texture.

## Measured browser result

Measured in the original editor on the same ocean map and the same water parameters (`waveStrength=1.2`, `waveScale=0.55`, `waveDirection=28`, `waveSharpness=2.6`):

| Build | FPS average | FPS 1% low | Frame average | Draw calls | Scene triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Previous directional waves | 165.0 | 158.7 | 6.06 ms | 67 | 448,226 |
| Four-wave Gerstner + three LOD rings | 164.9 | 156.3 | 6.06 ms | 67 | 398,050 |

Environment: Edge, ANGLE D3D11, NVIDIA GeForce RTX 5060 Laptop GPU, 1280 x 720. This is a single-machine comparison, not a universal hardware target. The editor also reported a pre-existing missing `HDRI-35.exr`; no WebGL shader compilation or runtime page error occurred.

The local solver was also measured in the original play mode on the same pond and camera path. Each sample lasted ten seconds:

| Pond state | FPS average | FPS 1% low | Frame average | Draw calls | Scene triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Solver asleep, player still | 135.1 | 80.0 | 7.40 ms | 401 | 454,485 |
| Solver active, player wading | 137.3 | 92.6 | 7.28 ms | 401 | 454,485 |

The run-to-run variation is larger than any measured solver cost, so these numbers support only a bounded conclusion: no FPS regression was measurable on this machine, and activation adds neither a draw call nor geometry. An active surface uploads 4 KiB of height data at 30 Hz and keeps three 4 KiB CPU arrays (12 KiB total). The active/sleep browser screenshots show the local ring trail disappearing after the three-second timeout. The same pre-existing HDRI 404 was present and no WebGL shader error occurred.

## Deliberate boundaries

- This is a physically inspired surface model, not a mass-conserving ocean simulation.
- Global FFT and 3D FLIP were rejected for the current cost target.
- The local height field is visual interaction only; it does not feed buoyancy, collision, or the persisted map schema.
- A camera-following ring origin is only needed if a future map can move the playable area far from the current centered bounds.
