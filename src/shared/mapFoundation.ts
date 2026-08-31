import type { Aabb } from './modelBounds';

export const MAP_FOUNDATION_SHAPES = ['capsule', 'rounded-rectangle', 'polygon', 'path'] as const;
export const MAP_FOUNDATION_TOPS = ['level', 'slope', 'steps'] as const;

export type MapFoundationShape = typeof MAP_FOUNDATION_SHAPES[number];
export type MapFoundationTop = typeof MAP_FOUNDATION_TOPS[number];

export interface MapFoundation {
  shape: MapFoundationShape;
  top: MapFoundationTop;
  width: number;
  depth: number;
  thickness: number;
  maxThickness: number;
  cornerRadius: number;
  points: Array<[number, number]>;
  curve: 'polyline' | 'catmull-rom';
  closed: boolean;
  slope: number;
  slopeDirection: number;
  stepHeight: number;
  stepCount: number;
  material: string;
  linkedObjectIds: string[];
}

export function normalizeMapFoundation(value: unknown): MapFoundation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<MapFoundation>;
  if (!MAP_FOUNDATION_SHAPES.includes(input.shape as MapFoundationShape)) return undefined;
  const shape = input.shape as MapFoundationShape;
  const width = clamp(finite(input.width, 4), 0.2, 512);
  const depth = clamp(finite(input.depth, width), 0.2, 512);
  const points = Array.isArray(input.points)
    ? input.points.slice(0, 96).flatMap((point): Array<[number, number]> => (
      Array.isArray(point) && point.length >= 2
      && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))
        ? [[Number(point[0]), Number(point[1])]] : []
    ))
    : [];
  return {
    shape,
    top: MAP_FOUNDATION_TOPS.includes(input.top as MapFoundationTop) ? input.top as MapFoundationTop : 'level',
    width,
    depth,
    thickness: clamp(finite(input.thickness, 0.45), 0.1, 4),
    maxThickness: clamp(finite(input.maxThickness, 4), 0.1, 16),
    cornerRadius: clamp(finite(input.cornerRadius, Math.min(width, depth) * 0.18), 0, Math.min(width, depth) / 2),
    points,
    curve: input.curve === 'catmull-rom' ? 'catmull-rom' : 'polyline',
    closed: input.closed === true,
    slope: clamp(finite(input.slope, 0.08), 0, 1),
    slopeDirection: wrapAngle(finite(input.slopeDirection, 0)),
    stepHeight: clamp(finite(input.stepHeight, 0.25), 0.05, 2),
    stepCount: clamp(Math.round(finite(input.stepCount, 3)), 1, 24),
    material: typeof input.material === 'string' && input.material.trim()
      ? input.material.trim().slice(0, 48) : 'concrete',
    linkedObjectIds: Array.isArray(input.linkedObjectIds)
      ? [...new Set(input.linkedObjectIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))].slice(0, 64)
      : []
  };
}

export function foundationBoundary(foundation: MapFoundation): Array<[number, number]> {
  if (foundation.shape === 'path') return pathBoundary(foundation);
  if (foundation.shape === 'polygon' && foundation.points.length >= 3) return foundation.points.map(clonePoint);
  const halfWidth = foundation.width / 2;
  const halfDepth = foundation.depth / 2;
  const radius = foundation.shape === 'capsule'
    ? Math.min(halfWidth, halfDepth)
    : Math.min(foundation.cornerRadius, halfWidth, halfDepth);
  return roundedRectangleBoundary(halfWidth, halfDepth, radius);
}

export function foundationTopHeight(foundation: MapFoundation, x: number, z: number): number {
  const projected = x * Math.sin(foundation.slopeDirection) + z * Math.cos(foundation.slopeDirection);
  if (foundation.top === 'slope') return projected * foundation.slope;
  if (foundation.top === 'steps') {
    const [min, max] = foundationStepRange(foundation);
    const step = clamp(Math.floor((projected - min) / (max - min) * foundation.stepCount), 0, foundation.stepCount - 1);
    return step * foundation.stepHeight;
  }
  return 0;
}

export function foundationStepRange(foundation: MapFoundation): [number, number] {
  const sin = Math.sin(foundation.slopeDirection);
  const cos = Math.cos(foundation.slopeDirection);
  const projections = foundationBoundary(foundation).map(([x, z]) => x * sin + z * cos);
  const min = projections.length > 0 ? Math.min(...projections) : -0.05;
  const max = projections.length > 0 ? Math.max(...projections) : 0.05;
  return max - min >= 0.1 ? [min, max] : [min, min + 0.1];
}

