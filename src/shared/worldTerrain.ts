/**
 * Experimental continuous world sampler. Metres, Y up, sea level 0, north = -Z.
 * No editor state, rendering style, network or mutable RNG enters this recipe.
 */
import { waterShoreProfile } from './waterShore';
import {
  riverEdgePairs,
  riverPathSamples,
  sampleRiverProfile,
  waterBoundaryContainsPoint,
  waterBoundaryDistance,
  waterBoundaryPoints,
  waterSeed,
  type RiverPathSample
} from './mapWater';
import type { MapWaterBody } from './map';
export const WORLD_MIN_SIZE = 500;
export const WORLD_BIOMES = ['ocean', 'grassland', 'forest', 'desert', 'mountains', 'snow'] as const;
export type WorldBiome = typeof WORLD_BIOMES[number];
export const WORLD_REGIONS = {
  west: [-0.8, 0], east: [0.8, 0], north: [0, -0.8], south: [0, 0.8],
  northwest: [-0.65, -0.65], northeast: [0.65, -0.65],
  southwest: [-0.65, 0.65], southeast: [0.65, 0.65], center: [0, 0]
} as const;
export type WorldRegion = keyof typeof WORLD_REGIONS;
export interface WorldConstraint { region: WorldRegion; biome: WorldBiome }
export type WorldTerrainRegion =
  | { kind: 'circle'; center: [number, number]; radius: number }
  | { kind: 'path'; points: Array<[number, number]>; width: number };
type WorldTerrainBrushBase = { id: string; region: WorldTerrainRegion; feather?: number };
export type WorldTerrainBrush =
  | (WorldTerrainBrushBase & { mode: 'raise'; amount: number })
  | (WorldTerrainBrushBase & { mode: 'lower'; amount: number })
  | (WorldTerrainBrushBase & { mode: 'crater'; region: Extract<WorldTerrainRegion, { kind: 'circle' }>; depth: number; rimHeight: number })
  | (WorldTerrainBrushBase & { mode: 'flatten'; height: number; strength?: number })
  | (WorldTerrainBrushBase & { mode: 'grade'; region: Extract<WorldTerrainRegion, { kind: 'path' }>; heights: number[]; strength?: number });
interface WorldWaterBodyBase {
  id: string;
  region: WorldTerrainRegion;
  /** Optional river width at each control point; omitted keeps region.width throughout. */
  widths?: number[];
  depth: number;
  shorelineSmoothness?: number;
  shorelineIrregularity?: number;
  shorelineProfile?: 'steep' | 'gentle';
  seed?: number;
}
export type WorldWaterBody =
  | (WorldWaterBodyBase & {
      type: 'lake'; levels: number[]; surfaceMode?: never; waterfallAfterPointIndices?: never;
    })
  | (WorldWaterBodyBase & {
      type: 'river'; surfaceMode?: 'authored'; levels: number[]; waterfallAfterPointIndices?: never;
    })
  | (WorldWaterBodyBase & {
      /** region.path points are ordered upstream to downstream; the shared terrain tool owns surface levels. */
      type: 'river'; surfaceMode: 'terrain-fit'; levels?: never; waterfallAfterPointIndices?: number[];
    });
