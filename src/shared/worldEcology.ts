import { habitatBandSuitability, normalizeHabitatBand, type HabitatBand } from './mapHabitat';
import { createWorldSampler, prepareWorldWaterBodies, preparedWorldFreshWaterDistance, validateWorldRecipe,
  worldRegionWeight, WORLD_BIOMES, WORLD_MIN_SIZE, type WorldBiome, type WorldRecipe, type WorldSample, type WorldTerrainRegion } from './worldTerrain';

export type EcologyKind = 'broadleaf' | 'pine' | 'shrub' | 'rock';
export type EcologyWaterSource = 'fresh' | 'sea' | 'any';
export interface EcologyRule {
  id: string;
  kind: EcologyKind;
  biome: WorldBiome;
  density: number;
  spacing: number;
  maxSlope: number;
  scale: [number, number];
  region?: WorldTerrainRegion;
  regionFeather?: number;
  /** Four-point water distance band: outer min, preferred min/max, outer max. */
  waterDistance?: HabitatBand;
  /** Water measured by waterDistance; omitted keeps the legacy fresh-water behavior. */
  waterSource?: EcologyWaterSource;
}
export interface EcologyInstance {
  id: string;
  ruleId: string;
  kind: EcologyKind;
  x: number;
  y: number;
  z: number;
  rotation: number;
  scale: number;
}
export interface EcologyChunk { x: number; z: number }
export const ECOLOGY_CHUNK_SIZE = 256;

export function validateEcologyRules(input: unknown): EcologyRule[] {
  if (!Array.isArray(input) || input.length > 8) throw new Error('invalid_ecology_rules: at most 8 rules');
  const seen = new Set<string>();
  const rules = input.map((value): EcologyRule => {
    if (!value || typeof value !== 'object') throw new Error('invalid_ecology_rule');
    const rule = value as EcologyRule;
    if (typeof rule.id !== 'string' || !rule.id.trim() || rule.id.length > 64 || seen.has(rule.id)
      || !['broadleaf', 'pine', 'shrub', 'rock'].includes(rule.kind) || !WORLD_BIOMES.includes(rule.biome)
      || !Number.isFinite(rule.density) || rule.density < 0 || rule.density > 1
      || !Number.isFinite(rule.spacing) || rule.spacing < 6 || rule.spacing > 100
      || !Number.isFinite(rule.maxSlope) || rule.maxSlope < 0 || rule.maxSlope > 60
      || !Array.isArray(rule.scale) || rule.scale.length !== 2 || !rule.scale.every(Number.isFinite)
      || rule.scale[0] <= 0 || rule.scale[1] < rule.scale[0] || rule.scale[1] > 8
      || rule.waterSource !== undefined && !['fresh', 'sea', 'any'].includes(rule.waterSource)
      || rule.regionFeather !== undefined && (!Number.isFinite(rule.regionFeather) || rule.regionFeather < 0 || rule.regionFeather > 2000)) throw new Error('invalid_ecology_rule');
    let region: WorldTerrainRegion | undefined;
    if (rule.region !== undefined) {
      if (!rule.region || typeof rule.region !== 'object') throw new Error('invalid_ecology_rule');
      if (rule.region.kind === 'circle' && Array.isArray(rule.region.center) && rule.region.center.length === 2
        && rule.region.center.every(Number.isFinite) && Number.isFinite(rule.region.radius) && rule.region.radius >= 1 && rule.region.radius <= 256000) {
        region = { kind: 'circle', center: [rule.region.center[0], rule.region.center[1]], radius: rule.region.radius };
      } else if (rule.region.kind === 'path' && Array.isArray(rule.region.points) && rule.region.points.length >= 2 && rule.region.points.length <= 64
        && rule.region.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
        && Number.isFinite(rule.region.width) && rule.region.width >= 1 && rule.region.width <= 1000) {
        region = { kind: 'path', points: rule.region.points.map(point => [point[0], point[1]]), width: rule.region.width };
      } else throw new Error('invalid_ecology_rule');
    }
    const waterDistance = normalizeHabitatBand(rule.waterDistance);
    if (rule.waterDistance !== undefined && !waterDistance) throw new Error('invalid_ecology_rule');
    seen.add(rule.id);
    return { id: rule.id, kind: rule.kind, biome: rule.biome, density: rule.density,
      spacing: rule.spacing, maxSlope: rule.maxSlope, scale: [rule.scale[0], rule.scale[1]],
      ...(region ? { region } : {}), ...(rule.regionFeather === undefined ? {} : { regionFeather: rule.regionFeather }),
      ...(waterDistance ? { waterDistance } : {}), ...(rule.waterSource ? { waterSource: rule.waterSource } : {}) };
  });
  return rules.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Fixed 5x5 resident budget; terrain mesh LOD never changes vegetation identities. */
export function selectEcologyChunks(worldSize: number, focusX: number, focusZ: number, distance: number): EcologyChunk[] {
  if (![worldSize, focusX, focusZ, distance].every(Number.isFinite) || worldSize < WORLD_MIN_SIZE || worldSize > 256000
    || distance < 0) throw new Error('invalid_ecology_view');
  if (distance > 3000 || Math.abs(focusX) > worldSize / 2 + 3 * ECOLOGY_CHUNK_SIZE
    || Math.abs(focusZ) > worldSize / 2 + 3 * ECOLOGY_CHUNK_SIZE) return [];
  const x = Math.floor(focusX / ECOLOGY_CHUNK_SIZE), z = Math.floor(focusZ / ECOLOGY_CHUNK_SIZE);
  const chunks: EcologyChunk[] = [];
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const chunk = { x: x + dx, z: z + dz };
    if (chunk.x * ECOLOGY_CHUNK_SIZE < worldSize / 2 && (chunk.x + 1) * ECOLOGY_CHUNK_SIZE > -worldSize / 2
      && chunk.z * ECOLOGY_CHUNK_SIZE < worldSize / 2 && (chunk.z + 1) * ECOLOGY_CHUNK_SIZE > -worldSize / 2) chunks.push(chunk);
  }
  const squaredDistance = (chunk: EcologyChunk) => ((chunk.x + 0.5) * ECOLOGY_CHUNK_SIZE - focusX) ** 2
    + ((chunk.z + 0.5) * ECOLOGY_CHUNK_SIZE - focusZ) ** 2;
  return chunks.sort((a, b) => squaredDistance(a) - squaredDistance(b) || a.x - b.x || a.z - b.z);
}

