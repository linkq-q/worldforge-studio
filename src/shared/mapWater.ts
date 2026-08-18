import {
  TERRAIN_MIN_HEIGHT,
  sampleTerrainHeight,
  terrainIndex,
  terrainPointAt,
  type EditableMap,
  type MapWaterBody
} from './map';

/** Bank run in metres per metre of depth. Lower means a steeper basin wall. */
const SHORE_SLOPE = 1.5;
/** Keeps the carved shoreline just under the water plane so the rim has no seam. */
const SHORE_RIM = 0.05;
const MAX_CURVE_POINTS = 128;

export interface RiverPathSample {
  point: [number, number];
  level: number;
}

export function waterBoundaryPoints(water: MapWaterBody): Array<[number, number]> {
  if (water.type === 'river') {
    const edges = riverEdgePairs(riverPathSamples(water), water.width);
    return [
      ...edges.map((edge) => edge.left),
      ...edges.slice().reverse().map((edge) => edge.right)
    ];
  }
  if (water.type === 'ocean' || (water.shorelineSmoothness ?? 0) <= 0) return cleanPoints(water.points);
  const rounds = (water.shorelineSmoothness ?? 0) >= 0.7 ? 2 : 1;
  let points = cleanPoints(water.points);
  for (let round = 0; round < rounds; round += 1) points = chaikinClosed(points);
  points = capPoints(points);
  const irregularity = clamp(water.shorelineIrregularity ?? 0, 0, 0.4);
  if (irregularity <= 0) return points;
  const center = points.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]] as [number, number],
    [0, 0] as [number, number]
  ).map((value) => value / points.length) as [number, number];
  const seed = water.seed ?? 0;
  const phases = [seededUnit(seed, 1), seededUnit(seed, 2), seededUnit(seed, 3)]
    .map((value) => value * Math.PI * 2);
  return points.map(([x, z]) => {
    const dx = x - center[0];
    const dz = z - center[1];
    const angle = Math.atan2(dz, dx);
    const noise = Math.sin(angle * 3 + phases[0]) * 0.56
      + Math.sin(angle * 5 + phases[1]) * 0.3
      + Math.sin(angle * 7 + phases[2]) * 0.14;
    const scale = 1 + irregularity * noise;
    return [center[0] + dx * scale, center[1] + dz * scale];
  });
}

export function riverPathSamples(water: MapWaterBody): RiverPathSample[] {
  const levels = water.levels?.length === water.points.length
    ? water.levels
    : water.points.map(() => water.level);
  let samples = cleanRiverSamples(water.points.map((point, index) => ({ point, level: levels[index] })));
  const smoothness = clamp(water.shorelineSmoothness ?? 0, 0, 1);
  const rounds = smoothness >= 0.7 ? 2 : smoothness > 0 ? 1 : 0;
  for (let round = 0; round < rounds; round += 1) samples = chaikinOpen(samples);
  return capRiverSamples(samples);
}

export function ensureRiverSurfaceLevels(map: EditableMap, water: MapWaterBody): MapWaterBody {
  if (water.type !== 'river' || water.levels?.length === water.points.length) return water;
  const sourceHeight = sampleTerrainHeight(map, water.points[0][0], water.points[0][1]);
  const startLevel = Math.min(map.box.size[1] - SHORE_RIM, Math.max(water.level, sourceHeight - SHORE_RIM));
  return {
    ...water,
    levels: water.points.map((_, index) => {
      const t = index / Math.max(1, water.points.length - 1);
      return startLevel + (water.level - startLevel) * t;
    })
  };
}

