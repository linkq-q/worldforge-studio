export const MAP_LAYOUT_VERSION = 1 as const;
export const MAP_TECHNICAL_CHUNK_SIZE = 48;
export const MAP_REGION_LIMIT = 32;

export type MapEdgeMaskKind = 'none' | 'circle' | 'heart' | 'noise' | 'polygon' | 'composite';

export interface MapGenerationOwner {
  kind: 'region' | 'seam';
  id: string;
  generationId: string;
}

export interface MapEcologyRegion {
  id: string;
  name: string;
  prompt: string;
  groupId: string | null;
  color: string;
  points: Array<[number, number]>;
  boundaryLocked: boolean;
  contentLocked: boolean;
}

export interface MapEdgeMask {
  kind: MapEdgeMaskKind;
  points: Array<[number, number]>;
  polygons?: Array<Array<[number, number]>>;
  seed: number;
  irregularity: number;
}

export interface MapStitchSource {
  mapId: string;
  name: string;
  version: number;
  offset: [number, number];
}

export interface MapStitchSeam {
  id: string;
  name: string;
  sourceMapIds: [string, string];
  mode: 'contact' | 'corridor';
  width: number;
  irregularity: number;
  seed: number;
  prompt: string;
  locked: boolean;
  points: Array<[number, number]>;
}

export interface MapLayout {
  version: 1;
  globalPrompt: string;
  regions: MapEcologyRegion[];
  edgeMask: MapEdgeMask;
  stitchSources: MapStitchSource[];
  seams: MapStitchSeam[];
}

export interface MapLayoutSize {
  size: [number, number, number];
}

export interface MapLayoutCoverage {
  playableSamples: number;
  uncoveredSamples: number;
  overlappingSamples: number;
  coverageRatio: number;
  valid: boolean;
}

export function createDefaultMapLayout(size: MapLayoutSize['size']): MapLayout {
  return {
    version: MAP_LAYOUT_VERSION,
    globalPrompt: '',
    regions: [],
    edgeMask: createMapEdgeMask('none', size),
    stitchSources: [],
    seams: []
  };
}

export function normalizeMapLayout(value: unknown, size: MapLayoutSize['size']): MapLayout {
  const fallback = createDefaultMapLayout(size);
  if (!value || typeof value !== 'object') return fallback;
  const input = value as Partial<MapLayout>;
  const regions = Array.isArray(input.regions)
    ? input.regions.map((region, index) => normalizeRegion(region, size, index)).filter(Boolean) as MapEcologyRegion[]
    : [];
  const seen = new Set<string>();
  const uniqueRegions = regions.filter((region) => {
    if (seen.has(region.id)) return false;
    seen.add(region.id);
    return true;
  }).slice(0, maxMapRegionCount(size));
  return {
    version: MAP_LAYOUT_VERSION,
    globalPrompt: cleanText(input.globalPrompt, 1_200),
    regions: uniqueRegions,
    edgeMask: normalizeMapEdgeMask(input.edgeMask, size),
    stitchSources: normalizeStitchSources(input.stitchSources),
    seams: normalizeSeams(input.seams, size)
  };
}

export function maxMapRegionCount(size: MapLayoutSize['size']): number {
  const chunksX = Math.max(1, Math.ceil(size[0] / MAP_TECHNICAL_CHUNK_SIZE));
  const chunksZ = Math.max(1, Math.ceil(size[2] / MAP_TECHNICAL_CHUNK_SIZE));
  return Math.min(MAP_REGION_LIMIT, Math.max(2, Math.floor(2 * Math.sqrt(chunksX * chunksZ))));
}

export function createMapEdgeMask(
  kind: MapEdgeMaskKind,
  size: MapLayoutSize['size'],
  seed = 1,
  irregularity = 0.22,
  customPoints?: readonly [number, number][]
): MapEdgeMask {
  const halfWidth = size[0] / 2;
  const halfDepth = size[2] / 2;
  const safeSeed = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 1;
  const safeIrregularity = clamp(Number(irregularity) || 0, 0, 0.65);
  const points = kind === 'polygon' && customPoints
    ? normalizePolygon(customPoints, size)
    : kind === 'circle'
      ? radialPolygon(48, (angle) => [Math.cos(angle) * halfWidth, Math.sin(angle) * halfDepth])
      : kind === 'heart'
        ? heartPolygon(64, halfWidth, halfDepth)
        : kind === 'noise'
          ? noisyPolygon(64, halfWidth, halfDepth, safeSeed, safeIrregularity)
          : rectanglePolygon(size);
  return { kind, points, seed: safeSeed, irregularity: safeIrregularity };
}

