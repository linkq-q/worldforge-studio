import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MapGuide } from '../src/shared/mapGuide';
import {
  auditWorldSettlement, createWorldSettlementLandmarkLayout, createWorldSettlementPartialLandmarkLayout,
  generateWorldSettlement, type WorldSettlementSampler
} from '../src/shared/worldSettlement';
import { createUrbanLayout } from '../src/shared/mapUrbanLayout';
import { createWorldSampler, type WorldRecipe, type WorldSample } from '../src/shared/worldTerrain';
import { buildingsOverlap, createPlannedWorldTerrainContext, segmentBuildingFootprint, validateTownPatch, worldRoadPolyline,
  type TownBuilding, type WorldPlan } from '../src/shared/worldPlanning';

type Point = [number, number];

const hawaiiV2TownRegression = JSON.parse(readFileSync(
  new URL('../scripts/fixtures/hawaii-v2-town-regression.json', import.meta.url), 'utf8'
)) as {
  plan: WorldPlan;
  requirements: Array<{ id:string;use:string;width:number;depth:number;height:number;assetKey:string;
    enterable?:boolean;siting?:'central'|'waterfront'|'gateway'|'high-ground' }>;
  options: { kind:'city';pattern:'organic';density:number;waterfrontBias:number };
};

function road(id: string, points: Point[], width = 8): MapGuide {
  return { id, name: id, points, curve: 'polyline', closed: false, width, tags: ['world-road'] };
}

function fixture(): WorldPlan {
  const recipe: WorldRecipe = {
    version: 1, seed: 42, size: 16000, heightScale: 0.1,
    constraints: [{ region: 'center', biome: 'grassland' }]
  };
  const terrain = createWorldSampler(recipe);
  return {
    version: 1, id: 'settlement-world', revision: 1, prompt: 'A river town', recipe, ecology: [],
    roads: [road('highway', [[-1800, 0], [1800, 0]])],
    towns: [{
      id: 'town', name: 'Town', prompt: 'A mixed settlement', center: [-2000, 0],
      radius: 200, blend: 600, foundation: terrain(-2000, 0).height, terrainMode: 'conform',
      ports: [{ id: 'east-gate', guideId: 'highway', position: [200, 0], width: 8 }]
    }]
  };
}

function sampler(plan: WorldPlan, river = false): WorldSettlementSampler {
  const base = createWorldSampler(plan.recipe), center = plan.towns[0].center;
  return (x, z): WorldSample => {
    const original = base(x, z), lx = x - center[0], lz = z - center[1];
    const water = river && Math.abs(lx + 86) <= 10;
    return {
      ...original,
      height: water ? -3 : original.height,
      waterLevel: water ? 0 : null,
      waterBodyId: water ? 'river' : null
    };
  };
}

function segments(patch: ReturnType<typeof generateWorldSettlement>) {
  return patch.streets.flatMap(street => street.points.slice(1).map((b, index) => ({ a: street.points[index], b, width: street.width })));
}

