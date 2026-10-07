import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type EditableMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { observeMapDesign } from '../src/shared/mapDesignObservation';
import { mapEnvironmentGuides } from '../src/shared/mapTerrainAnalysis';
import { mapGuidePolyline, type MapGuide } from '../src/shared/mapGuide';
import { worldPlanKey, type WorldPlan } from '../src/shared/worldPlanning';
import { normalizeMapFoundation } from '../src/shared/mapFoundation';

function world(height = (x: number, _z: number) => 100 + x * 0.2): EditableMap {
  const resolution = 65;
  const plan: WorldPlan = { version: 1, id: 'observed-world', revision: 1, prompt: 'Keep the mountain and inspect the village',
    generationPolicy: 'raw-first-call', recipe: { version: 1, seed: 47, size: 500,
      constraints: [{ region: 'center', biome: 'grassland' }], terrainProgram: {
        version: 1, source: 'not sent to the model by observation', resolution, observations: [],
        heights: Array.from({ length: resolution * resolution }, (_, index) => height(
          index % resolution * 500 / (resolution - 1) - 250, Math.floor(index / resolution) * 500 / (resolution - 1) - 250))
      } }, ecology: [], towns: [], roads: [] };
  return applyMapOperations(createEmptyMap(), [{ type: 'world.set', world: { bundle: { plan, patches: [] }, assets: [] } }]);
}
function route(id: string, points: [number, number][], width = 4): MapGuide {
  return { id, name: id, points, width, curve: 'polyline', closed: false, tags: ['route'] };
}

