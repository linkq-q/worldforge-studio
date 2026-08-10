import {
  TERRAIN_MIN_HEIGHT,
  terrainIndex,
  terrainPointAt,
  type EditableMap
} from './map';
import type { VisualZoneTag } from './visualDirection';

export const TERRAIN_GENERATION_PRESETS = [
  'plain',
  'hills',
  'valley',
  'island',
  'archipelago',
  'canyon',
  'cliff-plateau',
  'dune-desert'
] as const;
export type TerrainGenerationPreset = typeof TERRAIN_GENERATION_PRESETS[number];

export const TERRAIN_MODIFIERS = ['mountain', 'cliff', 'terrace', 'dune', 'island'] as const;
export type TerrainModifier = typeof TERRAIN_MODIFIERS[number];

export const TERRAIN_SURFACES = ['grass', 'sand', 'rock'] as const;
export type TerrainSurfaceKind = typeof TERRAIN_SURFACES[number];

export const TERRAIN_CLIFF_LAYOUTS = ['plateau', 'coast', 'canyon', 'wall', 'terraces'] as const;
export type TerrainCliffLayout = typeof TERRAIN_CLIFF_LAYOUTS[number];

export const TERRAIN_REGION_KINDS = ['circle', 'path', 'polygon'] as const;
export type TerrainRegionKind = typeof TERRAIN_REGION_KINDS[number];

export type TerrainRegion =
  | { kind: 'circle'; x: number; z: number; radius: number }
  | { kind: 'path'; points: Array<[number, number]>; width: number }
  | { kind: 'polygon'; points: Array<[number, number]> };

export interface TerrainGenerationParams {
  preset: TerrainGenerationPreset;
  seed: number;
  amplitude: number;
  roughness: number;
  direction?: number;
}

export interface TerrainModifierParams {
  modifier: TerrainModifier;
  region: TerrainRegion;
  seed: number;
  amplitude: number;
  softness: number;
  direction: number;
  variation: number;
  layers: number;
  layout: TerrainCliffLayout;
}

export interface TerrainSurfaceParams {
  surface: TerrainSurfaceKind;
  region: TerrainRegion;
  intensity: number;
  zoneId: string;
}

export interface TerrainCapabilityDefinition {
  id: string;
  label: string;
  category: 'base' | 'modifier' | 'surface';
  regionKinds: readonly TerrainRegionKind[];
}

const ALL_REGIONS = TERRAIN_REGION_KINDS;

/** One shared catalog drives UI choices, AI instructions and external manifests. */
export const TERRAIN_CAPABILITIES: readonly TerrainCapabilityDefinition[] = Object.freeze([
  ...[
    ['plain', '平原'],
    ['hills', '丘陵'],
    ['valley', '山谷'],
    ['island', '小岛'],
    ['archipelago', '群岛'],
    ['canyon', '峡谷'],
    ['cliff-plateau', '峭壁高原'],
    ['dune-desert', '沙丘荒漠']
  ].map(([id, label]) => ({ id: `base.${id}`, label, category: 'base' as const, regionKinds: [] })),
  { id: 'modifier.mountain', label: '山峦', category: 'modifier', regionKinds: ALL_REGIONS },
  { id: 'modifier.cliff', label: '峭壁', category: 'modifier', regionKinds: ALL_REGIONS },
  { id: 'modifier.terrace', label: '梯田', category: 'modifier', regionKinds: ALL_REGIONS },
  { id: 'modifier.dune', label: '沙丘', category: 'modifier', regionKinds: ALL_REGIONS },
  { id: 'modifier.island', label: '局部小岛', category: 'modifier', regionKinds: ['circle', 'polygon'] },
  { id: 'surface.grass', label: '草地', category: 'surface', regionKinds: ALL_REGIONS },
  { id: 'surface.sand', label: '沙地', category: 'surface', regionKinds: ALL_REGIONS },
  { id: 'surface.rock', label: '岩地', category: 'surface', regionKinds: ALL_REGIONS }
]);

export function terrainCapabilitySummary(): unknown[] {
  return TERRAIN_CAPABILITIES.map((capability) => ({
    id: capability.id,
    label: capability.label,
    category: capability.category,
    regionKinds: capability.regionKinds
  }));
}