function settlementShape(patch: ReturnType<typeof generateWorldSettlement>, radius: number) {
  const streets = patch.streets.filter(street => !street.tags.some(tag => ['port', 'waterfront', 'landmark-access'].includes(tag)));
  const edges = streets.flatMap(street => street.points.slice(1).map((b, index) => [street.points[index], b] as const));
  const key = (point: Point) => `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
  const graph = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    const ka = key(a), kb = key(b);
    if (!graph.has(ka)) graph.set(ka, new Set());
    if (!graph.has(kb)) graph.set(kb, new Set());
    graph.get(ka)!.add(kb); graph.get(kb)!.add(ka);
  }
  let components = 0;
  const remaining = new Set(graph.keys());
  while (remaining.size) {
    components++;
    const queue = [remaining.values().next().value!];
    remaining.delete(queue[0]);
    for (let index = 0; index < queue.length; index++) for (const next of graph.get(queue[index]) ?? []) {
      if (remaining.delete(next)) queue.push(next);
    }
  }
  const roadExtent = Math.max(...edges.flatMap(edge => edge.map(point => Math.hypot(...point)))) / radius;
  const buildingExtent = Math.max(...patch.buildings.map(building => Math.hypot(building.x, building.z))) / radius;
  return {
    cycles: edges.length - graph.size + components,
    deadEnds: [...graph.values()].filter(neighbors => neighbors.size === 1).length,
    roadExtent, buildingExtent
  };
}

function pointDistance(point: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dz * t);
}

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function properIntersection(a: Point, b: Point, c: Point, d: Point): boolean {
  const shared = [a, b].some(p => [c, d].some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6));
  return !shared && cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

function expectSafeRoadShape(patch: ReturnType<typeof generateWorldSettlement>): void {
  const edges = segments(patch);
  for (let left = 0; left < edges.length; left++) for (let right = left + 1; right < edges.length; right++) {
    expect(properIntersection(edges[left].a, edges[left].b, edges[right].a, edges[right].b),
      JSON.stringify([edges[left], edges[right]])).toBe(false);
  }
  for (const street of patch.streets) for (let index = 1; index + 1 < street.points.length; index++) {
    const incoming: Point = [street.points[index][0] - street.points[index - 1][0], street.points[index][1] - street.points[index - 1][1]];
    const outgoing: Point = [street.points[index + 1][0] - street.points[index][0], street.points[index + 1][1] - street.points[index][1]];
    expect((incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) / Math.hypot(...incoming) / Math.hypot(...outgoing)).toBeGreaterThan(-0.25);
  }
}

function expectStreetFacingBuildings(patch: ReturnType<typeof generateWorldSettlement>): void {
  const roads = segments(patch);
  for (const building of patch.buildings) {
    const entrance: Point = [
      building.x + Math.sin(building.rotation ?? 0) * building.depth / 2,
      building.z + Math.cos(building.rotation ?? 0) * building.depth / 2
    ];
    expect(Math.min(...roads.map(segment => pointDistance(entrance, segment.a, segment.b))), building.id).toBeLessThan(8.5);
  }
}

describe('world settlement growth', () => {
  it('keeps the best bounded full-landmark patch when the first feasible layout collapses the town', () => {
    const { plan, requirements, options } = structuredClone(hawaiiV2TownRegression);
    const sample = createPlannedWorldTerrainContext(plan).sample;
    const base = generateWorldSettlement(plan, plan.towns[0].id, sample, { ...options, landmarks: [] });
    const strictRequirements = requirements.slice(0, 2);
    const result = createWorldSettlementLandmarkLayout(plan, plan.towns[0].id, sample, options, strictRequirements);
    const landmarkIds = new Set(strictRequirements.map(requirement => requirement.id));
    const ordinary = result.patch.buildings.filter(building => !landmarkIds.has(building.id));
    const extent = Math.max(
      Math.max(...ordinary.map(building => building.x)) - Math.min(...ordinary.map(building => building.x)),
      Math.max(...ordinary.map(building => building.z)) - Math.min(...ordinary.map(building => building.z))
    ) / (plan.towns[0].radius * 2);

    expect(base.buildings.length).toBeGreaterThanOrEqual(35);
    expect(base.streets.length).toBeGreaterThanOrEqual(13);
    expect(result.landmarks).toHaveLength(2);
    expect(ordinary.length).toBeGreaterThanOrEqual(30);
    expect(extent).toBeGreaterThanOrEqual(0.6);
    expect(validateTownPatch(plan, result.patch)).toEqual(result.patch);
  }, 20_000);

  it('reserves the sampled curve of a Catmull-Rom world road before placing buildings', () => {
    const plan = fixture(), town = plan.towns[0], sample = sampler(plan);
    town.ports = [];
    plan.roads = [];
    const options = { kind: 'city' as const, pattern: 'organic' as const, seed: 91, density: 0.78 };
    const target = generateWorldSettlement(plan, town.id, sample, options).buildings[0];
    const center: Point = [target.x + town.center[0], target.z + town.center[1]];
    const curved = road('curved-world-road', [
      [center[0] - 20, center[1] + 90], [center[0] - 10, center[1] + 10],
      [center[0] + 10, center[1] + 10], [center[0] + 20, center[1] + 90]
    ], 2);
    curved.curve = 'catmull-rom';
    plan.roads = [curved];
    const worldTarget = { ...target, x: center[0], z: center[1] };

    expect(curved.points.slice(1).some((point, index) =>
      segmentBuildingFootprint(curved.points[index], point, worldTarget, curved.width / 2))).toBe(false);
    const sampled = worldRoadPolyline(curved);
    expect(sampled.slice(1).some((point, index) =>
      segmentBuildingFootprint(sampled[index], point, worldTarget, curved.width / 2))).toBe(true);

    const patch = generateWorldSettlement(plan, town.id, sample, options);
    expect(patch.buildings.length).toBeGreaterThan(20);
    for (const building of patch.buildings) {
      const worldBuilding = { ...building, x: building.x + town.center[0], z: building.z + town.center[1] };
      expect(sampled.slice(1).some((point, index) =>
        segmentBuildingFootprint(sampled[index], point, worldBuilding, curved.width / 2)), building.id).toBe(false);
    }
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it.each(['organic', 'grid'] as const)('creates deterministic, connected %s streets and terrain-fit buildings', pattern => {
    const plan = fixture(), sample = sampler(plan);
    const options = { kind: 'city' as const, pattern, seed: 91, density: 0.78, maxRoadSlope: 0.12, maxSiteSlope: 0.1 };
    const patch = generateWorldSettlement(plan, 'town', sample, options);
    expect(generateWorldSettlement(plan, 'town', sample, options)).toEqual(patch);
    expect(generateWorldSettlement(plan, 'town', sample, { ...options, seed: 92 })).not.toEqual(patch);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
    expect(patch.streets.length).toBeGreaterThan(5);
    expect(patch.buildings.length).toBeGreaterThan(20);
    expect(patch.streets.some(street => street.tags.includes('port') && street.width === 8)).toBe(true);
    expectSafeRoadShape(patch);
    const audit = auditWorldSettlement(patch, plan.towns[0], sample);
    expect(audit.buildingCount).toBe(patch.buildings.length);
    expect(audit.builtFootprintArea).toBeGreaterThan(audit.roadSurfaceArea * 0.35);
    expect(audit.roadWidthRange[0]).toBeGreaterThanOrEqual(3);
    expect(audit.roadWidthRange[1]).toBeLessThanOrEqual(8);
    expect(audit.maxRoadSlope).toBeLessThanOrEqual(options.maxRoadSlope + 1e-6);
    expect(audit.maxBuildingSlope).toBeLessThanOrEqual(options.maxSiteSlope + 1e-6);
    expect(Math.max(...patch.buildings.map(building => building.height))).toBeLessThanOrEqual(16);
    expectStreetFacingBuildings(patch);
  });

  it('uses one parameterized growth path for a dense city and a sparse village', () => {
    const plan = fixture(), sample = sampler(plan);
    const city = generateWorldSettlement(plan, 'town', sample, { kind: 'city', pattern: 'organic', seed: 19, density: 0.9 });
    const village = generateWorldSettlement(plan, 'town', sample, { kind: 'village', pattern: 'organic', seed: 19, density: 0.28 });
    expect(city.buildings.length).toBeGreaterThan(village.buildings.length * 1.5);
    expect(city.streets.length).toBeGreaterThan(village.streets.length);
    expect(city.buildings.length).toBeGreaterThan(city.streets.length * 2);
    expect(village.streets.length).toBeLessThanOrEqual(village.buildings.length);
    expect(city.buildings.some(building => building.height > 12)).toBe(true);
    expect(village.buildings.every(building => building.height <= 11)).toBe(true);
  });

  it('does not spend a small village budget on excess roads', () => {
    const plan = fixture(), town = plan.towns[0];
    town.radius = 100;
    town.ports[0].position = [100, 0];
    plan.roads[0].points = [[town.center[0] + 100, 0], [1800, 0]];
    const patch = generateWorldSettlement(plan, town.id, sampler(plan), {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.45
    });
    expect(patch.buildings.length).toBeGreaterThanOrEqual(8);
    expect(patch.streets.length).toBeLessThanOrEqual(12);
  });

  it('does not keep compact village streets that add no buildable frontage', () => {
    const plan = fixture(), town = plan.towns[0];
    plan.recipe.size = 500;
    plan.generationPolicy = 'raw-first-call';
    town.center = [0, 0];
    town.radius = 50;
    town.blend = 20;
    town.foundation = 12;
    town.ports = [];
    plan.roads = [];
    const flat: WorldSettlementSampler = () => ({
      height: 12, waterLevel: null, waterBodyId: null, moisture: 0.3, temperature: 0.5,
      continentalness: 0.8,
      weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 }
    });

    const patch = generateWorldSettlement(plan, town.id, flat, {
      kind: 'village', pattern: 'organic', seed: 1, density: 0.2, waterfrontBias: 0
    });
    const audit = auditWorldSettlement(patch, town, flat);

    expect(patch.buildings.length).toBeGreaterThanOrEqual(8);
    expect(patch.streets.length).toBeLessThanOrEqual(4);
    expect(audit.builtFootprintArea).toBeGreaterThan(audit.roadSurfaceArea);
    expectStreetFacingBuildings(patch);
  });

  it('fits an explicitly populated compact village with human-scale streets', () => {
    const plan = fixture(), town = plan.towns[0];
    town.radius = 100;
    town.ports = [];
    plan.roads = [];
    town.population = 250;
    const patch = generateWorldSettlement(plan, town.id, sampler(plan), {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.49
    });
    const ordinary = patch.buildings.filter(building => !building.assetKey).length;
    expect(ordinary).toBeGreaterThanOrEqual(Math.ceil(town.population / 5));
    expect(Math.max(...patch.streets.map(street => street.width))).toBeLessThanOrEqual(4.6);
  });

  it('uses buildable moderate city slopes when a house footprint needs no more than local earthwork', () => {
    const plan = fixture(), town = plan.towns[0];
    town.center = [0, 0]; town.radius = 100; town.ports = []; town.population = 80;
    plan.recipe.size = 500; plan.roads = []; plan.generationPolicy = 'raw-first-call';
    const hillside: WorldSettlementSampler = (x, z) => ({
      height: 12 + x * 0.17, waterLevel: null, waterBodyId: null,
      moisture: 0.3, temperature: 0.5, continentalness: 0.8,
      weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 }
    });

    const patch = generateWorldSettlement(plan, town.id, hillside, {
      kind: 'city', pattern: 'organic', seed: 59, density: 0.6, waterfrontBias: 0
    });
    expect(patch.buildings.length).toBeGreaterThan(5);
    expect(auditWorldSettlement(patch, town, hillside).maxBuildingSlope).toBeLessThanOrEqual(0.25 + 1e-6);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('lets local district access climb a modest foothill without steepening the core streets', () => {
    const plan = fixture(), town = plan.towns[0];
    town.center = [0, 0]; town.radius = 100; town.ports = []; town.population = 120;
    town.districts = [
      { anchorId: 'core', kind: 'civic', density: 0.5, offset: [0, 0], radius: 35 },
      { anchorId: 'foothill-homes', kind: 'residential', density: 0.9, offset: [130, 0], radius: 35 }
    ];
    plan.recipe.size = 500; plan.roads = []; plan.generationPolicy = 'raw-first-call';
    plan.featureGraph = { regions: town.districts.map(district => ({ id: `${district.anchorId}-region`,
      kind: 'settlement_district', name: district.anchorId, center: district.offset, radius: district.radius })),
    paths: [], relations: [], anchors: town.districts.map(district => ({ id: district.anchorId,
      kind: district.kind, position: district.offset, regionId: `${district.anchorId}-region` })) };
    const foothill: WorldSettlementSampler = (x) => ({
      height: 12 + Math.max(0, x - 80) * 0.21, waterLevel: null, waterBodyId: null,
      moisture: 0.3, temperature: 0.5, continentalness: 0.8,
      weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 }
    });

    const options = {
      kind: 'city', pattern: 'organic', seed: 59, density: 0.6, waterfrontBias: 0
    } as const;
    const strict = generateWorldSettlement(plan, town.id, foothill, { ...options, maxRoadSlope: 0.18 });
    const patch = generateWorldSettlement(plan, town.id, foothill, options);
    expect(patch.streets.filter(road => road.tags.includes('district-access')).length)
      .toBeGreaterThan(strict.streets.filter(road => road.tags.includes('district-access')).length);
    expect(patch.buildings.filter(building => building.x > 105 && building.use === 'home').length)
      .toBeGreaterThan(strict.buildings.filter(building => building.x > 105 && building.use === 'home').length);
    expect(auditWorldSettlement(patch, town, foothill).maxRoadSlope).toBeLessThanOrEqual(0.25 + 1e-6);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('tries walkable city streets when the default core road search finds no network', () => {
    const plan = fixture(), town = plan.towns[0];
    town.center = [0, 0]; town.radius = 100; town.ports = []; town.population = 80;
    plan.recipe.size = 500; plan.roads = []; plan.generationPolicy = 'raw-first-call';
    const foothill: WorldSettlementSampler = (x) => ({
      height: 12 + x * 0.21, waterLevel: null, waterBodyId: null,
      moisture: 0.3, temperature: 0.5, continentalness: 0.8,
      weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 }
    });
    const options = { kind: 'city', pattern: 'organic', seed: 59,
      density: 0.6, waterfrontBias: 0 } as const;

    expect(() => generateWorldSettlement(plan, town.id, foothill,
      { ...options, maxRoadSlope: 0.18 })).toThrow('world_settlement_no_buildable_network');
    const patch = generateWorldSettlement(plan, town.id, foothill, options);
    expect(patch.streets.length).toBeGreaterThanOrEqual(4);
    expect(patch.buildings.length).toBeGreaterThanOrEqual(8);
    expect(auditWorldSettlement(patch, town, foothill).maxRoadSlope).toBeLessThanOrEqual(0.25 + 1e-6);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('weights reachable frontage across explicit civic, residential, working and edge districts', () => {
    const plan = fixture(), town = plan.towns[0], base = sampler(plan);
    town.population = 150;
    town.districts = [
      { anchorId: 'civic', kind: 'civic', density: 0.2, offset: [0, 0], radius: 44 },
      { anchorId: 'homes', kind: 'residential', density: 1, offset: [-76, -42], radius: 68 },
      { anchorId: 'works', kind: 'working', density: 0.65, offset: [72, -38], radius: 68 },
      { anchorId: 'edge', kind: 'edge', density: 0.35, offset: [0, 116], radius: 64 }
    ];
    plan.featureGraph = {
      regions: [{ id: 'town-region', kind: 'settlement', name: 'Town', center: town.center, radius: town.radius }],
      paths: [], relations: [], anchors: town.districts.map(district => ({
        id: district.anchorId, kind: district.kind,
        position: [town.center[0] + district.offset[0], town.center[1] + district.offset[1]], regionId: 'town-region'
      }))
    };
    const flat: WorldSettlementSampler = (x, z) => ({
      ...base(x, z), height: 12, waterLevel: null, waterBodyId: null
    });
    const patch = generateWorldSettlement(plan, town.id, flat, {
      kind: 'city', pattern: 'organic', seed: 59, density: 0.82, waterfrontBias: 0
    });
    const districtFor = (building: TownBuilding) => town.districts!
      .filter(district => Math.hypot(building.x - district.offset[0], building.z - district.offset[1]) <= district.radius)
      .sort((a, b) => Math.hypot(building.x - a.offset[0], building.z - a.offset[1]) / a.radius
        - Math.hypot(building.x - b.offset[0], building.z - b.offset[1]) / b.radius)[0];
    const counts = Object.fromEntries(town.districts.map(district => [district.kind, 0])) as Record<string, number>;
    const uses = Object.fromEntries(town.districts.map(district => [district.kind, [] as string[]])) as Record<string, string[]>;
    for (const building of patch.buildings) {
      const district = districtFor(building);
      expect(district, building.id).toBeDefined();
      counts[district!.kind]++;
      uses[district!.kind].push(building.use);
    }
    expect(counts.residential).toBeGreaterThan(counts.working);
    expect(counts.working).toBeGreaterThan(counts.edge);
    expect(counts.edge).toBeGreaterThan(counts.civic);
    expect(counts.civic).toBeGreaterThan(0);
    expect(uses.civic).toContain('shop');
    expect(uses.working).toContain('workshop');
    expect(new Set(uses.residential)).toEqual(new Set(['home']));
    expect(new Set(uses.edge)).toEqual(new Set(['farmhouse']));
    expectStreetFacingBuildings(patch);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('does not move an unbuildable district across water just to satisfy population', () => {
    const plan = fixture(), town = plan.towns[0], base = sampler(plan);
    town.population = 25;
    town.districts = [{ anchorId: 'island-homes', kind: 'residential', density: 1, offset: [150, 0], radius: 20 }];
    plan.featureGraph = {
      regions: [{ id: 'town-region', kind: 'settlement', name: 'Town', center: town.center, radius: town.radius }],
      paths: [], relations: [], anchors: [{ id: 'island-homes', kind: 'residential',
        position: [town.center[0] + 150, town.center[1]], regionId: 'town-region' }]
    };
    const floodedDistrict: WorldSettlementSampler = (x, z) => {
      const original = base(x, z), flooded = Math.hypot(x - town.center[0] - 150, z - town.center[1]) <= 24;
      return { ...original, height: flooded ? -3 : 12,
        waterLevel: flooded ? 0 : null, waterBodyId: flooded ? 'marsh' : null };
    };

    expect(() => generateWorldSettlement(plan, town.id, floodedDistrict, {
      kind: 'city', pattern: 'organic', seed: 59, density: 0.82, waterfrontBias: 0
    })).toThrow('world_settlement_no_buildings');
  });

  it('connects and inhabits a dry authored district beyond the town core', () => {
    const plan = fixture(), town = plan.towns[0];
    town.center = [0, 0]; town.radius = 100; town.ports = []; town.population = 120;
    town.districts = [
      { anchorId: 'core', kind: 'civic', density: 0.5, offset: [0, 0], radius: 35 },
      { anchorId: 'outer-homes', kind: 'residential', density: 0.9, offset: [130, 0], radius: 35 }
    ];
    plan.roads = [];
    plan.generationPolicy = 'raw-first-call';
    plan.featureGraph = { regions: town.districts.map(district => ({ id: `${district.anchorId}-region`,
      kind: 'settlement_district', name: district.anchorId,
      center: district.offset, radius: district.radius })), paths: [], relations: [],
    anchors: town.districts.map(district => ({ id: district.anchorId, kind: district.kind,
      position: district.offset, regionId: `${district.anchorId}-region` })) };
    const flat: WorldSettlementSampler = () => ({ height: 12, waterLevel: null, waterBodyId: null,
      moisture: 0.3, temperature: 0.5, continentalness: 0.8,
      weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 } });
    const patch = generateWorldSettlement(plan, town.id, flat, {
      kind: 'village', pattern: 'organic', seed: 17, density: 0.55, waterfrontBias: 0
    });
    expect(patch.buildings.filter(building => building.x > 105 && building.use === 'home').length).toBeGreaterThanOrEqual(2);
    const central = patch.buildings.find(building => Math.abs(building.x) < 35 && Math.abs(building.z) < 35);
    expect(central).toBeDefined();
    const withLandmark = generateWorldSettlement(plan, town.id, flat, {
      kind: 'village', pattern: 'organic', seed: 17, density: 0.55, waterfrontBias: 0,
      landmarks: [{ ...central!, id: 'village-school', use: 'school' }]
    });
    expect(withLandmark.buildings.filter(building => building.x > 105 && building.use === 'home').length)
      .toBeGreaterThanOrEqual(2);
    expectStreetFacingBuildings(patch);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('places a public building on a dry authored road in an outer district', () => {
    const plan = fixture(), town = plan.towns[0];
    town.center = [0, 0]; town.radius = 100; town.population = 80;
    town.ports = [{ id: 'outer-gate', guideId: 'district-road', position: [100, 0], width: 4 }];
    town.districts = [{ anchorId: 'outer-civic', kind: 'civic', density: 1,
      offset: [130, 0], radius: 35 }];
    plan.roads = [road('district-road', [[100, 0], [130, 0]], 4)];
    plan.roads[0].tags = ['world-route', 'town-internal', 'local_street'];
    plan.generationPolicy = 'raw-first-call';
    plan.featureGraph = { regions: [{ id: 'outer-region', kind: 'settlement_district',
      name: 'Outer civic quarter', center: [130, 0], radius: 35 }], paths: [], relations: [],
    anchors: [{ id: 'outer-civic', kind: 'civic', position: [130, 0], regionId: 'outer-region' }] };
    const highGround: WorldSettlementSampler = (x) => ({ height: 12 + x * 0.01,
      waterLevel: null, waterBodyId: null, moisture: 0.3, temperature: 0.5, continentalness: 0.8,
      weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 } });
    const result = createWorldSettlementLandmarkLayout(plan, town.id, highGround, {
      kind: 'village', pattern: 'organic', seed: 17, density: 0.5, waterfrontBias: 0
    }, [{ id: 'outer-hall', use: 'civic hall', width: 8, depth: 8, height: 7, siting: 'high-ground' }]);
    expect(result.landmarks[0].x).toBeGreaterThan(100);
    expect(result.patch.streets.some(street => street.id.endsWith('landmark-outer-hall'))).toBe(true);
    expect(validateTownPatch(plan, result.patch)).toEqual(result.patch);
  });

  it('keeps the legacy populated layout when every explicit district has zero density', () => {
    const legacy = fixture();
    legacy.towns[0].population = 150;
    legacy.generationPolicy = 'raw-first-call';
    const options = { kind: 'city' as const, pattern: 'organic' as const, seed: 59, density: 0.82, waterfrontBias: 0 };
    const expected = generateWorldSettlement(legacy, legacy.towns[0].id, sampler(legacy), options);
    const zeroDensity = structuredClone(legacy), town = zeroDensity.towns[0];
    town.districts = [
      { anchorId: 'empty-core', kind: 'civic', density: 0, offset: [0, 0], radius: 40 },
      { anchorId: 'empty-edge', kind: 'edge', density: 0, offset: [0, 100], radius: 40 }
    ];
    zeroDensity.featureGraph = {
      regions: [{ id: 'town-region', kind: 'settlement', name: 'Town', center: town.center, radius: town.radius }],
      paths: [], relations: [], anchors: town.districts.map(district => ({ id: district.anchorId, kind: district.kind,
        position: [town.center[0] + district.offset[0], town.center[1] + district.offset[1]], regionId: 'town-region' }))
    };
    const actual = generateWorldSettlement(zeroDensity, town.id, sampler(zeroDensity), options);

    expect(actual.streets).toEqual(expected.streets);
    expect(actual.buildings).toEqual(expected.buildings);
  });

  it('keeps 150-person housing capacity while extending one town across compact authored districts', () => {
    const plan = fixture(), town = plan.towns[0];
    town.center = [0, 0]; town.radius = 100; town.blend = 100; town.foundation = 12; town.ports = []; town.population = 150;
    town.districts = [
      { anchorId: 'civic-anchor', kind: 'civic', density: 0.9, offset: [0, 0], radius: 24 },
      { anchorId: 'garden-anchor', kind: 'edge', density: 0.25, offset: [-10, 75], radius: 25 },
      { anchorId: 'residential-anchor', kind: 'residential', density: 0.65, offset: [40, 35], radius: 28 },
      { anchorId: 'working-anchor', kind: 'working', density: 0.8, offset: [-55, -15], radius: 22 }
    ];
    const localRoad = (id: string, points: Point[], width: number): MapGuide => ({
      id, name: id, points, curve: 'polyline', closed: false, width,
      tags: ['world-route', 'road', 'town-internal', 'local_street']
    });
    plan.roads = [
      localRoad('quay-route', [[0, 0], [105, -10], [-55, -15]], 4),
      localRoad('home-route', [[0, 0], [18, 20], [40, 35]], 3.5),
      localRoad('garden-route', [[40, 35], [12, 57], [-10, 75]], 2.5)
    ];
    plan.generationPolicy = 'raw-first-call';
    plan.featureGraph = {
      regions: town.districts.map(district => ({ id: `${district.anchorId}-region`, kind: 'settlement_district',
        name: district.anchorId, center: district.offset, radius: district.radius })),
      paths: [], relations: [], anchors: town.districts.map(district => ({ id: district.anchorId, kind: district.kind,
        position: district.offset, regionId: `${district.anchorId}-region` }))
    };
    const flat: WorldSettlementSampler = () => ({
      height: 12, waterLevel: null, waterBodyId: null, moisture: 0.3, temperature: 0.5,
      continentalness: 0.8, weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 }
    });
    const patch = generateWorldSettlement(plan, town.id, flat, {
      kind: 'village', pattern: 'organic', density: 0.45, waterfrontBias: 0
    });
    const counts = Object.fromEntries(town.districts.map(district => [district.kind, patch.buildings.filter(building =>
      Math.hypot(building.x - district.offset[0], building.z - district.offset[1]) <= district.radius).length])) as Record<string, number>;
    const allRoads = [...segments(patch), ...plan.roads.flatMap(route => route.points.slice(1)
      .map((b, index) => ({ a: route.points[index], b, width: route.width })))];

    expect(patch.buildings.filter(building => building.use === 'home' || building.use === 'farmhouse')).toHaveLength(30);
    expect(counts.civic).toBeGreaterThanOrEqual(4);
    expect(counts.working).toBeGreaterThanOrEqual(2);
    expect(counts.residential).toBeGreaterThanOrEqual(8);
    expect(counts.edge).toBeGreaterThanOrEqual(2);
    for (const building of patch.buildings) {
      const entrance: Point = [building.x + Math.sin(building.rotation ?? 0) * building.depth / 2,
        building.z + Math.cos(building.rotation ?? 0) * building.depth / 2];
      expect(Math.min(...allRoads.map(segment => pointDistance(entrance, segment.a, segment.b))), building.id).toBeLessThan(8.5);
    }
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('connects a corner port after clearing both town-boundary axes', () => {
    const plan = fixture(), town = plan.towns[0], base = sampler(plan);
    town.radius = 100;
    town.ports[0].position = [100, 100];
    plan.roads[0].points = [[town.center[0] + 100, 100], [-1000, 100]];
    const flat: WorldSettlementSampler = (x, z) => ({
      ...base(x, z), height: 12, waterLevel: null, waterBodyId: null
    });
    const patch = generateWorldSettlement(plan, town.id, flat, {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.45
    });
    expect(patch.streets.some(street => street.tags.includes('port')
      && street.points[0][0] === 100 && street.points[0][1] === 100)).toBe(true);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('keeps near-corner and fractional boundary ports connected to a compact town', () => {
    const plan = fixture(), town = plan.towns[0], base = sampler(plan);
    plan.recipe.size = 500;
    plan.recipe.reliefProfile = 'compact';
    plan.generationPolicy = 'raw-first-call';
    town.center = [0, 0];
    town.radius = 50;
    town.blend = 20;
    town.foundation = 12;
    town.ports = [
      { id: 'near-corner', guideId: 'harbour-lane', position: [50, 44.483870967741936], width: 5 },
      { id: 'fractional-edge', guideId: 'shore-lane', position: [-0.8947368421052602, 50], width: 2.5 }
    ];
    plan.roads = [
      road('harbour-lane', [[50, 44.483870967741936], [60, 47.483870967741936]], 5),
      road('shore-lane', [[-0.8947368421052602, 50], [1, 60]], 2.5)
    ];
    const flat: WorldSettlementSampler = (x, z) => ({
      ...base(x, z), height: 12, waterLevel: null, waterBodyId: null
    });

    const patch = generateWorldSettlement(plan, town.id, flat, {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.62, waterfrontBias: 0
    });

    for (const port of town.ports) expect(patch.streets.some(street => street.width === port.width
      && [street.points[0], street.points.at(-1)!].some(point => point[0] === port.position[0]
        && point[1] === port.position[1])), port.id).toBe(true);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('adds useful frontage behind mandatory approaches in a compact village', () => {
    const plan = fixture(), town = plan.towns[0];
    plan.recipe.size = 500;
    plan.generationPolicy = 'raw-first-call';
    town.center = [0, 0];
    town.radius = 50;
    town.blend = 20;
    town.foundation = 12;
    const approaches = [
      { id: 'east', position: [50, 0] as Point, end: [80, 0] as Point, width: 2 },
      { id: 'north', position: [0, 50] as Point, end: [0, 80] as Point, width: 5 },
      { id: 'west', position: [-50, 0] as Point, end: [-80, 0] as Point, width: 2.5 }
    ];
    town.ports = approaches.map(item => ({
      id: `${item.id}-gate`, guideId: `${item.id}-approach`, position: item.position, width: item.width
    }));
    plan.roads = approaches.map(item => road(`${item.id}-approach`, [item.position, item.end], item.width));
    const flat: WorldSettlementSampler = () => ({
      height: 12, waterLevel: null, waterBodyId: null, moisture: 0.3, temperature: 0.5,
      continentalness: 0.8,
      weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 }
    });

    const patch = generateWorldSettlement(plan, town.id, flat, {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.62, waterfrontBias: 0
    });
    const audit = auditWorldSettlement(patch, town, flat);

    for (const port of town.ports) expect(patch.streets.some(street => street.tags.includes('port')
      && street.points.some(point => point[0] === port.position[0] && point[1] === port.position[1])), port.id).toBe(true);
    expect(audit.builtFootprintArea).toBeGreaterThan(audit.roadSurfaceArea * 0.6);
    expectStreetFacingBuildings(patch);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('uses authored local streets as frontage without filling walking trails', () => {
    const plan = fixture(), town = plan.towns[0];
    plan.recipe.size = 500;
    plan.generationPolicy = 'raw-first-call';
    town.center = [0, 0];
    town.radius = 50;
    town.blend = 20;
    town.foundation = 12;
    town.ports = [];
    const street = road('authored-local-street', [[-45, 25], [45, 25]], 5);
    street.tags = ['local_street', 'world-route'];
    const trail = road('authored-walking-trail', [[-45, -25], [45, -25]], 2);
    trail.tags = ['walking_trail', 'world-route'];
    plan.roads = [trail, street];
    const flat: WorldSettlementSampler = () => ({
      height: 12, waterLevel: null, waterBodyId: null, moisture: 0.3, temperature: 0.5,
      continentalness: 0.8,
      weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 }
    });

    const patch = generateWorldSettlement(plan, town.id, flat, {
      kind: 'village', pattern: 'organic', seed: 7, density: 0.62, waterfrontBias: 0
    });
    const entrances = patch.buildings.map(building => [
      building.x + Math.sin(building.rotation ?? 0) * building.depth / 2,
      building.z + Math.cos(building.rotation ?? 0) * building.depth / 2
    ] as Point);

    expect(entrances.filter(point => pointDistance(point, street.points[0], street.points[1]) <= 3.6).length)
      .toBeGreaterThanOrEqual(3);
    expect(entrances.filter(point => pointDistance(point, trail.points[0], trail.points[1]) <= 2.1).length).toBe(0);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it.each([
    [100, 7, 110], [150, 19, 120], [200, 31, 160]
  ] as const)('keeps compact street-facing city blocks across radius %sm and seed %s', (radius, seed, minimumBuildings) => {
    const plan = fixture(), town = plan.towns[0];
    town.radius = radius;
    town.ports[0].position = [radius, 0];
    plan.roads[0].points = [[town.center[0] + radius, 0], [1800, 0]];
    const sample = sampler(plan);
    const patch = generateWorldSettlement(plan, town.id, sample, {
      kind: 'city', pattern: 'organic', seed, density: 0.9
    });
    const audit = auditWorldSettlement(patch, town, sample);
    expect(patch.buildings.length).toBeGreaterThanOrEqual(minimumBuildings);
    expect(audit.builtFootprintArea).toBeGreaterThan(audit.roadSurfaceArea * 0.45);
    expectStreetFacingBuildings(patch);
  });

  it('uses its road budget for outward, block-forming fabric across seeds and a sloped shore', () => {
    for (const [seed, shore] of [[7, false], [19, false], [31, true]] as const) {
      const plan = fixture(), town = plan.towns[0], base = sampler(plan);
      town.radius = 180;
      town.ports[0].position = [town.radius, 0];
      plan.roads[0].points = [[town.center[0] + town.radius, 0], [1800, 0]];
      const sample: WorldSettlementSampler = (x, z) => {
        const original = base(x, z), lx = x - town.center[0];
        const water = shore && lx < -125;
        return { ...original, height: water ? -3 : 12 + (shore ? z * 0.02 : 0),
          waterLevel: water ? 0 : null, waterBodyId: water ? 'shore' : null };
      };
      const patch = generateWorldSettlement(plan, town.id, sample, {
        kind: 'city', pattern: 'organic', seed, density: 0.82, waterfrontBias: shore ? 1 : 0, waterSetback: 6
      });
      const shape = settlementShape(patch, town.radius);
      expect(shape.cycles, `seed ${seed}`).toBeGreaterThanOrEqual(shore ? 4 : 5);
      expect(shape.deadEnds, `seed ${seed}`).toBeLessThanOrEqual(9);
      expect(shape.roadExtent, `seed ${seed}`).toBeGreaterThanOrEqual(0.78);
      expect(shape.buildingExtent, `seed ${seed}`).toBeGreaterThanOrEqual(0.65);
      const port = patch.streets.find(street => street.tags.includes('port'))!;
      expect(port.points[0], `seed ${seed}`).toEqual(town.ports[0].position);
      expect(patch.streets.some(street => street !== port && street.points.some(point =>
        Math.hypot(point[0] - port.points.at(-1)![0], point[1] - port.points.at(-1)![1]) < 1e-6)), `seed ${seed}`).toBe(true);
    }
  });

  it('builds coherent street walls from dry urban parcels and leaves block interiors open', () => {
    const plan = fixture(), town = plan.towns[0], seed = 53;
    town.radius = 140;
    town.ports[0].position = [town.radius, 0];
    plan.roads[0].points = [[town.center[0] + town.radius, 0], [1800, 0]];
    const sample: WorldSettlementSampler = (x, z) => {
      const lx = x - town.center[0], water = lx < -100;
      return {
        height: water ? -2 : 15 + lx * 0.025 + z * 0.015,
        moisture: water ? 1 : 0.25,
        temperature: 0.55,
        continentalness: water ? 0 : 0.7,
        weights: { ocean: water ? 1 : 0, grassland: water ? 0 : 1, forest: 0, desert: 0, mountains: 0, snow: 0 },
        waterLevel: water ? 0 : null,
        waterBodyId: water ? 'lake' : null
      };
    };
    const patch = generateWorldSettlement(plan, town.id, sample, {
      kind: 'city', pattern: 'organic', seed, density: 0.82, waterfrontBias: 0,
      maxRoadSlope: 0.12, maxSiteSlope: 0.1, waterSetback: 6
    });
    const rotation = Math.atan2(0.025 * 16, -0.015 * 16);
    const region = Array.from({ length: 16 }, (_, index): Point => {
      const angle = index / 16 * Math.PI * 2;
      return [Math.cos(angle) * town.radius * 0.94, Math.sin(angle) * town.radius * 0.94];
    });
    const layout = createUrbanLayout({
      id: `${town.id}-fabric`, pattern: 'organic', center: [0, 0],
      size: [town.radius * 1.82, town.radius * 1.82], region, rotation: rotation * 180 / Math.PI,
      blockSize: 34, roadWidth: 4.2, arterialWidth: 6.4,
      parcelWidth: 5.8, parcelDepth: 8.5, setback: 1, irregularity: 0.72, seed
    }, { minX: -town.radius, maxX: town.radius, minZ: -town.radius, maxZ: town.radius });
    const streetSegments = segments(patch).filter(segment => segment.width <= 6.4);
    const occupied = patch.buildings.map(building => {
      const parcel = layout.parcels.find(candidate => {
        const forward: Point = [Math.sin(candidate.rotationY), Math.cos(candidate.rotationY)];
        const relative: Point = [building.x - candidate.center[0], building.z - candidate.center[1]];
        const tangent: Point = [forward[1], -forward[0]];
        return Math.abs(relative[0] * tangent[0] + relative[1] * tangent[1]) <= candidate.width / 2 + 1e-5
          && Math.abs(relative[0] * forward[0] + relative[1] * forward[1]) <= candidate.depth / 2 + 1e-5
          && Math.abs(Math.atan2(Math.sin((building.rotation ?? 0) - candidate.rotationY), Math.cos((building.rotation ?? 0) - candidate.rotationY))) < 1e-6;
      });
      expect(parcel, building.id).toBeDefined();
      const parcelForward: Point = [Math.sin(parcel!.rotationY), Math.cos(parcel!.rotationY)];
      const parcelTangent: Point = [parcelForward[1], -parcelForward[0]];
      for (const x of [-building.width / 2, building.width / 2]) for (const z of [-building.depth / 2, building.depth / 2]) {
        const corner: Point = [
          building.x + parcelTangent[0] * x + parcelForward[0] * z,
          building.z + parcelTangent[1] * x + parcelForward[1] * z
        ];
        const relative: Point = [corner[0] - parcel!.center[0], corner[1] - parcel!.center[1]];
        expect(Math.abs(relative[0] * parcelTangent[0] + relative[1] * parcelTangent[1])).toBeLessThanOrEqual(parcel!.width / 2 + 1e-5);
        expect(Math.abs(relative[0] * parcelForward[0] + relative[1] * parcelForward[1])).toBeLessThanOrEqual(parcel!.depth / 2 + 1e-5);
      }
      const entrance: Point = [
        building.x + Math.sin(building.rotation ?? 0) * building.depth / 2,
        building.z + Math.cos(building.rotation ?? 0) * building.depth / 2
      ];
      expect(Math.min(...streetSegments.map(segment => pointDistance(entrance, segment.a, segment.b)))).toBeLessThan(7);
      expect(parcel!.depth - building.depth).toBeGreaterThanOrEqual(parcel!.depth * 0.25);
      const centerAlong = (building.x - parcel!.center[0]) * parcelForward[0] + (building.z - parcel!.center[1]) * parcelForward[1];
      expect(parcel!.depth / 2 + centerAlong - building.depth / 2).toBeGreaterThanOrEqual(0.25);
      expect(sample(town.center[0] + building.x, town.center[1] + building.z).waterLevel).toBeNull();
      return parcel!;
    });
    const occupiedByBlock = new Map<string, number>();
    for (const parcel of occupied) occupiedByBlock.set(parcel.blockId, (occupiedByBlock.get(parcel.blockId) ?? 0) + 1);
    expect(Math.max(...occupiedByBlock.values())).toBeGreaterThanOrEqual(4);
    expect(auditWorldSettlement(patch, town, sample).maxBuildingSlope).toBeLessThanOrEqual(0.1 + 1e-6);
  });

  it('grows a shore-following arterial, stays dry and avoids the old offset-fan foldback', () => {
    const plan = fixture(), sample = sampler(plan, true);
    const patch = generateWorldSettlement(plan, 'town', sample, {
      kind: 'city', pattern: 'organic', seed: 33, density: 0.8, waterfrontBias: 1, waterSetback: 6
    });
    const waterfront = patch.streets.find(street => street.tags.includes('waterfront'));
    expect(waterfront).toBeDefined();
    expect(waterfront!.points.length).toBeGreaterThan(2);
    const span = waterfront!.points.reduce((result, point) => ({
      minX: Math.min(result.minX, point[0]), maxX: Math.max(result.maxX, point[0]),
      minZ: Math.min(result.minZ, point[1]), maxZ: Math.max(result.maxZ, point[1])
    }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
    expect(span.maxZ - span.minZ).toBeGreaterThan(span.maxX - span.minX);
    for (const edge of segments(patch)) {
      const length = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
      for (let step = 0; step <= Math.ceil(length / 4); step++) {
        const t = step / Math.ceil(length / 4), point: Point = [edge.a[0] + (edge.b[0] - edge.a[0]) * t, edge.a[1] + (edge.b[1] - edge.a[1]) * t];
        expect(sample(plan.towns[0].center[0] + point[0], point[1]).waterLevel).toBeNull();
      }
    }
    expectSafeRoadShape(patch);
  });

  it.each(['straight','diagonal'] as const)('connects a deterministic dry sea landing on a %s coast', coast => {
    const plan=fixture(),town=plan.towns[0],base=sampler(plan);
    town.targetWaterBodyId='sea';
    const sample:WorldSettlementSampler=(x,z) => {
      const original=base(x,z),lx=x-town.center[0],lz=z-town.center[1];
      const water=coast==='straight'?lx < -100:lx+lz < -140;
      return {...original,height:water?-3:12,waterLevel:water?0:null,waterBodyId:null};
    };
    const options={kind:'city' as const,pattern:'organic' as const,seed:47,density:.8,waterfrontBias:1,waterSetback:6};
    const patch=generateWorldSettlement(plan,town.id,sample,options);
    expect(generateWorldSettlement(plan,town.id,sample,options)).toEqual(patch);
    const landing=patch.streets.find(street=>street.tags.includes('sea-landing'))!;
    const waterfront=patch.streets.find(street=>street.tags.includes('waterfront')&&!street.tags.includes('sea-landing'))!;
    expect(landing).toBeDefined();
    expect(waterfront.points).toContainEqual(landing.points[0]);
    expect(patch.streets.some(street=>street.tags.includes('waterfront')&&!street.tags.includes('sea-landing'))).toBe(true);
    for(const point of landing.points) expect(sample(town.center[0]+point[0],town.center[1]+point[1]).waterLevel).toBeNull();
    const coastDistance=(point:Point)=>coast==='straight'?point[0]+100:(point[0]+point[1]+140)/Math.sqrt(2);
    expect(Math.min(...waterfront.points.map(coastDistance))).toBeLessThanOrEqual(24);
    expect(waterfront.tags).toContain('working-waterfront');
    expect(coastDistance(landing.points.at(-1)!)).toBeLessThan(coastDistance(landing.points[0]));
    expect(coastDistance(landing.points.at(-1)!)).toBeLessThanOrEqual(20);
    expect(landing.tags).toContain('harbor-quay');
    expect(landing.width).toBeGreaterThanOrEqual(6.4);
    expect(landing.points.slice(1).reduce((length,point,index)=>length+Math.hypot(point[0]-landing.points[index][0],point[1]-landing.points[index][1]),0))
      .toBeGreaterThanOrEqual(Math.max(12,landing.width*2));
    expect(validateTownPatch(plan,patch)).toEqual(patch);
  });

  it('does not create a sea landing without sampled sea water', () => {
    const plan=fixture();
    plan.towns[0].targetWaterBodyId='sea';
    const patch=generateWorldSettlement(plan,'town',sampler(plan),{
      kind:'city',pattern:'organic',seed:47,density:.8,waterfrontBias:1,waterSetback:6
    });
    expect(patch.streets.some(street=>street.tags.includes('sea-landing'))).toBe(false);
  });

  it('reserves a landmark footprint, retains its asset contract and connects its entrance', () => {
    const plan = fixture(), sample = sampler(plan);
    const landmark: TownBuilding = {
      id: 'cathedral', x: -35, z: 45, width: 28, depth: 42, height: 36,
      use: 'cathedral', rotation: Math.PI / 4, assetKey: 'cathedral-modular', enterable: true
    };
    const patch = generateWorldSettlement(plan, 'town', sample, {
      kind: 'city', pattern: 'organic', seed: 71, landmarks: [landmark]
    });
    expect(patch.buildings.find(building => building.id === landmark.id)).toEqual(landmark);
    expect(patch.streets.some(street => street.tags.includes('landmark-access'))).toBe(true);
    for (const building of patch.buildings.filter(building => building.id !== landmark.id)) {
      expect(buildingsOverlap(building, landmark)).toBe(false);
    }
    const access = patch.streets.find(street => street.tags.includes('landmark-access'))!;
    for (const street of patch.streets) for (let index = 1; index < street.points.length; index++) {
      const [a, b] = [street.points[index - 1], street.points[index]];
      expect(street === access
        ? segmentBuildingFootprint(a, b, landmark, street.width / 2)
        : segmentBuildingFootprint(a, b, landmark, street.width / 2 + 1)).toBe(false);
    }
    const direction: Point = [Math.sin(landmark.rotation!), Math.cos(landmark.rotation!)];
    const door: Point = [
      landmark.x + direction[0] * landmark.depth / 2,
      landmark.z + direction[1] * landmark.depth / 2
    ];
    expect(pointDistance(door, access.points[0], access.points[1])).toBeCloseTo(access.width / 2, 5);
    expect(Math.hypot(access.points[0][0] - door[0], access.points[0][1] - door[1])).toBeCloseTo(access.width / 2, 5);
    const networkEnd = access.points.at(-1)!;
    expect(patch.streets.some(street => street !== access && street.points.some(point =>
      Math.hypot(point[0] - networkEnd[0], point[1] - networkEnd[1]) < 1e-6))).toBe(true);

    const penetrating = structuredClone(patch);
    penetrating.streets.find(street => street.id === access.id)!.points[0] = [landmark.x, landmark.z];
    expect(() => validateTownPatch(plan, penetrating)).toThrow('world_building_intersects_street');
  });

  it('places a required public footprint on reachable sampled street frontage', () => {
    const plan = fixture(), sample = sampler(plan);
    const result = createWorldSettlementLandmarkLayout(plan, 'town', sample, {
      kind: 'city', pattern: 'organic', seed: 71, density: 0.78
    }, [{
      id: 'market', use: 'covered public market', width: 12, depth: 10, height: 6,
      assetKey: 'market', enterable: true
    }]);
    expect(result.landmarks).toEqual([expect.objectContaining({
      id: 'market', use: 'covered public market', width: 12, depth: 10, height: 6,
      assetKey: 'market', enterable: true, x: expect.any(Number), z: expect.any(Number), rotation: expect.any(Number)
    })]);
    expect(result.patch.buildings.find(building => building.id === 'market')).toEqual(result.landmarks[0]);
    const access = result.patch.streets.find(street => street.tags.includes('landmark-access'))!;
    expect(access).toBeDefined();
    expect(Math.hypot(access.points[1][0] - access.points[0][0], access.points[1][1] - access.points[0][1]))
      .toBeLessThanOrEqual(5.0001);
    expect(validateTownPatch(plan, result.patch)).toEqual(result.patch);
  });

  it('uses the authored harbor anchor to choose between two accessible coasts', () => {
    const plan = fixture(), town = plan.towns[0], base = sampler(plan);
    town.ports = [];
    town.targetWaterBodyId = 'sea';
    plan.settlementPlan = { settlements: [{ id: town.id, anchorId: 'town-center', role: 'working harbor' }] };
    plan.featureGraph = { regions: [{ id: 'bay', kind: 'coast', name: 'Bay', center: town.center, radius: 200 }],
      paths: [], anchors: [
        { id: 'town-center', kind: 'town-center', position: town.center, regionId: 'bay' },
        { id: 'harbor-anchor', kind: 'working-harbor',
          position: [town.center[0] - 90, town.center[1]], regionId: 'bay' }
      ], relations: [] };
    const sample: WorldSettlementSampler = (x, z) => {
      const original = base(x, z);
      const sea = x - town.center[0] < -110 || z - town.center[1] > 80;
      return { ...original, height: sea ? -3 : 12, waterLevel: sea ? 0 : null, waterBodyId: null };
    };
    const patch = generateWorldSettlement(plan, town.id, sample,
      { kind: 'city', pattern: 'organic', seed: 47, density: 0.8, waterfrontBias: 1, waterSetback: 6 });
    const waterfront = patch.streets.find(street => street.tags.includes('working-waterfront'));
    expect(waterfront).toBeDefined();
    expect(Math.min(...waterfront!.points.map(point => point[0]))).toBeLessThan(-70);
    expect(Math.max(...waterfront!.points.map(point => point[1]))).toBeLessThan(75);
    plan.featureGraph.anchors[1].position = [town.center[0], town.center[1] + 90];
    const southPatch = generateWorldSettlement(plan, town.id, sample,
      { kind: 'city', pattern: 'organic', seed: 47, density: 0.8, waterfrontBias: 1, waterSetback: 6 });
    const southFront = southPatch.streets.find(street => street.tags.includes('working-waterfront'));
    expect(southFront).toBeDefined();
    expect(Math.max(...southFront!.points.map(point => point[1]))).toBeGreaterThan(50);
    expect(Math.min(...southFront!.points.map(point => point[0]))).toBeGreaterThan(-100);
  });

  it('samples a rotated landmark footprint in the same orientation used by placement', () => {
    const plan = fixture(), town = plan.towns[0], base = sampler(plan);
    const rotation = Math.PI / 4;
    const landmark: TownBuilding = {
      id: 'market-hall', x: -35, z: 45, width: 28, depth: 10, height: 8,
      use: 'market hall', rotation
    };
    const sample: WorldSettlementSampler = (x, z) => {
      const original = base(x, z), lx = x - town.center[0], lz = z - town.center[1];
      return {
        ...original,
        height: town.foundation + 0.13 * (lx * Math.sin(rotation) + lz * Math.cos(rotation)),
        waterLevel: null,
        waterBodyId: null
      };
    };

    const patch = generateWorldSettlement(plan, town.id, sample, {
      kind: 'city', pattern: 'organic', seed: 71, landmarks: [landmark]
    });

    expect(patch.buildings.find(building => building.id === landmark.id)).toEqual(landmark);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('uses the rotated landmark footprint when checking planned roads', () => {
    const plan = fixture(), town = plan.towns[0], base = sampler(plan);
    town.ports = [];
    const landmark: TownBuilding = {
      id: 'market-hall', x: -35, z: 45, width: 28, depth: 10, height: 8,
      use: 'market hall', rotation: Math.PI / 4
    };
    const worldBuilding = { ...landmark, x: landmark.x + town.center[0], z: landmark.z + town.center[1] };
    const plannedRoad = road('market-lane', [[-2022, 56], [-2022, 60]], 2);
    plan.roads = [plannedRoad];
    const flat: WorldSettlementSampler = (x, z) => ({
      ...base(x, z), height: town.foundation, waterLevel: null, waterBodyId: null
    });

    expect(segmentBuildingFootprint(plannedRoad.points[0], plannedRoad.points[1], worldBuilding, plannedRoad.width / 2)).toBe(false);
    const patch = generateWorldSettlement(plan, town.id, flat, {
      kind: 'city', pattern: 'organic', seed: 71, landmarks: [landmark]
    });

    expect(patch.buildings.find(building => building.id === landmark.id)).toEqual(landmark);
    expect(validateTownPatch(plan, patch)).toEqual(patch);
  });

  it('distributes public functions between the center, waterfront, gateway and high ground', () => {
    const plan = fixture(), town = plan.towns[0], base = sampler(plan);
    town.radius = 140;
    town.ports[0].position = [town.radius, 0];
    plan.roads[0].points = [[town.center[0] + town.radius, 0], [1800, 0]];
    const sample: WorldSettlementSampler = (x, z) => {
      const original = base(x, z), lx = x - town.center[0], lz = z - town.center[1];
      const water = lx < -100;
      return {
        ...original,
        height: water ? -3 : 12 + lz * 0.025,
        waterLevel: water ? 0 : null,
        waterBodyId: water ? 'western-bay' : null
      };
    };
    const requirements = [
      { id: 'town-hall', use: 'town hall', width: 10, depth: 9, height: 10, assetKey: 'hall', siting: 'central' },
      { id: 'fish-market', use: 'fish market', width: 10, depth: 9, height: 7, assetKey: 'market', siting: 'waterfront' },
      { id: 'gate-inn', use: 'gate inn', width: 10, depth: 9, height: 8, assetKey: 'inn', siting: 'gateway' },
      { id: 'watchtower', use: 'watchtower', width: 9, depth: 9, height: 16, assetKey: 'tower', siting: 'high-ground' }
    ] as const;
    const result = createWorldSettlementLandmarkLayout(plan, town.id, sample, {
      kind: 'city', pattern: 'organic', seed: 71, density: 0.78, waterfrontBias: 1, waterSetback: 6
    }, requirements);
    const byId = new Map(result.landmarks.map(landmark => [landmark.id, landmark]));
    const central = byId.get('town-hall')!, waterfront = byId.get('fish-market')!;
    const gateway = byId.get('gate-inn')!, highGround = byId.get('watchtower')!;
    expect(Math.hypot(central.x, central.z)).toBeLessThan(Math.hypot(gateway.x, gateway.z));
    expect(waterfront.x + 100).toBeLessThan(central.x + 100);
    expect(Math.hypot(gateway.x - town.ports[0].position[0], gateway.z - town.ports[0].position[1]))
      .toBeLessThan(Math.hypot(central.x - town.ports[0].position[0], central.z - town.ports[0].position[1]));
    expect(sample(town.center[0] + highGround.x, town.center[1] + highGround.z).height)
      .toBeGreaterThan(sample(town.center[0] + central.x, town.center[1] + central.z).height);
    expect(new Set(result.landmarks.map(landmark => `${landmark.x},${landmark.z}`)).size).toBe(4);
    expect(result.landmarks.every(landmark => !('siting' in landmark))).toBe(true);
    expect(validateTownPatch(plan, result.patch)).toEqual(result.patch);
  }, 10_000);

  it('reserves a complete civic program before filling the surrounding street blocks', () => {
    const plan=fixture(),town=plan.towns[0],base=sampler(plan);
    town.radius=112;town.ports=[];town.targetWaterBodyId='sea';plan.roads=[];
    const sample:WorldSettlementSampler=(x,z)=>{
      const original=base(x,z),lx=x-town.center[0],lz=z-town.center[1],water=lx < -94;
      return {...original,height:water?-3:14+lz*.008,waterLevel:water?0:null,waterBodyId:null};
    };
    const requirements=[
      {id:'fish-market',use:'fish market',width:12,depth:10,height:6,assetKey:'market',siting:'waterfront'},
      {id:'cargo-storehouse',use:'cargo storehouse',width:13,depth:10,height:7,assetKey:'warehouse',siting:'waterfront'},
      {id:'island-school',use:'island school',width:14,depth:11,height:7,assetKey:'school',siting:'central'},
      {id:'meeting-hall',use:'meeting hall',width:11,depth:9,height:7,assetKey:'hall',siting:'central'},
      {id:'farm-exchange',use:'farm exchange',width:10,depth:8,height:6,assetKey:'exchange',siting:'gateway'}
    ] as const;
    const result=createWorldSettlementLandmarkLayout(plan,town.id,sample,{
      kind:'city',pattern:'organic',seed:6103402,density:.65,waterfrontBias:.8,waterSetback:7
    },requirements);
    expect(result.landmarks.map(building=>building.id)).toEqual(requirements.map(building=>building.id));
    expect(result.patch.buildings.filter(building=>!requirements.some(item=>item.id===building.id)).length)
      .toBeGreaterThanOrEqual(24);
    expect(Math.max(...result.patch.buildings.map(building=>Math.hypot(building.x,building.z)))/town.radius)
      .toBeGreaterThanOrEqual(.8);
    expect(result.patch.streets.some(street=>street.tags.includes('sea-landing'))).toBe(true);
    for(const landmark of result.landmarks) {
      const access=result.patch.streets.find(street=>street.id===`${town.id}-landmark-${landmark.id}`);
      expect(access,landmark.id).toBeDefined();
      expect(access!.points.length,landmark.id).toBeGreaterThanOrEqual(2);
    }
    expect(validateTownPatch(plan,result.patch)).toEqual(result.patch);
  },10_000);

  it('does not invent a waterfront site when the sampled town has no water', () => {
    const plan = fixture();
    const requirements = [{
      id: 'dry-quay', use: 'quay market', width: 10, depth: 9, height: 7,
      assetKey: 'market', siting: 'waterfront'
    }] as const;
    expect(() => createWorldSettlementLandmarkLayout(plan, 'town', sampler(plan), {
      kind: 'city', pattern: 'organic', seed: 71, density: 0.78
    }, requirements)).toThrow('world_settlement_no_waterfront_site:dry-quay');
  });

  it('tries the full feasible landmark set before spending the partial-layout attempt budget on omissions', () => {
    const plan = fixture(), town = plan.towns[0];
    town.center = [0, 0];
    town.radius = 100;
    town.foundation = createWorldSampler(plan.recipe)(0, 0).height;
    town.ports = [];
    plan.roads = [road('crossing-trail', [[-50, 0], [50, 0]], 4)];
    const flat: WorldSettlementSampler = () => ({
      height: town.foundation, waterLevel: null, waterBodyId: null, moisture: 0.3, temperature: 0.5,
      continentalness: 0.8,
      weights: { ocean: 0, grassland: 1, forest: 0, desert: 0, mountains: 0, snow: 0 }
    });
    const civic = ['school', 'health-post', 'market-hall', 'service-house', 'meeting-hall'].map((id, index) => ({
      id, use: id, width: 12 - index * 0.5, depth: 10, height: 6, assetKey: id, siting: 'central' as const
    }));

    const result = createWorldSettlementPartialLandmarkLayout(plan, town.id, flat, {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.45
    }, [
      { id: 'fish-market', use: 'fish market', width: 12, depth: 10, height: 6,
        assetKey: 'fish-market', siting: 'waterfront' },
      ...civic
    ]);

    expect(result.landmarks.map(building => building.id)).toEqual(civic.map(building => building.id));
    expect(result.unrealized).toEqual([{ id: 'fish-market', reason: 'no_waterfront_site' }]);
    expect(result.landmarks.every(building => !segmentBuildingFootprint(
      plan.roads[0].points[0], plan.roads[0].points[1], building, plan.roads[0].width / 2))).toBe(true);
  }, 10_000);

  it('does not call an inland street across unusable ground waterfront frontage', () => {
    const plan = fixture(), town = plan.towns[0], base = sampler(plan);
    town.radius = 100;
    town.ports = [];
    town.targetWaterBodyId = 'sea';
    plan.roads = [];
    const sample: WorldSettlementSampler = (x, z) => {
      const original = base(x, z), localX = x - town.center[0], water = localX < -70;
      return { ...original, height: water ? -3 : localX < 0 ? 12 - localX * 0.5 : 12,
        waterLevel: water ? 0 : null, waterBodyId: null };
    };
    const patch = generateWorldSettlement(plan, town.id, sample, {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.45, waterfrontBias: 0.88
    });
    expect(patch.streets.some(street => street.tags.includes('working-waterfront'))).toBe(false);
    expect(() => createWorldSettlementLandmarkLayout(plan, town.id, sample, {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.45, waterfrontBias: 0.88
    }, [{ id: 'fish-market', use: 'fish market', width: 12, depth: 7, height: 5,
      assetKey: 'market', siting: 'waterfront' }])).toThrow('world_settlement_no_waterfront_site:fish-market');
  });

  it('uses a safe authored local street as real waterfront frontage without filling a shore trail', () => {
    const plan = fixture(), town = plan.towns[0];
    plan.recipe.size = 500;
    plan.generationPolicy = 'raw-first-call';
    town.center = [0, 0];
    town.radius = 50;
    town.blend = 20;
    town.foundation = 12;
    town.ports = [];
    town.targetWaterBodyId = 'sea';
    const street = road('working-lane', [[-20, -35], [-20, 35]], 3);
    street.tags = ['local_street', 'world-route'];
    const trail = road('shore-walk', [[-32, -35], [-32, 35]], 2);
    trail.tags = ['shore_trail', 'world-route'];
    plan.roads = [trail, street];
    const terrain = (cliff: boolean): WorldSettlementSampler => (x, z) => {
      const water = x < -40;
      return { height: water ? -3 : cliff ? 12 : 0.4 + (x + 40) * 0.08,
        waterLevel: water ? 0 : null, waterBodyId: null,
        moisture: water ? 1 : 0.3, temperature: 0.5, continentalness: water ? 0 : 0.8,
        weights: { ocean: water ? 1 : 0, grassland: water ? 0 : 1,
          forest: 0, desert: 0, mountains: 0, snow: 0 } };
    };
    const sample = terrain(false);

    const result = createWorldSettlementLandmarkLayout(plan, town.id, sample, {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.5, waterfrontBias: 0, waterSetback: 5
    }, [{ id: 'fish-market', use: 'fish market', width: 10, depth: 8, height: 5,
      assetKey: 'market', siting: 'waterfront' }]);
    const landmark = result.landmarks[0];
    const access = result.patch.streets.find(item => item.id === `${town.id}-landmark-${landmark.id}`)!;

    expect(result.patch.streets.some(item => item.tags.includes('working-waterfront'))).toBe(false);
    expect(access.points.some(point => Math.abs(point[0] + 20) < 1e-6)).toBe(true);
    expect(Math.abs(landmark.x + 20)).toBeLessThan(Math.abs(landmark.x + 32));
    expect(sample(landmark.x, landmark.z).waterLevel).toBeNull();
    expect(validateTownPatch(plan, result.patch)).toEqual(result.patch);
    expect(() => createWorldSettlementLandmarkLayout(plan, town.id, terrain(true), {
      kind: 'village', pattern: 'organic', seed: 19, density: 0.5, waterfrontBias: 0, waterSetback: 5
    }, [{ id: 'cliff-market', use: 'fish market', width: 10, depth: 8, height: 5,
      assetKey: 'market', siting: 'waterfront' }])).toThrow('world_settlement_no_waterfront_site:cliff-market');
  });

  it('finds real waterfront frontage across the full core of a compact sea town', () => {
    const plan=fixture(),town=plan.towns[0],base=sampler(plan);
    town.radius=100;town.ports[0].position=[100,0];town.targetWaterBodyId='sea';
    plan.roads[0].points=[[town.center[0]+100,0],[1800,0]];
    const sample:WorldSettlementSampler=(x,z) => {
      const original=base(x,z),water=x-town.center[0] < -92;
      return {...original,height:water?-3:12,waterLevel:water?0:null,waterBodyId:null};
    };
    const result=createWorldSettlementLandmarkLayout(plan,town.id,sample,{
      kind:'city',pattern:'organic',seed:47,density:.78,waterfrontBias:.95,waterSetback:6
    },[{id:'fish-market',use:'fish market',width:16,depth:12,height:5,assetKey:'market',siting:'waterfront'}]);
    expect(result.landmarks[0].id).toBe('fish-market');
    const waterfront=result.patch.streets.find(street=>street.tags.includes('waterfront')&&!street.tags.includes('sea-landing'))!;
    const landing=result.patch.streets.find(street=>street.tags.includes('sea-landing'))!;
    expect(Math.min(...waterfront.points.map(point=>point[0]+92))).toBeLessThanOrEqual(24);
    expect(waterfront.tags).toContain('working-waterfront');
    const access=result.patch.streets.find(street=>street.id===`${town.id}-landmark-fish-market`)!;
    expect(waterfront.points).toContainEqual(access.points.at(-1));
    expect(landing.points.at(-1)![0]+92).toBeLessThan(landing.points[0][0]+92);
    expect(landing.points.at(-1)![0]+92).toBeLessThanOrEqual(20);
    expect(landing.tags).toContain('harbor-quay');
    expect(landing.width).toBeGreaterThanOrEqual(6.4);
    expect(Math.max(...result.patch.buildings.map(building=>Math.hypot(building.x,building.z)))/town.radius).toBeGreaterThanOrEqual(.72);
  });

  it('fills a populated compact harbor along its safe connected frontage', () => {
    const plan=fixture(),town=plan.towns[0],base=sampler(plan);
    town.radius=105;town.ports[0].position=[105,0];town.targetWaterBodyId='sea';
    town.population=250;
    plan.roads[0].points=[[town.center[0]+105,0],[1800,0]];
    const sample:WorldSettlementSampler=(x,z) => {
      const original=base(x,z),water=x-town.center[0] < -96;
      return {...original,height:water?-3:12,waterLevel:water?0:null,waterBodyId:null};
    };
    const result=createWorldSettlementLandmarkLayout(plan,town.id,sample,{
      kind:'city',pattern:'organic',seed:59,density:.48,waterfrontBias:.95,waterSetback:5
    },[
      {id:'fish-market',use:'fish market',width:13,depth:10,height:5,assetKey:'market',siting:'waterfront'},
      {id:'school',use:'school',width:11,depth:9,height:5,assetKey:'school',siting:'central'},
      {id:'net-workshop',use:'net workshop',width:10,depth:8,height:5,assetKey:'workshop',siting:'waterfront'}
    ]);
    expect(result.patch.buildings.length).toBeGreaterThanOrEqual(32);
    const ordinary=result.patch.buildings.filter(building=>!result.landmarks.some(landmark=>landmark.id===building.id));
    const homes=result.patch.buildings.filter(building=>building.use==='home');
    expect(homes.length).toBeGreaterThanOrEqual(50);
    expect(homes.length).toBeLessThanOrEqual(60);
    expect(ordinary.length).toBeGreaterThan(homes.length);
    expectStreetFacingBuildings(result.patch);
    delete town.population;
    const unscaled=generateWorldSettlement(plan,town.id,sample,{
      kind:'city',pattern:'organic',seed:59,density:.48,waterfrontBias:.95,waterSetback:5,landmarks:result.landmarks
    });
    expect(result.patch.streets.length).toBeGreaterThan(unscaled.streets.length);
    const xs=homes.map(building=>building.x),zs=homes.map(building=>building.z);
    expect(Math.max(...xs)-Math.min(...xs)).toBeGreaterThanOrEqual(town.radius*.85);
    expect(Math.max(...zs)-Math.min(...zs)).toBeGreaterThanOrEqual(town.radius*.75);
    expect(Math.max(...homes.map(building=>Math.hypot(building.x,building.z)))/town.radius).toBeGreaterThanOrEqual(.7);
    const working=result.patch.streets.find(street=>street.tags.includes('working-waterfront'))!;
    expect(working.width).toBeGreaterThanOrEqual(6.4);
    expect(Math.min(...working.points.map(point=>point[0]+96))-working.width/2).toBeLessThanOrEqual(20);
    const landing=result.patch.streets.find(street=>street.tags.includes('sea-landing'))!;
    expect(landing.tags).toContain('harbor-quay');
    expect(landing.width).toBeGreaterThanOrEqual(6.4);
    expect(landing.points.at(-1)![0]+96).toBeLessThan(landing.points[0][0]+96);
    expect(landing.points.at(-1)![0]+96).toBeLessThanOrEqual(20);
  });

  it.each([
    { terrain: 'flat', seed: 17 },
    { terrain: 'flat', seed: 103 },
    { terrain: 'rising', seed: 59 }
  ])('fills connected residential clusters from the center through outer streets on $terrain terrain (seed $seed)', ({ terrain, seed }) => {
    const plan=fixture(),town=plan.towns[0],base=sampler(plan);
    town.center=[0,0];town.radius=120;town.population=250;town.ports=[];plan.roads=[];
    const sample:WorldSettlementSampler=(x,z)=>{
      const original=base(x,z);
      return {...original,height:terrain==='rising'?12+Math.abs(z)*.02:12,waterLevel:null,waterBodyId:null};
    };
    const patch=generateWorldSettlement(plan,town.id,sample,{
      kind:'city',pattern:'organic',seed,density:.5,maxRoadSlope:.3,maxSiteSlope:.3
    });
    const homes=patch.buildings.filter(building=>building.use==='home'||building.use==='farmhouse');
    const bands=[
      homes.filter(building=>Math.hypot(building.x,building.z)<town.radius*.4),
      homes.filter(building=>Math.hypot(building.x,building.z)>=town.radius*.4
        &&Math.hypot(building.x,building.z)<town.radius*.68),
      homes.filter(building=>Math.hypot(building.x,building.z)>=town.radius*.68)
    ];
    expect(Math.min(...bands.map(band=>band.length))).toBeGreaterThanOrEqual(5);
    expect(bands[2].filter(building=>bands[2].some(other=>other!==building
      &&Math.hypot(building.x-other.x,building.z-other.z)<=24)).length).toBeGreaterThanOrEqual(5);
    expectStreetFacingBuildings(patch);
  });

  it('grows a compact settlement along a planned road after the nearest shoulder cannot carry a street network', () => {
    const plan=fixture(),town=plan.towns[0];
    plan.recipe.size=500;town.center=[0,0];town.radius=50;town.blend=20;town.ports=[];
    plan.generationPolicy='raw-first-call';
    plan.roads=[road('shelf-road',[[-42,24],[42,24]],3)];
    const sample:WorldSettlementSampler=(x,z)=>{
      const water=z<5||z>45||Math.abs(x)>47;
      return {height:water?-3:12+x*.015,waterLevel:water?0:null,waterBodyId:water?'bay':null,
        moisture:water?1:.3,temperature:.55,continentalness:water?0:.7,
        weights:{ocean:water?1:0,grassland:water?0:1,forest:0,desert:0,mountains:0,snow:0}};
    };
    const patch=generateWorldSettlement(plan,town.id,sample,{
      kind:'city',pattern:'organic',seed:29,density:.6,waterfrontBias:0
    });
    expect(patch.streets.length).toBeGreaterThan(1);
    expect(patch.buildings.length).toBeGreaterThanOrEqual(4);
    expect(patch.buildings.some(building=>Math.abs(building.z-24)<12)).toBe(true);
    expect(patch.buildings.every(building=>sample(building.x,building.z).waterLevel===null)).toBe(true);
    expect(validateTownPatch(plan,patch)).toEqual(patch);
  });

  it('bounds public-footprint retries and still fails explicitly when no site can fit', () => {
    const plan = fixture(), sample = sampler(plan);
    expect(() => createWorldSettlementLandmarkLayout(plan, 'town', sample, {
      kind: 'city', pattern: 'organic', seed: 71, density: 0.78
    }, [{
      id: 'oversized-hall', use: 'oversized public hall', width: 380, depth: 380, height: 20,
      assetKey: 'oversized-hall'
    }])).toThrow(/^world_settlement_no_landmark_site:oversized-hall:/);
  }, 5_000);

  it('fails explicitly when no settlement can be built', () => {
    const plan = fixture(), base = sampler(plan);
    const flooded: WorldSettlementSampler = (x, z) => ({ ...base(x, z), height: -4, waterLevel: 0, waterBodyId: 'flood' });
    expect(() => generateWorldSettlement(plan, 'town', flooded, { kind: 'village' })).toThrow('world_settlement_no_buildable_site');
    expect(() => generateWorldSettlement(plan, 'missing', base, { kind: 'village' })).toThrow('world_settlement_unknown_town');
  });
});
