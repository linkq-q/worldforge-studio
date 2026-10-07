import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyMap, normalizeMap, sampleTerrainHeight } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { diagnoseWorldBundle, validateWorldBundle, validateWorldPlan, worldPlanKey, type WorldBundle, type WorldPlan } from '../src/shared/worldPlanning';
import { MapStore } from '../src/server/mapStore';
import type { MapGuide } from '../src/shared/mapGuide';

const road = (id: string, points: [number, number][]): MapGuide => ({ id, name: id, points, width: 4, curve: 'polyline', closed: false, tags: [] });
function plan(grade = 0): WorldPlan {
  const resolution = 33;
  return { version: 1, id: 'diagnostic-policy', revision: 1, prompt: '', ecology: [], towns: [], roads: [],
    recipe: { version: 1, seed: 7, size: 500, constraints: [{ region: 'center', biome: 'grassland' }], terrainProgram: {
      version: 1, source: 'analytic field', resolution, observations: [],
      heights: Array.from({ length: resolution ** 2 }, (_, index) => 200 + (index % resolution * 500 / (resolution - 1) - 250) * grade)
    } } };
}
function townBundle(policy: WorldPlan['generationPolicy']): WorldBundle {
  const input = plan(); input.generationPolicy = policy;
  input.towns = [{ id: 'town', name: 'Town', prompt: '', center: [0, 0], radius: 50, blend: 20,
    foundation: 200, terrainMode: 'conform', ports: [] }];
  return { plan: input, patches: [{ townId: 'town', worldKey: worldPlanKey(input), summary: '', streets: [], buildings: [
    { id: 'home-a', x: 0, z: 0, width: 8, depth: 8, height: 6, use: 'home' },
    { id: 'home-b', x: 2, z: 2, width: 8, depth: 8, height: 6, use: 'home' }
  ] }] };
}

