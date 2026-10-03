import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { createMapEnvironmentSampler, sampleMapEnvironment, terrainFootprintSlopeDegrees, terrainSlopeDegrees } from '../src/shared/mapTerrainAnalysis';
import * as worldSampling from '../src/shared/worldMapState';
import { worldPlanKey, type WorldPlan } from '../src/shared/worldPlanning';
import type { WorldMapState } from '../src/shared/worldMapState';
import type { WorldRecipe } from '../src/shared/worldTerrain';

function recipe(height: (x: number, z: number) => number): WorldRecipe {
  const resolution = 65, size = 500;
  return { version: 1, seed: 17, size, constraints: [{ region: 'center', biome: 'grassland' }], terrainProgram: {
    version: 1, source: 'Analytic test height field', resolution, observations: [],
    heights: Array.from({ length: resolution ** 2 }, (_, index) => height(
      (index % resolution) * size / (resolution - 1) - size / 2,
      Math.floor(index / resolution) * size / (resolution - 1) - size / 2
    ))
  } };
}

function worldMap(input: WorldRecipe, configure?: (state: WorldMapState) => void) {
  const plan: WorldPlan = { version: 1, id: 'environment', revision: 1, prompt: 'Environment queries',
    generationPolicy: 'raw-first-call', recipe: input, ecology: [], towns: [], roads: [] };
  const state: WorldMapState = { bundle: { plan, patches: [] }, assets: [] };
  configure?.(state);
  return applyMapOperations(createEmptyMap(), [{ type: 'world.set', world: state }]);
}