export function createCompositeMapEdgeMask(
  size: MapLayoutSize['size'],
  polygons: ReadonlyArray<ReadonlyArray<[number, number]>>,
  seed = 1
): MapEdgeMask {
  const normalized = polygons
    .map((polygon) => normalizePolygon(polygon, size))
    .filter((polygon) => polygon.length >= 3)
    .slice(0, 64);
  if (normalized.length === 0) return createMapEdgeMask('none', size, seed);
  return { kind: 'composite', points: normalized[0], polygons: normalized, seed: Math.trunc(seed) >>> 0, irregularity: 0 };
}

export function normalizeMapEdgeMask(value: unknown, size: MapLayoutSize['size']): MapEdgeMask {
  if (!value || typeof value !== 'object') return createMapEdgeMask('none', size);
  const input = value as Partial<MapEdgeMask>;
  const kind: MapEdgeMaskKind = ['none', 'circle', 'heart', 'noise', 'polygon', 'composite'].includes(String(input.kind))
    ? input.kind as MapEdgeMaskKind
    : 'none';
  if (kind === 'composite') {
    return createCompositeMapEdgeMask(size, Array.isArray(input.polygons) ? input.polygons : [input.points ?? []], Number(input.seed));
  }
  return createMapEdgeMask(kind, size, Number(input.seed), Number(input.irregularity), input.points);
}

export function isPointInsidePlayableArea(
  layout: Pick<MapLayout, 'edgeMask'>,
  size: MapLayoutSize['size'],
  x: number,
  z: number
): boolean {
  const halfWidth = size[0] / 2;
  const halfDepth = size[2] / 2;
  if (x < -halfWidth || x > halfWidth || z < -halfDepth || z > halfDepth) return false;
  if (layout.edgeMask.kind === 'none') return true;
  if (layout.edgeMask.kind === 'composite') {
    return (layout.edgeMask.polygons ?? [layout.edgeMask.points]).some((polygon) => pointInPolygon(x, z, polygon));
  }
  return pointInPolygon(x, z, layout.edgeMask.points);
}

export function pointInMapRegion(region: MapEcologyRegion, x: number, z: number): boolean {
  return pointInPolygon(x, z, region.points);
}

export function measureMapLayoutCoverage(
  layout: Pick<MapLayout, 'edgeMask' | 'regions'>,
  size: MapLayoutSize['size'],
  samples = 48
): MapLayoutCoverage {
  let playableSamples = 0;
  let uncoveredSamples = 0;
  let overlappingSamples = 0;
  const count = Math.max(8, Math.min(128, Math.round(samples)));
  for (const gridSize of [count, count + 1]) {
    for (let row = 0; row < gridSize; row += 1) {
      const z = -size[2] / 2 + (row + 0.5) / gridSize * size[2];
      for (let column = 0; column < gridSize; column += 1) {
        const x = -size[0] / 2 + (column + 0.5) / gridSize * size[0];
        if (!isPointInsidePlayableArea(layout, size, x, z)) continue;
        playableSamples += 1;
        const matches = layout.regions.filter((region) => pointInMapRegion(region, x, z)).length;
        if (matches === 0) uncoveredSamples += 1;
        else if (matches > 1) overlappingSamples += 1;
      }
    }
  }
  const exactSamples = playableSamples - uncoveredSamples - overlappingSamples;
  const coverageRatio = playableSamples > 0 ? exactSamples / playableSamples : 0;
  return {
    playableSamples,
    uncoveredSamples,
    overlappingSamples,
    coverageRatio,
    valid: playableSamples > 0 && uncoveredSamples === 0 && overlappingSamples === 0
  };
}

export function findAdjacentMapRegion(
  regions: readonly MapEcologyRegion[],
  region: MapEcologyRegion
): MapEcologyRegion | null {
  return regions
    .filter((candidate) => candidate !== region)
    .map((candidate) => ({ candidate, shared: sharedPointCount(region.points, candidate.points) }))
    .filter((entry) => entry.shared >= 2)
    .sort((left, right) => right.shared - left.shared || left.candidate.id.localeCompare(right.candidate.id))[0]?.candidate ?? null;
}