describe('versioned map design observations', () => {
  it('reads the complete current world field, reports precision, and does not expose height arrays or mutate the draft', () => {
    const map = world();
    map.version = 7;
    const before = JSON.stringify(map);
    const result = observeMapDesign(map, { kind: 'points', points: [[0, 0], [10, 0]] }, 3);
    expect(result).toMatchObject({ schemaVersion: 1, mapVersion: 7, draftRevision: 3,
      source: 'continuous-world-plan-and-current-draft', units: { grade: 'rise/run' } });
    expect(result.data.samples.map((item: { height: number }) => item.height)).toEqual([100, 102]);
    expect(result.data.samples[0].slope).toBeCloseTo(Math.atan(0.2) * 180 / Math.PI, 3);
    expect(result.data.samples[0]).toMatchObject({ waterDistance: null, guideDistance: null, water: null });
    expect(result.precision.nullDistances).toContain('Not zero');
    expect(JSON.stringify(result)).not.toContain('not sent to the model');
    expect(JSON.stringify(result)).not.toContain('heights');
    expect(JSON.stringify(map)).toBe(before);
    const changed = structuredClone(map);
    changed.world!.bundle.plan.recipe.terrainProgram!.heights = changed.world!.bundle.plan.recipe.terrainProgram!.heights.map(value => value + 12);
    expect(observeMapDesign(changed, { kind: 'points', points: [[0, 0]] }, 4).data.samples[0].height).toBe(112);
    expect(result.draftRevision).toBe(3);
  });

  it('separates wetness from a requested named water body and keeps sea identity', () => {
    const map = world(() => -4);
    const result = observeMapDesign(map, { kind: 'points', points: [[0, 0]], waterId: 'sea' }, 0);
    expect(result.data.samples[0]).toMatchObject({ water: { id: 'sea', surfaceHeight: 0, depth: 4 },
      requestedWater: { id: 'sea', inside: true }, waterDistance: 0 });
    expect(() => observeMapDesign(map, { kind: 'points', points: [[0, 0]], waterId: 'missing' }, 0)).toThrow('unknown_map_environment_water');
  });

  it('lists the actual biome masks and distribution rules separately, with sample coverage rather than fabricated tree counts', () => {
    const map = world(() => 30), plan = map.world!.bundle.plan;
    plan.recipe.biomePatches = [{ id: 'round-forest', region: { kind: 'circle', center: [0, 0], radius: 20 }, biome: 'forest', feather: 4 }];
    plan.ecology = [{ id: 'path-trees', kind: 'pine', biome: 'forest', density: 0.9, spacing: 8, maxSlope: 30,
      scale: [1, 2], region: { kind: 'path', points: [[-80, 0], [80, 0]], width: 80 }, regionFeather: 8,
      exclusions: [{ kind: 'circle', center: [0, 0], radius: 5 }] }];
    const overview = observeMapDesign(map, { kind: 'summary', limit: 1 }, 0);
    expect(overview.data.biomePatches.items[0].region.kind).toBe('circle');
    expect(overview.data.ecologyRules.items[0].region.kind).toBe('path');
    expect(overview.data.ecologyRules.items[0].exclusions).toEqual([{ kind: 'circle', center: [0, 0], radius: 5 }]);
    expect(overview.data.counts.ecologyRules).toBe(1);
    const region = observeMapDesign(map, { kind: 'region', bounds: [-60, -20, 60, 20], grid: 7, limit: 4 }, 0);
    expect(region.data.samples.total).toBe(49);
    expect(region.data.samples.items).toHaveLength(4);
    expect(region.data.samples.nextOffset).toBe(4);
    expect(region.data.sampledCoverage.dryOutsideFootprintsAndGuidesFraction).toBe(1);
    expect(region.data.ecologySupport[0].meanRegionWeight).toBe(1);
    expect(region.data.ecologySupport[0].meanBiomeWeight).toBeLessThan(0.5);
    expect(region.data.limits.join(' ')).toContain('not acceptance probabilities');
    expect(region.data.sampledCoverage).not.toHaveProperty('treeCount');
    const clearing = observeMapDesign(map, { kind: 'region', bounds: [-20, -20, 20, 20], grid: 3 }, 0);
    expect(clearing.data.ecologySupport[0].sampledExcludedFraction).toBeCloseTo(1 / 9, 4);
  });

  it('reports full translated and rotated footprints even when their centers lie outside the requested bounds', () => {
    const map = world(), object = createMapObject('wide box', 'missing-asset');
    object.id = 'wide'; object.transform.position = [10, 100, 0]; object.transform.size = [20, 5, 10];
    map.objects = [object];
    const result = observeMapDesign(map, { kind: 'objects', bounds: [-1, -1, 1, 1] }, 2);
    expect(result.total).toBeUndefined();
    expect(result.data.total).toBe(1);
    expect(result.data.items[0]).toMatchObject({ reference: 'object:wide', geometry: 'fallback-aabb-missing-asset', entrance: null,
      polygon: [[0, -5], [20, -5], [20, 5], [0, 5]], ground: { min: 100, max: 104, bottomMinusGroundRange: [-4, 0] } });
    const plan = map.world!.bundle.plan;
    plan.towns = [{ id: 'village', name: 'Village', prompt: 'Existing village', center: [100, 80], radius: 50,
      blend: 20, foundation: 100, terrainMode: 'conform', ports: [] }];
    map.world!.bundle.patches = [{ townId: 'village', worldKey: worldPlanKey(plan), summary: 'existing', streets: [],
      buildings: [{ id: 'shop', x: 10, z: 20, width: 12, depth: 4, height: 6, rotation: Math.PI / 2, use: 'shop' }] }];
    const building = observeMapDesign(map, { kind: 'objects', ids: ['building:village:shop'] }, 3).data.items[0];
    expect(building.geometry).toBe('planned-oriented-footprint');
    expect(building.polygon).toEqual([[108, 106], [108, 94], [112, 94], [112, 106]]);
    expect(building.bottom).toBeNull();
    expect(building.entrance).toBeNull();
  });

  it('exposes town-local ports and districts needed to preserve settlement boundary connections', () => {
    const map = world(() => 100), state = map.world!, plan = state.bundle.plan;
    plan.featureGraph = { regions: [{ id: 'east-region', kind: 'district', name: 'East', center: [100, 30], radius: 20 }],
      anchors: [{ id: 'east-anchor', kind: 'district', position: [100, 30], regionId: 'east-region' }], paths: [], relations: [] };
    plan.towns = [{ id: 'town', name: 'Town', prompt: '', center: [20, 30], radius: 50, blend: 20, foundation: 100,
      ports: [{ id: 'east-port', guideId: 'east-road', position: [50, 0], width: 4 }],
      districts: [{ anchorId: 'east-anchor', kind: 'residential', density: 0.5, offset: [80, 0], radius: 20 }] }];
    plan.roads = [route('east-road', [[70, 30], [150, 30]])];
    state.bundle.patches = [{ townId: 'town', worldKey: worldPlanKey(plan), summary: '', buildings: [],
      streets: [route('main-street', [[0, 0], [50, 0]])] }];
    const valid = applyMapOperations(map, [{ type: 'world.set', world: state }]);
    const result = observeMapDesign(valid, { kind: 'summary' }, 2);
    expect(result.data.settlements.items[0]).toMatchObject({ center: [20, 30], radius: 50,
      ports: [{ id: 'east-port', guideId: 'east-road', position: [50, 0], width: 4 }],
      districts: [{ anchorId: 'east-anchor', kind: 'residential', density: 0.5, offset: [80, 0], radius: 20 }] });
    expect(result.data.access.items.find((item: { id: string }) => item.id === 'town:east-port').position).toEqual([70, 30]);
    expect(result.data.limits.join(' ')).toContain('town-local');
  });

  it('measures route gaps against the entire object footprint and detects a corridor crossing it', () => {
    const map = world(), object = createMapObject('shop');
    object.id = 'shop'; object.transform.position = [0, 100, 0]; object.transform.size = [20, 5, 20];
    map.objects = [object];
    map.guides = [route('through', [[-30, 0], [30, 0]])];
    const observation = observeMapDesign(map, { kind: 'objects' }, 0);
    expect(observation.data.items[0].nearestGuideCorridor).toMatchObject({ reference: 'map:through', gap: 0 });
    map.guides = [route('outside', [[-30, 20], [30, 20]])];
    expect(observeMapDesign(map, { kind: 'objects' }, 1).data.items[0].nearestGuideCorridor.gap).toBe(8);
  });

  it('observes the whole procedural foundation instead of mistaking it for a one-metre placeholder', () => {
    const map = world(), object = createMapObject('foundation');
    object.id = 'platform'; object.transform.position = [0, 100, 0];
    object.foundation = normalizeMapFoundation({ shape: 'rounded-rectangle', width: 20, depth: 10, cornerRadius: 0 });
    map.objects = [object];
    const reading = observeMapDesign(map, { kind: 'objects', bounds: [8, -2, 12, 2] }, 0).data.items[0];
    expect(reading.geometry).toBe('procedural-foundation-collider-envelope');
    expect(reading.polygon).toEqual([[-10, -5], [10, -5], [10, 5], [-10, 5]]);
    expect(reading.bottom).toBeNull();
  });

  it('returns longitudinal grades, designer-selected threshold intervals, and geometric endpoint gaps without claiming traversal', () => {
    const map = world();
    map.guides = [route('main', [[-100, 0], [100, 0]]), route('separate', [[120, 0], [160, 0]])];
    map.designSemantics.viewpoints = [{ id: 'entry', role: 'entry', point: [110, 0] }];
    const result = observeMapDesign(map, { kind: 'path', pathId: 'map:main', spacing: 20, maxGrade: 0.15 }, 0);
    expect(result.data.route.width).toBe(4);
    expect(result.data.absoluteGrade).toEqual({ min: 0.2, max: 0.2, mean: 0.2 });
    expect(result.data.events.items[0]).toEqual({ index: 1, position: [-80, 0], kind: 'grade-threshold-enter', distance: 20 });
    expect(result.data.endpoints[1]).toMatchObject({ nearestOtherCorridor: { reference: 'map:separate', gap: 16 },
      nearestDeclaredAccess: { id: 'entry', distance: 10 } });
    expect(result.data).not.toHaveProperty('walkable');
    expect(result.data.limits.join(' ')).toContain('not bridge decks');
  });

  it.each([false, true])('ignores a semantic mirror of the same curve when measuring adjacent corridors (reversed=%s)', reversed => {
    const map = world(), plan = map.world!.bundle.plan;
    const main = { ...route('orchard-return', [[-30, 0], [0, 20], [30, 0]]), curve: 'catmull-rom' as const };
    plan.roads = [main, route('neighbor', [[40, 0], [80, 0]])];
    plan.featureGraph = { regions: [], anchors: [], relations: [], paths: [{
      id: main.id, name: 'Semantic orchard path', kind: 'trail', width: main.width, curve: main.curve,
      points: (reversed ? [...main.points].reverse() : main.points).map(([x, z]) => [x + 0.000001, z])
    }] };
    const result = observeMapDesign(map, { kind: 'path', pathId: 'world:orchard-return' }, 0);
    expect(result.data.endpoints[1].nearestOtherCorridor).toMatchObject({ reference: 'world:neighbor', gap: 6 });
    const summary = observeMapDesign(map, { kind: 'summary' }, 0);
    expect(summary.data.routes.items.map((item: { reference: string }) => item.reference)).toEqual([
      'world:orchard-return', 'world:neighbor', 'feature:orchard-return'
    ]);
    plan.roads.pop();
    expect(observeMapDesign(map, { kind: 'path', pathId: 'world:orchard-return' }, 1).data.endpoints
      .every((endpoint: { nearestOtherCorridor: unknown }) => endpoint.nearestOtherCorridor === null)).toBe(true);
  });

  it('compares geometry rather than IDs, including extra collinear points in a semantic copy', () => {
    const map = world(), plan = map.world!.bundle.plan;
    plan.roads = [route('main', [[-30, 0], [30, 0]])];
    plan.featureGraph = { regions: [], anchors: [], relations: [], paths: [
      { id: 'mirror-with-another-id', name: 'Mirror', kind: 'trail', width: 4, points: [[30, 0], [0, 0], [-30, 0]] },
      { id: 'main', name: 'Distinct route with the same ID', kind: 'trail', width: 4, points: [[40, 0], [80, 0]] }
    ] };
    expect(observeMapDesign(map, { kind: 'path', pathId: 'world:main' }, 0).data.endpoints[1].nearestOtherCorridor)
      .toMatchObject({ reference: 'feature:main', gap: 6 });
    plan.featureGraph.paths[1].points = [[-30, 0], [0, 40], [30, 0]];
    expect(observeMapDesign(map, { kind: 'path', pathId: 'world:main' }, 1).data.endpoints[1].nearestOtherCorridor)
      .toMatchObject({ reference: 'feature:main', gap: 0 });
  });

  it('reports sampled water boundaries and coarsens a requested profile before allocation', () => {
    const map = world(x => x * 0.1);
    const result = observeMapDesign(map, { kind: 'path', points: [[-250, 0], [250, 0]], spacing: 0.25, limit: 8 }, 0);
    expect(result.data.sampleCount).toBe(512);
    expect(result.data.coarsened).toBe(true);
    expect(result.data.profile.items).toHaveLength(8);
    expect(result.data.events.items.some((event: { kind: string }) => event.kind === 'water-transition')).toBe(true);
    expect(result.data.waterSampleCount).toBe(256);
  });

  it('uses one canonical curve and town street coordinates and requires a source reference for ambiguous IDs', () => {
    const map = world(), plan = map.world!.bundle.plan;
    map.guides = [{ ...route('bend', [[-40, 0], [0, 30], [40, 0]]), curve: 'catmull-rom' }];
    plan.featureGraph = { regions: [], anchors: [], relations: [], paths: [{ id: 'bend', name: 'other', kind: 'trail', points: [[-10, -80], [10, -80]], width: 2 }] };
    const canonical = mapEnvironmentGuides(map)[0];
    expect(canonical.points).toEqual(mapGuidePolyline(map.guides[0]));
    expect(canonical.curve).toBe('polyline');
    expect(() => observeMapDesign(map, { kind: 'path', pathId: 'bend' }, 0)).toThrow('ambiguous_observation_path');
    expect(observeMapDesign(map, { kind: 'path', pathId: 'map:bend' }, 0).data.route.reference).toBe('map:bend');
    plan.towns = [{ id: 'town', name: 'Town', prompt: 'Town', center: [100, 80], radius: 50, blend: 20, foundation: 100, ports: [] }];
    map.world!.bundle.patches = [{ townId: 'town', worldKey: worldPlanKey(plan), summary: '', buildings: [], streets: [route('local', [[-10, 0], [10, 0]])] }];
    expect(mapEnvironmentGuides(map).find(path => path.reference === 'town:town:local')!.points).toEqual([[90, 80], [110, 80]]);
  });

  it('bounds and validates hostile queries rather than quietly truncating or sampling outside the map', () => {
    const map = world();
    for (const query of [
      { kind: 'points', points: [[undefined, 0]] }, { kind: 'points', points: [[NaN, 0]] },
      { kind: 'points', points: [[251, 0]] }, { kind: 'points', points: Array(129).fill([0, 0]) },
      { kind: 'region', bounds: [-10, -10, 10, 10], grid: 18 },
      { kind: 'summary', limit: 100000 }, { kind: 'summary', offset: -1 }, { kind: 'summary', secret: true },
      { kind: 'path', points: [[0, 0], [0, 0]] }, { kind: 'path', points: [[0, 0], [1, 0]], width: Infinity },
      { kind: 'objects', ids: ['missing'] }
    ]) expect(() => observeMapDesign(map, query, 0), JSON.stringify(query)).toThrow();
    expect(() => observeMapDesign(map, { kind: 'summary' }, -1)).toThrow('invalid_observation_revision');
  });
});