export function normalizeTerrainGenerationParams(value: unknown, map: EditableMap): TerrainGenerationParams {
  const input = objectValue(value, 'invalid_terrain_generation');
  if (!TERRAIN_GENERATION_PRESETS.includes(input.preset as TerrainGenerationPreset)) {
    throw new Error('invalid_terrain_generation');
  }
  const preset = input.preset as TerrainGenerationPreset;
  const defaultAmplitude = preset === 'plain' ? 0 : map.box.size[1] * 0.42;
  return {
    preset,
    seed: normalizeSeed(input.seed, map.seed),
    amplitude: clamp(finiteNumber(input.amplitude, defaultAmplitude), 0, map.box.size[1] - 0.05),
    roughness: clamp(finiteNumber(input.roughness, 0.55), 0, 1),
    direction: wrapDegrees(finiteNumber(input.direction, (map.seed % 360)))
  };
}

export function normalizeTerrainModifierParams(value: unknown, map: EditableMap): TerrainModifierParams {
  const input = objectValue(value, 'invalid_terrain_modifier');
  if (!TERRAIN_MODIFIERS.includes(input.modifier as TerrainModifier)) throw new Error('invalid_terrain_modifier');
  const modifier = input.modifier as TerrainModifier;
  const layout = TERRAIN_CLIFF_LAYOUTS.includes(input.layout as TerrainCliffLayout)
    ? input.layout as TerrainCliffLayout
    : 'plateau';
  const region = normalizeTerrainRegion(input.region, map);
  if (modifier === 'island' && region.kind === 'path') throw new Error('invalid_terrain_modifier_region');
  return {
    modifier,
    region,
    seed: normalizeSeed(input.seed, map.seed),
    amplitude: clamp(finiteNumber(input.amplitude, map.box.size[1] * 0.3), 0.05, map.box.size[1] - 0.05),
    softness: clamp(finiteNumber(input.softness, 0.2), 0, 1),
    direction: wrapDegrees(finiteNumber(input.direction, map.seed % 360)),
    variation: clamp(finiteNumber(input.variation, 0.45), 0, 1),
    layers: Math.round(clamp(finiteNumber(input.layers, 4), 2, 12)),
    layout
  };
}

export function normalizeTerrainSurfaceParams(value: unknown, map: EditableMap): TerrainSurfaceParams {
  const input = objectValue(value, 'invalid_terrain_surface');
  if (!TERRAIN_SURFACES.includes(input.surface as TerrainSurfaceKind)) throw new Error('invalid_terrain_surface');
  const surface = input.surface as TerrainSurfaceKind;
  const region = normalizeTerrainRegion(input.region, map);
  return {
    surface,
    region,
    intensity: clamp(finiteNumber(input.intensity, 1), 0.05, 1),
    zoneId: cleanZoneId(input.zoneId, surfaceZoneId(surface, region))
  };
}

export function generateTerrainInPlace(map: EditableMap, value: unknown): TerrainGenerationParams {
  const params = normalizeTerrainGenerationParams(value, map);
  const terrain = map.terrain;
  const maxHeight = map.box.size[1] - 0.05;
  const rotateAxis = (params.seed & 1) === 1;
  const angle = (params.direction ?? 0) * Math.PI / 180;
  const directionX = Math.cos(angle);
  const directionZ = Math.sin(angle);
  const archipelagoCenters = createArchipelagoCenters(params.seed);

  for (let z = 0; z < terrain.resolutionZ; z += 1) {
    const nz = z / Math.max(1, terrain.resolutionZ - 1) * 2 - 1;
    for (let x = 0; x < terrain.resolutionX; x += 1) {
      const nx = x / Math.max(1, terrain.resolutionX - 1) * 2 - 1;
      const axis = rotateAxis ? nz : nx;
      const crossAxis = rotateAxis ? nx : nz;
      const noise = fbm((nx + 1) * 1.7, (nz + 1) * 1.7, params.seed, params.roughness);
      const detail = (noise + 1) / 2;
      let height = 0;

      switch (params.preset) {
        case 'plain':
          height = 0;
          break;
        case 'hills':
          height = params.amplitude * (0.12 + detail * 0.78);
          break;
        case 'valley': {
          const valleyAxis = Math.abs(axis + noise * 0.16);
          height = params.amplitude * (0.08 + Math.pow(valleyAxis, 1.55) * 0.72 + detail * 0.12);
          break;
        }
        case 'island': {
          const radius = Math.min(1.25, Math.hypot(nx, nz));
          const falloff = smoothstep(1.08, 0.16, radius);
          height = params.amplitude * (falloff * (0.55 + detail * 0.38) - (1 - falloff) * 0.08);
          break;
        }
        case 'archipelago': {
          const island = archipelagoCenters.reduce((strongest, center) => {
            const radius = Math.hypot(nx - center.x, nz - center.z) / center.radius;
            return Math.max(strongest, smoothstep(1.05, 0.08, radius) * center.height);
          }, 0);
          height = params.amplitude * (island * (0.55 + detail * 0.35) - (1 - island) * 0.09);
          break;
        }
        case 'canyon': {
          const wanderingAxis = Math.abs(axis + noise * 0.2 + Math.sin(crossAxis * 2.4) * 0.06);
          const wall = smoothstep(0.12, 0.52, wanderingAxis);
          height = params.amplitude * (0.06 + wall * 0.82 + detail * 0.08);
          break;
        }
        case 'cliff-plateau': {
          const edge = axis + noise * (0.025 + params.roughness * 0.055);
          const plateau = smoothstep(-0.025, 0.025, edge);
          height = params.amplitude * (0.06 + plateau * 0.86 + detail * 0.06);
          break;
        }
        case 'dune-desert': {
          const alongWind = nx * directionX + nz * directionZ;
          const acrossWind = -nx * directionZ + nz * directionX;
          const wave = 0.5 + 0.5 * Math.sin(alongWind * Math.PI * 7 + noise * 1.6 + Math.sin(acrossWind * 5) * 0.4);
          const dunes = Math.pow(wave, 1.4);
          height = params.amplitude * (0.04 + dunes * 0.5 + detail * 0.16);
          break;
        }
      }
      terrain.heights[z * terrain.resolutionX + x] = clamp(height, TERRAIN_MIN_HEIGHT, maxHeight);
    }
  }
  return params;
}