export function foundationLocalColliderBoxes(foundation: MapFoundation): Aabb[] {
  if (foundation.shape === 'path') {
    const points = foundationPathPoints(foundation);
    if (points.length < 2) return [];
    const padding = foundation.width / 2;
    const segmentCount = foundation.closed ? points.length : points.length - 1;
    return Array.from({ length: segmentCount }, (_, index): Aabb => {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      const middle: [number, number] = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
      const top = Math.max(
        foundationTopHeight(foundation, start[0], start[1]),
        foundationTopHeight(foundation, end[0], end[1]),
        foundationTopHeight(foundation, middle[0], middle[1]),
        0
      );
      return {
        min: [Math.min(start[0], end[0]) - padding, -foundation.maxThickness, Math.min(start[1], end[1]) - padding],
        max: [Math.max(start[0], end[0]) + padding, top + 0.05, Math.max(start[1], end[1]) + padding]
      };
    });
  }
  const points = foundationBoundary(foundation);
  if (points.length < 3) return [];
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minZ = Math.min(...points.map((point) => point[1]));
  const maxZ = Math.max(...points.map((point) => point[1]));
  const top = Math.max(...points.map(([x, z]) => foundationTopHeight(foundation, x, z)), 0);
  return [{ min: [minX, -foundation.maxThickness, minZ], max: [maxX, top + 0.05, maxZ] }];
}

function roundedRectangleBoundary(halfWidth: number, halfDepth: number, radius: number): Array<[number, number]> {
  if (radius <= 0.001) return [
    [-halfWidth, -halfDepth], [halfWidth, -halfDepth],
    [halfWidth, halfDepth], [-halfWidth, halfDepth]
  ];
  const points: Array<[number, number]> = [];
  const corners: Array<[number, number, number]> = [
    [halfWidth - radius, -halfDepth + radius, -Math.PI / 2],
    [halfWidth - radius, halfDepth - radius, 0],
    [-halfWidth + radius, halfDepth - radius, Math.PI / 2],
    [-halfWidth + radius, -halfDepth + radius, Math.PI]
  ];
  for (const [cx, cz, start] of corners) {
    for (let step = 0; step <= 4; step += 1) {
      const angle = start + step * Math.PI / 8;
      points.push([cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius]);
    }
  }
  return points;
}

function pathBoundary(foundation: MapFoundation): Array<[number, number]> {
  const points = foundationPathPoints(foundation);
  if (points.length < 2) return [];
  const half = foundation.width / 2;
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[index === 0 ? (foundation.closed ? points.length - 1 : 0) : index - 1];
    const next = points[index === points.length - 1 ? (foundation.closed ? 0 : points.length - 1) : index + 1];
    const dx = next[0] - previous[0];
    const dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length * half;
    const nz = dx / length * half;
    left.push([points[index][0] + nx, points[index][1] + nz]);
    right.push([points[index][0] - nx, points[index][1] - nz]);
  }
  return [...left, ...right.reverse()];
}

function foundationPathPoints(foundation: MapFoundation): Array<[number, number]> {
  return foundation.curve === 'catmull-rom' && foundation.points.length >= 3
    ? smoothPathPoints(foundation.points, foundation.closed)
    : foundation.points;
}

function smoothPathPoints(points: Array<[number, number]>, closed: boolean): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  const segmentCount = closed ? points.length : points.length - 1;
  const at = (index: number): [number, number] => closed
    ? points[(index % points.length + points.length) % points.length]
    : points[Math.max(0, Math.min(points.length - 1, index))];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const p0 = at(segment - 1);
    const p1 = at(segment);
    const p2 = at(segment + 1);
    const p3 = at(segment + 2);
    for (let step = 0; step < 8; step += 1) {
      const t = step / 8;
      const t2 = t * t;
      const t3 = t2 * t;
      const sample = (axis: 0 | 1) => 0.5 * ((2 * p1[axis]) + (-p0[axis] + p2[axis]) * t
        + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2
        + (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3);
      result.push([sample(0), sample(1)]);
    }
  }
  if (!closed) result.push(clonePoint(points[points.length - 1]));
  return result;
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function wrapAngle(value: number): number {
  const tau = Math.PI * 2;
  return ((value + Math.PI) % tau + tau) % tau - Math.PI;
}

function clonePoint(point: [number, number]): [number, number] {
  return [point[0], point[1]];
}
