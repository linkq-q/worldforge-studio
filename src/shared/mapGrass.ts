import type { EditableMap } from './map';

export type GrassBrushMode = 'add' | 'erase' | 'density' | 'smooth';

export interface GrassVariantMix {
  short: number;
  tall: number;
  flowers: number;
}

export interface MapGrassLayer {
  id: string;
  name: string;
  visible: boolean;
  seed: number;
  resolutionX: number;
  resolutionZ: number;
  densities: number[];
  mix: GrassVariantMix;
}

export type GrassRegion =
  | { kind: 'circle'; center: [number, number]; radius: number }
  | { kind: 'polygon'; points: Array<[number, number]> };

export interface GrassLayerInput {
  id?: string;
  name?: string;
  visible?: boolean;
  seed?: number;
  densities?: number[];
  mix?: Partial<GrassVariantMix>;
}

export type GrassLayerPatch = Pick<GrassLayerInput, 'name' | 'visible' | 'seed' | 'mix'>;

export const MAX_GRASS_LAYERS = 8;
export const DEFAULT_GRASS_MIX: GrassVariantMix = { short: 0.7, tall: 0.2, flowers: 0.1 };

export function normalizeGrassLayers(
  value: unknown,
  resolutionX: number,
  resolutionZ: number
): MapGrassLayer[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const layers: MapGrassLayer[] = [];
  for (const raw of value.slice(0, MAX_GRASS_LAYERS)) {
    if (!raw || typeof raw !== 'object') continue;
    const input = raw as Partial<MapGrassLayer>;
    const id = cleanText(input.id, '') || createGrassId();
    if (seen.has(id)) continue;
    seen.add(id);
    const sourceX = positiveInt(input.resolutionX, resolutionX);
    const sourceZ = positiveInt(input.resolutionZ, resolutionZ);
    const source = normalizeDensityArray(input.densities, sourceX * sourceZ);
    layers.push({
      id,
      name: cleanText(input.name, `草地 ${layers.length + 1}`),
      visible: input.visible !== false,
      seed: finiteSeed(input.seed, layers.length + 1),
      resolutionX,
      resolutionZ,
      densities: sourceX === resolutionX && sourceZ === resolutionZ
        ? normalizeDensityArray(source, resolutionX * resolutionZ)
        : resampleDensity(source, sourceX, sourceZ, resolutionX, resolutionZ),
      mix: normalizeGrassMix(input.mix)
    });
  }
  return layers;
}

export function createGrassLayer(
  input: GrassLayerInput,
  resolutionX: number,
  resolutionZ: number,
  fallbackSeed = 1
): MapGrassLayer {
  return normalizeGrassLayers([{
    ...input,
    id: cleanText(input.id, '') || createGrassId(),
    seed: finiteSeed(input.seed, fallbackSeed),
    resolutionX,
    resolutionZ
  }], resolutionX, resolutionZ)[0];
}

export function updateGrassLayer(layer: MapGrassLayer, patch: GrassLayerPatch): MapGrassLayer {
  return {
    ...layer,
    name: patch.name === undefined ? layer.name : cleanText(patch.name, layer.name),
    visible: patch.visible === undefined ? layer.visible : patch.visible !== false,
    seed: patch.seed === undefined ? layer.seed : finiteSeed(patch.seed, layer.seed),
    mix: patch.mix === undefined ? layer.mix : normalizeGrassMix({ ...layer.mix, ...patch.mix })
  };
}

export function fillGrassLayerInPlace(map: EditableMap, layerId: string, density: number): void {
  const layer = requireLayer(map, layerId);
  layer.densities.fill(clamp01(density));
}

export function applyGrassBrushInPlace(
  map: EditableMap,
  layerId: string,
  mode: GrassBrushMode,
  point: [number, number],
  size = 3,
  strength = 0.35,
  targetDensity = 0.6
): void {
  const layer = requireLayer(map, layerId);
  const [width, , depth] = map.box.size;
  const radius = Math.max(0.1, finite(size, 3));
  const amount = clamp01(strength);
  const xMin = worldToIndex(point[0] - radius, width, layer.resolutionX);
  const xMax = worldToIndex(point[0] + radius, width, layer.resolutionX);
  const zMin = worldToIndex(point[1] - radius, depth, layer.resolutionZ);
  const zMax = worldToIndex(point[1] + radius, depth, layer.resolutionZ);
  const source = mode === 'smooth' ? [...layer.densities] : layer.densities;
  for (let z = zMin; z <= zMax; z += 1) {
    for (let x = xMin; x <= xMax; x += 1) {
      const worldX = indexToWorld(x, width, layer.resolutionX);
      const worldZ = indexToWorld(z, depth, layer.resolutionZ);
      const distance = Math.hypot(worldX - point[0], worldZ - point[1]);
      if (distance > radius) continue;
      const falloff = (1 - (distance / radius) ** 2) ** 2;
      const index = z * layer.resolutionX + x;
      const current = source[index] ?? 0;
      if (mode === 'add') layer.densities[index] = clamp01(current + amount * falloff);
      else if (mode === 'erase') layer.densities[index] = clamp01(current - amount * falloff);
      else if (mode === 'density') layer.densities[index] = mix(current, clamp01(targetDensity), amount * falloff);
      else layer.densities[index] = mix(current, neighborhoodAverage(source, layer, x, z), amount * falloff);
    }
  }
}