export function applyTerrainModifierInPlace(map: EditableMap, value: unknown): TerrainModifierParams {
  const params = normalizeTerrainModifierParams(value, map);
  const terrain = map.terrain;
  const maxHeight = map.box.size[1] - 0.05;
  const angle = params.direction * Math.PI / 180;
  const directionX = Math.cos(angle);
  const directionZ = Math.sin(angle);
  const scale = regionScale(params.region);
  const terraceStep = params.amplitude / params.layers;

  for (let zIndex = 0; zIndex < terrain.resolutionZ; zIndex += 1) {
    for (let xIndex = 0; xIndex < terrain.resolutionX; xIndex += 1) {
      const point = terrainPointAt(map, xIndex, zIndex);
      const weight = regionWeight(params.region, point[0], point[2], params.softness);
      if (weight <= 0) continue;
      const index = terrainIndex(terrain, xIndex, zIndex);
      const current = terrain.heights[index] ?? 0;
      const noise = fbm(
        point[0] / Math.max(1, scale) * 2,
        point[2] / Math.max(1, scale) * 2,
        params.seed,
        params.variation
      );
      let next = current;

      switch (params.modifier) {
        case 'mountain': {
          const roundedWeight = mountainRegionWeight(params.region, point[0], point[2], params.softness);
          const broadNoise = (fbm(
            point[0] / Math.max(1, scale) * 4,
            point[2] / Math.max(1, scale) * 4,
            params.seed + 4049,
            0.25 + params.variation * 0.5
          ) + 1) / 2;
          const peakNoise = (fbm(
            point[0] / Math.max(1, scale) * 9,
            point[2] / Math.max(1, scale) * 9,
            params.seed + 8087,
            params.variation
          ) + 1) / 2;
          const rollingPeaks = smoothstep(0.22, 0.82, broadNoise);
          next = current + params.amplitude * roundedWeight * (0.22 + rollingPeaks * 0.65 + peakNoise * 0.13);
          break;
        }
        case 'cliff': {
          if (params.layout === 'terraces') {
            const lifted = current + params.amplitude * weight;
            next = lerp(current, Math.round(lifted / terraceStep) * terraceStep, weight);
          } else if (params.layout === 'canyon') {
            next = current - params.amplitude * weight;
          } else if (params.layout === 'wall') {
            next = current + params.amplitude * Math.pow(weight, 0.45);
          } else if (params.region.kind === 'path') {
            const side = signedDistanceToPath(point[0], point[2], params.region.points);
            const sideWeight = smoothstep(-Math.max(0.05, params.region.width * params.softness), Math.max(0.05, params.region.width * params.softness), side);
            next = current + params.amplitude * weight * sideWeight;
          } else {
            next = current + params.amplitude * weight;
          }
          break;
        }
        case 'terrace': {
          const lifted = current + params.amplitude * weight;
          const terraced = Math.round(lifted / terraceStep) * terraceStep;
          next = lerp(current, terraced, weight);
          break;
        }
        case 'dune': {
          const projected = point[0] * directionX + point[2] * directionZ;
          const wavelength = Math.max(1.2, scale / (3 + params.variation * 4));
          const wave = Math.pow(0.5 + 0.5 * Math.sin(projected / wavelength * Math.PI * 2 + noise * 1.8), 1.45);
          next = current + params.amplitude * wave * weight;
          break;
        }
        case 'island': {
          next = current + params.amplitude * (0.72 + noise * 0.12) * weight;
          break;
        }
      }
      terrain.heights[index] = clamp(next, TERRAIN_MIN_HEIGHT, maxHeight);
    }
  }
  return params;
}