function ruleSeed(seed: number, id: string): number {
  let value = seed;
  for (let i = 0; i < id.length; i++) value = Math.imul(value ^ id.charCodeAt(i), 16777619);
  return value >>> 0;
}
function random(x: number, z: number, seed: number, channel: number): number {
  let value = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed ^ channel, 69069);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}
const isTree = (kind: EcologyKind) => kind === 'broadleaf' || kind === 'pine';
const isSea = (sample: WorldSample) => sample.waterLevel !== null && sample.waterBodyId === null;
function createSeaWaterDistance(sample: (x: number, z: number) => WorldSample,
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number }): (x: number, z: number) => number {
  const width = bounds.maxX - bounds.minX, depth = bounds.maxZ - bounds.minZ;
  const step = Math.max(4, Math.max(width, depth) / 128);
  const columns = Math.ceil(width / step) + 1, rows = Math.ceil(depth / step) + 1;
  const values = Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    const x = Math.min(bounds.maxX, bounds.minX + column * step);
    const z = Math.min(bounds.maxZ, bounds.minZ + row * step);
    return { x, z, sample: sample(x, z) };
  }));
  const coast: Array<[number, number]> = [];
  const addCrossing = (a: typeof values[number][number], b: typeof values[number][number]) => {
    if (isSea(a.sample) === isSea(b.sample)) return;
    const amount = a.sample.height > 0 && b.sample.height <= 0
      || a.sample.height <= 0 && b.sample.height > 0
      ? Math.max(0, Math.min(1, a.sample.height / (a.sample.height - b.sample.height))) : 0.5;
    coast.push([a.x + (b.x - a.x) * amount, a.z + (b.z - a.z) * amount]);
  };
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    if (column + 1 < columns) addCrossing(values[row][column], values[row][column + 1]);
    if (row + 1 < rows) addCrossing(values[row][column], values[row + 1][column]);
  }
  return (x, z) => coast.reduce((nearest, point) =>
    Math.min(nearest, Math.hypot(x - point[0], z - point[1])), Infinity);
}
interface Candidate {
  id: string;
  x: number;
  z: number;
  priority: number;
  threshold: number;
  rotation: number;
  scale: number;
  eligibility?: { accepted: false } | { accepted: true; height: number };
}