export function generateGrassRegionInPlace(
  map: EditableMap,
  layerId: string,
  region: GrassRegion,
  density = 0.7,
  variation = 0.25,
  softness = 0.2,
  seed?: number
): void {
  const layer = requireLayer(map, layerId);
  const [width, , depth] = map.box.size;
  const baseDensity = clamp01(density);
  const densityVariation = clamp01(variation);
  const edgeSoftness = clamp01(softness);
  const effectiveSeed = finiteSeed(seed, layer.seed);
  for (let z = 0; z < layer.resolutionZ; z += 1) {
    for (let x = 0; x < layer.resolutionX; x += 1) {
      const worldX = indexToWorld(x, width, layer.resolutionX);
      const worldZ = indexToWorld(z, depth, layer.resolutionZ);
      const regionWeight = grassRegionWeight(region, worldX, worldZ, edgeSoftness);
      if (regionWeight <= 0) continue;
      const slopeWeight = grassSlopeWeight(map, x, z);
      const noise = hash01(x, z, effectiveSeed) * 2 - 1;
      const generated = clamp01(baseDensity * (1 + noise * densityVariation) * regionWeight * slopeWeight);
      const index = z * layer.resolutionX + x;
      layer.densities[index] = Math.max(layer.densities[index] ?? 0, generated);
    }
  }
}

export function sampleGrassDensity(layer: MapGrassLayer, map: Pick<EditableMap, 'box'>, x: number, z: number): number {
  if (!layer.visible) return 0;
  const [width, , depth] = map.box.size;
  const u = clamp01(x / Math.max(width, 0.001) + 0.5) * (layer.resolutionX - 1);
  const v = clamp01(z / Math.max(depth, 0.001) + 0.5) * (layer.resolutionZ - 1);
  return bilinear(layer.densities, layer.resolutionX, layer.resolutionZ, u, v);
}

export function combinedGrassDensity(map: Pick<EditableMap, 'box' | 'grassLayers'>, x: number, z: number): number {
  let remaining = 1;
  for (const layer of map.grassLayers) remaining *= 1 - sampleGrassDensity(layer, map, x, z);
  return 1 - remaining;
}

export function normalizeGrassMix(value: Partial<GrassVariantMix> | undefined): GrassVariantMix {
  const short = Math.max(0, finite(value?.short, DEFAULT_GRASS_MIX.short));
  const tall = Math.max(0, finite(value?.tall, DEFAULT_GRASS_MIX.tall));
  const flowers = Math.max(0, finite(value?.flowers, DEFAULT_GRASS_MIX.flowers));
  const total = short + tall + flowers;
  if (total <= 0.0001) return { ...DEFAULT_GRASS_MIX };
  return { short: short / total, tall: tall / total, flowers: flowers / total };
}

function grassSlopeWeight(map: EditableMap, x: number, z: number): number {
  const terrain = map.terrain;
  const left = terrain.heights[z * terrain.resolutionX + Math.max(0, x - 1)] ?? 0;
  const right = terrain.heights[z * terrain.resolutionX + Math.min(terrain.resolutionX - 1, x + 1)] ?? 0;
  const down = terrain.heights[Math.max(0, z - 1) * terrain.resolutionX + x] ?? 0;
  const up = terrain.heights[Math.min(terrain.resolutionZ - 1, z + 1) * terrain.resolutionX + x] ?? 0;
  const stepX = map.box.size[0] / Math.max(1, terrain.resolutionX - 1);
  const stepZ = map.box.size[2] / Math.max(1, terrain.resolutionZ - 1);
  const slope = Math.atan(Math.hypot((right - left) / Math.max(stepX * 2, 0.001), (up - down) / Math.max(stepZ * 2, 0.001))) * 180 / Math.PI;
  if (slope <= 20) return 1;
  if (slope >= 55) return 0;
  const t = (slope - 20) / 35;
  return 1 - t * t * (3 - 2 * t);
}

