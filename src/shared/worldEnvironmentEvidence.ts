import {
  createPlannedWorldSampler,
  validateWorldPlan,
  worldFeaturePathPolyline,
  type FeaturePath,
  type Point,
  type WorldPlan
} from './worldPlanning';
import { dominantBiome, sampleWorldSlope, type WorldBiome } from './worldTerrain';

export interface WorldAnchorEnvironmentSample {
  id: string;
  kind: string;
  regionId: string;
  position: Point;
  groundHeight: number;
  slopeDegrees: number;
  biome: WorldBiome;
  water: { kind: 'sea' | 'lake' | 'river'; id: string | null; surfaceHeight: number; depthMeters: number } | null;
  nearestWater: {
    kind: 'sea' | 'lake' | 'river'; id: string | null; surfaceHeight: number;
    distanceMeters: number; direction: Point;
  } | null;
  access: { routeId: string; pathId: string; distanceMeters: number; declaredConnection: boolean } | null;
}

export interface WorldEnvironmentEvidence {
  version: 1;
  anchors: WorldAnchorEnvironmentSample[];
}

const rounded = (value: number) => Number(value.toFixed(3));
const WATER_SEARCH_RADIUS = 160;
const WATER_SEARCH_STEP = 12;
const WATER_SEARCH_RAYS = 24;
const WATER_DISTANCE_REFINEMENTS = 6;

type WaterSurface = ReturnType<ReturnType<typeof createPlannedWorldSampler>>;
type WaterTypes = Map<string, 'lake' | 'river'>;

function waterReading(surface: WaterSurface, waterTypes: WaterTypes) {
  return surface.waterLevel === null ? null : {
    kind: surface.waterBodyId === null ? 'sea' as const : waterTypes.get(surface.waterBodyId)!,
    id: surface.waterBodyId,
    surfaceHeight: rounded(surface.waterLevel),
    depthMeters: rounded(Math.max(0, surface.waterLevel - surface.height))
  };
}

/** Fixed 24-ray, 160m probe; evidence may report null beyond that bounded context. */
function nearestWater(sample: ReturnType<typeof createPlannedWorldSampler>, point: Point,
  surface: WaterSurface, waterTypes: WaterTypes): WorldAnchorEnvironmentSample['nearestWater'] {
  const here = waterReading(surface, waterTypes);
  if (here) return { kind: here.kind, id: here.id, surfaceHeight: here.surfaceHeight,
    distanceMeters: 0, direction: [0, 0] };
  let previousRing = 0;
  for (let ring = WATER_SEARCH_STEP; previousRing < WATER_SEARCH_RADIUS;
    previousRing = ring, ring = Math.min(ring + WATER_SEARCH_STEP, WATER_SEARCH_RADIUS)) {
    const candidates = [];
    for (let ray = 0; ray < WATER_SEARCH_RAYS; ray++) {
      const angle = ray * Math.PI * 2 / WATER_SEARCH_RAYS;
      const direction: Point = [Math.cos(angle), Math.sin(angle)];
      const wet = sample(point[0] + direction[0] * ring, point[1] + direction[1] * ring);
      if (wet.waterLevel === null) continue;
      let low = previousRing, high = ring;
      for (let refinement = 0; refinement < WATER_DISTANCE_REFINEMENTS; refinement++) {
        const middle = (low + high) / 2;
        const value = sample(point[0] + direction[0] * middle, point[1] + direction[1] * middle);
        if (value.waterLevel === null) low = middle;
        else high = middle;
      }
      const refined = sample(point[0] + direction[0] * high, point[1] + direction[1] * high);
      candidates.push({ distance: high, direction, surface: refined });
    }
    const nearest = candidates.sort((left, right) => left.distance - right.distance)[0];
    if (nearest) {
      const water = waterReading(nearest.surface, waterTypes)!;
      return { kind: water.kind, id: water.id, surfaceHeight: water.surfaceHeight,
        distanceMeters: rounded(nearest.distance),
        direction: nearest.direction.map(rounded) as Point };
    }
  }
  return null;
}

function pointSegmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to[0] - from[0], dz = to[1] - from[1], lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point[0] - from[0]) * dx + (point[1] - from[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - from[0] - dx * amount, point[1] - from[1] - dz * amount);
}

function distanceToPath(point: Point, path: FeaturePath): number {
  const points = worldFeaturePathPolyline(path);
  return Math.max(0, points.slice(1).reduce((closest, to, index) =>
    Math.min(closest, pointSegmentDistance(point, points[index], to)), Infinity) - path.width / 2);
}

/** Compact deterministic scene evidence only; it never scores, rejects, moves, or repairs authored intent. */
export function createWorldEnvironmentEvidence(input: WorldPlan): WorldEnvironmentEvidence {
  const plan = validateWorldPlan(input), sample = createPlannedWorldSampler(plan);
  const graph = plan.featureGraph;
  if (!graph) return { version: 1, anchors: [] };
  const paths = new Map(graph.paths.map(path => [path.id, path]));
  const routes = (plan.mobilityPlan?.routes ?? []).flatMap(route => {
    const path = paths.get(route.pathId);
    return path ? [{ route, path }] : [];
  });
  const waterTypes = new Map((plan.recipe.waterBodies ?? []).map(water => [water.id, water.type]));
  return { version: 1, anchors: graph.anchors.map(anchor => {
    const surface = sample(...anchor.position);
    const candidates = routes.map(({ route, path }) => ({ route, path,
      distance: distanceToPath(anchor.position, path), declared: route.connects.includes(anchor.id) }));
    const accessible = candidates.filter(candidate => candidate.declared);
    const nearest = (accessible.length ? accessible : candidates)
      .sort((left, right) => left.distance - right.distance || left.route.id.localeCompare(right.route.id))[0];
    return {
      id: anchor.id, kind: anchor.kind, regionId: anchor.regionId, position: [...anchor.position],
      groundHeight: rounded(surface.height),
      slopeDegrees: rounded(Math.atan(sampleWorldSlope(sample, ...anchor.position)) * 180 / Math.PI),
      biome: dominantBiome(surface),
      water: waterReading(surface, waterTypes),
      nearestWater: nearestWater(sample, anchor.position, surface, waterTypes),
      access: nearest ? { routeId: nearest.route.id, pathId: nearest.path.id,
        distanceMeters: rounded(nearest.distance), declaredConnection: nearest.declared } : null
    };
  }) };
}
