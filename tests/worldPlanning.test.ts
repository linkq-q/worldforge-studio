import { describe, expect, it } from 'vitest';
import type { MapGuide } from '../src/shared/mapGuide';
import { createWorldSampler, type WorldRecipe } from '../src/shared/worldTerrain';
import {
  buildingsOverlap, createPlannedWorldSampler, createTownTasks, createWorldExclusion, createWorldEcologyDensity, mergeTownPatch,
  observeWorldWhitebox, validateTownPatch, validateWorldBundle, validateWorldPlan, worldPlanKey, worldRoadPolyline,
  worldTownBuildingQuota,
  type TownPatch, type WorldBundle, type WorldPlan
} from '../src/shared/worldPlanning';

function road(id: string, points: Array<[number, number]>, width = 10): MapGuide {
  return { id, name: id, points, curve: 'polyline', closed: false, width, tags: ['settlement'] };
}
function fixture(): WorldPlan {
  const recipe: WorldRecipe = { version: 1, seed: 42, size: 16000, constraints: [{ region: 'center', biome: 'grassland' }] };
  const sample = createWorldSampler(recipe);
  return {
    version: 1, id: 'test-world', revision: 1, prompt: 'Two connected villages', recipe,
    ecology: [
      { id: 'trees', kind: 'broadleaf', biome: 'forest', density: 0.6, spacing: 12, maxSlope: 30, scale: [1, 2] },
      { id: 'rocks', kind: 'rock', biome: 'grassland', density: 0.1, spacing: 18, maxSlope: 45, scale: [0.5, 1] }
    ],
    roads: [road('highway', [[-1800, 0], [1800, 0]])],
    towns: [-2000, 2000].map((x, i) => ({
      id: 'town-' + i, name: 'Town ' + i, prompt: 'A compact village', center: [x, 0],
      radius: 200, blend: 600, foundation: sample(x, 0).height,
      ports: [{ id: 'port-' + i, guideId: 'highway', position: [i === 0 ? 200 : -200, 0], width: 10 }]
    }))
  };
}
function patch(plan: WorldPlan, index: number): TownPatch {
  const town = plan.towns[index];
  return {
    townId: town.id, worldKey: worldPlanKey(plan), summary: 'A connected main street with a house',
    streets: [road(town.id + '-street', [[...town.ports[0].position], [0, 0], [0, 100]])],
    buildings: [{ id: town.id + '-house', x: -70, z: -70, width: 40, depth: 35, height: 12, use: 'home' }]
  };
}