function grassRegionWeight(region: GrassRegion, x: number, z: number, softness: number): number {
  if (region.kind === 'circle') {
    const radius = Math.max(0.1, finite(region.radius, 1));
    const normalized = Math.hypot(x - region.center[0], z - region.center[1]) / radius;
    if (normalized >= 1) return 0;
    const inner = Math.max(0, 1 - softness);
    return normalized <= inner ? 1 : 1 - smoothstep(inner, 1, normalized);
  }
  if (region.points.length < 3 || !pointInPolygon(x, z, region.points)) return 0;
  if (softness <= 0) return 1;
  const distance = distanceToPolygon(x, z, region.points);
  const bounds = polygonBounds(region.points);
  const fadeDistance = Math.max(0.1, Math.min(bounds.width, bounds.depth) * 0.5 * softness);
  return smoothstep(0, fadeDistance, distance);
}

function requireLayer(map: EditableMap, layerId: string): MapGrassLayer {
  const layer = map.grassLayers.find((item) => item.id === layerId);
  if (!layer) throw new Error('grass_layer_not_found');
  return layer;
}

function normalizeDensityArray(value: unknown, length: number): number[] {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length }, (_, index) => clamp01(finite(source[index], 0)));
}

function resampleDensity(source: number[], sourceX: number, sourceZ: number, targetX: number, targetZ: number): number[] {
  return Array.from({ length: targetX * targetZ }, (_, index) => {
    const x = index % targetX;
    const z = Math.floor(index / targetX);
    return bilinear(
      source,
      sourceX,
      sourceZ,
      (x / Math.max(1, targetX - 1)) * Math.max(0, sourceX - 1),
      (z / Math.max(1, targetZ - 1)) * Math.max(0, sourceZ - 1)
    );
  });
}

function bilinear(values: number[], width: number, height: number, x: number, z: number): number {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const z0 = Math.max(0, Math.min(height - 1, Math.floor(z)));
  const x1 = Math.min(width - 1, x0 + 1);
  const z1 = Math.min(height - 1, z0 + 1);
  const tx = x - x0;
  const tz = z - z0;
  const top = mix(values[z0 * width + x0] ?? 0, values[z0 * width + x1] ?? 0, tx);
  const bottom = mix(values[z1 * width + x0] ?? 0, values[z1 * width + x1] ?? 0, tx);
  return clamp01(mix(top, bottom, tz));
}

function neighborhoodAverage(values: number[], layer: MapGrassLayer, x: number, z: number): number {
  let total = 0;
  let count = 0;
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const px = Math.max(0, Math.min(layer.resolutionX - 1, x + dx));
      const pz = Math.max(0, Math.min(layer.resolutionZ - 1, z + dz));
      total += values[pz * layer.resolutionX + px] ?? 0;
      count += 1;
    }
  }
  return total / count;
}

function worldToIndex(value: number, size: number, resolution: number): number {
  return Math.max(0, Math.min(resolution - 1, Math.floor((value / Math.max(size, 0.001) + 0.5) * (resolution - 1))));
}

function indexToWorld(index: number, size: number, resolution: number): number {
  return -size / 2 + (index / Math.max(1, resolution - 1)) * size;
}

function pointInPolygon(x: number, z: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    if (((zi > z) !== (zj > z)) && x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

function distanceToPolygon(x: number, z: number, points: Array<[number, number]>): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / Math.max(1e-9, dx * dx + dz * dz)));
    distance = Math.min(distance, Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)));
  }
  return distance;
}

function polygonBounds(points: Array<[number, number]>): { width: number; depth: number } {
  const xs = points.map((point) => point[0]);
  const zs = points.map((point) => point[1]);
  return { width: Math.max(...xs) - Math.min(...xs), depth: Math.max(...zs) - Math.min(...zs) };
}

function hash01(x: number, z: number, seed: number): number {
  let value = Math.imul(x + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(z + seed, 0xc2b2ae35);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value >>> 0) / 0xffffffff;
}

function createGrassId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `grass-${random.slice(0, 18)}`;
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Math.round(finite(value, fallback));
  return parsed > 0 ? parsed : fallback;
}

function finiteSeed(value: unknown, fallback: number): number {
  return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) >>> 0 : Math.trunc(fallback) >>> 0;
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
