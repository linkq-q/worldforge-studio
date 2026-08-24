import type { MapGenerationOwner } from './mapLayout';
import type { Vec3 } from './protocol';

export const MAP_GUIDE_CURVES = ['polyline', 'catmull-rom'] as const;
export type MapGuideCurve = typeof MAP_GUIDE_CURVES[number];

export interface MapGuide {
  id: string;
  name: string;
  points: Array<[number, number]>;
  curve: MapGuideCurve;
  closed: boolean;
  width: number;
  tags: string[];
  generation?: MapGenerationOwner;
}

export interface MapGuideSample {
  x: number;
  z: number;
  distance: number;
  tangentX: number;
  tangentZ: number;
  yaw: number;
}

export interface SampleMapGuideOptions {
  spacing: number;
  offset?: number;
  startOffset?: number;
  endOffset?: number;
}

export interface ParallelMapGuideOptions {
  idPrefix: string;
  namePrefix?: string;
  region: Array<[number, number]>;
  direction: number;
  spacing: number;
  width?: number;
  inset?: number;
  tags?: string[];
  generation?: MapGenerationOwner;
}

export interface MapStreetGridOptions {
  idPrefix: string;
  region: Array<[number, number]>;
  direction: number;
  blockWidth: number;
  blockDepth: number;
  roadWidth: number;
  inset?: number;
  tags?: string[];
  generation?: MapGenerationOwner;
}

export interface MapPlannedBlock {
  id: string;
  points: Array<[number, number]>;
  center: [number, number];
}

export interface MapStreetGrid {
  streets: MapGuide[];
  blocks: MapPlannedBlock[];
}

const MAX_GUIDES = 96;
const MAX_GUIDE_POINTS = 96;
const CURVE_STEPS_PER_SEGMENT = 12;

export function normalizeMapGuides(value: unknown, boxSize: Vec3): MapGuide[] {
  if (!Array.isArray(value)) return [];
  const halfWidth = Math.max(0.5, boxSize[0] / 2);
  const halfDepth = Math.max(0.5, boxSize[2] / 2);
  const maxGuideWidth = Math.max(0.2, Math.min(boxSize[0], boxSize[2]));
  const seen = new Set<string>();
  const guides: MapGuide[] = [];
  for (const raw of value.slice(0, MAX_GUIDES)) {
    if (!raw || typeof raw !== 'object') continue;
    const input = raw as Partial<MapGuide>;
    const id = cleanId(input.id);
    if (!id || seen.has(id) || !Array.isArray(input.points)) continue;
    const points = input.points.slice(0, MAX_GUIDE_POINTS)
      .filter((point): point is [number, number] => (
        Array.isArray(point) && point.length >= 2
        && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
      ))
      .map((point): [number, number] => [
        clamp(Number(point[0]), -halfWidth, halfWidth),
        clamp(Number(point[1]), -halfDepth, halfDepth)
      ]);
    if (points.length < 2) continue;
    seen.add(id);
    guides.push({
      id,
      name: cleanName(input.name, id),
      points,
      curve: MAP_GUIDE_CURVES.includes(input.curve as MapGuideCurve)
        ? input.curve as MapGuideCurve
        : 'polyline',
      closed: Boolean(input.closed) && points.length >= 3,
      width: clamp(finiteNumber(input.width, 1.5), 0.1, maxGuideWidth),
      tags: normalizeTags(input.tags),
      generation: normalizeGenerationOwner(input.generation)
    });
  }
  return guides;
}

export function sampleMapGuide(guide: MapGuide, options: SampleMapGuideOptions): MapGuideSample[] {
  const dense = denseGuidePoints(guide);
  if (dense.length < 2) return [];
  const segments = dense.slice(1).map((end, index) => {
    const start = dense[index];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    return { start, end, length };
  }).filter((segment) => segment.length > 0.0001);
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (totalLength <= 0) return [];
  const spacing = Math.max(0.1, finiteNumber(options.spacing, 1));
  const start = clamp(finiteNumber(options.startOffset, 0), 0, totalLength);
  const end = Math.max(start, totalLength - clamp(finiteNumber(options.endOffset, 0), 0, totalLength));
  const distances: number[] = [];
  for (let distance = start; distance <= end + 0.0001; distance += spacing) distances.push(Math.min(distance, end));
  if (distances.length === 0 || end - distances[distances.length - 1] > spacing * 0.35) distances.push(end);
  const offset = finiteNumber(options.offset, 0);
  return distances.map((distance) => sampleAtDistance(segments, distance, offset));
}