describe('hierarchical world planning contracts', () => {
  it('canonicalizes semantic intent and exposes a compact deterministic exploration observation', () => {
    const plan = fixture();
    Object.assign(plan, {
      concept: { premise: 'A divided valley reconnects', themes: ['renewal', 'distance'], experience: 'Navigate by landmarks' },
      featureGraph: {
        regions: [
          { id: 'quiet-west', kind: 'wilderness', name: 'Quiet West', center: [-3500, 0], radius: 900 },
          { id: 'inhabited-east', kind: 'settled', name: 'Inhabited East', center: [3500, 0], radius: 900 }
        ],
        paths: [{ id: 'valley-road', kind: 'road', name: 'Valley Road', points: [[-2000, 0], [0, 250], [2000, 0]], width: 12 }],
        anchors: [
          { id: 'east-gate', kind: 'settlement', position: [2000, 0], regionId: 'inhabited-east' },
          { id: 'west-ruin', kind: 'landmark', position: [-2000, 0], regionId: 'quiet-west' }
        ],
        relations: [{ fromId: 'valley-road', toId: 'west-ruin', kind: 'reaches' }]
      },
      settlementPlan: { settlements: [{ id: 'east-hamlet', anchorId: 'east-gate', role: 'safe hub' }] },
      mobilityPlan: { routes: [{ id: 'main-route', pathId: 'valley-road', mode: 'walk', connects: ['west-ruin', 'east-gate'] }] },
      explorationPlan: {
        pointsOfInterest: [
          { id: 'ruin-clue', anchorId: 'west-ruin', purpose: 'reveal the old crossing' },
          { id: 'gate-supplies', anchorId: 'east-gate', purpose: 'prepare for the crossing' }
        ],
        sequence: ['gate-supplies', 'ruin-clue']
      },
      intentionalEmptyAreas: [{ id: 'western-breathing-room', regionId: 'quiet-west', purpose: 'preserve anticipation' }]
    });
    const checked = validateWorldPlan(plan);
    expect(checked.concept?.themes).toEqual(['distance', 'renewal']);
    expect(checked.featureGraph?.anchors.map(item => item.id)).toEqual(['east-gate', 'west-ruin']);
    expect(checked.featureGraph?.paths[0].points).toEqual([[-2000, 0], [0, 250], [2000, 0]]);
    const observation = observeWorldWhitebox(plan);
    expect(observation.scope).toBe('planned');
    expect(observation.pointsOfInterest).toMatchObject({
      plannedCount: 2, realizedCount: 0, unrealizedIds: [], spacing: { median: 4000, p90: 4000 }
    });
    expect(observation.pointsOfInterest.items.map(item => item.id)).toEqual(['gate-supplies', 'ruin-clue']);
    expect(observation.routes[0]).toMatchObject({ id: 'main-route', regions: ['quiet-west', 'inhabited-east'], roadTypeChanges: 0, branches: 0 });
    expect(observation.paths).toMatchObject({ components: 1, intersections: 0, deadEnds: 2, unrealizedIds: [] });
    expect(observation.emptyAreaDiagnostics).toEqual([
      { id: 'western-breathing-room', regionId: 'quiet-west', purpose: 'preserve anticipation', kind: 'intentional-empty' }
    ]);
    const reordered = structuredClone(plan);
    reordered.featureGraph!.anchors.reverse();
    reordered.explorationPlan!.pointsOfInterest.reverse();
    expect(observeWorldWhitebox(reordered)).toEqual(observeWorldWhitebox(plan));
    expect(worldPlanKey(reordered)).toBe(worldPlanKey(plan));
  });

  it('reports executed POIs and deterministic path-network metrics without turning them into gates', () => {
    const plan = fixture();
    plan.whitebox = true;
    plan.towns = []; plan.roads = [];
    plan.featureGraph = {
      regions: [
        { id: 'west', kind: 'wild', name: 'West', center: [-2000, 0], radius: 1000 },
        { id: 'east', kind: 'settled', name: 'East', center: [2000, 0], radius: 1000 },
        { id: 'north', kind: 'wild', name: 'North', center: [0, 2500], radius: 500 }
      ],
      paths: [
        { id: 'main', kind: 'road', name: 'Main', points: [[-2000, 0], [2000, 0]], width: 10 },
        { id: 'crossing', kind: 'trail', name: 'Crossing', points: [[0, -1000], [0, 1000]], width: 3 }
      ],
      anchors: [
        { id: 'west-anchor', kind: 'landmark', position: [-2000, 0], regionId: 'west' },
        { id: 'east-anchor', kind: 'settlement', position: [2000, 0], regionId: 'east' }
      ], relations: []
    };
    plan.mobilityPlan = { routes: [{ id: 'main-route', pathId: 'main', mode: 'walk', connects: ['west-anchor', 'east-anchor'] }] };
    plan.explorationPlan = { pointsOfInterest: [
      { id: 'west-poi', anchorId: 'west-anchor', purpose: 'clue' },
      { id: 'east-poi', anchorId: 'east-anchor', purpose: 'supplies' }
    ], sequence: ['east-poi', 'west-poi'] };
    plan.intentionalEmptyAreas = [{ id: 'west-silence', regionId: 'west', purpose: 'pacing' }];
    const observation = observeWorldWhitebox(plan, {
      pointsOfInterest: [{ id: 'east-poi', position: [1900, 12, 0] }],
      paths: [
        { id: 'main', points: [[-2000, 0], [2000, 0]] },
        { id: 'crossing', points: [[0, -1000], [0, 1000]] }
      ]
    });
    expect(observation.scope).toBe('executed');
    expect(observation.pointsOfInterest).toMatchObject({
      plannedCount: 2, realizedCount: 1, unrealizedIds: ['west-poi'], spacing: { median: 0, p90: 0 }
    });
    expect(observation.pointsOfInterest.items[0].realizedPosition).toEqual([1900, 12, 0]);
    expect(observation.routes[0]).toEqual({
      id: 'main-route', mode: 'walk', connects: ['west-anchor', 'east-anchor'], length: 4000,
      regions: ['west', 'east'], roadTypeChanges: 0, branches: 1, longestContentFreeStretch: 3900
    });
    expect(observation.paths).toEqual({
      totalLength: 6000, lengthByType: { road: 4000, trail: 2000 }, components: 1,
      intersections: 1, deadEnds: 4, unrealizedIds: []
    });
    expect(observation.emptyAreaDiagnostics).toEqual([
      { id: 'north', regionId: 'north', kind: 'missing-content' },
      { id: 'west-silence', regionId: 'west', purpose: 'pacing', kind: 'intentional-empty' }
    ]);
  });

  it('rejects semantic references that do not resolve inside the feature graph', () => {
    const plan = fixture();
    plan.featureGraph = { regions: [], paths: [], anchors: [], relations: [] };
    plan.explorationPlan = { pointsOfInterest: [{ id: 'lost', anchorId: 'missing', purpose: 'unreachable' }], sequence: ['lost'] };
    expect(() => validateWorldPlan(plan)).toThrow('world_unknown_poi_anchor');
  });

  it('keeps whitebox plans opt-in and free of terrain realization gates', () => {
    const plan = fixture();
    plan.whitebox = true;
    plan.towns = [];
    plan.recipe = { version: 1, seed: 42, size: 16000, constraints: [{ region: 'west', biome: 'ocean' }] };
    plan.roads = [road('concept-route', [[-6000, 0], [-5000, 0]])];
    expect(validateWorldPlan(plan).whitebox).toBe(true);
    const invalid = structuredClone(plan) as unknown as Record<string, unknown>;
    invalid.whitebox = false;
    expect(() => validateWorldPlan(invalid)).toThrow('world_invalid_whitebox_marker');
  });

  it('canonicalizes complete plans, while preserving ordered geometry and including every semantic field', () => {
    const original = fixture(), reordered = structuredClone(original);
    reordered.towns.reverse(); reordered.ecology.reverse();
    expect(worldPlanKey(reordered)).toBe(worldPlanKey(original));
    expect(validateWorldPlan(original).towns.map(town => town.id)).toEqual(['town-0', 'town-1']);
    for (const edit of [
      (p: WorldPlan) => { p.prompt += '!'; },
      (p: WorldPlan) => { p.ecology[0].density += 0.1; },
      (p: WorldPlan) => { p.towns[0].prompt += '!'; },
      (p: WorldPlan) => { p.towns[0].foundation += 1; },
      (p: WorldPlan) => { p.roads[0].points.reverse(); },
      (p: WorldPlan) => { p.revision++; }
    ]) {
      const changed = structuredClone(original); edit(changed);
      expect(worldPlanKey(changed)).not.toBe(worldPlanKey(original));
    }
  });

  it('persists an explicit sea target while rejecting a water body absent from the recipe', () => {
    const plan = fixture();
    plan.towns[0].targetWaterBodyId = 'sea';
    expect(validateWorldPlan(plan).towns[0].targetWaterBodyId).toBe('sea');
    plan.towns[0].targetWaterBodyId = 'missing-lake';
    expect(() => validateWorldPlan(plan)).toThrow('world_unknown_town_water_target');
  });

  it('creates deterministic independent tasks and refuses patches from any prior plan content', () => {
    const plan = fixture(), result = createTownTasks(plan);
    expect(result).toEqual(createTownTasks(plan));
    expect(result[0].seed).not.toBe(result[1].seed);
    result[0].town.center[0] = 999;
    expect(plan.towns[0].center[0]).toBe(-2000);
    const old = patch(plan, 0);
    plan.prompt += ' revised';
    expect(() => validateTownPatch(plan, old)).toThrow('world_stale_patch');
  });

  it('rejects nonfinite, out-of-world, overlapping and excessive contracts', () => {
    const invalid = (edit: (plan: WorldPlan) => void, error: string) => {
      const plan = fixture(); edit(plan); expect(() => validateWorldPlan(plan)).toThrow(error);
    };
    invalid(p => { p.towns[0].center[0] = NaN; }, 'world_town_outside');
    for (const id of ['../town', 'town/child', 'town\\child', 'town:stream', ' town', '.', 'CON', 'nul', 'Lpt1', 'COM9']) {
      invalid(p => { p.towns[0].id = id; }, 'world_invalid_town_id');
      invalid(p => { p.id = id; }, 'world_invalid_plan_id');
    }
    invalid(p => { p.towns[0].center[0] = 7900; }, 'world_town_outside');
    invalid(p => { p.towns[0].blend = Infinity; }, 'world_invalid_town_blend');
    invalid(p => { p.towns[0].radius = 99; }, 'world_invalid_town_radius');
    invalid(p => { p.towns[1].center = [-1700, 0]; }, 'world_town_extents_overlap');
    invalid(p => { p.towns = Array.from({ length: 13 }, () => p.towns[0]); }, 'world_town_quota');
    invalid(p => { p.roads = Array.from({ length: 33 }, () => p.roads[0]); }, 'world_road_quota');
    invalid(p => { p.roads[0].points = Array.from({ length: 66 }, (_, i) => [i, 0]); }, 'world_guide_segment_quota');
    invalid(p => { p.towns[1].id = p.towns[0].id; }, 'world_duplicate_id');
  });

  it('rejects mismatched road and port contracts', () => {
    for (const [edit, error] of [
      [(p: WorldPlan) => { p.towns[0].ports[0].position = [100, 0]; }, 'world_port_not_on_core_boundary'],
      [(p: WorldPlan) => { p.roads[0].points[0][0] += 1; }, 'world_port_endpoint_mismatch'],
      [(p: WorldPlan) => { p.towns[0].ports[0].width = 12; }, 'world_port_width_mismatch'],
      [(p: WorldPlan) => { p.towns[0].ports[0].guideId = 'missing'; }, 'world_port_unknown_road']
    ] as const) {
      const plan = fixture(); edit(plan); expect(() => validateWorldPlan(plan)).toThrow(error);
    }
  });

  it('checks land, foundation height budgets and roads crossing sea', () => {
    const lifted = fixture(); lifted.towns[0].foundation += 500;
    expect(() => validateWorldPlan(lifted)).toThrow('world_foundation_height_budget');
    const ocean: WorldPlan = {
      ...fixture(), ecology: [], roads: [], towns: [],
      recipe: { version: 1, seed: 42, size: 64000, constraints: [{ region: 'west', biome: 'ocean' }, { region: 'east', biome: 'desert' }] }
    };
    ocean.towns = [{ ...fixture().towns[0], ports: [], center: [-25000, 0] }];
    expect(() => validateWorldPlan(ocean)).toThrow('world_town_core_not_land');
    ocean.towns = []; ocean.roads = [road('sea-road', [[-25000, 0], [-24000, 0]])];
    expect(() => validateWorldPlan(ocean)).toThrow('world_road_crosses_water');
    const steep: WorldPlan = {
      ...ocean, recipe: { version: 1, seed: 42, size: 16000, constraints: [{ region: 'center', biome: 'mountains' }] },
      roads: [road('steep-road', [[-6000, -6000], [-5872, -6000]])]
    };
    expect(() => validateWorldPlan(steep)).toThrow('world_road_cross_slope');
  });

  it('uses finite water for road rejection while allowing a conform coastal town with a dry majority', () => {
    const recipe:WorldRecipe={version:1,seed:42,size:16000,constraints:[{region:'center',biome:'grassland'}],
      waterBodies:[{id:'harbor',type:'lake',region:{kind:'circle',center:[-180,0],radius:80},levels:[150],depth:8}]};
    const roadPlan:WorldPlan={...fixture(),recipe,towns:[],roads:[road('wet-road',[[-220,0],[-140,0]])]};
    expect(()=>validateWorldPlan(roadPlan)).toThrow('world_road_crosses_water');
    const sample=createWorldSampler(recipe),town={...fixture().towns[0],id:'coast',center:[0,0] as [number,number],
      foundation:sample(0,0).height,terrainMode:'conform' as const,ports:[]};
    expect(validateWorldPlan({...fixture(),recipe,towns:[town],roads:[]} as WorldPlan).towns[0].terrainMode).toBe('conform');
  });

  it('requires actual shared graph vertices and every port connected at the matching width', () => {
    const plan = fixture();
    const missing = patch(plan, 0); missing.streets[0].points[0] = [199, 0];
    expect(() => validateTownPatch(plan, missing)).toThrow('world_street_port_missing');
    const width = patch(plan, 0); width.streets[0].width = 8;
    expect(() => validateTownPatch(plan, width)).toThrow('world_street_port_width_mismatch');
    const disconnected = patch(plan, 0);
    disconnected.streets.push(road('disconnected', [[-100, 40], [100, 40]]));
    expect(() => validateTownPatch(plan, disconnected)).toThrow('world_streets_disconnected');
    const connected = patch(plan, 0);
    connected.streets.push(road('connected', [[-100, 100], [0, 100]]));
    expect(validateTownPatch(plan, connected).streets).toHaveLength(2);
  });

  it('accepts bounded Catmull-Rom roads and samples their actual curve for water', () => {
    const controlPoints:Array<[number,number]>=[[-100,0],[-30,70],[30,-70],[100,0]];
    const curved=road('curved-road',controlPoints,2);curved.curve='catmull-rom';
    const sampled=worldRoadPolyline(curved);
    expect(sampled.length).toBeGreaterThan(controlPoints.length);
    expect(sampled.length).toBeLessThanOrEqual(512);
    const curveOnly:[number,number]=[55.18518518518518,-59.62962962962963];
    const recipe:WorldRecipe={version:1,seed:42,size:500,heightScale:.02,constraints:[{region:'center',biome:'grassland'}],
      waterBodies:[{id:'curve-lake',type:'lake',region:{kind:'circle',center:curveOnly,radius:3},levels:[150],depth:4}]};
    const plan:WorldPlan={version:1,id:'curved-water-road',revision:1,prompt:'A curved road around water',recipe,
      ecology:[],towns:[],roads:[curved]};
    expect(()=>validateWorldPlan(plan)).toThrow('world_road_crosses_water');
    expect(validateWorldPlan({...plan,roads:[{...curved,curve:'polyline'}]}).roads[0].curve).toBe('polyline');
  });

  it('rejects buildings outside their core, overlaps and exact segment collisions without sparse sampling', () => {
    const plan = fixture();
    const outside = patch(plan, 0); outside.buildings[0].x = -190;
    expect(() => validateTownPatch(plan, outside)).toThrow('world_building_outside');
    const overlap = patch(plan, 0); overlap.buildings.push({ ...overlap.buildings[0], id: 'overlap', x: -65 });
    expect(() => validateTownPatch(plan, overlap)).toThrow('world_buildings_overlap');
    const crossing = patch(plan, 0);
    crossing.streets = [road('diagonal', [[200, 0], [0, 0], [-150, 150]])];
    crossing.buildings = [{ ...crossing.buildings[0], x: -73, z: 73, width: 2, depth: 2 }];
    expect(() => validateTownPatch(plan, crossing)).toThrow('world_building_intersects_street');
    const invalidHeight = patch(plan, 0); invalidHeight.buildings[0].height = Infinity;
    expect(() => validateTownPatch(plan, invalidHeight)).toThrow('world_invalid_building_height');
  });

  it('bounds local task output and rejects IDs colliding with the world or another town', () => {
    const plan = fixture(), initial: WorldBundle = { plan, patches: [] };
    const streets = patch(plan, 0); streets.streets = Array.from({ length: 49 }, () => streets.streets[0]);
    expect(() => validateTownPatch(plan, streets)).toThrow('world_street_quota');
    const buildings = patch(plan, 0); buildings.buildings = Array.from({ length: worldTownBuildingQuota(plan.towns[0]) + 1 }, () => buildings.buildings[0]);
    expect(() => validateTownPatch(plan, buildings)).toThrow('world_building_quota');
    const worldCollision = patch(plan, 0); worldCollision.buildings[0].id = 'highway';
    expect(() => validateTownPatch(plan, worldCollision)).toThrow('world_duplicate_id');
    const first = patch(plan, 0), other = patch(plan, 1); other.buildings[0].id = first.buildings[0].id;
    expect(() => mergeTownPatch(mergeTownPatch(initial, first), other)).toThrow('world_duplicate_id');
    expect(() => validateWorldBundle({ plan, patches: [first, first] })).toThrow('world_duplicate_town_patch');
  });

  it('merges atomically, independently of completion order, and replaces only the intended town', () => {
    const plan = fixture(), empty: WorldBundle = { plan, patches: [] };
    const a = patch(plan, 0), b = patch(plan, 1), before = JSON.stringify({ empty, a, b });
    const ab = mergeTownPatch(mergeTownPatch(empty, a), b), ba = mergeTownPatch(mergeTownPatch(empty, b), a);
    expect(ab).toEqual(ba);
    expect(JSON.stringify({ empty, a, b })).toBe(before);
    const replacement = structuredClone(a); replacement.summary = 'A revised house'; replacement.buildings[0].height = 20;
    const replaced = mergeTownPatch(ab, replacement);
    expect(replaced.patches[1]).toEqual(ab.patches[1]);
    expect(replaced.patches[0].buildings[0].height).toBe(20);
    expect(ab.patches[0].buildings[0].height).toBe(12);
    const bad = structuredClone(replacement); bad.worldKey = 'stale';
    const snapshot = JSON.stringify(ab);
    expect(() => mergeTownPatch(ab, bad)).toThrow('world_stale_patch');
    expect(JSON.stringify(ab)).toBe(snapshot);
  });

  it('changes only completed town pads and preserves exact samples outside their finite collar', () => {
    const plan = fixture(), base = createWorldSampler(plan.recipe);
    const pending = createPlannedWorldSampler(plan), sampler = createPlannedWorldSampler(plan, [patch(plan, 0)]);
    const town = plan.towns[0];
    expect(pending(-1900, 100)).toEqual(base(-1900, 100));
    for (const [dx, dz] of [[0, 0], [100, 100], [-200, 200]]) {
      expect(sampler(town.center[0] + dx, dz).height).toBe(town.foundation);
    }
    for (const [x, z] of [[-2800, 0], [-2801, 0], [-2000, 801], [2000, 0], [0, 4000]]) {
      expect(sampler(x, z)).toEqual(base(x, z));
    }
    expect(sampler(-2400, 0).height).not.toBe(base(-2400, 0).height);
    expect(sampler(-2400, 0).weights).toEqual(base(-2400, 0).weights);
  });

  it('has continuous heights and matching endpoint slopes at both sides of its quintic collar', () => {
    const plan = fixture(), town = plan.towns[0], sampler = createPlannedWorldSampler(plan, [patch(plan, 0)]);
    const base = createWorldSampler(plan.recipe), epsilon = 0.05, center = town.center[0];
    const inner = center + town.radius, outer = inner + town.blend;
    expect(Math.abs(sampler(inner - epsilon, 0).height - sampler(inner + epsilon, 0).height)).toBeLessThan(1e-6);
    const innerSlope = (sampler(inner + epsilon, 0).height - sampler(inner, 0).height) / epsilon;
    expect(Math.abs(innerSlope)).toBeLessThan(1e-5);
    const leftSlope = (sampler(outer, 0).height - sampler(outer - epsilon, 0).height) / epsilon;
    const rightSlope = (base(outer + epsilon, 0).height - base(outer, 0).height) / epsilon;
    expect(Math.abs(leftSlope - rightSlope)).toBeLessThan(0.002);
    expect(sampler(outer, 0)).toEqual(base(outer, 0));
  });

  it('reserves pending cores and road corridors with footprint clearance but keeps blend land available', () => {
    const plan = fixture(), exclude = createWorldExclusion(plan);
    expect(exclude(-2000, 0, 0)).toBe(true);
    expect(exclude(2000, 0, 0)).toBe(true);
    expect(exclude(-2220, 0, 21)).toBe(true);
    expect(exclude(-2250, 0, 10)).toBe(false);
    expect(exclude(-2500, 0, 0)).toBe(false);
    expect(exclude(0, 4, 0)).toBe(true);
    expect(exclude(0, 7, 3)).toBe(true);
    expect(exclude(0, 10, 0)).toBe(false);
    expect(() => exclude(0, 0, -1)).toThrow('world_invalid_exclusion_query');
  });
});