export function pointInPolygon(x: number, z: number, points: readonly [number, number][]): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [xi, zi] = points[index];
    const [xj, zj] = points[previous];
    if (((zi > z) !== (zj > z)) && x < ((xj - xi) * (z - zi)) / (zj - zi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

export function regionCenter(region: Pick<MapEcologyRegion, 'points'>): [number, number] {
  if (region.points.length === 0) return [0, 0];
  return [
    region.points.reduce((sum, point) => sum + point[0], 0) / region.points.length,
    region.points.reduce((sum, point) => sum + point[1], 0) / region.points.length
  ];
}

export function splitMapRegion(
  region: MapEcologyRegion,
  axis: 'x' | 'z'
): [MapEcologyRegion, MapEcologyRegion] | null {
  if (region.boundaryLocked) return null;
  const coordinate = regionCenter(region)[axis === 'x' ? 0 : 1];
  const firstPoints = clipPolygon(region.points, axis, coordinate, true);
  const secondPoints = clipPolygon(region.points, axis, coordinate, false);
  if (firstPoints.length < 3 || secondPoints.length < 3) return null;
  return [
    { ...region, id: `${region.id}-a`.slice(0, 80), name: `${region.name} A`, points: firstPoints },
    { ...region, id: `${region.id}-b`.slice(0, 80), name: `${region.name} B`, points: secondPoints }
  ];
}

export function mergeMapRegions(primary: MapEcologyRegion, secondary: MapEcologyRegion): MapEcologyRegion {
  if (primary.boundaryLocked || secondary.boundaryLocked) throw new Error('ecology_region_boundary_locked');
  return {
    ...primary,
    prompt: [primary.prompt, secondary.prompt].filter(Boolean).join('\n').slice(0, 1_200),
    points: convexHull([...primary.points, ...secondary.points])
  };
}

export function rectanglePolygon(size: MapLayoutSize['size']): Array<[number, number]> {
  const halfWidth = size[0] / 2;
  const halfDepth = size[2] / 2;
  return [
    [-halfWidth, -halfDepth],
    [halfWidth, -halfDepth],
    [halfWidth, halfDepth],
    [-halfWidth, halfDepth]
  ];
}

function normalizeRegion(
  value: unknown,
  size: MapLayoutSize['size'],
  index: number
): MapEcologyRegion | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<MapEcologyRegion>;
  const points = normalizePolygon(input.points, size);
  if (points.length < 3) return null;
  const id = cleanId(input.id, `region-${index + 1}`);
  return {
    id,
    name: cleanText(input.name, 80) || `区块 ${index + 1}`,
    prompt: cleanText(input.prompt, 1_200),
    groupId: typeof input.groupId === 'string' && input.groupId.trim() ? cleanId(input.groupId, '') : null,
    color: /^#[0-9a-f]{6}$/i.test(String(input.color)) ? String(input.color) : regionColor(index),
    points,
    boundaryLocked: input.boundaryLocked === true,
    contentLocked: input.contentLocked === true
  };
}

function sharedPointCount(
  first: readonly [number, number][],
  second: readonly [number, number][]
): number {
  return first.filter((point) => second.some((candidate) => (
    Math.abs(point[0] - candidate[0]) < 0.001
    && Math.abs(point[1] - candidate[1]) < 0.001
  ))).length;
}

function normalizeStitchSources(value: unknown): MapStitchSource[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((raw): MapStitchSource[] => {
    if (!raw || typeof raw !== 'object') return [];
    const input = raw as Partial<MapStitchSource>;
    if (typeof input.mapId !== 'string' || !input.mapId.trim()) return [];
    return [{
      mapId: cleanId(input.mapId, ''),
      name: cleanText(input.name, 80) || input.mapId,
      version: Math.max(1, Math.round(Number(input.version) || 1)),
      offset: normalizePoint(input.offset, [Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER])
    }];
  });
}

function normalizeSeams(value: unknown, size: MapLayoutSize['size']): MapStitchSeam[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((raw, index): MapStitchSeam[] => {
    if (!raw || typeof raw !== 'object') return [];
    const input = raw as Partial<MapStitchSeam>;
    if (!Array.isArray(input.sourceMapIds) || input.sourceMapIds.length < 2) return [];
    const sourceMapIds: [string, string] = [cleanId(input.sourceMapIds[0], ''), cleanId(input.sourceMapIds[1], '')];
    if (!sourceMapIds[0] || !sourceMapIds[1]) return [];
    return [{
      id: cleanId(input.id, `seam-${index + 1}`),
      name: cleanText(input.name, 80) || `接缝 ${index + 1}`,
      sourceMapIds,
      mode: input.mode === 'corridor' ? 'corridor' : 'contact',
      width: clamp(Number(input.width) || 24, 8, 96),
      irregularity: clamp(Number.isFinite(Number(input.irregularity)) ? Number(input.irregularity) : 0.25, 0, 0.65),
      seed: Math.trunc(Number(input.seed) || index + 1) >>> 0,
      prompt: cleanText(input.prompt, 1_200),
      locked: input.locked === true,
      points: normalizePolygon(input.points, size).slice(0, 64)
    }];
  });
}

function normalizePolygon(value: unknown, size: MapLayoutSize['size']): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const halfWidth = size[0] / 2;
  const halfDepth = size[2] / 2;
  return value.slice(0, 128).flatMap((point): Array<[number, number]> => {
    if (!Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every(Number.isFinite)) return [];
    return [[clamp(Number(point[0]), -halfWidth, halfWidth), clamp(Number(point[1]), -halfDepth, halfDepth)]];
  });
}