export interface WorldBiomePatch {
  id: string;
  region: WorldTerrainRegion;
  biome: WorldBiome;
  feather?: number;
}
export interface WorldRecipe {
  version: 1;
  seed: number;
  size: number;
  reliefProfile?: 'legacy' | 'compact';
  heightScale?: number;
  constraints: WorldConstraint[];
  landforms?: Array<{ center: [number, number]; radius: [number, number]; height: number }>;
  terrainBrushes?: WorldTerrainBrush[];
  waterBodies?: WorldWaterBody[];
  biomePatches?: WorldBiomePatch[];
}
export interface WorldSample {
  height: number;
  temperature: number;
  moisture: number;
  continentalness: number;
  weights: Record<WorldBiome, number>;
  /** Fresh-water footprint and bank influence, kept separate from the salt-ocean biome. */
  freshWaterWeight?: number;
  waterLevel: number | null;
  waterBodyId: string | null;
}
export type WorldSampler = (x: number, z: number) => WorldSample;
export interface WorldTile { x: number; z: number; size: number }
export interface WorldTileData {
  heights: Float32Array;
  normals: Float32Array;
  weights: Float32Array;
  freshWaterWeights: Float32Array;
  waterLevels: Float32Array;
  resolution: number;
}
export interface PreparedWorldWaterBody {
  source: WorldWaterBody;
  mapWater: MapWaterBody;
  boundary: Array<[number, number]>;
  riverSamples: RiverPathSample[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}
export interface WorldTerrainContext {
  sample: WorldSampler;
  waterBodies: PreparedWorldWaterBody[];
  freshWaterDistance: (x: number, z: number) => number;
  diagnostics: WorldTerrainPreparationDiagnostic[];
}
export interface WorldRiverProfileInfeasibleDiagnostic {
  code: 'river_profile_infeasible';
  waterBodyId: string;
  reason: 'outlet_above_bank' | 'excessive_cut';
  position: [number, number];
  fallback: 'detached-low-water' | 'truncated-before-drop' | 'omitted';
  message: string;
}
export interface WorldRiverMouthClippedDiagnostic {
  code: 'river_mouth_clipped';
  waterBodyId: string;
  reason: 'offshore_land_after_mouth';
  position: [number, number];
  fallback: 'clipped-at-first-ocean';
  authoredLength: number;
  retainedLength: number;
  retainedRatio: number;
  message: string;
}
export type WorldTerrainPreparationDiagnostic =
  | WorldRiverProfileInfeasibleDiagnostic
  | WorldRiverMouthClippedDiagnostic;
export interface WorldRiverSurfaceAboveBankDiagnostic {
  code: 'river_surface_above_bank';
  message: string;
  waterBodyId: string;
  affectedSampleCount: number;
  sampleCount: number;
  maxHoverHeight: number;
  position: [number, number];
}
export const WORLD_TERRAIN_FIT_RIVER_MAX_GRADE = 0.08;
export const WORLD_TERRAIN_FIT_RIVER_MAX_EXTRA_CUT = 4;
const WORLD_TERRAIN_FIT_RIVER_BANK_CLEARANCE = 0.05;

const regionWords: Record<WorldRegion, string> = {
  northwest: '西北|northwest', northeast: '东北|northeast',
  southwest: '西南|southwest', southeast: '东南|southeast',
  west: '西|west', east: '东|east', north: '北|north', south: '南|south',
  center: '中央|中心|中部|中间|center|centre'
};
const biomeWords: Record<WorldBiome, string> = {
  ocean: '海洋|大海|海域|海|ocean|sea',
  grassland: '草原|草地|平原|grassland|plains?',
  forest: '森林|树林|雨林|forest',
  desert: '沙漠|荒漠|沙丘|desert',
  mountains: '山脉|山地|高山|群山|mountains?',
  snow: '雪山|雪原|雪地|冰原|snow'
};
export const REGION_LABELS: Record<WorldRegion, string> = {
  west: '西方', east: '东方', north: '北方', south: '南方', center: '中央',
  northwest: '西北', northeast: '东北', southwest: '西南', southeast: '东南'
};
export const BIOME_LABELS: Record<WorldBiome, string> = {
  ocean: '海洋', grassland: '草原', forest: '森林', desert: '沙漠', mountains: '山脉', snow: '雪地'
};

/** Deliberately bounded grammar: refuse omitted/contradictory semantics, never pretend to be an LLM. */
export function parseWorldPrompt(prompt: string, seed = 42, size = 64000): WorldRecipe {
  if (typeof prompt !== 'string' || prompt.length > 500) throw new Error('描述须为 500 字以内的文本。');
  const regionPattern = Object.values(regionWords).join('|');
  const direction = new RegExp(regionPattern, 'giu');
  const matches = [...prompt.matchAll(direction)];
  if (!matches.length) throw new Error('请给出方位与群落，例如：西方是海洋，东方是沙漠。');
  const prefix = prompt.slice(0, matches[0].index).replace(/我|希望|想要|想|一个|生成|地图|请|为|在|的|地形|世界|I|want|would|like|a|world|with|please|generate|\s|[，,。.!！:：]/giu, '');
  if (prefix) throw new Error('无法理解开头描述：' + prefix);
  const constraints: WorldConstraint[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const region = (Object.keys(regionWords) as WorldRegion[]).find(key => new RegExp('^(?:' + regionWords[key] + ')$', 'iu').test(match[0]))!;
    const phrase = prompt.slice(match.index! + match[0].length, matches[i + 1]?.index ?? prompt.length);
    const found = (Object.keys(biomeWords) as WorldBiome[]).filter(key => new RegExp(biomeWords[key], 'iu').test(phrase));
    if (found.length !== 1) throw new Error(REGION_LABELS[region] + '需要一个明确群落；支持海洋、森林、草原、沙漠、山脉、雪地。');
    const residue = phrase.replace(new RegExp(biomeWords[found[0]], 'giu'), '')
      .replace(/方|边|部|面|侧|区域|地区|一片|一带|是|为|有|要|以|主|则|的|和|与|以及|然后|希望|我|到|is|are|has|the|and|with|\s|[，,。.!！:：;；、]/giu, '');
    if (residue) throw new Error('暂不支持这部分描述：' + residue + '。请用“方位＋群落”。');
    const existing = constraints.find(item => item.region === region);
    if (existing && existing.biome !== found[0]) throw new Error(REGION_LABELS[region] + '存在冲突，请只指定一个群落。');
    if (!existing) constraints.push({ region, biome: found[0] });
  }
  return validateWorldRecipe({ version: 1, seed, size, reliefProfile: 'compact', constraints });
}

export function validateWorldRecipe(input: WorldRecipe): WorldRecipe {
  if (!input || input.version !== 1 || !Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff
    || !Number.isFinite(input.size) || input.size < WORLD_MIN_SIZE || input.size > 256000
    || !Array.isArray(input.constraints) || input.constraints.length < 1 || input.constraints.length > 9) {
    throw new Error('无效世界配方：尺寸为 500 m–256 km，种子为 0–4294967295 整数。');
  }
  const seen = new Set<WorldRegion>();
  for (const item of input.constraints) {
    if (!item || !Object.hasOwn(WORLD_REGIONS, item.region) || !WORLD_BIOMES.includes(item.biome) || seen.has(item.region)) {
      throw new Error('无效或重复的方位约束。');
    }
    seen.add(item.region);
  }
  const recipe: WorldRecipe = { version: 1, seed: input.seed, size: input.size, constraints: input.constraints.map(item => ({ ...item })) };
  if (input.reliefProfile !== undefined) {
    if (input.reliefProfile !== 'legacy' && input.reliefProfile !== 'compact') throw new Error('invalid_world_relief_profile');
    recipe.reliefProfile = input.reliefProfile;
  }
  if (input.heightScale !== undefined) {
    if (!Number.isFinite(input.heightScale) || input.heightScale < 0.02 || input.heightScale > 4) throw new Error('invalid_world_height_scale');
    recipe.heightScale = input.heightScale;
  }
  if (input.landforms !== undefined) {
    if (!Array.isArray(input.landforms) || input.landforms.length > 16) throw new Error('invalid_world_landform');
    recipe.landforms = input.landforms.map(form => {
      if (!form || !Array.isArray(form.center) || form.center.length !== 2 || !Array.isArray(form.radius) || form.radius.length !== 2
        || !form.center.every(n => Number.isFinite(n) && Math.abs(n) <= input.size / 2)
        || !form.radius.every(n => Number.isFinite(n) && n >= 10 && n <= input.size)
        || !Number.isFinite(form.height) || Math.abs(form.height) > 500) throw new Error('invalid_world_landform');
      return { center: [...form.center], radius: [...form.radius], height: form.height };
    });
  }
  const ids = new Set<string>();
  const safeId = (value: unknown) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value) || ids.has(value)) throw new Error('invalid_world_terrain_id');
    ids.add(value);
    return value;
  };
  const point = (value: unknown): [number, number] => {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(n => Number.isFinite(n) && Math.abs(n) <= input.size / 2)) {
      throw new Error('invalid_world_terrain_region');
    }
    return [value[0], value[1]];
  };
  const region = (value: unknown): WorldTerrainRegion => {
    if (!value || typeof value !== 'object') throw new Error('invalid_world_terrain_region');
    const raw = value as Partial<WorldTerrainRegion>;
    if (raw.kind === 'circle') {
      if (!Number.isFinite(raw.radius) || raw.radius! < 1 || raw.radius! > input.size) throw new Error('invalid_world_terrain_region');
      return { kind: 'circle', center: point(raw.center), radius: raw.radius! };
    }
    if (raw.kind === 'path' && Array.isArray(raw.points) && raw.points.length >= 2 && raw.points.length <= 64
      && Number.isFinite(raw.width) && raw.width! >= 1 && raw.width! <= 1000) {
      return { kind: 'path', points: raw.points.map(point), width: raw.width! };
    }
    throw new Error('invalid_world_terrain_region');
  };
  if (input.terrainBrushes !== undefined) {
    if (!Array.isArray(input.terrainBrushes) || input.terrainBrushes.length > 32) throw new Error('invalid_world_terrain_brush');
    recipe.terrainBrushes = input.terrainBrushes.map(value => {
      if (!value || typeof value !== 'object') throw new Error('invalid_world_terrain_brush');
      const raw = value as WorldTerrainBrush;
      const common = { id: safeId(raw.id), region: region(raw.region), feather: raw.feather };
      if (common.feather !== undefined && (!Number.isFinite(common.feather) || common.feather < 0 || common.feather > 2000)) throw new Error('invalid_world_terrain_brush');
      if (raw.mode === 'raise' || raw.mode === 'lower') {
        if (!Number.isFinite(raw.amount) || raw.amount <= 0 || raw.amount > 1000) throw new Error('invalid_world_terrain_brush');
        return { ...common, mode: raw.mode, amount: raw.amount };
      }
      if (raw.mode === 'crater' && common.region.kind === 'circle') {
        if (!Number.isFinite(raw.depth) || raw.depth <= 0 || raw.depth > 1000
          || !Number.isFinite(raw.rimHeight) || raw.rimHeight <= 0 || raw.rimHeight > 1000) throw new Error('invalid_world_terrain_brush');
        return { ...common, mode: raw.mode, region: common.region, depth: raw.depth, rimHeight: raw.rimHeight };
      }
      if (raw.mode === 'flatten') {
        if (!Number.isFinite(raw.height) || raw.height < -1000 || raw.height > 5000
          || raw.strength !== undefined && (!Number.isFinite(raw.strength) || raw.strength < 0 || raw.strength > 1)) throw new Error('invalid_world_terrain_brush');
        return { ...common, mode: raw.mode, height: raw.height, strength: raw.strength };
      }
      if (raw.mode === 'grade' && common.region.kind === 'path' && Array.isArray(raw.heights)
        && raw.heights.length === common.region.points.length && raw.heights.every(n => Number.isFinite(n) && n >= -1000 && n <= 5000)
        && (raw.strength === undefined || Number.isFinite(raw.strength) && raw.strength >= 0 && raw.strength <= 1)) {
        return { ...common, mode: raw.mode, region: common.region, heights: [...raw.heights], strength: raw.strength };
      }
      throw new Error('invalid_world_terrain_brush');
    });
  }
  if (input.waterBodies !== undefined) {
    if (!Array.isArray(input.waterBodies) || input.waterBodies.length > 32) throw new Error('invalid_world_water_body');
    recipe.waterBodies = input.waterBodies.map(value => {
      if (!value || typeof value !== 'object') throw new Error('invalid_world_water_body');
      const raw = value as WorldWaterBody, shape = region(raw.region);
      const levelCount = shape.kind === 'circle' ? 1 : shape.points.length;
      const terrainFit = raw.type === 'river' && raw.surfaceMode === 'terrain-fit';
      if (raw.type === 'river' && raw.surfaceMode !== undefined
        && raw.surfaceMode !== 'authored' && raw.surfaceMode !== 'terrain-fit'
        || raw.type === 'lake' && raw.surfaceMode !== undefined
        || terrainFit && raw.levels !== undefined
        || raw.type === 'river' && raw.surfaceMode !== 'terrain-fit' && !Array.isArray(raw.levels)) {
        throw new Error('invalid_world_river_surface_mode');
      }
      if (raw.waterfallAfterPointIndices !== undefined && (!terrainFit || shape.kind !== 'path'
        || !Array.isArray(raw.waterfallAfterPointIndices) || raw.waterfallAfterPointIndices.length > 16
        || raw.waterfallAfterPointIndices.some(index => !Number.isInteger(index) || index < 0 || index >= shape.points.length - 1)
        || new Set(raw.waterfallAfterPointIndices).size !== raw.waterfallAfterPointIndices.length)) {
        throw new Error('invalid_world_waterfall_segment');
      }
      if ((raw.type !== 'lake' && raw.type !== 'river')
        || !terrainFit && (!Array.isArray(raw.levels) || raw.levels.length !== levelCount
          || !raw.levels.every(n => Number.isFinite(n) && n >= -1000 && n <= 5000))
        || raw.widths !== undefined && (raw.type !== 'river' || !Array.isArray(raw.widths)
          || raw.widths.length !== levelCount || !raw.widths.every(n => Number.isFinite(n) && n >= 1 && n <= 1000))
        || !Number.isFinite(raw.depth) || raw.depth < 0.1 || raw.depth > 500
        || raw.type === 'lake' && shape.kind !== 'circle' || raw.type === 'river' && shape.kind !== 'path'
        || raw.shorelineSmoothness !== undefined && (!Number.isFinite(raw.shorelineSmoothness) || raw.shorelineSmoothness < 0 || raw.shorelineSmoothness > 1)
        || raw.shorelineIrregularity !== undefined && (!Number.isFinite(raw.shorelineIrregularity) || raw.shorelineIrregularity < 0 || raw.shorelineIrregularity > 0.6)
        || raw.shorelineProfile !== undefined && raw.shorelineProfile !== 'steep' && raw.shorelineProfile !== 'gentle'
        || raw.seed !== undefined && (!Number.isInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffffffff)) throw new Error('invalid_world_water_body');
      const id = safeId(raw.id);
      const common = {
        id, region: shape,
        ...(raw.widths ? { widths: [...raw.widths] } : {}), depth: raw.depth,
        shorelineSmoothness: raw.shorelineSmoothness ?? 0.82,
        shorelineIrregularity: raw.shorelineIrregularity ?? (raw.type === 'lake' ? 0.16 : 0),
        ...(raw.shorelineProfile ? { shorelineProfile: raw.shorelineProfile } : {}),
        seed: raw.seed ?? waterSeed(input.seed, id)
      };
      if (terrainFit) return {
        ...common, type: 'river' as const, surfaceMode: 'terrain-fit' as const,
        ...(raw.waterfallAfterPointIndices ? { waterfallAfterPointIndices: [...raw.waterfallAfterPointIndices] } : {})
      };
      if (raw.type === 'lake') return { ...common, type: 'lake' as const, levels: [...raw.levels!] };
      return { ...common, type: 'river' as const, levels: [...raw.levels!],
        ...(raw.surfaceMode === 'authored' ? { surfaceMode: 'authored' as const } : {}) };
    });
  }
  if (input.biomePatches !== undefined) {
    if (!Array.isArray(input.biomePatches) || input.biomePatches.length > 32) throw new Error('invalid_world_biome_patch');
    recipe.biomePatches = input.biomePatches.map(value => {
      if (!value || typeof value !== 'object') throw new Error('invalid_world_biome_patch');
      const raw = value as WorldBiomePatch;
      if (!WORLD_BIOMES.includes(raw.biome) || raw.feather !== undefined
        && (!Number.isFinite(raw.feather) || raw.feather < 0 || raw.feather > 2000)) throw new Error('invalid_world_biome_patch');
      return { id: safeId(raw.id), region: region(raw.region), biome: raw.biome, feather: raw.feather };
    });
  }
  return recipe;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function pathSample(points: Array<[number, number]>, x: number, z: number): { distance: number; t: number } {
  let distance = Infinity, along = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b[0] - a[0], dz = b[1] - a[1], length2 = dx * dx + dz * dz;
    const local = length2 === 0 ? 0 : clamp(((x - a[0]) * dx + (z - a[1]) * dz) / length2);
    const d = Math.hypot(x - mix(a[0], b[0], local), z - mix(a[1], b[1], local));
    if (d < distance) {
      distance = d;
      along = (i - 1 + local) / (points.length - 1);
    }
  }
  return { distance, t: along };
}