export function applyTerrainSurfaceInPlace(map: EditableMap, value: unknown): TerrainSurfaceParams {
  const params = normalizeTerrainSurfaceParams(value, map);
  const bounds = regionBounds(params.region);
  const tagMap: Record<TerrainSurfaceKind, VisualZoneTag[]> = {
    grass: ['grass'],
    sand: ['sand', 'dry'],
    rock: ['rocky']
  };
  const zone = {
    id: params.zoneId,
    tags: tagMap[params.surface],
    center: bounds.center,
    radius: bounds.radius,
    intensity: params.intensity
  };
  const existing = map.visualSemantics.zones.findIndex((item) => item.id === zone.id);
  if (existing >= 0) map.visualSemantics.zones[existing] = zone;
  else map.visualSemantics.zones.push(zone);
  map.visualSemantics.zones = map.visualSemantics.zones.slice(-24);
  if (params.surface === 'sand' && !map.renderPromptSuggestions.includes('沙地流动与低空飞沙')) {
    map.renderPromptSuggestions = [...map.renderPromptSuggestions, '沙地流动与低空飞沙'].slice(-8);
  }
  return params;
}

export function normalizeTerrainRegion(value: unknown, map: EditableMap): TerrainRegion {
  const input = objectValue(value, 'invalid_terrain_region');
  const kind = input.kind;
  const halfWidth = map.box.size[0] / 2;
  const halfDepth = map.box.size[2] / 2;
  const point = (raw: unknown): [number, number] => {
    const pair = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? [(raw as Record<string, unknown>).x, (raw as Record<string, unknown>).z]
        : [];
    if (pair.length < 2 || !pair.every((item) => Number.isFinite(Number(item)))) throw new Error('invalid_terrain_region');
    return [clamp(Number(pair[0]), -halfWidth, halfWidth), clamp(Number(pair[1]), -halfDepth, halfDepth)];
  };
  if (kind === 'circle') {
    return {
      kind,
      x: clamp(finiteNumber(input.x, 0), -halfWidth, halfWidth),
      z: clamp(finiteNumber(input.z, 0), -halfDepth, halfDepth),
      radius: clamp(finiteNumber(input.radius ?? input.r, Math.min(map.box.size[0], map.box.size[2]) * 0.15), 0.3, Math.max(map.box.size[0], map.box.size[2]))
    };
  }
  if (kind === 'path' || kind === 'polygon') {
    if (!Array.isArray(input.points)) throw new Error('invalid_terrain_region');
    const points = input.points.slice(0, 64).map(point);
    if (points.length < (kind === 'path' ? 2 : 3)) throw new Error('invalid_terrain_region');
    return kind === 'path'
      ? { kind, points, width: clamp(finiteNumber(input.width, 4), 0.3, Math.max(map.box.size[0], map.box.size[2])) }
      : { kind, points };
  }
  throw new Error('invalid_terrain_region');
}

function regionWeight(region: TerrainRegion, x: number, z: number, softness: number): number {
  if (region.kind === 'circle') {
    const distance = Math.hypot(x - region.x, z - region.z);
    const feather = Math.max(0.05, region.radius * softness);
    return 1 - smoothstep(region.radius - feather, region.radius, distance);
  }
  if (region.kind === 'path') {
    const distance = distanceToPath(x, z, region.points);
    const halfWidth = region.width / 2;
    const feather = Math.max(0.05, halfWidth * softness);
    return 1 - smoothstep(halfWidth - feather, halfWidth, distance);
  }
  if (!pointInPolygon(x, z, region.points)) return 0;
  if (softness <= 0) return 1;
  const feather = Math.max(0.05, regionScale(region) * softness * 0.2);
  return smoothstep(0, feather, polygonEdgeDistance(x, z, region.points));
}