/** Upgrades legacy flat water in memory without writing during a read. */
export function prepareStructuredWaterInPlace(map: EditableMap): void {
  const upgradedIds = new Set<string>();
  map.waterBodies = map.waterBodies.map((water) => {
    const needsUpgrade = water.shorelineSmoothness === undefined
      || water.shorelineIrregularity === undefined
      || water.seed === undefined
      || (water.type === 'river' && water.levels?.length !== water.points.length);
    if (!needsUpgrade) return water;
    upgradedIds.add(water.id);
    const upgraded: MapWaterBody = {
      ...water,
      shorelineSmoothness: water.shorelineSmoothness ?? (water.type === 'ocean' ? 0 : 0.82),
      shorelineIrregularity: water.shorelineIrregularity ?? (water.type === 'lake' ? 0.16 : 0),
      seed: water.seed ?? waterSeed(map.seed, water.id)
    };
    return ensureRiverSurfaceLevels(map, upgraded);
  });
  for (const water of map.waterBodies) {
    if (upgradedIds.has(water.id)) carveWaterBasinInPlace(map, water);
  }
}

export function waterSurfaceLevelAt(water: MapWaterBody, x: number, z: number): number {
  if (water.type !== 'river') return water.level;
  return closestRiverPoint(x, z, riverPathSamples(water)).level;
}

/**
 * Sinks a lake basin or river channel into the height field. Idempotent: every
 * grid point is clamped to a ceiling derived from persisted water geometry.
 */
export function carveWaterBasinInPlace(map: EditableMap, water: MapWaterBody): void {
  if (water.type === 'river') {
    carveRiverChannelInPlace(map, water);
    return;
  }
  if (water.type !== 'lake' || water.points.length < 3) return;

  const terrain = map.terrain;
  const [boxWidth, , boxDepth] = map.box.size;
  const top = water.level - SHORE_RIM;
  const bottom = Math.max(TERRAIN_MIN_HEIGHT, water.level - water.depth);
  const shore = Math.max(0.5, water.depth * SHORE_SLOPE);

  const boundary = waterBoundaryPoints(water);
  const xs = boundary.map((point) => point[0]);
  const zs = boundary.map((point) => point[1]);
  const minX = gridFloor(Math.min(...xs), boxWidth, terrain.resolutionX);
  const maxX = gridCeil(Math.max(...xs), boxWidth, terrain.resolutionX);
  const minZ = gridFloor(Math.min(...zs), boxDepth, terrain.resolutionZ);
  const maxZ = gridCeil(Math.max(...zs), boxDepth, terrain.resolutionZ);

  for (let zIndex = minZ; zIndex <= maxZ; zIndex += 1) {
    for (let xIndex = minX; xIndex <= maxX; xIndex += 1) {
      const world = terrainPointAt(map, xIndex, zIndex);
      if (!pointInPolygon(world[0], world[2], boundary)) continue;
      const t = Math.min(1, polygonEdgeDistance(world[0], world[2], boundary) / shore);
      const ceiling = top + (bottom - top) * (t * t * (3 - 2 * t));
      const index = terrainIndex(terrain, xIndex, zIndex);
      terrain.heights[index] = Math.min(terrain.heights[index] ?? 0, ceiling);
    }
  }
}

function carveRiverChannelInPlace(map: EditableMap, input: MapWaterBody): void {
  if (input.points.length < 2) return;
  const water = ensureRiverSurfaceLevels(map, input);
  const samples = riverPathSamples(water);
  const terrain = map.terrain;
  const [boxWidth, , boxDepth] = map.box.size;
  const halfWidth = Math.max(0.15, water.width / 2);
  const bedHalfWidth = halfWidth * 0.5;
  const shore = Math.max(0.5, water.depth * SHORE_SLOPE);
  const reach = halfWidth + shore;
  const xs = samples.map((sample) => sample.point[0]);
  const zs = samples.map((sample) => sample.point[1]);
  const minX = gridFloor(Math.min(...xs) - reach, boxWidth, terrain.resolutionX);
  const maxX = gridCeil(Math.max(...xs) + reach, boxWidth, terrain.resolutionX);
  const minZ = gridFloor(Math.min(...zs) - reach, boxDepth, terrain.resolutionZ);
  const maxZ = gridCeil(Math.max(...zs) + reach, boxDepth, terrain.resolutionZ);

  for (let zIndex = minZ; zIndex <= maxZ; zIndex += 1) {
    for (let xIndex = minX; xIndex <= maxX; xIndex += 1) {
      const world = terrainPointAt(map, xIndex, zIndex);
      const closest = closestRiverPoint(world[0], world[2], samples);
      if (closest.distance > reach) continue;
      const top = closest.level - SHORE_RIM;
      const bottom = Math.max(TERRAIN_MIN_HEIGHT, closest.level - water.depth);
      let ceiling: number;
      if (closest.distance <= bedHalfWidth) {
        ceiling = bottom;
      } else if (closest.distance <= halfWidth) {
        const t = smoothstep((closest.distance - bedHalfWidth) / Math.max(0.01, halfWidth - bedHalfWidth));
        ceiling = bottom + (top - bottom) * t;
      } else {
        const t = smoothstep((closest.distance - halfWidth) / shore);
        ceiling = top + water.depth * t;
      }
      const index = terrainIndex(terrain, xIndex, zIndex);
      terrain.heights[index] = Math.min(terrain.heights[index] ?? 0, ceiling);
    }
  }
}

