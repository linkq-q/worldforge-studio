import { describe, expect, it } from 'vitest';
import type { MapGuide } from '../src/shared/mapGuide';
import {
  auditWorldSettlement, createWorldSettlementLandmarkLayout, generateWorldSettlement, type WorldSettlementSampler
} from '../src/shared/worldSettlement';
import { createUrbanLayout } from '../src/shared/mapUrbanLayout';
import { createWorldSampler, type WorldRecipe, type WorldSample } from '../src/shared/worldTerrain';
import { buildingsOverlap, segmentBuildingFootprint, validateTownPatch, type TownBuilding, type WorldPlan } from '../src/shared/worldPlanning';

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
      .toBeLessThanOrEqual(12.0001);
    expect(validateTownPatch(plan, result.patch)).toEqual(result.patch);
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