/**
 * Local Matérn-II-like priority thinning on jittered cells, not a maximal Poisson-disk solver.
 * Habitat eligibility is cached before thinning, so an impossible species cannot suppress a
 * viable neighbor. Sea rules share one bounded shoreline sample grid per chunk. Neighbor tests use
 * bounded cells (spacing 6..100), never the whole world.
 */
export function generateEcologyChunk(
  input: WorldRecipe,
  inputRules: EcologyRule[],
  chunk: EcologyChunk,
  options: {
    sample?: (x: number, z: number) => WorldSample;
    exclusion?: (x: number, z: number, radius: number) => boolean;
    density?: (x: number, z: number) => number;
    freshWaterDistance?: (x: number, z: number) => number;
    seaWaterDistance?: (x: number, z: number, maxDistance: number) => number;
  } = {}
): { instances: EcologyInstance[]; candidateCount: number; rejectedCount: number } {
  const recipe = validateWorldRecipe(input), rules = validateEcologyRules(inputRules);
  if (!chunk || !Number.isSafeInteger(chunk.x) || !Number.isSafeInteger(chunk.z)) throw new Error('invalid_ecology_chunk');
  const minX = Math.max(-recipe.size / 2, chunk.x * ECOLOGY_CHUNK_SIZE);
  const minZ = Math.max(-recipe.size / 2, chunk.z * ECOLOGY_CHUNK_SIZE);
  const maxX = Math.min(recipe.size / 2, (chunk.x + 1) * ECOLOGY_CHUNK_SIZE);
  const maxZ = Math.min(recipe.size / 2, (chunk.z + 1) * ECOLOGY_CHUNK_SIZE);
  if (minX >= maxX || minZ >= maxZ || !rules.length) return { instances: [], candidateCount: 0, rejectedCount: 0 };
  const sample = options.sample ?? createWorldSampler(recipe);
  const waterBodies = options.freshWaterDistance ? [] : prepareWorldWaterBodies(recipe);
  const freshWaterDistance = options.freshWaterDistance
    ?? ((x: number, z: number) => preparedWorldFreshWaterDistance(waterBodies, x, z));
  const worldMin = -recipe.size / 2, worldMax = recipe.size / 2;
  const seaRules = rules.filter(rule => rule.waterDistance && rule.waterSource !== undefined
    && rule.waterSource !== 'fresh');
  const seaReach = Math.max(0, ...seaRules.map(rule => rule.waterDistance![3] + rule.spacing));
  const sampledSeaDistance = options.seaWaterDistance || !seaRules.length ? null : createSeaWaterDistance(sample, {
    minX: Math.max(worldMin, minX - seaReach), minZ: Math.max(worldMin, minZ - seaReach),
    maxX: Math.min(worldMax, maxX + seaReach), maxZ: Math.min(worldMax, maxZ + seaReach)
  });
  const distanceToSea = options.seaWaterDistance
    ?? ((x: number, z: number, _maxDistance: number) => sampledSeaDistance!(x, z));
  const contexts = rules.map(rule => {
    const seed = ruleSeed(recipe.seed, rule.id), cache = new Map<string, Candidate>();
    return { rule, at: (ix: number, iz: number): Candidate => {
      const key = ix + ',' + iz;
      let candidate = cache.get(key);
      if (!candidate) {
        candidate = {
          id: 'ecology-v1:' + recipe.seed + ':' + rule.id + ':' + ix + ':' + iz,
          x: (ix + random(ix, iz, seed, 11)) * rule.spacing,
          z: (iz + random(ix, iz, seed, 29)) * rule.spacing,
          priority: random(ix, iz, seed, 47), threshold: random(ix, iz, seed, 71),
          rotation: random(ix, iz, seed, 101) * Math.PI * 2,
          scale: rule.scale[0] + random(ix, iz, seed, 131) * (rule.scale[1] - rule.scale[0])
        };
        cache.set(key, candidate);
      }
      return candidate;
    } };
  });

  function eligibilityOf(context: typeof contexts[number], point: Candidate): NonNullable<Candidate['eligibility']> {
    if (point.eligibility) return point.eligibility;
    const rule = context.rule;
    const reject = (): { accepted: false } => (point.eligibility = { accepted: false });
    if (point.x < worldMin || point.x >= worldMax || point.z < worldMin || point.z >= worldMax
      || point.threshold >= rule.density || options.exclusion?.(point.x, point.z, rule.spacing / 2)) return reject();
    const localDensity = options.density ? options.density(point.x, point.z) : 1;
    if (!Number.isFinite(localDensity)) throw new Error('invalid_ecology_density');
    const density = rule.density * Math.max(0, Math.min(1, localDensity));
    const regionDensity = rule.region ? worldRegionWeight(rule.region, point.x, point.z, rule.regionFeather ?? 0) : 1;
    if (point.threshold >= density * regionDensity) return reject();
    if (rule.waterDistance) {
      const source = rule.waterSource ?? 'fresh';
      const freshDistance = source === 'sea' ? Infinity : freshWaterDistance(point.x, point.z);
      const seaDistance = source === 'fresh' ? Infinity
        : distanceToSea(point.x, point.z, rule.waterDistance[3]);
      if (point.threshold >= density * habitatBandSuitability(
        Math.min(freshDistance, seaDistance), rule.waterDistance
      )) return reject();
    }
    const environment = sample(point.x, point.z);
    const weight = environment.weights[rule.biome];
    if (!Number.isFinite(environment.height) || environment.height < 0 || environment.waterLevel !== null
      || !Number.isFinite(environment.weights.ocean) || environment.weights.ocean >= 0.5
      || !Number.isFinite(weight) || point.threshold >= density * Math.max(0, Math.min(1, weight))) return reject();
    // Same world-space central difference as terrain normals, including across chunk borders.
    const epsilon = 4;
    const dx = (sample(point.x + epsilon, point.z).height - sample(point.x - epsilon, point.z).height) / (2 * epsilon);
    const dz = (sample(point.x, point.z + epsilon).height - sample(point.x, point.z - epsilon).height) / (2 * epsilon);
    const slope = Math.atan(Math.hypot(dx, dz)) * 180 / Math.PI;
    if (!Number.isFinite(slope) || slope > rule.maxSlope) return reject();
    return point.eligibility = { accepted: true, height: environment.height };
  }

  function hasHigherPriorityNeighbor(point: Candidate, rule: EcologyRule): boolean {
    for (const context of contexts) {
      if (rule.id !== context.rule.id && !(isTree(rule.kind) && isTree(context.rule.kind))) continue;
      const spacing = Math.max(rule.spacing, context.rule.spacing), cell = context.rule.spacing;
      for (let z = Math.floor((point.z - spacing) / cell); z <= Math.floor((point.z + spacing) / cell); z++) {
        for (let x = Math.floor((point.x - spacing) / cell); x <= Math.floor((point.x + spacing) / cell); x++) {
          const other = context.at(x, z);
          if (other.id === point.id || other.priority > point.priority
            || (other.priority === point.priority && other.id > point.id)) continue;
          if ((other.x - point.x) ** 2 + (other.z - point.z) ** 2 < spacing ** 2
            && eligibilityOf(context, other).accepted) return true;
        }
      }
    }
    return false;
  }

  const instances: EcologyInstance[] = [];
  let candidateCount = 0;
  for (const context of contexts) {
    const rule = context.rule;
    for (let z = Math.floor(minZ / rule.spacing); z < Math.ceil(maxZ / rule.spacing); z++) {
      for (let x = Math.floor(minX / rule.spacing); x < Math.ceil(maxX / rule.spacing); x++) {
        const point = context.at(x, z);
        if (point.x < minX || point.x >= maxX || point.z < minZ || point.z >= maxZ) continue;
        candidateCount++;
        const eligibility = eligibilityOf(context, point);
        if (!eligibility.accepted || hasHigherPriorityNeighbor(point, rule)) continue;
        instances.push({ id: point.id, ruleId: rule.id, kind: rule.kind, x: point.x, y: eligibility.height, z: point.z,
          rotation: point.rotation, scale: point.scale });
      }
    }
  }
  instances.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { instances, candidateCount, rejectedCount: candidateCount - instances.length };
}