function regionSample(region: WorldTerrainRegion, x: number, z: number): { inside: boolean; edge: number; t: number } {
  if (region.kind === 'circle') {
    const distance = Math.hypot(x - region.center[0], z - region.center[1]);
    return { inside: distance <= region.radius, edge: region.radius - distance, t: 0 };
  }
  const result = pathSample(region.points, x, z), halfWidth = region.width / 2;
  return { inside: result.distance <= halfWidth, edge: halfWidth - result.distance, t: result.t };
}

export function worldRegionWeight(region: WorldTerrainRegion, x: number, z: number, feather = 0): number {
  if (![x, z, feather].every(Number.isFinite) || feather < 0) throw new Error('invalid_world_region_query');
  const area = regionSample(region, x, z);
  return area.inside ? 1 : feather > 0 ? 1 - smooth(0, feather, -area.edge) : 0;
}

function worldBiomePatchWeight(patch: WorldBiomePatch, x: number, z: number, seed: number): number {
  const area = regionSample(patch.region, x, z);
  const scale = patch.region.kind === 'circle' ? patch.region.radius : patch.region.width;
  const authoredFeather = patch.feather;
  // Keep authored metre values intact while giving natural material changes a
  // small minimum transition. Explicit zero remains available for a hard edge.
  const minimumFeather = clamp(scale * 0.24, 4, 24);
  const feather = authoredFeather === 0 ? 0 : Math.max(authoredFeather ?? 0, minimumFeather);
  const noiseScale = clamp(scale * 0.9, 12, 192);
  const variation = fbm(x / noiseScale, z / noiseScale, waterSeed(seed, patch.id), 3)
    * Math.min(scale * 0.18, Math.max(3, feather * 1.4));
  const edge = area.edge + variation;
  return edge >= 0 ? 1 : feather > 0 ? 1 - smooth(0, feather, -edge) : 0;
}

/** Precomputes the original editor shoreline workflow once in global coordinates. */
export function prepareWorldWaterBodies(input: WorldRecipe): PreparedWorldWaterBody[] {
  return createWorldTerrainContext(input).waterBodies;
}

function worldWaterEndpointConnected(
  waters: readonly WorldWaterBody[],
  waterIndex: number,
  point: readonly [number, number]
): boolean {
  return waters.some((water, index) => index !== waterIndex
    && regionSample(water.region, point[0], point[1]).inside);
}

function mixRiverPathSample(start: RiverPathSample, end: RiverPathSample, t: number): RiverPathSample {
  return {
    point: [mix(start.point[0], end.point[0], t), mix(start.point[1], end.point[1], t)],
    level: mix(start.level, end.level, t),
    width: mix(start.width, end.width, t)
  };
}

function taperIsolatedRiverSource(samples: RiverPathSample[]): RiverPathSample[] {
  if (samples.length < 2) return samples;
  const taperLength = samples[0].width * 1.25;
  const distances = [0];
  const expanded = [samples[0]];
  let distance = 0, inserted = false;
  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1], end = samples[index];
    const segmentLength = Math.hypot(end.point[0] - start.point[0], end.point[1] - start.point[1]);
    if (!inserted && distance < taperLength && distance + segmentLength > taperLength) {
      expanded.push(mixRiverPathSample(start, end, (taperLength - distance) / segmentLength));
      distances.push(taperLength);
      inserted = true;
    }
    distance += segmentLength;
    expanded.push(end);
    distances.push(distance);
  }
  return expanded.map((sample, index) => ({
    ...sample,
    point: [...sample.point],
    width: sample.width * mix(0.075, 1, smooth(0, taperLength, distances[index]))
  }));
}

function flareRiverIntoCoast(samples: RiverPathSample[], shoreWidth: number): RiverPathSample[] {
  const reach = shoreWidth * 2.5;
  const flared = samples.map(sample => ({ ...sample, point: [...sample.point] as [number, number] }));
  let distance = 0;
  for (let index = flared.length - 1; index >= 0 && distance < reach; index -= 1) {
    flared[index].width *= mix(1.35, 1, smooth(0, reach, distance));
    if (index > 0) distance += Math.hypot(
      flared[index].point[0] - flared[index - 1].point[0],
      flared[index].point[1] - flared[index - 1].point[1]
    );
  }
  return flared;
}

function submergedRiverMouth(
  samples: readonly RiverPathSample[],
  oceanIndex: number,
  shore: RiverPathSample
): RiverPathSample {
  const maximumExtension = Math.max(4, shore.width * 1.5);
  let start = shore, travelled = 0;
  const candidates = samples.slice(oceanIndex).map(sample => ({ ...sample, point: [...sample.point] as [number, number] }));
  const tail = samples.at(-1)!, beforeTail = samples.at(-2)!;
  const tailDx = tail.point[0] - beforeTail.point[0], tailDz = tail.point[1] - beforeTail.point[1];
  const tailLength = Math.hypot(tailDx, tailDz) || 1;
  candidates.push({
    point: [tail.point[0] + tailDx / tailLength * maximumExtension,
      tail.point[1] + tailDz / tailLength * maximumExtension],
    level: -0.03,
    width: shore.width * 1.5
  });
  for (const candidate of candidates) {
    const segmentLength = Math.hypot(candidate.point[0] - start.point[0], candidate.point[1] - start.point[1]);
    if (segmentLength <= 0.000001) continue;
    const allowed = Math.min(segmentLength, maximumExtension - travelled);
    const end = allowed < segmentLength
      ? mixRiverPathSample(start, candidate, allowed / segmentLength)
      : candidate;
    travelled += allowed;
    start = end;
    if (travelled >= maximumExtension - 0.000001) break;
  }
  return { ...start, level: -0.03, width: shore.width * 1.5 };
}

function clipRiverAtImplicitOcean(
  water: MapWaterBody,
  terrainHeightAt: (x: number, z: number) => number,
  endpointConnected: readonly [boolean, boolean],
  sourceToMouth = false,
  diagnostics?: WorldTerrainPreparationDiagnostic[]
): MapWaterBody {
  if (water.type !== 'river') return water;
  const authoredSamples = riverPathSamples(water);
  if (authoredSamples.length < 2) return water;
  const first = authoredSamples[0], last = authoredSamples.at(-1)!;
  const reversed = !sourceToMouth && (first.level < last.level
    || first.level === last.level && terrainHeightAt(...first.point) < terrainHeightAt(...last.point));
  const samples = reversed ? [...authoredSamples].reverse() : authoredSamples;
  const sourceConnected = endpointConnected[reversed ? 1 : 0];
  const downstreamConnected = endpointConnected[reversed ? 0 : 1];
  if (downstreamConnected || terrainHeightAt(...samples[0].point) <= 0) return water;
  let oceanIndex = samples.length - 1;
  if (sourceToMouth) {
    // Terrain-fit paths are authored upstream to downstream. Their first contact
    // with the implicit ocean is the mouth; later dry islets are offshore.
    oceanIndex = samples.findIndex(sample => terrainHeightAt(...sample.point) <= 0);
  } else {
    if (terrainHeightAt(...samples.at(-1)!.point) > 0) return water;
    while (oceanIndex > 0 && terrainHeightAt(...samples[oceanIndex - 1].point) <= 0) oceanIndex -= 1;
  }
  if (oceanIndex <= 0) return water;
  const from = samples[oceanIndex - 1], to = samples[oceanIndex];
  let land = 0, ocean = 1;
  for (let step = 0; step < 18; step += 1) {
    const t = (land + ocean) / 2;
    const x = mix(from.point[0], to.point[0], t), z = mix(from.point[1], to.point[1], t);
    if (terrainHeightAt(x, z) > 0) land = t;
    else ocean = t;
  }
  const shore = {
    point: [mix(from.point[0], to.point[0], ocean), mix(from.point[1], to.point[1], ocean)] as [number, number],
    level: 0,
    width: mix(from.width, to.width, ocean)
  };
  const mouth = submergedRiverMouth(samples, oceanIndex, shore);
  if (sourceToMouth && samples.slice(oceanIndex + 1)
    .some(sample => terrainHeightAt(...sample.point) > 0)) {
    const length = (path: readonly RiverPathSample[]) => path.slice(1).reduce((sum, sample, index) => sum
      + Math.hypot(sample.point[0] - path[index].point[0], sample.point[1] - path[index].point[1]), 0);
    const authoredLength = length(samples);
    const retainedLength = length([...samples.slice(0, oceanIndex), shore]);
    diagnostics?.push({
      code: 'river_mouth_clipped', waterBodyId: water.id, reason: 'offshore_land_after_mouth',
      position: [...shore.point], fallback: 'clipped-at-first-ocean',
      authoredLength, retainedLength, retainedRatio: authoredLength > 0 ? retainedLength / authoredLength : 1,
      message: `${water.id}: clipped at first ocean contact because its authored path returns to dry land offshore.`
    });
  }
  let clipped = [...flareRiverIntoCoast([...samples.slice(0, oceanIndex), shore], shore.width), mouth];
  if (!sourceConnected) clipped = taperIsolatedRiverSource(clipped);
  if (reversed) clipped = clipped.reverse();
  return {
    ...water,
    level: clipped.reduce((sum, sample) => sum + sample.level, 0) / clipped.length,
    points: clipped.map(sample => [...sample.point] as [number, number]),
    levels: clipped.map(sample => sample.level),
    widths: clipped.map(sample => sample.width),
    // The derived samples already contain the authored curve and irregularity.
    shorelineSmoothness: 0,
    shorelineIrregularity: 0
  };
}