describe('continuous world map environment compatibility', () => {
  it('samples the local analytic gradient independently of the 2x2 placeholder', () => {
    const map = worldMap(recipe((x, z) => 20 + x * 0.5 + z * 0.25));
    expect(map.terrain.heights).toHaveLength(4);
    expect(terrainSlopeDegrees(map, 0, 0)).toBeCloseTo(29.205932, 5);
    expect(sampleMapEnvironment(map, 0, 0).slope).toBeCloseTo(29.205932, 5);
  });

  it('checks a small footprint locally instead of expanding it to the world placeholder spacing', () => {
    const map = worldMap(recipe(x => 20 + Math.max(0, x - 100) * 0.5));
    expect(terrainFootprintSlopeDegrees(map, 0, 0, 6)).toBe(0);
    expect(terrainFootprintSlopeDegrees(map, 150, 0, 6)).toBeCloseTo(26.565051, 5);
  });

  it.each(['sea', 'lake', 'river'] as const)('reads real %s water and bounds nearby-water queries', kind => {
    const input = recipe(() => kind === 'sea' ? -5 : 8);
    const waterId = kind === 'sea' ? 'sea' : `named-${kind}`;
    if (kind !== 'sea') input.waterBodies = [{ id: waterId, type: kind,
      region: kind === 'lake' ? { kind: 'circle', center: [0, 0], radius: 20 }
        : { kind: 'path', points: [[-20, 0], [20, 0]], width: 8 }, levels: kind === 'lake' ? [10] : [10, 10], depth: 3 }];
    const map = worldMap(input);
    expect(map.waterBodies).toEqual([]);
    const wet = sampleMapEnvironment(map, 0, 0, { waterId });
    expect(wet.water).toMatchObject({ id: waterId, inside: true, surfaceHeight: kind === 'sea' ? 0 : 10 });
    expect(wet.water!.depth).toBeGreaterThan(0);
    expect(wet.waterDistance).toBe(0);
    if (kind !== 'sea') {
      const shore = sampleMapEnvironment(map, 32, 0, { waterId });
      expect(shore.water).toMatchObject({ inside: false, surfaceHeight: null });
      expect(shore.waterDistance).toBeGreaterThan(0);
      expect(shore.waterDistance).toBeLessThan(16);
      expect(sampleMapEnvironment(map, 240, 240).waterDistance).toBe(Infinity);
    }
    expect(() => sampleMapEnvironment(map, 0, 0, { waterId: 'missing' }))
      .toThrow('unknown_map_environment_water:missing');
  });

  it('includes world roads, feature paths, translated town streets, and regular guides with ID filters', () => {
    const map = worldMap(recipe(() => 20), state => {
      const plan = state.bundle.plan;
      plan.roads = [{ id: 'world-road', name: 'Road', points: [[-80, -100], [80, -100]],
        curve: 'polyline', closed: false, width: 4, tags: [] }];
      plan.featureGraph = { regions: [], anchors: [], relations: [], paths: [{ id: 'feature-path',
        name: 'Trail', kind: 'trail', points: [[-80, -50], [80, -50]], width: 2 }] };
      plan.towns = [{ id: 'town', name: 'Town', prompt: 'Local streets', center: [100, 80], radius: 80,
        blend: 64, foundation: 20, terrainMode: 'conform', ports: [] }];
      state.bundle.patches = [{ townId: 'town', worldKey: worldPlanKey(plan), summary: 'Street', buildings: [],
        streets: [{ id: 'local-street', name: 'Street', points: [[-20, 0], [20, 0]],
          curve: 'polyline', closed: false, width: 6, tags: [] }] }];
    });
    map.guides = [{ id: 'regular', name: 'Guide', points: [[-20, 0], [20, 0]],
      curve: 'polyline', closed: false, width: 2, tags: [] }];
    expect(sampleMapEnvironment(map, 0, -94, { guideIds: ['world-road'] }).guideDistance).toBe(4);
    expect(sampleMapEnvironment(map, 0, -45, { guideIds: ['feature-path'] }).guideDistance).toBe(4);
    expect(sampleMapEnvironment(map, 100, 88, { guideIds: ['local-street'] }).guideDistance).toBe(5);
    expect(sampleMapEnvironment(map, 100, 88).guideDistance).toBe(5);
    expect(sampleMapEnvironment(map, 0, 5, { guideIds: ['regular'] }).guideDistance).toBe(4);
    expect(sampleMapEnvironment(map, 100, 88, { guideIds: ['missing'] }).guideDistance).toBe(Infinity);
  });

  it('finds nearby sampled sea from a dry shore and keeps the requested sea identity outside water', () => {
    const map = worldMap(recipe(x => x * 0.1));
    const shore = sampleMapEnvironment(map, 8, 0, { waterId: 'sea' });
    expect(shore.water).toEqual({ id: 'sea', inside: false, surfaceHeight: null, depth: 0 });
    expect(shore.waterDistance).toBeGreaterThanOrEqual(7.9);
    expect(shore.waterDistance).toBeLessThan(8.2);
    expect(sampleMapEnvironment(map, 240, 0, { waterId: 'sea' }).waterDistance).toBe(Infinity);
  });

  it('reuses bounded water probes for nearby queries instead of resampling hundreds of points each time', () => {
    const map = worldMap(recipe(() => 20));
    const actual = worldSampling.worldMapSampler(map.world!);
    let calls = 0;
    const spy = vi.spyOn(worldSampling, 'worldMapSampler').mockReturnValue((x, z) => {
      calls++;
      return actual(x, z);
    });
    try {
      const sample = createMapEnvironmentSampler(map);
      for (let i = 0; i < 32; i++) expect(sample(i / 16, 0).waterDistance).toBe(Infinity);
      expect(calls).toBeLessThan(1000);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the legacy water identity, geometry, guide filter, and grid slope', () => {
    const map = createEmptyMap();
    map.terrain = { resolutionX: 3, resolutionZ: 3, heights: [0, 1, 2, 0, 1, 2, 0, 1, 2] };
    map.waterBodies = [{ id: 'legacy-lake', name: 'Lake', type: 'lake', level: 2, depth: 3, width: 1,
      shorelineIrregularity: 0, points: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }];
    expect(sampleMapEnvironment(map, 0, 0, { waterId: 'legacy-lake' })).toMatchObject({
      height: 1, waterDistance: 0, water: { id: 'legacy-lake', inside: true, surfaceHeight: 2, depth: 3 }
    });
    expect(terrainSlopeDegrees(map, 0, 0)).toBeCloseTo(Math.atan(2 / map.box.size[0]) * 180 / Math.PI, 8);
    expect(() => sampleMapEnvironment(map, 0, 0, { waterId: 'sea' })).toThrow('unknown_map_environment_water:sea');
  });
});
