# Low-cost ocean waves

## Goal

Give the editor ocean coherent fluid-like motion without running a global fluid solver. The implementation must remain adjustable through the existing water controls, preserve rivers and lakes, and keep one ocean draw call.

## Source findings

- Unreal's Water Waves asset uses GPU-driven Gerstner waves for the default ocean surface. Its generator exposes wave count, wavelength and amplitude falloff, wind direction/spread, and steepness. Fewer waves are explicitly cheaper. Source: <https://dev.epicgames.com/documentation/en-us/unreal-engine/simulating-waves-using-the-water-waves-asset?application_version=4.27>
- Unreal's water mesh concentrates tessellation around the camera with quadtree LOD tiles and morphs between levels; distant water uses progressively coarser geometry. Source: <https://dev.epicgames.com/documentation/unreal-engine/water-meshing-system-and-surface-rendering-in-unreal-engine>
- Unreal's Niagara shallow-water solver is a height-field technique for local pools, wakes, and interactions. A full 3D FLIP simulation is a substantially more expensive tier and is not the default global-ocean solution. Source: <https://dev.epicgames.com/documentation/unreal-engine/fluid-simulation-in-unreal-engine---overview?lang=en-US>
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

## Measured browser result

Measured in the original editor on the same ocean map and the same water parameters (`waveStrength=1.2`, `waveScale=0.55`, `waveDirection=28`, `waveSharpness=2.6`):

| Build | FPS average | FPS 1% low | Frame average | Draw calls | Scene triangles |
| --- | ---: | ---: | ---: | ---: | ---: |
| Previous directional waves | 165.0 | 158.7 | 6.06 ms | 67 | 448,226 |
| Four-wave Gerstner + three LOD rings | 164.9 | 156.3 | 6.06 ms | 67 | 398,050 |

Environment: Edge, ANGLE D3D11, NVIDIA GeForce RTX 5060 Laptop GPU, 1280 x 720. This is a single-machine comparison, not a universal hardware target. The editor also reported a pre-existing missing `HDRI-35.exr`; no WebGL shader compilation or runtime page error occurred.

## Deliberate boundaries

- This is a physically inspired surface model, not a mass-conserving ocean simulation.
- Global FFT and 3D FLIP were rejected for the current cost target.
- Local shallow-water height-field interaction remains a separate optional tier for wakes or impacts. It should run in a small bounded region and must not replace the macro Gerstner surface.
- A camera-following ring origin is only needed if a future map can move the playable area far from the current centered bounds.