type RiverProfileFailure = {
  reason: WorldRiverProfileInfeasibleDiagnostic['reason'];
  index: number;
};

function materializeRiverSamples(water: MapWaterBody, samples: readonly RiverPathSample[]): MapWaterBody {
  const levels = samples.map(sample => sample.level);
  return {
    ...water,
    level: levels.reduce((sum, level) => sum + level, 0) / Math.max(1, levels.length),
    points: samples.map(sample => [...sample.point]),
    levels,
    widths: samples.map(sample => sample.width),
    shorelineSmoothness: 0,
    shorelineIrregularity: 0
  };
}

function worldWaterEndpointConnection(
  waters: readonly WorldWaterBody[],
  waterIndex: number,
  point: readonly [number, number]
): WorldWaterBody | undefined {
  return waters.find((water, index) => index !== waterIndex
    && regionSample(water.region, point[0], point[1]).inside);
}

function connectedWaterLevel(water: WorldWaterBody | undefined, point: readonly [number, number]): number | undefined {
  if (!water?.levels?.length) return undefined;
  if (water.region.kind === 'circle') return water.levels[0];
  let closestIndex = 0, closestDistance = Infinity;
  for (let index = 0; index < water.region.points.length; index += 1) {
    const distance = Math.hypot(water.region.points[index][0] - point[0], water.region.points[index][1] - point[1]);
    if (distance < closestDistance) { closestDistance = distance; closestIndex = index; }
  }
  return water.levels[closestIndex];
}

function terrainFitRiverCaps(
  water: MapWaterBody,
  terrainHeightAt: (x: number, z: number) => number
): number[] {
  return riverEdgePairs(water).map((edge, index) => {
    const center = water.points[index];
    const midpoint: [number, number] = [
      (edge.left[0] + edge.right[0]) / 2,
      (edge.left[1] + edge.right[1]) / 2
    ];
    const bankHeight = (bank: [number, number]) => {
      const dx = bank[0] - midpoint[0], dz = bank[1] - midpoint[1], length = Math.hypot(dx, dz) || 1;
      return terrainHeightAt(
        bank[0] + dx / length * WORLD_TERRAIN_FIT_RIVER_BANK_CLEARANCE,
        bank[1] + dz / length * WORLD_TERRAIN_FIT_RIVER_BANK_CLEARANCE
      );
    };
    return Math.min(
      bankHeight(edge.left) - WORLD_TERRAIN_FIT_RIVER_BANK_CLEARANCE,
      bankHeight(edge.right) - WORLD_TERRAIN_FIT_RIVER_BANK_CLEARANCE,
      terrainHeightAt(...center) + water.depth
    );
  });
}

function terrainFitWaterfallSegments(source: Extract<WorldWaterBody, { surfaceMode: 'terrain-fit' }>, water: MapWaterBody): Set<number> {
  const segments = new Set<number>();
  if (source.region.kind !== 'path') return segments;
  for (const pointIndex of source.waterfallAfterPointIndices ?? []) {
    const point = source.region.points[pointIndex];
    let closestIndex = 0, closestDistance = Infinity;
    for (let index = 0; index < water.points.length - 1; index += 1) {
      const distance = Math.hypot(water.points[index][0] - point[0], water.points[index][1] - point[1]);
      if (distance < closestDistance) { closestDistance = distance; closestIndex = index; }
    }
    segments.add(closestIndex);
  }
  return segments;
}

function solveTerrainFitRiverProfile(
  samples: readonly RiverPathSample[],
  caps: readonly number[],
  waterfalls: ReadonlySet<number>,
  outletLevel?: number,
  oceanMouth = false
): { levels: number[] } | RiverProfileFailure {
  const levels = new Array<number>(samples.length);
  let index = samples.length - 1;
  if (oceanMouth && samples.length >= 2) {
    levels[index] = -0.03;
    levels[index - 1] = 0;
    index -= 2;
  } else {
    const level = outletLevel ?? caps[index];
    if (level > caps[index] + WORLD_TERRAIN_FIT_RIVER_BANK_CLEARANCE) {
      return { reason: 'outlet_above_bank', index };
    }
    levels[index] = level;
    index -= 1;
  }
  for (; index >= 0; index -= 1) {
    const downstream = levels[index + 1];
    if (caps[index] < downstream - 0.000001) return { reason: 'outlet_above_bank', index };
    const distance = Math.hypot(
      samples[index + 1].point[0] - samples[index].point[0],
      samples[index + 1].point[1] - samples[index].point[1]
    );
    const level = waterfalls.has(index)
      ? caps[index]
      : Math.min(caps[index], downstream + distance * WORLD_TERRAIN_FIT_RIVER_MAX_GRADE);
    if (caps[index] - level > WORLD_TERRAIN_FIT_RIVER_MAX_EXTRA_CUT + 0.000001) {
      return { reason: 'excessive_cut', index };
    }
    levels[index] = level;
  }
  return { levels };
}

function trimRiverBeforeRegion(
  samples: readonly RiverPathSample[],
  region: WorldTerrainRegion
): RiverPathSample[] {
  let outsideIndex = samples.length - 1;
  while (outsideIndex >= 0 && regionSample(region, ...samples[outsideIndex].point).inside) outsideIndex -= 1;
  if (outsideIndex < 0) return [];
  if (outsideIndex === samples.length - 1) return samples.map(sample => ({ ...sample, point: [...sample.point] }));
  const outside = samples[outsideIndex], inside = samples[outsideIndex + 1];
  let low = 0, high = 1;
  for (let step = 0; step < 18; step += 1) {
    const t = (low + high) / 2;
    const point: [number, number] = [mix(outside.point[0], inside.point[0], t), mix(outside.point[1], inside.point[1], t)];
    if (regionSample(region, ...point).inside) high = t;
    else low = t;
  }
  return [
    ...samples.slice(0, outsideIndex + 1).map(sample => ({ ...sample, point: [...sample.point] as [number, number] })),
    mixRiverPathSample(outside, inside, low)
  ];
}

function trimRiverBeforeOcean(
  samples: readonly RiverPathSample[],
  terrainHeightAt: (x: number, z: number) => number
): RiverPathSample[] {
  let landIndex = samples.length - 1;
  while (landIndex >= 0 && terrainHeightAt(...samples[landIndex].point) <= 0) landIndex -= 1;
  if (landIndex < 0) return [];
  if (landIndex === samples.length - 1) return samples.map(sample => ({ ...sample, point: [...sample.point] }));
  const land = samples[landIndex], ocean = samples[landIndex + 1];
  let low = 0, high = 1;
  for (let step = 0; step < 18; step += 1) {
    const t = (low + high) / 2;
    const x = mix(land.point[0], ocean.point[0], t), z = mix(land.point[1], ocean.point[1], t);
    if (terrainHeightAt(x, z) > 0) low = t;
    else high = t;
  }
  return [
    ...samples.slice(0, landIndex + 1).map(sample => ({ ...sample, point: [...sample.point] as [number, number] })),
    mixRiverPathSample(land, ocean, low)
  ];
}

function taperIsolatedRiverEnd(samples: RiverPathSample[]): RiverPathSample[] {
  return taperIsolatedRiverSource([...samples].reverse()).reverse();
}

function fallbackTerrainFitRiver(
  samples: RiverPathSample[],
  depth: number,
  terrainHeightAt: (x: number, z: number) => number,
  waterfalls: ReadonlySet<number>
): { samples: RiverPathSample[]; truncated: boolean } | null {
  if (samples.length < 2) return null;
  const provisional = materializeRiverSamples({
    id: 'terrain-fit-fallback', name: 'terrain-fit-fallback', type: 'river', level: 0, depth,
    width: samples[0].width, points: samples.map(sample => [...sample.point]),
    levels: samples.map(() => 0), widths: samples.map(sample => sample.width), shorelineSmoothness: 0,
    shorelineIrregularity: 0
  }, samples.map(sample => ({ ...sample, level: 0 })));
  const caps = terrainFitRiverCaps(provisional, terrainHeightAt), levels = [caps[0]];
  let retained = samples.length;
  for (let index = 1; index < samples.length; index += 1) {
    const level = Math.min(caps[index], levels[index - 1]);
    const distance = Math.hypot(
      samples[index].point[0] - samples[index - 1].point[0],
      samples[index].point[1] - samples[index - 1].point[1]
    );
    if (caps[index] - level > WORLD_TERRAIN_FIT_RIVER_MAX_EXTRA_CUT + 0.000001
      || !waterfalls.has(index - 1)
        && levels[index - 1] - level > distance * WORLD_TERRAIN_FIT_RIVER_MAX_GRADE + 0.000001) {
      retained = index;
      break;
    }
    levels.push(level);
  }
  if (retained < 2) return null;
  const fitted = samples.slice(0, retained).map((sample, index) => ({ ...sample, point: [...sample.point] as [number, number], level: levels[index] }));
  return { samples: retained < samples.length ? taperIsolatedRiverEnd(fitted) : fitted, truncated: retained < samples.length };
}

