import { describe, expect, it } from 'vitest';
import type { MapGuide } from '../src/shared/mapGuide';
import {
  auditWorldSettlement, generateWorldSettlement, type WorldSettlementSampler
} from '../src/shared/worldSettlement';
import { createWorldSampler, type WorldRecipe, type WorldSample } from '../src/shared/worldTerrain';
import { segmentBox, townBuildingBounds, validateTownPatch, type TownBuilding, type WorldPlan } from '../src/shared/worldPlanning';

type Point = [number, number];

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

describe('world settlement growth', () => {
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

  it.each([
    [100, 7, 50], [150, 19, 100], [200, 31, 140]
  ] as const)('fills compact city blocks across radius %sm and seed %s', (radius, seed, minimumBuildings) => {
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

  it('reserves a landmark footprint, retains its asset contract and connects its entrance', () => {
    const plan = fixture(), sample = sampler(plan);
    const landmark: TownBuilding = {
      id: 'cathedral', x: -35, z: 45, width: 28, depth: 42, height: 36,
      use: 'cathedral', rotation: 0.18, assetKey: 'cathedral-modular', enterable: true
    };
    const patch = generateWorldSettlement(plan, 'town', sample, {
      kind: 'city', pattern: 'organic', seed: 71, landmarks: [landmark]
    });
    expect(patch.buildings.find(building => building.id === landmark.id)).toEqual(landmark);
    expect(patch.streets.some(street => street.tags.includes('landmark-access'))).toBe(true);
    const landmarkBounds = townBuildingBounds(landmark);
    for (const building of patch.buildings.filter(building => building.id !== landmark.id)) {
      const bounds = townBuildingBounds(building);
      expect(Math.abs(bounds.x - landmarkBounds.x) < (bounds.width + landmarkBounds.width) / 2
        && Math.abs(bounds.z - landmarkBounds.z) < (bounds.depth + landmarkBounds.depth) / 2).toBe(false);
    }
    for (const edge of segments(patch)) expect(segmentBox(edge.a, edge.b, landmarkBounds, edge.width / 2)).toBe(false);
    const access = patch.streets.find(street => street.tags.includes('landmark-access'))!;
    expect(Math.min(...access.points.map(point => pointDistance(point, [landmark.x, landmark.z], [landmark.x, landmark.z])))).toBeLessThan(50);
  });

  it('fails explicitly when no settlement can be built', () => {
    const plan = fixture(), base = sampler(plan);
    const flooded: WorldSettlementSampler = (x, z) => ({ ...base(x, z), height: -4, waterLevel: 0, waterBodyId: 'flood' });
    expect(() => generateWorldSettlement(plan, 'town', flooded, { kind: 'village' })).toThrow('world_settlement_no_buildable_site');
    expect(() => generateWorldSettlement(plan, 'missing', base, { kind: 'village' })).toThrow('world_settlement_unknown_town');
  });
});