function normalizePoint(value: unknown, limits: [number, number, number]): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return [0, 0];
  return [clamp(Number(value[0]) || 0, -limits[0], limits[0]), clamp(Number(value[1]) || 0, -limits[2], limits[2])];
}

function radialPolygon(count: number, pointAt: (angle: number) => [number, number]): Array<[number, number]> {
  return Array.from({ length: count }, (_, index) => pointAt(index / count * Math.PI * 2));
}

function clipPolygon(
  points: readonly [number, number][],
  axis: 'x' | 'z',
  coordinate: number,
  keepLower: boolean
): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  const component = axis === 'x' ? 0 : 1;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[(index + points.length - 1) % points.length];
    const currentInside = keepLower ? current[component] <= coordinate : current[component] >= coordinate;
    const previousInside = keepLower ? previous[component] <= coordinate : previous[component] >= coordinate;
    if (currentInside !== previousInside) {
      const t = (coordinate - previous[component]) / (current[component] - previous[component] || 1e-9);
      result.push([
        previous[0] + (current[0] - previous[0]) * t,
        previous[1] + (current[1] - previous[1]) * t
      ]);
    }
    if (currentInside) result.push([...current]);
  }
  return result;
}

function convexHull(points: readonly [number, number][]): Array<[number, number]> {
  const sorted = [...points]
    .map((point) => [point[0], point[1]] as [number, number])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (sorted.length <= 3) return sorted;
  const cross = (origin: [number, number], a: [number, number], b: [number, number]) => (
    (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
  );
  const lower: Array<[number, number]> = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Array<[number, number]> = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function heartPolygon(count: number, halfWidth: number, halfDepth: number): Array<[number, number]> {
  const raw = radialPolygon(count, (angle) => {
    const x = 16 * Math.sin(angle) ** 3;
    const z = 13 * Math.cos(angle) - 5 * Math.cos(2 * angle) - 2 * Math.cos(3 * angle) - Math.cos(4 * angle);
    return [x / 17 * halfWidth * 0.92, -z / 17 * halfDepth * 0.92];
  });
  return raw.reverse();
}

function noisyPolygon(
  count: number,
  halfWidth: number,
  halfDepth: number,
  seed: number,
  irregularity: number
): Array<[number, number]> {
  return radialPolygon(count, (angle) => {
    const wave = Math.sin(angle * 3 + seed * 0.17) * 0.55
      + Math.sin(angle * 7 - seed * 0.11) * 0.3
      + Math.sin(angle * 13 + seed * 0.07) * 0.15;
    const radius = 0.9 * (1 + wave * irregularity);
    return [Math.cos(angle) * halfWidth * radius, Math.sin(angle) * halfDepth * radius];
  });
}

function regionColor(index: number): string {
  const palette = ['#4f8fdd', '#49a078', '#db8a4b', '#9b6bd3', '#d65f7e', '#79a63a', '#4ca7a5', '#c6a240'];
  return palette[index % palette.length];
}

function cleanId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().replace(/[^a-zA-Z0-9:_-]+/g, '-').slice(0, 80) || fallback;
}

function cleanText(value: unknown, length: number): string {
  return typeof value === 'string' ? value.trim().slice(0, length) : '';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