function prepareTerrainFitRiver(
  source: Extract<WorldWaterBody, { surfaceMode: 'terrain-fit' }>,
  authored: MapWaterBody,
  waters: readonly WorldWaterBody[],
  waterIndex: number,
  terrainHeightAt: (x: number, z: number) => number,
  diagnostics: WorldTerrainPreparationDiagnostic[]
): MapWaterBody | null {
  let mapWater = materializeRiverSamples(authored, riverPathSamples(authored));
  const sourceRegion = source.region as Extract<WorldTerrainRegion, { kind: 'path' }>;
  const sourceConnected = worldWaterEndpointConnected(waters, waterIndex, sourceRegion.points[0]);
  const outletConnection = worldWaterEndpointConnection(waters, waterIndex, sourceRegion.points.at(-1)!);
  mapWater = clipRiverAtImplicitOcean(mapWater, terrainHeightAt,
    [sourceConnected, Boolean(outletConnection)], true, diagnostics);
  let samples = riverPathSamples(mapWater);
  const waterfalls = terrainFitWaterfallSegments(source, mapWater);
  const oceanMouth = (mapWater.levels?.at(-1) ?? 0) < 0;
  const outletLevel = connectedWaterLevel(outletConnection, sourceRegion.points.at(-1)!);
  const caps = terrainFitRiverCaps(mapWater, terrainHeightAt);
  const solution = solveTerrainFitRiverProfile(samples, caps, waterfalls, outletLevel, oceanMouth);
  if ('levels' in solution) {
    return materializeRiverSamples(mapWater,
      samples.map((sample, index) => ({ ...sample, point: [...sample.point], level: solution.levels[index] })));
  }

  if (outletConnection) samples = trimRiverBeforeRegion(samples, outletConnection.region);
  else if (oceanMouth) samples = trimRiverBeforeOcean(samples, terrainHeightAt);
  const fallback = fallbackTerrainFitRiver(samples, source.depth, terrainHeightAt, waterfalls);
  const fallbackKind: WorldRiverProfileInfeasibleDiagnostic['fallback'] = !fallback
    ? 'omitted'
    : fallback.truncated ? 'truncated-before-drop' : 'detached-low-water';
  const failedPoint = mapWater.points[Math.min(solution.index, mapWater.points.length - 1)];
  diagnostics.push({
    code: 'river_profile_infeasible', waterBodyId: source.id, reason: solution.reason,
    position: [...failedPoint], fallback: fallbackKind,
    message: `${source.id}: ${solution.reason}; fallback=${fallbackKind}.`
  });
  return fallback ? materializeRiverSamples(mapWater, fallback.samples) : null;
}

function prepareValidatedWorldWaterBodies(
  waters: WorldWaterBody[],
  worldSeed: number,
  terrainHeightAt?: (x: number, z: number) => number,
  diagnostics: WorldTerrainPreparationDiagnostic[] = []
): PreparedWorldWaterBody[] {
  return waters.flatMap((source, waterIndex) => {
    const region = source.region;
    const seed = source.seed ?? waterSeed(worldSeed, source.id);
    const points = region.kind === 'circle'
      ? Array.from({ length: 32 }, (_, index): [number, number] => {
          const angle = index / 32 * Math.PI * 2;
          return [
            region.center[0] + Math.cos(angle) * region.radius,
            region.center[1] + Math.sin(angle) * region.radius
          ];
        })
      : region.points.map((point) => [...point] as [number, number]);
    const width = region.kind === 'circle' ? region.radius * 2 : region.width;
    const levels = source.levels ?? points.map(() => 0);
    const authored: MapWaterBody = {
      id: source.id,
      name: source.id,
      type: source.type,
      level: levels.reduce((sum, value) => sum + value, 0) / levels.length,
      levels: [...levels],
      ...(region.kind === 'path' ? { widths: source.widths ? [...source.widths] : region.points.map(() => region.width) } : {}),
      depth: source.depth,
      width,
      points,
      shorelineSmoothness: source.shorelineSmoothness ?? 0.82,
      shorelineIrregularity: source.shorelineIrregularity ?? (source.type === 'lake' ? 0.16 : 0),
      shorelineProfile: source.shorelineProfile,
      seed
    };
    let mapWater: MapWaterBody = authored.type === 'river'
      ? authored
      : {
          ...authored,
          points: waterBoundaryPoints(authored),
          shorelineSmoothness: 0,
          shorelineIrregularity: 0
        };
    if (source.type === 'river' && source.surfaceMode === 'terrain-fit' && terrainHeightAt) {
      const fitted = prepareTerrainFitRiver(source, authored, waters, waterIndex, terrainHeightAt, diagnostics);
      if (!fitted) return [];
      mapWater = fitted;
    } else if (terrainHeightAt && mapWater.type === 'river' && region.kind === 'path') {
      mapWater = clipRiverAtImplicitOcean(mapWater, terrainHeightAt, [
        worldWaterEndpointConnected(waters, waterIndex, region.points[0]),
        worldWaterEndpointConnected(waters, waterIndex, region.points.at(-1)!)
      ]);
    }
    const riverSamples = mapWater.type === 'river' ? riverPathSamples(mapWater) : [];
    const boundary = waterBoundaryPoints(mapWater);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of boundary) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    return [{ source: { ...source, seed }, mapWater, boundary, riverSamples, bounds: { minX, maxX, minZ, maxZ } }];
  });
}

function distanceToPreparedWater(water: PreparedWorldWaterBody, x: number, z: number): number {
  const dx = x < water.bounds.minX ? water.bounds.minX - x : x > water.bounds.maxX ? x - water.bounds.maxX : 0;
  const dz = z < water.bounds.minZ ? water.bounds.minZ - z : z > water.bounds.maxZ ? z - water.bounds.maxZ : 0;
  return Math.hypot(dx, dz);
}

export function preparedWorldFreshWaterDistance(waters: readonly PreparedWorldWaterBody[], x: number, z: number): number {
  if (![x, z].every(Number.isFinite)) throw new Error('invalid_world_water_query');
  let distance = Infinity;
  for (const water of waters) {
    if (distanceToPreparedWater(water, x, z) >= distance) continue;
    if (waterBoundaryContainsPoint(water.boundary, x, z)) return 0;
    distance = Math.min(distance, waterBoundaryDistance(water.boundary, x, z));
  }
  return distance;
}

/** Distance to authored fresh water. The implicit height<0 ocean is salt water and is deliberately excluded. */
export function worldFreshWaterDistance(
  recipe: Pick<WorldRecipe, 'waterBodies'> & Partial<Pick<WorldRecipe, 'seed'>>,
  x: number,
  z: number
): number {
  return preparedWorldFreshWaterDistance(
    prepareValidatedWorldWaterBodies(recipe.waterBodies ?? [], recipe.seed ?? 0), x, z
  );
}

function interpolatePath(values: number[], t: number): number {
  if (values.length === 1) return values[0];
  const scaled = clamp(t) * (values.length - 1), index = Math.min(values.length - 2, Math.floor(scaled));
  return mix(values[index], values[index + 1], scaled - index);
}

function hash(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 69069);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 2147483647.5 - 1;
}

/** Global coordinates, quintic interpolation, no per-tile normalization. */
function noise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const tx = fade(x - ix), tz = fade(z - iz);
  return mix(mix(hash(ix, iz, seed), hash(ix + 1, iz, seed), tx),
    mix(hash(ix, iz + 1, seed), hash(ix + 1, iz + 1, seed), tx), tz);
}
function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let value = 0, amplitude = 1, total = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise(x, z, seed + i * 1013);
    total += amplitude;
    const nextX = x * 1.7 - z * 1.1 + 13.1;
    z = x * 1.1 + z * 1.7 - 7.7;
    x = nextX;
    amplitude *= 0.48;
  }
  return value / total;
}

function riverBendAt(samples: readonly RiverPathSample[], point: [number, number]): number {
  if (samples.length < 3) return 0;
  let closest = 0, distance = Infinity;
  for (let index = 0; index < samples.length; index += 1) {
    const dx = samples[index].point[0] - point[0], dz = samples[index].point[1] - point[1];
    const nextDistance = dx * dx + dz * dz;
    if (nextDistance < distance) { closest = index; distance = nextDistance; }
  }
  const span = Math.min(3, closest, samples.length - 1 - closest);
  if (span < 1) return 0;
  const before = samples[closest - span].point, center = samples[closest].point;
  const after = samples[closest + span].point;
  const incoming: [number, number] = [center[0] - before[0], center[1] - before[1]];
  const outgoing: [number, number] = [after[0] - center[0], after[1] - center[1]];
  const incomingLength = Math.hypot(...incoming), outgoingLength = Math.hypot(...outgoing);
  if (incomingLength <= 0.000001 || outgoingLength <= 0.000001) return 0;
  const cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
  const dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1];
  return clamp(Math.atan2(cross, dot) / (Math.PI / 2), -1, 1);
}