/** Deterministic approximation used by terrain paths and the existing placement solver. */
export function mapGuidePolyline(guide: MapGuide, maxPoints = 64): Array<[number, number]> {
  const dense = denseGuidePoints(guide);
  const limit = Math.max(2, Math.floor(maxPoints));
  if (dense.length <= limit) return dense.map(clonePoint);
  return Array.from({ length: limit }, (_, index) => (
    clonePoint(dense[Math.round(index * (dense.length - 1) / (limit - 1))])
  ));
}

/** Reduces noisy freehand input to stable editable control points. */
export function simplifyMapGuidePoints(
  points: readonly [number, number][],
  tolerance: number,
  maxPoints = 64
): Array<[number, number]> {
  if (points.length <= 2) return points.map(clonePoint);
  const threshold = Math.max(0.001, tolerance) ** 2;
  const keep = new Set<number>([0, points.length - 1]);
  const visit = (start: number, end: number): void => {
    let furthest = -1;
    let furthestDistance = threshold;
    for (let index = start + 1; index < end; index += 1) {
      const distance = squaredDistanceToSegment(points[index], points[start], points[end]);
      if (distance <= furthestDistance) continue;
      furthest = index;
      furthestDistance = distance;
    }
    if (furthest < 0) return;
    keep.add(furthest);
    visit(start, furthest);
    visit(furthest, end);
  };
  visit(0, points.length - 1);
  const simplified = [...keep].sort((left, right) => left - right).map((index) => clonePoint(points[index]));
  if (simplified.length <= maxPoints) return simplified;
  return Array.from({ length: maxPoints }, (_, index) => (
    clonePoint(simplified[Math.round(index * (simplified.length - 1) / (maxPoints - 1))])
  ));
}

/** Slices a polygon with parallel lines for farms, campuses, parks and street blocks. */
export function createParallelMapGuides(options: ParallelMapGuideOptions): MapGuide[] {
  const polygon = normalizePolygon(options.region);
  if (polygon.length < 3) return [];
  const spacing = Math.max(0.2, finiteNumber(options.spacing, 2));
  const inset = Math.max(0, finiteNumber(options.inset, 0));
  const angle = finiteNumber(options.direction, 0) * Math.PI / 180;
  const tangent = { x: Math.cos(angle), z: Math.sin(angle) };
  const normal = { x: -tangent.z, z: tangent.x };
  const projections = polygon.map(([x, z]) => x * normal.x + z * normal.z);
  const minProjection = Math.min(...projections) + inset;
  const maxProjection = Math.max(...projections) - inset;
  if (maxProjection < minProjection) return [];
  const centerProjection = (minProjection + maxProjection) / 2;
  const rowCount = Math.max(1, Math.floor((maxProjection - minProjection) / spacing) + 1);
  const firstProjection = centerProjection - (rowCount - 1) * spacing / 2;
  const guides: MapGuide[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const projection = firstProjection + row * spacing;
    const intervals = linePolygonIntervals(polygon, tangent, normal, projection);
    for (const [segmentIndex, interval] of intervals.entries()) {
      const start = interval[0] + inset;
      const end = interval[1] - inset;
      if (end - start < Math.max(0.2, options.width ?? 0.5)) continue;
      const suffix = intervals.length === 1 ? `${row + 1}` : `${row + 1}-${segmentIndex + 1}`;
      guides.push({
        id: `${cleanId(options.idPrefix) || 'guide'}-${suffix}`,
        name: `${cleanName(options.namePrefix, options.idPrefix || 'Guide')} ${suffix}`,
        points: [
          [tangent.x * start + normal.x * projection, tangent.z * start + normal.z * projection],
          [tangent.x * end + normal.x * projection, tangent.z * end + normal.z * projection]
        ],
        curve: 'polyline',
        closed: false,
        width: Math.max(0.1, finiteNumber(options.width, 0.6)),
        tags: normalizeTags(options.tags),
        generation: options.generation
      });
    }
  }
  return guides.slice(0, MAX_GUIDES);
}

