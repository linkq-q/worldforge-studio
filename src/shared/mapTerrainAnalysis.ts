import { sampleTerrainHeight, type EditableMap } from './map';
import { mapGuidePolyline } from './mapGuide';
import { distanceToWater, isPointInsideWaterBody, waterSurfaceLevelAt } from './mapWater';
import type { VisualZoneRegion } from './visualDirection';
import { createWorldSeaProbeSampler, nearestWorldWater } from './worldEnvironmentEvidence';
import { worldMapSampler, worldMapTerrainContext, type WorldMapState } from './worldMapState';
import { worldFeaturePathPolyline, worldRoadPolyline } from './worldPlanning';
import { sampleWorldSlope, type WorldSampler } from './worldTerrain';

const seaProbes = new WeakMap<WorldMapState, WorldSampler>();

export interface MapEnvironmentSample {
  x: number;
  z: number;
  height: number;
  slope: number;
  /**
   * Worlds use fresh-water boundaries and a 24-ray, 160m coast search over cached 16m terrain interpolation.
   * Coast distance is approximate and may miss sub-grid features; Infinity means no water found within 160m.
   */
  waterDistance: number;
  guideDistance: number;
  /** Signed distance to the requested region boundary: negative inside, positive outside. */
  regionDistance?: number;
  water?: { id: string; inside: boolean; surfaceHeight: number | null; depth: number };
}

export interface MapEnvironmentSampleOptions {
  guideIds?: readonly string[];
  region?: VisualZoneRegion;
  waterId?: string;
}

export function createMapEnvironmentSampler(
  map: EditableMap,
  options: MapEnvironmentSampleOptions = {}
): (x: number, z: number) => MapEnvironmentSample {
  const world = map.world, plan = world?.bundle.plan;
  const guides = [
    ...map.guides.map(guide => ({ ...guide, points: mapGuidePolyline(guide) })),
    ...(plan?.roads ?? []).map(guide => ({ ...guide, points: worldRoadPolyline(guide) })),
    ...(plan?.featureGraph?.paths ?? []).map(path => ({ ...path, points: worldFeaturePathPolyline(path) })),
    ...(world?.bundle.patches ?? []).flatMap(patch => {
      const town = plan!.towns.find(candidate => candidate.id === patch.townId)!;
      return patch.streets.map(street => ({ ...street, points: worldRoadPolyline(street).map(point =>
        [point[0] + town.center[0], point[1] + town.center[1]] as [number, number]) }));
    })
  ];
  const selected = options.guideIds && options.guideIds.length > 0
    ? guides.filter((guide) => options.guideIds!.includes(guide.id))
    : guides;
  const guideSegments = selected.flatMap((guide) => {
    const points = guide.points;
    return points.slice(1).map((end, index) => ({ start: points[index], end, halfWidth: guide.width / 2 }));
  });
  const water = options.waterId === undefined
    ? undefined
    : map.waterBodies.find((candidate) => candidate.id === options.waterId);
  const worldWater = plan?.recipe.waterBodies?.find(candidate => candidate.id === options.waterId);
  const sea = !!world && options.waterId === 'sea';
  if (options.waterId !== undefined && !water && !worldWater && !sea) {
    throw new Error(`unknown_map_environment_water:${options.waterId}`);
  }
  const sampleWorld = world ? worldMapSampler(world) : undefined;
  let seaProbe = world ? seaProbes.get(world) : undefined;
  if (world && !seaProbe) {
    seaProbe = createWorldSeaProbeSampler(sampleWorld!);
    seaProbes.set(world, seaProbe);
  }
  const context = world ? worldMapTerrainContext(world) : undefined;
  const noFreshWater = new Map<string, 'lake' | 'river'>();
  return (x, z) => {
    const surface = sampleWorld?.(x, z);
    const insideWater = water ? isPointInsideWaterBody(water, x, z, map)
      : !!surface && surface.waterLevel !== null && (surface.waterBodyId ?? 'sea') === options.waterId;
    const freshWaterDistance = context?.freshWaterDistance(x, z) ?? Infinity;
    const seaDistance = surface && surface.waterLevel !== null ? 0
      : seaProbe ? nearestWorldWater(seaProbe, [x, z], surface!, noFreshWater)?.distanceMeters ?? Infinity : Infinity;
    return {
      x,
      z,
      height: sampleTerrainHeight(map, x, z),
      slope: terrainSlopeDegrees(map, x, z),
      waterDistance: Math.min(distanceToWater(map, x, z), freshWaterDistance <= 160 ? freshWaterDistance : Infinity, seaDistance),
      guideDistance: distanceToGuideSegments(x, z, guideSegments),
      ...(options.region ? { regionDistance: signedDistanceToRegion(x, z, options.region) } : {}),
      ...(water || worldWater || sea ? { water: {
        id: options.waterId!,
        inside: insideWater,
        surfaceHeight: insideWater ? water ? waterSurfaceLevelAt(water, x, z) : surface!.waterLevel : null,
        depth: water?.depth ?? worldWater?.depth ?? (insideWater ? Math.max(0, surface!.waterLevel! - surface!.height) : 0)
      } } : {})
    };
  };
}