describe('town vegetation transitions', () => {
  it('uses the same quintic collar for every reserved town with exact untouched density outside', () => {
    const plan = fixture(), density = createWorldEcologyDensity(plan);
    for (const town of plan.towns) {
      const x = town.center[0], inner = x + town.radius, outer = inner + town.blend, epsilon = 0.05;
      expect(density(x, 0)).toBe(0);
      expect(density(inner, 0)).toBe(0);
      expect(density(inner + town.blend / 2, 0)).toBe(0.5);
      expect(density(outer, 0)).toBe(1);
      expect(density(x, town.radius + town.blend + 1)).toBe(1);
      expect(density(inner + epsilon, 0)).toBeLessThan(1e-8);
      expect(1 - density(outer - epsilon, 0)).toBeLessThan(1e-8);
    }
    const town = plan.towns[0], x = town.center[0] - town.radius - town.blend / 2;
    const base = createWorldSampler(plan.recipe), sampler = createPlannedWorldSampler(plan, [patch(plan, 0)]);
    const expected = town.foundation + (base(x, 0).height - town.foundation) * density(x, 0);
    expect(sampler(x, 0).height).toBeCloseTo(expected, 12);
    expect(density(0, 7000)).toBe(1);
    expect(() => density(NaN, 0)).toThrow('world_invalid_density_query');
  });
});


