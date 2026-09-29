import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createEmptyMap, normalizeMap, sampleTerrainHeight } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { validateWorldMapState, type WorldMapState } from '../src/shared/worldMapState';
import { createWorldSampler } from '../src/shared/worldTerrain';
import { MapStore } from '../src/server/mapStore';

function world(): WorldMapState {
  const recipe = {version: 1 as const, seed: 2309, size: 1600, heightScale: 0.1,
    constraints: [{region: 'center' as const, biome: 'grassland' as const}]};
  return {bundle: {plan: {version: 1, id: 'test-world', revision: 1, prompt: 'A grassland world', recipe,
    towns: [], roads: [], ecology: []}, patches: []}, assets: []};
}

it('keeps the continuous sampler and a tiny persisted placeholder through normalization', () => {
  const state = world(), expected = createWorldSampler(state.bundle.plan.recipe)(53, -127).height;
  const map = applyMapOperations(createEmptyMap(), [{type: 'world.set', world: state}]);
  const reloaded = normalizeMap(JSON.parse(JSON.stringify(map)));
  expect(reloaded.terrain.heights).toHaveLength(4);
  expect(sampleTerrainHeight(reloaded, 53, -127)).toBeCloseTo(expected, 8);
  expect(reloaded.box.size[0]).toBe(1600);
  expect(() => applyMapOperations(reloaded, [{type: 'terrain.brush', mode: 'raise', point: [0, 0, 0]}])).toThrow('world_terrain_requires_world_plan');
  expect(() => applyMapOperations(reloaded, [{type: 'map.update', size: [100, 40, 100]}])).toThrow('world_size_is_recipe_owned');
  expect(() => validateWorldMapState(null)).toThrow('invalid_world_map');
});

it('saves a world as one undoable transaction and carries its bound assets through export/import', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-world-transaction-'));
  try {
    const store = new MapStore({rootDir});
    const map = await store.createMap({name: 'World transaction'});
    const asset = await store.saveAsset({name: 'Reusable house', prompt: 'A house', provider: 'deepseek', modelJson: {format: 2, nodes: []}});
    const state = world();
    state.assets.push({key: 'house', role: 'house', assetId: asset.id});
    const committed = await store.commitTransaction(map.id, {source: 'agent', operations: [{type: 'world.set', world: state}]}, map.version);
    expect(committed.transaction.operationCount).toBe(1);
    const loaded = await new MapStore({rootDir}).loadMap(map.id);
    expect(loaded.assets?.map(item => item.id)).toContain(asset.id);
    expect(loaded.world).toEqual(state);
    expect((await store.undoTransaction(map.id)).map.world).toBeUndefined();
    expect((await store.redoTransaction(map.id)).map.world).toEqual(state);
    const imported = await store.importMap(loaded);
    expect(imported.world?.assets[0].assetId).not.toBe(asset.id);
    expect(imported.assets?.[0].id).toBe(imported.world?.assets[0].assetId);
    const bad = world(); bad.assets.push({key: 'house', role: 'house', assetId: 'asset-missing'});
    await expect(store.commitTransaction(map.id, {source: 'agent', operations: [{type: 'world.set', world: bad}]})).rejects.toThrow('unknown_map_asset');
    expect((await store.loadMap(map.id)).world).toEqual(state);
  } finally { await rm(rootDir, {recursive: true, force: true}); }
});