export function sampleMapEnvironment(
  map: EditableMap,
  x: number,
  z: number,
  options: MapEnvironmentSampleOptions = {}
): MapEnvironmentSample {
  return createMapEnvironmentSampler(map, options)(x, z);
}

export function terrainSlopeDegrees(map: EditableMap, x: number, z: number): number {
  if (map.world) return Math.atan(sampleWorldSlope(worldMapSampler(map.world), x, z)) * 180 / Math.PI;
  const stepX = map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1);
  const stepZ = map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1);
  const riseX = (
    sampleTerrainHeight(map, x + stepX, z)
    - sampleTerrainHeight(map, x - stepX, z)
  ) / (2 * stepX);
  const riseZ = (
    sampleTerrainHeight(map, x, z + stepZ)
    - sampleTerrainHeight(map, x, z - stepZ)
  ) / (2 * stepZ);
  return Math.atan(Math.hypot(riseX, riseZ)) * 180 / Math.PI;
}

export function terrainFootprintSlopeDegrees(
  map: EditableMap,
  x: number,
  z: number,
  footprintRadius: number
): number {
  const stepX = map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1);
  const stepZ = map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1);
  const radius = Math.max(0.1, footprintRadius, map.world ? 0 : Math.min(stepX, stepZ) * 0.75);
  const directions = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]
  ] as const;
  const samples = directions.map(([dx, dz]) => ({
    x: x + dx * radius,
    z: z + dz * radius
  }));
  const heights = samples.map((sample) => sampleTerrainHeight(map, sample.x, sample.z));
  const localSlope = Math.max(...samples.map((sample) => terrainSlopeDegrees(map, sample.x, sample.z)));
  const reliefSlope = Math.atan((Math.max(...heights) - Math.min(...heights)) / (2 * radius)) * 180 / Math.PI;
  return Math.max(localSlope, reliefSlope);
}

function distanceToGuideSegments(
  x: number,
  z: number,
  segments: readonly { start: [number, number]; end: [number, number]; halfWidth: number }[]
): number {
  let closest = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    closest = Math.min(closest, Math.max(
      0,
      pointSegmentDistance(x, z, segment.start, segment.end) - segment.halfWidth
    ));
  }
  return closest;
}

function signedDistanceToRegion(x: number, z: number, region: VisualZoneRegion): number {
  if (region.kind === 'circle') return Math.hypot(x - region.x, z - region.z) - region.radius;
  if (region.kind === 'path') {
    let closest = Number.POSITIVE_INFINITY;
    for (let index = 1; index < region.points.length; index += 1) {
      closest = Math.min(closest, pointSegmentDistance(x, z, region.points[index - 1], region.points[index]));
    }
    return closest - region.width / 2;
  }
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < region.points.length; index += 1) {
    closest = Math.min(closest, pointSegmentDistance(
      x,
      z,
      region.points[index],
      region.points[(index + 1) % region.points.length]
    ));
  }
  return pointInsidePolygon(x, z, region.points) ? -closest : closest;
}

function pointSegmentDistance(
  x: number,
  z: number,
  start: readonly [number, number],
  end: readonly [number, number]
): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0.000001) return Math.hypot(x - start[0], z - start[1]);
  const amount = Math.min(1, Math.max(0, ((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared));
  return Math.hypot(x - (start[0] + dx * amount), z - (start[1] + dz * amount));
}

function pointInsidePolygon(x: number, z: number, points: readonly [number, number][]): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const left = points[index];
    const right = points[previous];
    if (((left[1] > z) !== (right[1] > z))
      && x < (right[0] - left[0]) * (z - left[1]) / (right[1] - left[1]) + left[0]) inside = !inside;
  }
  return inside;
}
