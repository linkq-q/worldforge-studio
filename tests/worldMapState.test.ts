import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createEmptyMap, normalizeMap, sampleTerrainHeight } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { worldPlanKey } from '../src/shared/worldPlanning';
import { validateWorldMapState, worldMapSampler, worldMapTerrainContext, type WorldMapState } from '../src/shared/worldMapState';
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
  const context = worldMapTerrainContext(state);
  expect(worldMapTerrainContext(state)).toBe(context);
  expect(worldMapSampler(state)).toBe(context.sample);
  const map = applyMapOperations(createEmptyMap(), [{type: 'world.set', world: state}]);
  const reloaded = normalizeMap(JSON.parse(JSON.stringify(map)));
  expect(reloaded.terrain.heights).toHaveLength(4);
  expect(sampleTerrainHeight(reloaded, 53, -127)).toBeCloseTo(expected, 8);
  expect(reloaded.box.size[0]).toBe(1600);
  expect(() => applyMapOperations(reloaded, [{type: 'terrain.brush', mode: 'raise', point: [0, 0, 0]}])).toThrow('world_terrain_requires_world_plan');
  expect(() => applyMapOperations(reloaded, [{type: 'map.update', size: [100, 40, 100]}])).toThrow('world_size_is_recipe_owned');
  expect(() => validateWorldMapState(null)).toThrow('invalid_world_map');
});

it('preserves ecology asset intent while accepting legacy untyped tree bindings', () => {
  const state = world();
  state.bundle.plan.ecology = [{
    id: 'oak-grove', kind: 'broadleaf', biome: 'forest', density: 0.6,
    spacing: 18, maxSlope: 25, scale: [0.8, 1.2]
  }];
  state.assets = [
    {key: 'legacy-tree', role: 'tree', assetId: 'asset-legacy'},
    {key: 'oak', role: 'tree', assetId: 'asset-oak', ecologyKind: 'broadleaf', ecologyRuleId: 'oak-grove'}
  ];
  expect(validateWorldMapState(state).assets).toEqual(state.assets);
  expect(() => validateWorldMapState({...state, assets: [{...state.assets[1], ecologyKind: 'pine'}]}))
    .toThrow('invalid_world_asset_binding');
});

it('allows ordinary construction to keep primitive fallbacks while requiring landmark assets', () => {
  const state = world();
  const foundation = createWorldSampler(state.bundle.plan.recipe)(0, 0).height;
  state.bundle.plan.towns = [{
    id: 'town', name: 'Town', prompt: 'A built town', center: [0, 0], radius: 100, blend: 64,
    foundation, terrainMode: 'conform', ports: []
  }];
  state.bundle.patches = [{
    townId: 'town', worldKey: worldPlanKey(state.bundle.plan), summary: 'Raw construction', streets: [],
    buildings: [{
    id: 'home', x: 0, z: 0, width: 8, depth: 8, height: 6, use: 'home'
    }]
  }];
  state.assets = [{key: 'generated-shop', role: 'shop', assetId: 'asset-shop'}];
  expect(validateWorldMapState(state).bundle.patches[0].buildings[0].use).toBe('home');

  state.bundle.patches[0].buildings.push({
    id: 'hall', x: 20, z: 0, width: 12, depth: 12, height: 10, use: 'school', assetKey: 'town-hall'
  });
  expect(() => validateWorldMapState(state)).toThrow('world_missing_asset_binding:town-hall');
});

it('loads a legacy world whose tagged harbor quay is shorter than current generation quality', () => {
  const state = world(), sample = createWorldSampler(state.bundle.plan.recipe);
  state.bundle.plan.towns = [{
    id: 'harbor', name: 'Harbor', prompt: 'Legacy fishing town', center: [0, 0], radius: 100, blend: 100,
    foundation: sample(0, 0).height, terrainMode: 'conform', targetWaterBodyId: 'sea', ports: []
  }];
  state.bundle.patches = [{
    townId: 'harbor', worldKey: '', summary: 'Legacy generated harbor', buildings: [],
    streets: [{id: 'harbor-sea-landing', name: 'harbor-sea-landing', points: [[0, 0], [3.03, 0]],
      curve: 'polyline', closed: false, width: 6.4, tags: ['settlement', 'waterfront', 'sea-landing', 'harbor-quay']}]
  }];
  state.bundle.patches[0].worldKey = worldPlanKey(state.bundle.plan);
  expect(validateWorldMapState(state).bundle.patches[0].streets[0].points).toEqual([[0, 0], [3.03, 0]]);
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