export function isNearWater(map: EditableMap, x: number, z: number, padding: number): boolean {
  return map.waterBodies.some((water) => {
    if (water.type === 'ocean') {
      return sampleTerrainHeight(map, x, z) <= water.level + Math.max(0, padding);
    }
    if (water.type === 'river') {
      const safeDistance = Math.max(0, water.width / 2 + padding);
      const samples = riverPathSamples(water);
      return samples.slice(1).some((sample, index) =>
        distanceToSegment(x, z, samples[index].point, sample.point) <= safeDistance
      );
    }
    const boundary = waterBoundaryPoints(water);
    if (pointInPolygon(x, z, boundary)) return true;
    return polygonEdgeDistance(x, z, boundary) <= padding;
  });
}

export function distanceToWater(map: EditableMap, x: number, z: number): number {
  let closest = Number.POSITIVE_INFINITY;
  for (const water of map.waterBodies) {
    if (water.type === 'ocean') {
      if (sampleTerrainHeight(map, x, z) <= water.level) return 0;
      continue;
    }
    if (water.type === 'river') {
      const samples = riverPathSamples(water);
      for (let index = 1; index < samples.length; index += 1) {
        closest = Math.min(
          closest,
          Math.max(0, distanceToSegment(x, z, samples[index - 1].point, samples[index].point) - water.width / 2)
        );
      }
      continue;
    }
    const boundary = waterBoundaryPoints(water);
    if (pointInPolygon(x, z, boundary)) return 0;
    closest = Math.min(closest, polygonEdgeDistance(x, z, boundary));
  }
  return closest;
}

export function isPointInsideWaterBody(water: MapWaterBody, x: number, z: number, map?: EditableMap): boolean {
  if (water.type === 'ocean') return map ? sampleTerrainHeight(map, x, z) <= water.level + 0.02 : false;
  if (water.type === 'river') {
    const samples = riverPathSamples(water);
    return samples.slice(1).some((sample, index) =>
      distanceToSegment(x, z, samples[index].point, sample.point) <= water.width / 2
    );
  }
  return pointInPolygon(x, z, waterBoundaryPoints(water));
}

function riverEdgePairs(samples: readonly RiverPathSample[], width: number): Array<{
  left: [number, number];
  right: [number, number];
}> {
  const halfWidth = width / 2;
  return samples.map((sample, index) => {
    const previous = samples[Math.max(0, index - 1)].point;
    const next = samples[Math.min(samples.length - 1, index + 1)].point;
    const dx = next[0] - previous[0];
    const dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const offsetX = -dz / length * halfWidth;
    const offsetZ = dx / length * halfWidth;
    return {
      left: [sample.point[0] + offsetX, sample.point[1] + offsetZ],
      right: [sample.point[0] - offsetX, sample.point[1] - offsetZ]
    };
  });
}

function closestRiverPoint(
  x: number,
  z: number,
  samples: readonly RiverPathSample[]
): { distance: number; level: number } {
  let closest = { distance: Number.POSITIVE_INFINITY, level: samples[0]?.level ?? 0 };
  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1];
    const end = samples[index];
    const dx = end.point[0] - start.point[0];
    const dz = end.point[1] - start.point[1];
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared <= 0.000001
      ? 0
      : clamp(((x - start.point[0]) * dx + (z - start.point[1]) * dz) / lengthSquared, 0, 1);
    const distance = Math.hypot(
      x - (start.point[0] + dx * t),
      z - (start.point[1] + dz * t)
    );
    if (distance < closest.distance) {
      closest = { distance, level: start.level + (end.level - start.level) * t };
    }
  }
  return closest;
}