function freshWaterMaterialBankWidth(
  prepared: PreparedWorldWaterBody,
  river: ReturnType<typeof sampleRiverProfile> | null,
  x: number,
  z: number,
  height: number,
  level: number,
  boundaryDistance: number,
  moisture: number
): number {
  const water = prepared.mapWater;
  const baseWidth = water.shorelineProfile === 'steep'
    ? Math.max(3, water.depth)
    : water.shorelineProfile === 'gentle'
      ? Math.max(7, water.depth * 3.5)
      : water.type === 'river'
        ? Math.max(7, water.depth * 2.5)
        : Math.max(6, water.depth * 3.5);
  let side = 0, bendFactor = 1;
  if (river) {
    const offsetX = x - river.point[0], offsetZ = z - river.point[1];
    side = Math.sign(river.direction[0] * offsetZ - river.direction[1] * offsetX);
    // A point-bar side reads wider than the outside cut bank without changing the water polygon.
    bendFactor += clamp(riverBendAt(prepared.riverSamples, river.point) * side * 1.15, -0.38, 0.38);
  }
  const bankSlope = Math.max(0, height - level) / Math.max(3, boundaryDistance);
  const slopeFactor = mix(1.18, 0.72, smooth(0.08, 0.55, bankSlope));
  const moistureFactor = mix(0.9, 1.14, smooth(0.25, 0.75, moisture));
  const anchor = river?.point ?? [x, z];
  const macroScale = Math.max(96, (river?.width ?? water.width) * 6);
  const bankVariation = fbm(anchor[0] / macroScale + side * 13,
    anchor[1] / macroScale - side * 7, (water.seed ?? 0) + 2089, 2);
  return clamp(baseWidth * bendFactor * slopeFactor * moistureFactor * (1 + bankVariation * 0.18), 3, 24);
}
const targets: Record<WorldBiome, readonly [number, number, number, number]> = {
  ocean: [-0.95, 0.6, 0.8, 0.05],
  desert: [0.65, 0.95, 0.06, 0.04],
  forest: [0.7, 0.62, 0.94, 0.16],
  grassland: [0.65, 0.65, 0.48, 0.03],
  mountains: [0.85, 0.48, 0.46, 1],
  snow: [0.8, 0.03, 0.5, 0.6]
};

export function createWorldSampler(input: WorldRecipe): WorldSampler {
  return createWorldTerrainContext(input).sample;
}