/** Creates a road skeleton plus inset buildable blocks for towns and campuses. */
export function createMapStreetGrid(options: MapStreetGridOptions): MapStreetGrid {
  const region = normalizePolygon(options.region);
  if (region.length < 3) return { streets: [], blocks: [] };
  const roadWidth = Math.max(0.3, finiteNumber(options.roadWidth, 3));
  const blockWidth = Math.max(roadWidth, finiteNumber(options.blockWidth, 12));
  const blockDepth = Math.max(roadWidth, finiteNumber(options.blockDepth, 12));
  const direction = finiteNumber(options.direction, 0);
  const common = {
    region,
    inset: Math.max(0, finiteNumber(options.inset, roadWidth / 2)),
    width: roadWidth,
    tags: normalizeTags([...(options.tags ?? []), 'street']),
    generation: options.generation
  };
  const primary = createParallelMapGuides({
    ...common,
    idPrefix: `${options.idPrefix}-primary`,
    namePrefix: `${options.idPrefix} Primary`,
    direction,
    spacing: blockDepth + roadWidth
  });
  const cross = createParallelMapGuides({
    ...common,
    idPrefix: `${options.idPrefix}-cross`,
    namePrefix: `${options.idPrefix} Cross`,
    direction: direction + 90,
    spacing: blockWidth + roadWidth
  });
  const angle = direction * Math.PI / 180;
  const tangent: [number, number] = [Math.cos(angle), Math.sin(angle)];
  const normal: [number, number] = [-tangent[1], tangent[0]];
  const primaryLines = uniqueSorted(primary.map((guide) => averageProjection(guide.points, normal)));
  const crossLines = uniqueSorted(cross.map((guide) => averageProjection(guide.points, tangent)));
  const blocks: MapPlannedBlock[] = [];
  for (let vIndex = 1; vIndex < primaryLines.length; vIndex += 1) {
    for (let uIndex = 1; uIndex < crossLines.length; uIndex += 1) {
      const uMin = crossLines[uIndex - 1] + roadWidth / 2;
      const uMax = crossLines[uIndex] - roadWidth / 2;
      const vMin = primaryLines[vIndex - 1] + roadWidth / 2;
      const vMax = primaryLines[vIndex] - roadWidth / 2;
      if (uMax <= uMin || vMax <= vMin) continue;
      const point = (u: number, v: number): [number, number] => [
        tangent[0] * u + normal[0] * v,
        tangent[1] * u + normal[1] * v
      ];
      const points = [point(uMin, vMin), point(uMax, vMin), point(uMax, vMax), point(uMin, vMax)];
      if (!points.every(([x, z]) => pointInsidePolygon(x, z, region))) continue;
      blocks.push({
        id: `${cleanId(options.idPrefix) || 'grid'}-block-${blocks.length + 1}`,
        points,
        center: point((uMin + uMax) / 2, (vMin + vMax) / 2)
      });
    }
  }
  return { streets: [...primary, ...cross].slice(0, MAX_GUIDES), blocks };
}

function denseGuidePoints(guide: MapGuide): Array<[number, number]> {
  const source = guide.closed && guide.points.length >= 3 ? [...guide.points, guide.points[0]] : guide.points;
  if (guide.curve !== 'catmull-rom' || guide.points.length < 3) return source.map(clonePoint);
  const points = guide.points;
  const segmentCount = guide.closed ? points.length : points.length - 1;
  const result: Array<[number, number]> = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const p0 = curvePoint(points, segment - 1, guide.closed);
    const p1 = curvePoint(points, segment, guide.closed);
    const p2 = curvePoint(points, segment + 1, guide.closed);
    const p3 = curvePoint(points, segment + 2, guide.closed);
    for (let step = 0; step < CURVE_STEPS_PER_SEGMENT; step += 1) {
      const t = step / CURVE_STEPS_PER_SEGMENT;
      result.push([
        catmullRom(p0[0], p1[0], p2[0], p3[0], t),
        catmullRom(p0[1], p1[1], p2[1], p3[1], t)
      ]);
    }
  }
  result.push(guide.closed ? clonePoint(result[0]) : clonePoint(points[points.length - 1]));
  return result;
}