function chaikinClosed(points: readonly [number, number][]): Array<[number, number]> {
  return points.flatMap((point, index): Array<[number, number]> => {
    const next = points[(index + 1) % points.length];
    return [mixPoint(point, next, 0.25), mixPoint(point, next, 0.75)];
  });
}

function chaikinOpen(samples: readonly RiverPathSample[]): RiverPathSample[] {
  const result: RiverPathSample[] = [{ point: [...samples[0].point], level: samples[0].level }];
  for (let index = 0; index < samples.length - 1; index += 1) {
    result.push(mixRiverSample(samples[index], samples[index + 1], 0.25));
    result.push(mixRiverSample(samples[index], samples[index + 1], 0.75));
  }
  result.push({ point: [...samples.at(-1)!.point], level: samples.at(-1)!.level });
  return result;
}

function mixRiverSample(start: RiverPathSample, end: RiverPathSample, t: number): RiverPathSample {
  return {
    point: mixPoint(start.point, end.point, t),
    level: start.level + (end.level - start.level) * t
  };
}

function mixPoint(start: readonly [number, number], end: readonly [number, number], t: number): [number, number] {
  return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
}

function cleanPoints(points: readonly [number, number][]): Array<[number, number]> {
  return points
    .filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1])
    .map((point) => [...point]);
}

function cleanRiverSamples(samples: readonly RiverPathSample[]): RiverPathSample[] {
  return samples
    .filter((sample, index) => index === 0
      || sample.point[0] !== samples[index - 1].point[0]
      || sample.point[1] !== samples[index - 1].point[1])
    .map((sample) => ({ point: [...sample.point], level: sample.level }));
}

function capPoints(points: readonly [number, number][]): Array<[number, number]> {
  if (points.length <= MAX_CURVE_POINTS) return points.map((point) => [...point]);
  return Array.from({ length: MAX_CURVE_POINTS }, (_, index) => (
    [...points[Math.floor(index * points.length / MAX_CURVE_POINTS)]]
  ));
}

function capRiverSamples(samples: readonly RiverPathSample[]): RiverPathSample[] {
  if (samples.length <= MAX_CURVE_POINTS) return samples.map((sample) => ({ point: [...sample.point], level: sample.level }));
  return Array.from({ length: MAX_CURVE_POINTS }, (_, index) => {
    const source = samples[Math.round(index * (samples.length - 1) / (MAX_CURVE_POINTS - 1))];
    return { point: [...source.point], level: source.level };
  });
}

function seededUnit(seed: number, salt: number): number {
  let value = (Math.trunc(seed) ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967295;
}

function waterSeed(seed: number, id: string): number {
  let hash = Math.trunc(seed) >>> 0;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function polygonEdgeDistance(x: number, z: number, points: Array<[number, number]>): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    closest = Math.min(
      closest,
      distanceToSegment(x, z, points[index], points[(index + 1) % points.length])
    );
  }
  return closest;
}

function pointInPolygon(x: number, z: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [xi, zi] = points[index];
    const [xj, zj] = points[previous];
    if ((zi > z) !== (zj > z)
      && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(
  x: number,
  z: number,
  start: [number, number],
  end: [number, number]
): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0.000001) return Math.hypot(x - start[0], z - start[1]);
  const t = Math.min(1, Math.max(0, ((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared));
  return Math.hypot(x - (start[0] + t * dx), z - (start[1] + t * dz));
}

function gridFloor(world: number, extent: number, resolution: number): number {
  return Math.max(0, Math.floor(((world + extent / 2) / extent) * (resolution - 1)));
}

function gridCeil(world: number, extent: number, resolution: number): number {
  return Math.min(resolution - 1, Math.ceil(((world + extent / 2) / extent) * (resolution - 1)));
}