export function createWorldTerrainContext(input: WorldRecipe): WorldTerrainContext {
  const recipe = validateWorldRecipe(input);
  const { seed, size, constraints } = recipe;
  const terrainBrushes = recipe.terrainBrushes ?? [];
  const diagnostics: WorldTerrainPreparationDiagnostic[] = [];
  // Stored recipes without a profile predate scale-aware relief and must replay exactly.
  const compactRelief = recipe.reliefProfile === 'compact';
  const terrainScale = compactRelief ? clamp(size / 6400, 0.125, 1) : 1;
  const cardinalOceanRing = (['west', 'east', 'north', 'south'] as const)
    .every(region => constraints.some(constraint => constraint.region === region && constraint.biome === 'ocean'));
  // A world-scale central footprint is authored island mass; local mountains and headlands are not.
  const authoredIslandCore = (recipe.landforms ?? []).some(form => form.height > 0
    && Math.hypot(...form.center) <= size * 0.12 && Math.min(...form.radius) >= size * 0.32);
  const boundedIslandMass = compactRelief && cardinalOceanRing
    && (constraints.some(constraint => constraint.region === 'center' && constraint.biome !== 'ocean')
      || authoredIslandCore);
  const compactDetailScale = 1 + (Math.sqrt(size / WORLD_MIN_SIZE) - 1) * 0.75;
  const landforms = (recipe.landforms ?? []).map(form => {
    const minRadius = Math.min(...form.radius);
    const worldScaleIslandCore = compactRelief && form.height > 0
      && Math.hypot(...form.center) <= size * 0.12 && minRadius >= size * 0.32
      && form.height / minRadius >= 0.12;
    return {
      form,
      minRadius,
      formPhase: worldScaleIslandCore
        ? hash(Math.round(form.center[0]), Math.round(form.center[1]), seed + 1741) * Math.PI
        : null
    };
  });
  const shapedIslandCore = landforms.some(({ formPhase }) => formPhase !== null);
  const craterRimReferences = new Map<number, number>();
  let waterBodies: PreparedWorldWaterBody[] = [];
  const sample = (x: number, z: number, brushLimit = terrainBrushes.length): WorldSample => {
    const nx = x / (size / 2), nz = z / (size / 2);
    const warpX = fbm(x / (13000 * terrainScale) + 17, z / (13000 * terrainScale), seed + 41, 2);
    const warpZ = fbm(x / (13000 * terrainScale), z / (13000 * terrainScale) - 23, seed + 73, 2);
    const ux = nx + warpX * 0.12, uz = nz + warpZ * 0.12;
    const broad = fbm(x / (8500 * terrainScale), z / (8500 * terrainScale), seed + 103);
    let continentalness = (0.5 + broad * 0.5) * 0.12;
    let temperature = (0.62 - nz * 0.12) * 0.12;
    let moisture = (0.52 + fbm(x / (10000 * terrainScale), z / (10000 * terrainScale), seed + 701, 2) * 0.28) * 0.12;
    let uplift = (0.15 + smooth(-0.15, 0.65, broad) * 0.7) * 0.12;
    let total = 0.12;
    for (const constraint of constraints) {
      const anchor = WORLD_REGIONS[constraint.region];
      const d2 = (ux - anchor[0]) ** 2 + (uz - anchor[1]) ** 2;
      const w = Math.exp(-d2 / 0.27) * 2.4;
      const target = targets[constraint.biome];
      continentalness += target[0] * w;
      temperature += target[1] * w;
      moisture += target[2] * w;
      uplift += target[3] * w;
      total += w;
    }
    continentalness = continentalness / total + broad * 0.14;
    if (boundedIslandMass) {
      // A complete ocean ring explicitly describes an island. Keep its mass inside the ring;
      // the domain warp and authored core keep its shoreline rolling without leaking to the edge.
      const islandFloor = 0.14 - smooth(0.3, 0.98, Math.hypot(ux, uz)) * 0.24;
      const floorBlend = clamp(0.5 + (continentalness - islandFloor) / 0.12);
      continentalness = mix(islandFloor, continentalness, floorBlend) + 0.06 * floorBlend * (1 - floorBlend);
    }
    if (compactRelief) {
      // Keep smaller headlands visible without letting local noise dominate a bounded island outline.
      const coastBand = 1 - smooth(0.04, 0.28, Math.abs(continentalness));
      const localCoast = fbm(x / (1000 * terrainScale), z / (1000 * terrainScale), seed + 1667, 2);
      continentalness += localCoast * (boundedIslandMass && shapedIslandCore ? 0.04 : 0.06) * coastBand;
    }
    moisture = clamp(moisture / total
      + fbm(x / (4500 * terrainScale) + 13, z / (4500 * terrainScale), seed + 809, 2) * 0.08);
    temperature = clamp(temperature / total);
    uplift = uplift / total;
    const land = smooth(-0.03, 0.22, continentalness);
    const wx = x + warpX * 1500 * terrainScale, wz = z + warpZ * 1500 * terrainScale;
    const ridgeNoise = fbm(wx / (2600 * terrainScale), wz / (2600 * terrainScale), seed + 211, 3);
    const ridge = Math.cos(ridgeNoise * Math.PI / 2) ** 4;
    const mass = smooth(-0.45, 0.5, fbm(wx / (6200 * terrainScale), wz / (6200 * terrainScale), seed + 919, 3));
    const mountain = uplift * (0.16 + mass * 0.84);
    const climateDry = smooth(0.53, 0.82, temperature) * (1 - smooth(0.14, 0.44, moisture));
    const rolling = fbm(wx / (1200 * terrainScale), wz / (1200 * terrainScale), seed + 311, 4) * 115;
    const dunes = (0.5 + 0.5 * Math.sin(wx / 85 + wz / 160 + noise(wx / 1100, wz / 1100, seed + 505) * 4)) ** 1.5 * 28;
    const foldedRelief = compactRelief
      ? fbm(wx / (520 * terrainScale), wz / (520 * terrainScale), seed + 1237, 3)
      : 0;
    const erosionChannels = compactRelief ? 1 - smooth(0.035, 0.32, Math.abs(foldedRelief)) : 0;
    const reliefDetail = compactRelief
      ? fbm(wx / (310 * terrainScale), wz / (310 * terrainScale), seed + 1451, 2) * 0.32 - erosionChannels * 0.48
      : 0;
    const oceanDepthScale = compactRelief ? 0.4 + terrainScale * 0.6 : 1;
    const base = continentalness < 0
      ? continentalness * 1050 * oceanDepthScale
      : Math.pow(continentalness, 1.4) * 400;
    const macroHeight = base + land * (mountain * ridge * 3100 * terrainScale
      + rolling * (1 - climateDry * 0.8));
    let height = macroHeight * (recipe.heightScale ?? 1) + land * climateDry * dunes;
    let authoredDetailAmplitude = 0, authoredDrainageDetail = 0;
    for (const { form, minRadius, formPhase } of landforms) {
      const formX = (x - form.center[0]) / form.radius[0];
      const formZ = (z - form.center[1]) / form.radius[1];
      let d2 = formX ** 2 + formZ ** 2;
      if (formPhase !== null) {
        const formAngle = Math.atan2(formZ, formX);
        const formShape = Math.sin(formAngle * 3 + formPhase) * 0.7
          + Math.sin(formAngle * 5 - formPhase * 0.61) * 0.3;
        const formShapeScale = 1 + formShape * 0.1;
        d2 = (formX * formShapeScale) ** 2 + (formZ * formShapeScale) ** 2;
      }
      // Compact support with zero first and second derivatives at the boundary.
      if (d2 < 1) {
        const influence = (1 - d2) ** 3;
        height += form.height * influence;
        if (form.height > 0) {
          const slopeBand = 64 * d2 ** 3 * (1 - d2) ** 3;
          const smallHillBoost = Math.sqrt(form.height) * 1.3 * (1 - smooth(20, 40, form.height));
          authoredDetailAmplitude = Math.max(authoredDetailAmplitude,
            slopeBand * Math.min(14 * Math.sqrt(compactDetailScale), form.height * 0.16 + smallHillBoost));
          const formSlope = form.height / minRadius;
          if (compactRelief && form.height >= 14 && minRadius >= 18 && formSlope >= 0.18) {
            // Authored compact relief needs coherent downslope structure, not isotropic noise alone.
            // Ellipse angle follows the local fall line; a slow phase warp bends channels without
            // breaking them into dots, while the slope band protects both summit and foothill.
            const radius = Math.sqrt(d2);
            const aspect = Math.atan2((z - form.center[1]) / form.radius[1],
              (x - form.center[0]) / form.radius[0]);
            const channelCount = clamp(Math.round((form.radius[0] + form.radius[1]) / 34), 5, 6);
            const formScale = Math.max(...form.radius);
            // Carry broad gullies uphill only on relief tall enough to read as a mountain at this world scale.
            const strongDrainage = form.height >= Math.max(30, size * 0.06);
            const phase = noise(form.center[0] / formScale, form.center[1] / formScale,
              seed + 1877) * Math.PI;
            const twist = noise(form.center[0] / formScale + 11, form.center[1] / formScale - 7,
              seed + 1907) * 0.9;
            const channelWarp = fbm(x / (formScale * 1.25), z / (formScale * 1.25), seed + 1931, 2)
              * (strongDrainage ? 0.72 : 1.2);
            const branchWarp = fbm(x / (formScale * 1.6) + 13, z / (formScale * 1.6) - 9,
              seed + 1973, 2) * (strongDrainage ? 0.72 : 1);
            const drainageWave = Math.cos(channelCount * aspect + phase
              + twist * (radius - 0.55) + channelWarp) * 0.72
              + Math.cos((channelCount + 2) * aspect - phase * 0.45
                - twist * (radius - 0.55) * 0.7 + branchWarp) * 0.28;
            const channel = strongDrainage
              ? smooth(0.05, 0.76, drainageWave)
              : smooth(0.25, 0.82, drainageWave);
            const rib = strongDrainage
              ? smooth(0.08, 0.8, -drainageWave)
              : smooth(0.15, 0.86, -drainageWave);
            const macroFold = Math.cos(2 * aspect + phase * 0.37 + twist * (radius - 0.5));
            // Multi-metre cuts remain legible in a 500m overview; the C2 slope band still
            // takes them to zero before the summit and footprint boundary.
            const drainageAmplitude = Math.min(12 * (strongDrainage ? compactDetailScale : Math.sqrt(compactDetailScale)),
              form.height * 0.21)
              * smooth(8, 14, form.height) * smooth(18, 30, minRadius)
              * mix(strongDrainage ? 0.2 : 0.55, 1, smooth(0.25, 0.5, formSlope));
            const ridgeAmplitude = Math.min(size * 0.006, form.height * 0.06)
              * smooth(0.18, 0.34, formSlope);
            // Do not turn a mountain-backed beach into a drainage cliff.
            const downslopeBand = smooth(0.08, 0.24, d2) * (1 - smooth(0.68, 0.98, d2));
            const drainageMask = (strongDrainage ? Math.max(slopeBand, downslopeBand * 0.6) : slopeBand)
              * smooth(3, 12, height);
            authoredDrainageDetail += drainageMask * (drainageAmplitude
              * (rib * (strongDrainage ? 0.38 : 0.32) - channel * (strongDrainage ? 0.96 : 0.82))
              + ridgeAmplitude * macroFold * 0.55);
          }
        }
      }
    }
    if (compactRelief) {
      const proceduralAmplitude = land * smooth(0.28, 0.68, uplift)
        * 360 * terrainScale * (recipe.heightScale ?? 1);
      height += reliefDetail * (proceduralAmplitude + authoredDetailAmplitude) + authoredDrainageDetail;
    }
    for (let brushIndex = 0; brushIndex < brushLimit; brushIndex += 1) {
      const brush = terrainBrushes[brushIndex];
      const authoredFeather = brush.feather ?? 0;
      // Preserve deliberate drainage cuts; only bulk earthworks need the slope-safe expansion.
      const narrowGully = brush.mode === 'lower' && brush.amount <= 8
        && brush.region.kind === 'path' && brush.region.width <= 16
        && authoredFeather <= Math.max(12, brush.region.width * 1.5);
      const feather = brush.mode === 'crater'
        ? brush.feather ?? Math.min(2000, brush.region.radius * 0.25)
        : compactRelief && (brush.mode === 'raise' || brush.mode === 'lower') && !narrowGully
          ? Math.max(authoredFeather, brush.amount * 3.75) : authoredFeather;
      const area = regionSample(brush.region, x, z);
      const influence = area.inside ? 1 : feather > 0 ? 1 - smooth(0, feather, -area.edge) : 0;
      if (influence <= 0) continue;
      if (brush.mode === 'raise' || brush.mode === 'lower') {
        height += brush.amount * influence * (brush.mode === 'raise' ? 1 : -1);
        continue;
      }
      if (brush.mode === 'crater') {
        const reference = craterRimReference(brush, brushIndex);
        const distance = brush.region.radius - area.edge;
        const target = area.inside
          ? mix(reference - brush.depth, reference + brush.rimHeight,
              smooth(brush.region.radius * 0.3, brush.region.radius, distance))
          : reference + brush.rimHeight;
        height = mix(height, target, influence);
        continue;
      }
      const target = brush.mode === 'flatten' ? brush.height : interpolatePath(brush.heights, area.t);
      height = mix(height, target, influence * (brush.strength ?? 1));
    }
    const terrainHeightBeforeWater = height;
    let waterLevel: number | null = null, waterBodyId: string | null = null, freshWaterDistance = Infinity;
    let freshWaterWeight = 0;
    for (const prepared of waterBodies) {
      const water = prepared.mapWater;
      const river = water.type === 'river' ? sampleRiverProfile(x, z, prepared.riverSamples) : null;
      const level = river?.level ?? water.level;
      const implicitOceanRiver = river !== null
        && ((prepared.riverSamples[0]?.level ?? 0) < 0 || (prepared.riverSamples.at(-1)?.level ?? 0) < 0);
      // Fade the derived freshwater bed and bank before the centerline reaches
      // the coast, then let the higher ocean surface hide the submerged cap.
      const mouthBlend = implicitOceanRiver ? smooth(-0.15, 0.75, terrainHeightBeforeWater) : 1;
      const outerBankWidth = water.shorelineProfile === 'steep'
        ? Math.max(2, water.depth * 0.6)
        : water.shorelineProfile === 'gentle'
          ? Math.max(4, water.depth * 4)
          : Math.max(4, water.depth * 4, (height - level) * 3);
      if (distanceToPreparedWater(prepared, x, z) > Math.max(160, outerBankWidth)) continue;
      const inside = waterBoundaryContainsPoint(prepared.boundary, x, z);
      const boundaryDistance = waterBoundaryDistance(prepared.boundary, x, z);
      freshWaterDistance = Math.min(freshWaterDistance, inside ? 0 : boundaryDistance);
      if (inside) freshWaterWeight = Math.max(freshWaterWeight, mouthBlend);
      else if (boundaryDistance < 24) {
        const materialBankWidth = freshWaterMaterialBankWidth(prepared, river, x, z,
          height, level, boundaryDistance, moisture);
        freshWaterWeight = Math.max(freshWaterWeight,
          (1 - smooth(0, materialBankWidth, boundaryDistance)) * mouthBlend);
      }
      if (!inside) {
        // Reuse the editor's outer bank profile. Carving only the inside of a
        // water polygon creates a vertical wall exactly at its boundary.
        if (height > level && boundaryDistance < outerBankWidth) {
          height = mix(height, waterShoreProfile(level, height, boundaryDistance, outerBankWidth), mouthBlend);
        }
        continue;
      }
      const reach = prepared.source.region.kind === 'circle'
        ? prepared.source.region.radius
        : (river?.width ?? water.width) / 2;
      const innerShoreWidth = river && !water.shorelineProfile
        ? reach
        : water.shorelineProfile === 'steep'
          ? Math.max(1, water.depth * 0.6)
          : water.shorelineProfile === 'gentle'
            ? Math.max(4, water.depth * 4)
            : Math.max(1, water.depth * 2);
      const waterBed = waterShoreProfile(level, level - water.depth,
        boundaryDistance, Math.min(reach, innerShoreWidth));
      height = Math.min(height, mix(height, waterBed, mouthBlend));
      if (height <= level + 0.000001 && (waterLevel === null || level > waterLevel)) {
        waterLevel = level;
        waterBodyId = prepared.source.id;
      }
    }
    if (terrainHeightBeforeWater < 0 && (waterLevel === null || waterLevel <= 0)) {
      waterLevel = 0;
      waterBodyId = null;
      freshWaterWeight = 0;
    }
    const freshWaterInfluence = 1 - smooth(20, 160, freshWaterDistance);
    moisture = clamp(moisture + (1 - moisture) * freshWaterInfluence * 0.75);
    const localTemp = clamp(temperature - Math.max(0, height - 300) * 0.00012);
    const dry = smooth(0.53, 0.82, temperature) * (1 - smooth(0.14, 0.44, moisture));
    let ocean = 1 - smooth(-12, 8, terrainHeightBeforeWater);
    let snow = smooth(0.28, 0.1, localTemp) * (1 - ocean);
    let rock = smooth(0.24, 0.65, mountain) * (1 - ocean) * (1 - snow);
    const remainder = Math.max(0, 1 - ocean - snow - rock);
    let desert = dry * remainder;
    let forest = smooth(0.5, 0.82, moisture) * (remainder - desert);
    let grassland = Math.max(0, remainder - desert - forest);
    const weights = { ocean, grassland, forest, desert, mountains: rock, snow };
    if (waterLevel === null) for (const patch of recipe.biomePatches ?? []) {
      const influence = worldBiomePatchWeight(patch, x, z, seed);
      if (influence <= 0) continue;
      for (const biome of WORLD_BIOMES) weights[biome] *= 1 - influence;
      weights[patch.biome] += influence;
    }
    return {
      height, continentalness, temperature: localTemp, moisture,
      weights, freshWaterWeight, waterLevel, waterBodyId
    };
  };
  function craterRimReference(brush: Extract<WorldTerrainBrush, { mode: 'crater' }>, brushIndex: number): number {
    const cached = craterRimReferences.get(brushIndex);
    if (cached !== undefined) return cached;
    const count = 16;
    const reference = Array.from({ length: count }, (_, index) => {
      const angle = index / count * Math.PI * 2;
      return sample(brush.region.center[0] + Math.cos(angle) * brush.region.radius,
        brush.region.center[1] + Math.sin(angle) * brush.region.radius, brushIndex).height;
    }).reduce((sum, height) => sum + height, 0) / count;
    craterRimReferences.set(brushIndex, reference);
    return reference;
  }
  terrainBrushes.forEach((brush, index) => {
    if (brush.mode === 'crater') craterRimReference(brush, index);
  });
  waterBodies = prepareValidatedWorldWaterBodies(recipe.waterBodies ?? [], seed, (x, z) => sample(x, z).height, diagnostics);
  return {
    sample,
    waterBodies,
    freshWaterDistance: (x, z) => preparedWorldFreshWaterDistance(waterBodies, x, z),
    diagnostics
  };
}