describe('world diagnostic policy boundaries', () => {
  it('keeps a measured steep road unchanged through diagnosis, sampling and persisted reload', async () => {
    const input = plan(0.6); input.roads = [road('ridge-access', [[-100, 0], [100, 0]])];
    expect(() => validateWorldPlan(input)).toThrow('world_road_slope');
    input.generationPolicy = 'diagnostic';
    const bundle = { plan: input, patches: [] }, original = structuredClone(bundle);
    const diagnostics = diagnoseWorldBundle(bundle);
    expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'world_road_slope', severity: 'warning', repaired: false })]));
    expect(diagnostics.find(item => item.code === 'world_road_slope')?.message).toContain('ridge-access');
    expect(bundle).toEqual(original);
    const state = { bundle: validateWorldBundle(bundle), assets: [] };
    const map = normalizeMap(JSON.parse(JSON.stringify(applyMapOperations(createEmptyMap(), [{ type: 'world.set', world: state }]))));
    expect(sampleTerrainHeight(map, 50, 0)).toBeCloseTo(230, 6);
    expect(map.world?.bundle.plan.roads).toEqual(original.plan.roads);
    expect(map.world?.bundle.plan.recipe).toEqual(original.plan.recipe);
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-diagnostic-policy-'));
    try {
      const store = new MapStore({ rootDir }), base = await store.createMap({ name: 'Diagnostic policy' });
      await store.commitTransaction(base.id, { source: 'agent', operations: [{ type: 'world.set', world: state }] }, base.version);
      const loaded = await new MapStore({ rootDir }).loadMap(base.id);
      expect(loaded.world).toEqual(state);
      expect(sampleTerrainHeight(loaded, 50, 0)).toBeCloseTo(230, 6);
      expect((await store.undoTransaction(base.id)).map.world).toBeUndefined();
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  });

  it('reports intersecting buildings without changing the existing strict and raw-first-call contracts', () => {
    expect(() => validateWorldBundle(townBundle(undefined))).toThrow('world_buildings_overlap');
    expect(() => validateWorldBundle(townBundle('raw-first-call'))).toThrow('world_buildings_overlap');
    const bundle = townBundle('diagnostic'), original = structuredClone(bundle);
    expect(validateWorldBundle(bundle).patches[0].buildings).toEqual(original.patches[0].buildings);
    expect(diagnoseWorldBundle(bundle)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'world_buildings_overlap', repaired: false })]));
    expect(bundle).toEqual(original);
  });

  it('collects overlapping towns, disconnected streets, footprint collisions, earthwork and water findings together', () => {
    const bundle = townBundle('diagnostic');
    bundle.plan.recipe = plan(0.6).recipe;
    bundle.plan.recipe.waterBodies = [{ id: 'pond', type: 'lake', region: { kind: 'circle', center: [-24, 20], radius: 8 }, levels: [210], depth: 5 }];
    bundle.plan.towns.push({ ...bundle.plan.towns[0], id: 'neighbor', center: [40, 0], foundation: 224 });
    bundle.plan.roads = [road('world-road', [[-40, 0], [40, 0]]), road('wet-road', [[-24, 12], [-24, 28]])];
    bundle.patches[0].streets = [road('main-street', [[-30, 0], [30, 0]]), road('isolated-street', [[-30, 30], [30, 30]])];
    bundle.patches[0].buildings.push({ id: 'wet-house', x: -24, z: 20, width: 8, depth: 8, height: 6, use: 'home' });
    bundle.patches[0].worldKey = worldPlanKey(bundle.plan);
    const original = structuredClone(bundle), canonical = validateWorldBundle(bundle), diagnostics = diagnoseWorldBundle(bundle);
    expect(diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'world_town_extents_overlap', 'world_streets_disconnected', 'world_buildings_overlap',
      'world_building_intersects_street', 'world_building_intersects_road',
      'world_building_earthwork_budget', 'world_building_on_water', 'world_road_crosses_water'
    ]));
    expect(diagnostics.every(item => item.severity === 'warning' && item.repaired === false)).toBe(true);
    expect(diagnostics.find(item => item.code === 'world_building_on_water')?.message).toContain('wet-house');
    expect(diagnostics.find(item => item.code === 'world_streets_disconnected')?.message).toContain('"roadIds":["main-street"]');
    expect(validateWorldBundle(bundle)).toEqual(canonical);
    expect(bundle).toEqual(original);
  });

  it.each([
    ['nonfinite coordinate', 'world_guide_outside', (input: WorldPlan) => { input.roads[0].points[0][0] = NaN; }],
    ['out-of-bounds coordinate', 'world_guide_outside', (input: WorldPlan) => { input.roads[0].points[0][0] = -251; }],
    ['duplicate id', 'world_duplicate_id', (input: WorldPlan) => { input.roads.push(structuredClone(input.roads[0])); }],
    ['road quota', 'world_road_quota', (input: WorldPlan) => { input.roads = Array.from({ length: 33 }, (_, i) => road('road-' + i, [[0, 0], [20, 0]])); }],
    ['sampling quota', 'world_road_sampling_quota', (input: WorldPlan) => { input.roads = Array.from({ length: 25 }, (_, i) => road('road-' + i, [[-240, -240], [240, 240]])); }]
  ] as const)('still rejects %s before it can be saved or diagnosed', (_name, code, edit) => {
    const input = plan(); input.generationPolicy = 'diagnostic'; input.roads = [road('road', [[0, 0], [20, 0]])]; edit(input);
    expect(() => validateWorldPlan(input)).toThrow(code);
    expect(() => diagnoseWorldBundle({ plan: input, patches: [] })).toThrow(code);
  });

  it('keeps referenced ports and stale patch identities as hard errors', () => {
    const bundle = townBundle('diagnostic');
    bundle.plan.towns[0].ports = [{ id: 'east', guideId: 'missing', position: [50, 0], width: 4 }];
    expect(() => validateWorldPlan(bundle.plan)).toThrow('world_port_unknown_road');
    bundle.plan.roads = [road('missing', [[50, 0], [100, 0]])];
    bundle.plan.towns[0].ports[0].width = 6;
    expect(() => validateWorldPlan(bundle.plan)).toThrow('world_port_width_mismatch');
    bundle.plan.towns[0].ports[0].width = 4;
    bundle.plan.roads[0].points[0] = [51, 0];
    expect(() => validateWorldPlan(bundle.plan)).toThrow('world_port_endpoint_mismatch');
    const stale = townBundle('diagnostic'); stale.patches[0].worldKey = 'old';
    expect(() => diagnoseWorldBundle(stale)).toThrow('world_stale_patch');
  });
});
