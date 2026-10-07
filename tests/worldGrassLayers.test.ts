import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyMap, normalizeMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { sampleGrassDensity } from '../src/shared/mapGrass';
import { MapStore } from '../src/server/mapStore';
import { executeMapDesignProgram } from '../src/server/mapDesignExecution';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
function world(height = (_x: number) => 30, size = 500) {
  const resolution = 33;
  return applyMapOperations(createEmptyMap(), [{ type: 'world.set', world: { assets: [], bundle: { patches: [], plan: {
    version: 1, id: 'grass-world', revision: 1, prompt: 'grass patches', ecology: [], towns: [], roads: [],
    recipe: { version: 1, seed: 9, size, constraints: [{ region: 'center', biome: 'grassland' }], terrainProgram: {
      version: 1, source: 'test height function', resolution, observations: [],
      heights: Array.from({ length: resolution ** 2 }, (_, i) => height((i % resolution / (resolution - 1) - 0.5) * size))
    } }
  } } } }]);
}

describe('world grass fields', () => {
  it('preserves a local grass region through actual design execution on a new world', async () => {
    const base = createEmptyMap();
    const result = await executeMapDesignProgram({ baseMap: base, assets: [], maxNewAssets: 0,
      code: `function plan(api) {
        api.createWorld({recipe:{version:1,seed:9,size:500,reliefProfile:'compact',heightScale:0.11,
          constraints:[{region:'center',biome:'grassland'}],
          terrainBrushes:[{id:'local-field',mode:'flatten',region:{kind:'circle',center:[64,40],radius:60},height:30,feather:8}]}});
        api.grass({id:'orchard',preset:'farm',region:{kind:'circle',center:[64,40],radius:18},
          density:1,variation:0,softness:0});
      }` });
    const map = applyMapOperations(base, result.operations);
    expect(map.terrain.resolutionX).toBe(2);
    const orchard = map.grassLayers.find(layer => layer.id === 'orchard')!;
    expect(orchard.resolutionX).toBe(257);
    expect(sampleGrassDensity(orchard, map, 63.9, 40)).toBe(1);
    expect(sampleGrassDensity(orchard, map, 64.1, 40)).toBe(1);
    expect(sampleGrassDensity(orchard, map, -64, 40)).toBe(0);
  });

  it('represents a local grass patch crossing a tile boundary independently of the 2x2 editor placeholder', () => {
    const map = applyMapOperations(world(), [
      { type: 'grass.layer.add', layer: { id: 'orchard', preset: 'farm' } },
      { type: 'grass.generate', layerId: 'orchard', region: { kind: 'circle', center: [64, 40], radius: 18 },
        density: 1, variation: 0, softness: 0 }
    ]);
    expect(map.terrain.resolutionX).toBe(2);
    expect(map.grassLayers[0].resolutionX).toBeGreaterThanOrEqual(257);
    expect(sampleGrassDensity(map.grassLayers[0], map, 63.9, 40)).toBe(1);
    expect(sampleGrassDensity(map.grassLayers[0], map, 64.1, 40)).toBe(1);
    expect(sampleGrassDensity(map.grassLayers[0], map, -64, 40)).toBe(0);
  });

  it('uses real world slopes rather than grass indices into the terrain placeholder', () => {
    const map = applyMapOperations(world(x => 100 + Math.max(0, x) * 1.5), [
      { type: 'grass.layer.add', layer: { id: 'farm', preset: 'farm' } },
      { type: 'grass.generate', layerId: 'farm', region: { kind: 'circle', center: [0, 0], radius: 150 },
        density: 1, variation: 0, softness: 0 }
    ]);
    expect(sampleGrassDensity(map.grassLayers[0], map, -80, 0)).toBe(1);
    expect(sampleGrassDensity(map.grassLayers[0], map, 80, 0)).toBe(0);
  });

  it('preserves a finer explicit density field through normalization, storage and reload', async () => {
    const resolution = 513, densities = Array.from({ length: resolution ** 2 }, (_, i) =>
      i % resolution === 270 ? 1 : 0);
    const map = applyMapOperations(world(), [
      { type: 'grass.layer.add', layer: { id: 'fine' } },
      { type: 'grass.density.set', layerId: 'fine', resolutionX: resolution, resolutionZ: resolution, densities }
    ]);
    expect(map.grassLayers[0].resolutionX).toBe(resolution);
    expect(normalizeMap(map).grassLayers[0].densities).toEqual(densities);
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-world-grass-')); directories.push(rootDir);
    const store = new MapStore({ rootDir }), saved = await store.importMap(map);
    const loaded = await new MapStore({ rootDir }).loadMap(saved.id);
    expect(loaded.grassLayers[0]).toEqual(map.grassLayers[0]);
    expect(loaded.terrain.resolutionX).toBe(2);
  });

  it('reads freshwater habitat distance from world water rather than the empty ordinary water list', () => {
    const base = world();
    base.world!.bundle.plan.recipe.waterBodies = [{ id: 'pond', type: 'lake', region: { kind: 'circle', center: [0, 0], radius: 10 },
      levels: [30], depth: 3, shorelineSmoothness: 0, shorelineIrregularity: 0 }];
    const map = applyMapOperations(base, [
      { type: 'grass.layer.add', layer: { id: 'reeds', preset: 'wetland' } },
      { type: 'grass.generate', layerId: 'reeds', region: { kind: 'circle', center: [0, 0], radius: 90 },
        density: 1, variation: 0, softness: 0, habitat: { waterDistance: [0, 0, 10, 20] } }
    ]);
    expect(map.waterBodies).toHaveLength(0);
    expect(sampleGrassDensity(map.grassLayers[0], map, 20, 0)).toBeGreaterThan(0.7);
    expect(sampleGrassDensity(map.grassLayers[0], map, 60, 0)).toBe(0);
  });

  it('preserves legacy layer precision on load and upgrades a 2x2 layer only when locally editing it', () => {
    const base = world();
    base.grassLayers = [{ id: 'old', name: 'Old', visible: true, seed: 1, preset: 'meadow', height: 1,
      resolutionX: 2, resolutionZ: 2, densities: [0, 0, 0, 0], mix: { short: 1, tall: 0, flowers: 0 } }];
    expect(normalizeMap(base).grassLayers[0].resolutionX).toBe(2);
    const updated = applyMapOperations(base, [{ type: 'grass.brush', layerId: 'old', mode: 'density',
      point: [0, 0], size: 5, strength: 1, targetDensity: 1 }]);
    expect(sampleGrassDensity(updated.grassLayers[0], updated, 0, 0)).toBe(1);
    expect(updated.grassLayers[0].resolutionX).toBeGreaterThanOrEqual(257);
  });

  it('caps new large-world allocations and rejects invalid persisted world precision before allocation', () => {
    const huge = applyMapOperations(world(() => 30, 256000), [{ type: 'grass.layer.add', layer: { id: 'bounded' } }]);
    expect(huge.grassLayers[0].resolutionX).toBeLessThanOrEqual(513);
    expect(huge.grassLayers[0].densities.length).toBeLessThanOrEqual(513 ** 2);
    for (const resolutionX of [514, 1e9, -2, 2.5, Infinity]) {
      expect(() => normalizeMap({ ...huge, grassLayers: [{ ...huge.grassLayers[0], resolutionX }] })).toThrow();
    }
  });
});