describe('world road geometry budget', () => {
  function densePatch(plan: WorldPlan, index: number, count: number): TownPatch {
    const result = patch(plan, index), town = plan.towns[index];
    result.buildings = [];
    result.streets = Array.from({ length: count }, (_, i) => road(town.id + '-dense-' + i, [
      [...town.ports[0].position], [0, 0],
      ...Array.from({ length: 63 }, (_, j): [number, number] => [(j % 2 ? 1 : -1) * town.radius, 0])
    ]));
    return result;
  }

  it('rejects excessive global road tessellation before terrain sampling or rendering', () => {
    const plan = fixture();
    plan.roads.push(road('long-zigzag', Array.from({ length: 30 }, (_, i): [number, number] => [i % 2 ? 7000 : -7000, 3000])));
    expect(() => validateWorldPlan(plan)).toThrow('world_road_geometry_quota');
  });

  it('rejects the accepted stress shape and combined town budgets without changing the existing bundle', () => {
    const plan = fixture(), stress = densePatch(plan, 0, 48);
    expect(() => validateTownPatch(plan, stress)).toThrow('world_road_geometry_quota');
    const a = densePatch(plan, 0, 6), b = densePatch(plan, 1, 6);
    expect(validateTownPatch(plan, a).streets).toHaveLength(6);
    expect(validateTownPatch(plan, b).streets).toHaveLength(6);
    const existing = mergeTownPatch({ plan, patches: [] }, a);
    const before = JSON.stringify(existing);
    expect(() => mergeTownPatch(existing, b)).toThrow('world_road_geometry_quota');
    expect(() => validateWorldBundle({ plan, patches: [a, b] })).toThrow('world_road_geometry_quota');
    expect(JSON.stringify(existing)).toBe(before);
  });
});

