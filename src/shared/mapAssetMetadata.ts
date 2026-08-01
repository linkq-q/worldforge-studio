import type { ModelColliderPlan } from './modelBounds';

export type MapAssetSizeClass = 'small' | 'medium' | 'large';

export function normalizeAssetTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = [...new Set(value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48))
    .filter(Boolean))]
    .slice(0, 16);
  return tags.length > 0 ? tags : undefined;
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