function curvePoint(points: Array<[number, number]>, index: number, closed: boolean): [number, number] {
  if (closed) return points[(index % points.length + points.length) % points.length];
  return points[Math.max(0, Math.min(points.length - 1, index))];
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function sampleAtDistance(
  segments: Array<{ start: [number, number]; end: [number, number]; length: number }>,
  distance: number,
  offset: number
): MapGuideSample {
  let traversed = 0;
  let selected = segments[segments.length - 1];
  for (const segment of segments) {
    selected = segment;
    if (distance <= traversed + segment.length) break;
    traversed += segment.length;
  }
  const t = clamp((distance - traversed) / selected.length, 0, 1);
  const tangentX = (selected.end[0] - selected.start[0]) / selected.length;
  const tangentZ = (selected.end[1] - selected.start[1]) / selected.length;
  const x = selected.start[0] + (selected.end[0] - selected.start[0]) * t - tangentZ * offset;
  const z = selected.start[1] + (selected.end[1] - selected.start[1]) * t + tangentX * offset;
  return { x, z, distance, tangentX, tangentZ, yaw: Math.atan2(tangentX, tangentZ) };
}

function linePolygonIntervals(
  polygon: Array<[number, number]>,
  tangent: { x: number; z: number },
  normal: { x: number; z: number },
  projection: number
): Array<[number, number]> {
  const intersections: number[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const a = start[0] * normal.x + start[1] * normal.z - projection;
    const b = end[0] * normal.x + end[1] * normal.z - projection;
    if ((a < 0 && b < 0) || (a > 0 && b > 0) || Math.abs(a - b) < 0.000001) continue;
    const ratio = a / (a - b);
    if (ratio < -0.000001 || ratio >= 1 - 0.000001) continue;
    const x = start[0] + (end[0] - start[0]) * ratio;
    const z = start[1] + (end[1] - start[1]) * ratio;
    intersections.push(x * tangent.x + z * tangent.z);
  }
  intersections.sort((left, right) => left - right);
  const intervals: Array<[number, number]> = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    if (intersections[index + 1] - intersections[index] > 0.0001) {
      intervals.push([intersections[index], intersections[index + 1]]);
    }
  }
  return intervals;
}

function normalizePolygon(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  return value.filter((point): point is [number, number] => (
    Array.isArray(point) && point.length >= 2
    && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
  )).map((point) => [Number(point[0]), Number(point[1])]);
}

function averageProjection(points: Array<[number, number]>, axis: [number, number]): number {
  return points.reduce((sum, point) => sum + point[0] * axis[0] + point[1] * axis[1], 0) / points.length;
}

function uniqueSorted(values: number[]): number[] {
  return values.sort((left, right) => left - right)
    .filter((value, index, sorted) => index === 0 || Math.abs(value - sorted[index - 1]) > 0.001);
}

function pointInsidePolygon(x: number, z: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const [cx, cz] = points[current];
    const [px, pz] = points[previous];
    if (pointOnSegment(x, z, points[previous], points[current])) return true;
    if ((cz > z) !== (pz > z) && x < (px - cx) * (z - cz) / (pz - cz) + cx) inside = !inside;
  }
  return inside;
}

function pointOnSegment(x: number, z: number, start: [number, number], end: [number, number]): boolean {
  const cross = (x - start[0]) * (end[1] - start[1]) - (z - start[1]) * (end[0] - start[0]);
  if (Math.abs(cross) > 0.0001) return false;
  return x >= Math.min(start[0], end[0]) - 0.0001 && x <= Math.max(start[0], end[0]) + 0.0001
    && z >= Math.min(start[1], end[1]) - 0.0001 && z <= Math.max(start[1], end[1]) + 0.0001;
}

function squaredDistanceToSegment(
  point: readonly [number, number],
  start: readonly [number, number],
  end: readonly [number, number]
): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0.0000001) return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2;
  const amount = clamp(((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared, 0, 1);
  const x = start[0] + dx * amount;
  const z = start[1] + dz * amount;
  return (point[0] - x) ** 2 + (point[1] - z) ** 2;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

function normalizeGenerationOwner(value: unknown): MapGenerationOwner | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<MapGenerationOwner>;
  if ((input.kind !== 'region' && input.kind !== 'seam') || !cleanId(input.id) || !cleanId(input.generationId)) {
    return undefined;
  }
  return { kind: input.kind, id: cleanId(input.id), generationId: cleanId(input.generationId) };
}

function cleanId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/[^a-zA-Z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    : '';
}

function cleanName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : fallback.slice(0, 80);
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clonePoint(point: [number, number]): [number, number] {
  return [point[0], point[1]];
}