describe('organic settlement integration',()=>{
  it('lets finished towns keep vegetation on unoccupied land while reserving unfinished cores',()=>{
    const plan=fixture(), done=patch(plan,0);
    expect(createWorldExclusion(plan)(-1880,120,0)).toBe(true);
    expect(createWorldExclusion(plan,[done])(-1880,120,0)).toBe(false);
    expect(createWorldExclusion(plan,[done])(-2070,-70,0)).toBe(true);
    expect(createWorldEcologyDensity(plan,[done])(-1880,120)).toBeGreaterThan(0);
    expect(createWorldEcologyDensity(plan,[done])(2000,0)).toBe(0);
  });
  it('keeps conform settlements on local road grades and building pads instead of flattening the town core',()=>{
    const plan=fixture(); plan.recipe={...plan.recipe,heightScale:.1};
    const town=plan.towns[0],base=createWorldSampler(plan.recipe);
    plan.towns.forEach(item=>{item.foundation=base(item.center[0],item.center[1]).height;});
    town.terrainMode='conform';
    const local:TownPatch={
      townId:town.id,worldKey:worldPlanKey(plan),summary:'terrain conforming village',
      streets:[road('conform-street',[
        ...Array.from({length:21},(_,i):[number,number]=>[200-i*10,0]),
        ...Array.from({length:10},(_,i):[number,number]=>[0,(i+1)*10])
      ])],
      buildings:[
        {id:'conform-house',x:-48,z:-70,width:8,depth:8,height:12,use:'home',assetKey:'house-kit',enterable:true},
        {id:'conform-neighbor',x:-39,z:-70,width:8,depth:8,height:12,use:'home'}
      ]
    };
    const checked=validateTownPatch(plan,local),sample=createPlannedWorldSampler(plan,[checked]);
    expect(checked.buildings[0]).toMatchObject({assetKey:'house-kit',enterable:true});
    const bx=town.center[0]-48,bz=-70,h=sample(bx,bz).height;
    expect(sample(bx-4,bz-4).height).toBeCloseTo(h,10);
    expect(sample(bx+4,bz+4).height).toBeCloseTo(h,10);
    expect(sample(town.center[0]+100,5).height).toBeCloseTo(sample(town.center[0]+100,-5).height,10);
    expect(sample(town.center[0]+150,150)).toEqual(base(town.center[0]+150,150));
  });
  it('keeps a short street playable where its centerline leaves another street endpoint cap',()=>{
    const recipe:WorldRecipe={version:1,seed:2309,size:1600,heightScale:.12,constraints:[
      {region:'center',biome:'desert'},{region:'east',biome:'desert'},{region:'north',biome:'desert'},
      {region:'south',biome:'desert'},{region:'west',biome:'ocean'}
    ]};
    const base=createWorldSampler(recipe),center:[number,number]=[-360,370];
    const plan:WorldPlan={version:1,id:'harbor-grade',revision:1,prompt:'Playable harbor junction',recipe,ecology:[],roads:[],towns:[{
      id:'harbor',name:'Harbor',prompt:'Shore-side streets',center,radius:110,blend:100,
      foundation:base(center[0],center[1]).height,ports:[],terrainMode:'conform'
    }]};
    const junction:[number,number]=[0,-92.4],spur=road('harbor-spur',[junction,[7.70958194384224,-90.8664688040429]],4.6);
    const local:TownPatch={townId:'harbor',worldKey:worldPlanKey(plan),summary:'Two connected harbor streets',buildings:[],streets:[
      road('harbor-approach',[[-35.35994915053436,-85.3664688040428],[-19.09939117826633,-88.6008948852209],junction],4.6),spur
    ]};
    const sample=createPlannedWorldSampler(plan,[local]),a=spur.points[0],b=spur.points[1];
    const length=Math.hypot(b[0]-a[0],b[1]-a[1]),steps=Math.ceil(length),nx=-(b[1]-a[1])/length,nz=(b[0]-a[0])/length;
    let previous:number|undefined,maxLongitudinal=0,maxCross=0,maxEarthwork=0;
    for(let i=0;i<=steps;i++){
      const t=i/steps,x=center[0]+a[0]+(b[0]-a[0])*t,z=center[1]+a[1]+(b[1]-a[1])*t;
      const heights=[-spur.width/2,0,spur.width/2].map(offset=>sample(x+nx*offset,z+nz*offset).height);
      const raw=[-spur.width/2,0,spur.width/2].map(offset=>base(x+nx*offset,z+nz*offset).height);
      maxEarthwork=Math.max(maxEarthwork,...heights.map((height,index)=>Math.abs(height-raw[index])));
      maxCross=Math.max(maxCross,(Math.max(...heights)-Math.min(...heights))/spur.width);
      if(previous!==undefined)maxLongitudinal=Math.max(maxLongitudinal,Math.abs(heights[1]-previous)/(length/steps));
      previous=heights[1];
    }
    expect(maxLongitudinal).toBeLessThanOrEqual(.5);
    expect(maxCross).toBeLessThanOrEqual(.5);
    expect(maxEarthwork).toBeLessThanOrEqual(1.5);
  });
  it('bounds the combined cut and fill where conform streets overlap',()=>{
    const recipe:WorldRecipe={version:1,seed:2309,size:1600,heightScale:.5,constraints:[{region:'center',biome:'desert'}]};
    const base=createWorldSampler(recipe),center:[number,number]=[0,0];
    const plan:WorldPlan={version:1,id:'cross-grade',revision:1,prompt:'Crossing streets',recipe,ecology:[],roads:[],towns:[{
      id:'town',name:'Town',prompt:'Town',center,radius:120,blend:64,foundation:base(0,0).height,ports:[],terrainMode:'conform'
    }]};
    const local:TownPatch={townId:'town',worldKey:worldPlanKey(plan),summary:'Crossing streets',buildings:[],streets:[
      road('east-west',[[-80,0],[0,0],[80,0]],12),road('north-south',[[0,-80],[0,0],[0,80]],12)
    ]};
    const sample=createPlannedWorldSampler(plan,[local]);
    let maxEarthwork=0;
    for(let z=-10;z<=10;z++) for(let x=-10;x<=10;x++) {
      maxEarthwork=Math.max(maxEarthwork,Math.abs(sample(x,z).height-base(x,z).height));
    }
    expect(maxEarthwork).toBeLessThanOrEqual(1.5);
  });
  it('preserves building orientation and checks its rotated footprint',()=>{
    const plan=fixture(), rotated=patch(plan,0);
    Object.assign(rotated.buildings[0],{rotation:Math.PI/4});
    expect(validateTownPatch(plan,rotated).buildings[0]).toMatchObject({rotation:Math.PI/4});
    rotated.buildings[0].x=-175;
    expect(()=>validateTownPatch(plan,rotated)).toThrow('world_building_outside');
  });
  it('uses rotated footprints instead of overlapping world-axis bounds',()=>{
    const a={id:'a',x:0,z:0,width:10,depth:2,height:4,use:'home',rotation:Math.PI/4};
    expect(buildingsOverlap(a,{...a,id:'separate',z:6})).toBe(false);
    expect(buildingsOverlap(a,{...a,id:'crossing',x:1,z:1})).toBe(true);
  });
  it('blends overlapping collars continuously while keeping separate town cores exact',()=>{
    const plan=fixture(),base=createWorldSampler(plan.recipe);
    plan.towns[0].center=[-400,0];plan.towns[1].center=[400,0];
    plan.towns[0].foundation=base(-400,0).height-10;plan.towns[1].foundation=base(400,0).height+20;
    plan.roads[0].points=[[-200,0],[200,0]];
    const patches=[patch(plan,0),patch(plan,1)], sample=createPlannedWorldSampler(plan,patches);
    expect(sample(-350,0).height).toBe(plan.towns[0].foundation);
    expect(sample(350,0).height).toBe(plan.towns[1].foundation);
    for(const x of [-200,0,200]){
      expect(Math.abs(sample(x-.0001,0).height-sample(x+.0001,0).height)).toBeLessThan(.001);
      expect(sample(x,0)).toEqual(createPlannedWorldSampler(plan,[...patches].reverse())(x,0));
    }
  });
});
