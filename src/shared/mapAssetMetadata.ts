import type { ModelColliderPlan } from './modelBounds';

export type MapAssetSizeClass = 'small' | 'medium' | 'large';

export interface MapAssetLight {
  kind: 'point' | 'spot';
  color: string;
  intensity: number;
  range: number;
  offset: [number, number, number];
  direction?: [number, number, number];
  coneAngleDegrees?: number;
  penumbra?: number;
}

export function normalizeAssetTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = [...new Set(value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48))
    .filter(Boolean))]
    .slice(0, 16);
  return tags.length > 0 ? tags : undefined;
}

export function normalizeMapAssetLight(value: unknown): MapAssetLight | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (input.kind !== 'point' && input.kind !== 'spot') return undefined;
  const color = typeof input.color === 'string' && /^#[0-9a-f]{6}$/i.test(input.color.trim())
    ? input.color.trim().toLowerCase()
    : '#ffd878';
  const offset = normalizeVector(input.offset, [0, 0, 0]);
  const direction = input.kind === 'spot' ? normalizeVector(input.direction, [0, -1, 0]) : undefined;
  return {
    kind: input.kind,
    color,
    intensity: clampNumber(input.intensity, 3, 0.5, 12),
    range: clampNumber(input.range, 7, 1, 20),
    offset,
    ...(direction ? { direction } : {}),
    ...(input.kind === 'spot' ? {
      coneAngleDegrees: clampNumber(input.coneAngleDegrees, 40, 10, 90),
      penumbra: clampNumber(input.penumbra, 0.4, 0, 1)
    } : {})
  };
}

function normalizeVector(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return value.slice(0, 3).map((entry, index) => (
    Number.isFinite(Number(entry)) ? Math.max(-10, Math.min(10, Number(entry))) : fallback[index]
  )) as [number, number, number];
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

export function assetFootprintRadius(plan: ModelColliderPlan): number {
  if (plan.boxes.length === 0) return 0.5;
  return Math.max(0.1, ...plan.boxes.map((box) => Math.max(
    Math.abs(box.min[0]),
    Math.abs(box.max[0]),
    Math.abs(box.min[2]),
    Math.abs(box.max[2])
  )));
}

export function assetSizeClass(radius: number): MapAssetSizeClass {
  if (radius < 0.8) return 'small';
  if (radius < 2.5) return 'medium';
  return 'large';
}