function mountainRegionWeight(region: TerrainRegion, x: number, z: number, softness: number): number {
  const profilePower = lerp(1.6, 0.7, softness);
  if (region.kind === 'circle') {
    return Math.pow(smoothstep(0, 1, 1 - Math.hypot(x - region.x, z - region.z) / Math.max(0.05, region.radius)), profilePower);
  }
  if (region.kind === 'path') {
    return Math.pow(smoothstep(0, 1, 1 - distanceToPath(x, z, region.points) / Math.max(0.05, region.width / 2)), profilePower);
  }
  return regionWeight(region, x, z, Math.max(0.45, softness));
}

function regionBounds(region: TerrainRegion): { center: [number, number]; radius: number } {
  if (region.kind === 'circle') return { center: [region.x, region.z], radius: region.radius };
  const xs = region.points.map((point) => point[0]);
  const zs = region.points.map((point) => point[1]);
  const center: [number, number] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
  const extra = region.kind === 'path' ? region.width / 2 : 0;
  return {
    center,
    radius: Math.max(0.5, ...region.points.map((point) => Math.hypot(point[0] - center[0], point[1] - center[1]))) + extra
  };
}

function regionScale(region: TerrainRegion): number {
  return regionBounds(region).radius * 2;
}

function createArchipelagoCenters(seed: number): Array<{ x: number; z: number; radius: number; height: number }> {
  return Array.from({ length: 5 }, (_, index) => ({
    x: (hash01(seed, index * 3) - 0.5) * 1.25,
    z: (hash01(seed, index * 3 + 1) - 0.5) * 1.25,
    radius: 0.28 + hash01(seed, index * 3 + 2) * 0.28,
    height: index === 0 ? 1 : 0.58 + hash01(seed + 11, index) * 0.32
  }));
}

function surfaceZoneId(surface: TerrainSurfaceKind, region: TerrainRegion): string {
  const source = JSON.stringify(region);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `terrain-${surface}-${(hash >>> 0).toString(36)}`;
}

function cleanZoneId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim().replace(/[^a-zA-Z0-9:_-]/g, '-').slice(0, 80);
  return clean || fallback;
}

function fbm(x: number, z: number, seed: number, roughness: number): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  const gain = 0.34 + roughness * 0.28;
  const lacunarity = 1.8 + roughness * 0.7;
  for (let octave = 0; octave < 4; octave += 1) {
    value += valueNoise(x * frequency, z * frequency, seed + octave * 1013) * amplitude;
    total += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return total > 0 ? value / total : 0;
}

function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  const a = hashNoise(x0, z0, seed);
  const b = hashNoise(x0 + 1, z0, seed);
  const c = hashNoise(x0, z0 + 1, seed);
  const d = hashNoise(x0 + 1, z0 + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

function hashNoise(x: number, z: number, seed: number): number {
  let value = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 69069);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 2147483647.5 - 1;
}

function hash01(seed: number, salt: number): number {
  return (hashNoise(salt, salt * 13 + 7, seed) + 1) / 2;
}

function distanceToPath(x: number, z: number, points: readonly [number, number][]): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    closest = Math.min(closest, distanceToSegment(x, z, points[index - 1], points[index]));
  }
  return closest;
}

function signedDistanceToPath(x: number, z: number, points: readonly [number, number][]): number {
  let closest = Number.POSITIVE_INFINITY;
  let signed = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const distance = distanceToSegment(x, z, start, end);
    if (distance >= closest) continue;
    closest = distance;
    signed = Math.sign((end[0] - start[0]) * (z - start[1]) - (end[1] - start[1]) * (x - start[0])) * distance;
  }
  return signed;
}

function distanceToSegment(x: number, z: number, start: readonly [number, number], end: readonly [number, number]): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0.000001) return Math.hypot(x - start[0], z - start[1]);
  const t = clamp(((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared, 0, 1);
  return Math.hypot(x - (start[0] + t * dx), z - (start[1] + t * dz));
}

function polygonEdgeDistance(x: number, z: number, points: readonly [number, number][]): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    closest = Math.min(closest, distanceToSegment(x, z, points[index], points[(index + 1) % points.length]));
  }
  return closest;
}

function pointInPolygon(x: number, z: number, points: readonly [number, number][]): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const a = points[current];
    const b = points[previous];
    if ((a[1] > z) !== (b[1] > z)
      && x < (b[0] - a[0]) * (z - a[1]) / ((b[1] - a[1]) || Number.EPSILON) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function objectValue(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error(error);
  return value as Record<string, unknown>;
}

function normalizeSeed(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) >>> 0 : fallback >>> 0;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function wrapDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / ((edge1 - edge0) || Number.EPSILON), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