const WORLD_RIVER_BANK_DIAGNOSTIC_SECTION_LIMIT = 256;
const WORLD_RIVER_BANK_DIAGNOSTIC_OUTSET = 0.05;
const WORLD_RIVER_BANK_DIAGNOSTIC_THRESHOLD = 0.05;

/** Reports exposed river ribbons without changing authored water or terrain. */
export function diagnoseWorldRiverSurfaceAboveBank(
  context: WorldTerrainContext
): WorldRiverSurfaceAboveBankDiagnostic[] {
  const rivers = context.waterBodies.filter(water => water.mapWater.type === 'river');
  if (!rivers.length) return [];
  const sectionsPerRiver = Math.max(2, Math.floor(WORLD_RIVER_BANK_DIAGNOSTIC_SECTION_LIMIT / rivers.length));
  const diagnostics: WorldRiverSurfaceAboveBankDiagnostic[] = [];
  for (const river of rivers) {
    const edges = riverEdgePairs(river.mapWater);
    const sectionCount = Math.min(edges.length, sectionsPerRiver);
    const indices = sectionCount === edges.length
      ? edges.map((_, index) => index)
      : Array.from({ length: sectionCount }, (_, index) => Math.round(index * (edges.length - 1) / (sectionCount - 1)));
    let affectedSampleCount = 0, sampleCount = 0, maxHoverHeight = -Infinity;
    let position: [number, number] = [0, 0];
    for (const index of indices) {
      const edge = edges[index];
      const midpoint: [number, number] = [
        (edge.left[0] + edge.right[0]) / 2,
        (edge.left[1] + edge.right[1]) / 2
      ];
      for (const bank of [edge.left, edge.right]) {
        const dx = bank[0] - midpoint[0], dz = bank[1] - midpoint[1];
        const length = Math.hypot(dx, dz) || 1;
        const samplePosition: [number, number] = [
          bank[0] + dx / length * WORLD_RIVER_BANK_DIAGNOSTIC_OUTSET,
          bank[1] + dz / length * WORLD_RIVER_BANK_DIAGNOSTIC_OUTSET
        ];
        const terrain = context.sample(...samplePosition);
        // The river bed and its submerged ocean-mouth cap cannot expose a hovering ribbon.
        const coveredByOcean = terrain.waterBodyId === null && terrain.waterLevel !== null
          && terrain.waterLevel >= edge.level;
        if (terrain.waterBodyId === river.source.id || coveredByOcean) continue;
        sampleCount += 1;
        const hoverHeight = edge.level - terrain.height;
        if (hoverHeight <= WORLD_RIVER_BANK_DIAGNOSTIC_THRESHOLD) continue;
        affectedSampleCount += 1;
        if (hoverHeight > maxHoverHeight) {
          maxHoverHeight = hoverHeight;
          position = samplePosition;
        }
      }
    }
    if (!affectedSampleCount) continue;
    const roundedHeight = Number(maxHoverHeight.toFixed(3));
    const roundedPosition = position.map(value => Number(value.toFixed(3))) as [number, number];
    diagnostics.push({
      code: 'river_surface_above_bank',
      message: `${river.source.id}: ${affectedSampleCount}/${sampleCount} sampled bank points are below the river surface; maximum ${roundedHeight}m at (${roundedPosition[0]}, ${roundedPosition[1]}).`,
      waterBodyId: river.source.id,
      affectedSampleCount,
      sampleCount,
      maxHoverHeight: roundedHeight,
      position: roundedPosition
    });
  }
  return diagnostics;
}

/** Rise/run gradient sampled in world metres. */
export function sampleWorldSlope(sample: WorldSampler, x: number, z: number, epsilon = 4): number {
  if (![x, z, epsilon].every(Number.isFinite) || epsilon <= 0 || epsilon > 1000) throw new Error('invalid_world_slope_query');
  const dx = (sample(x + epsilon, z).height - sample(x - epsilon, z).height) / (2 * epsilon);
  const dz = (sample(x, z + epsilon).height - sample(x, z - epsilon).height) / (2 * epsilon);
  return Math.hypot(dx, dz);
}

export function dominantBiome(sample: WorldSample): WorldBiome {
  return WORLD_BIOMES.reduce((a, b) => sample.weights[a] >= sample.weights[b] ? a : b);
}

export function sampleWorldTile(
  recipe: WorldRecipe,
  tile: WorldTile,
  resolution = 33,
  sample = createWorldSampler(recipe),
  includeNormals = true
): WorldTileData {
  if (!Number.isInteger(resolution) || resolution < 3 || resolution > 129 || !Number.isFinite(tile.x)
    || !Number.isFinite(tile.z) || !Number.isFinite(tile.size) || tile.size <= 0 || tile.size > recipe.size) {
    throw new Error('invalid_world_tile');
  }
  const heights = new Float32Array(resolution * resolution);
  const normals = new Float32Array(includeNormals ? resolution * resolution * 3 : 0);
  const weights = new Float32Array(resolution * resolution * WORLD_BIOMES.length);
  const freshWaterWeights = new Float32Array(resolution * resolution);
  const waterLevels = new Float32Array(resolution * resolution).fill(NaN);
  // A fixed world-space stencil gives identical normals at every LOD's shared vertices.
  const epsilon = 4;
  for (let iz = 0; iz < resolution; iz++) for (let ix = 0; ix < resolution; ix++) {
    const i = iz * resolution + ix;
    const x = tile.x + ix * tile.size / (resolution - 1);
    const z = tile.z + iz * tile.size / (resolution - 1);
    const point = sample(x, z);
    heights[i] = point.height;
    freshWaterWeights[i] = point.freshWaterWeight ?? 0;
    if (point.waterLevel !== null) waterLevels[i] = point.waterLevel;
    if (includeNormals) {
      const dx = sample(x + epsilon, z).height - sample(x - epsilon, z).height;
      const dz = sample(x, z + epsilon).height - sample(x, z - epsilon).height;
      const length = Math.hypot(dx, epsilon * 2, dz);
      normals.set([-dx / length, epsilon * 2 / length, -dz / length], i * 3);
    }
    for (let j = 0; j < WORLD_BIOMES.length; j++) weights[i * WORLD_BIOMES.length + j] = point.weights[WORLD_BIOMES[j]];
  }
  return { heights, normals, weights, freshWaterWeights, waterLevels, resolution };
}

/** Bounded quadtree covering the whole world; detail follows the camera and its orbit target. */
export function selectWorldTiles(size: number, focusX: number, focusZ: number, distance: number, maxTiles = 256): WorldTile[] {
  if (![size, focusX, focusZ, distance, maxTiles].every(Number.isFinite) || size < WORLD_MIN_SIZE || size > 256000
    || distance < 0 || maxTiles < 1 || maxTiles > 1024 || !Number.isInteger(maxTiles)) throw new Error('invalid_world_lod');
  const tiles: WorldTile[] = [{ x: -size / 2, z: -size / 2, size }];
  while (tiles.length + 3 <= maxTiles) {
    let best = -1, priority = 1 / 1.65;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      if (tile.size <= Math.min(125, size / 16)) continue;
      const dx = Math.max(0, Math.abs(focusX - (tile.x + tile.size / 2)) - tile.size / 2);
      const dz = Math.max(0, Math.abs(focusZ - (tile.z + tile.size / 2)) - tile.size / 2);
      const score = tile.size > size / 8 ? 1000 + tile.size / size
        : tile.size / Math.max(1, Math.hypot(dx, dz, distance * 0.35));
      if (score > priority) { priority = score; best = i; }
    }
    if (best === -1) break;
    const tile = tiles[best], half = tile.size / 2;
    tiles.splice(best, 1,
      { x: tile.x, z: tile.z, size: half }, { x: tile.x + half, z: tile.z, size: half },
      { x: tile.x, z: tile.z + half, size: half }, { x: tile.x + half, z: tile.z + half, size: half });
  }
  return tiles;
}
