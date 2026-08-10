import type { MapBounds } from './map';

export interface MapPlanLimits {
  terrainBrushCount: number;
  brushRadiusMax: number;
  objectCount: number;
  waterCount: number;
  assetRequestCount: number;
  assetVariantMin: number;
  assetVariantMax: number;
}

export const DEFAULT_MAP_AI_MAX_NEW_ASSETS = 16;
export const DEFAULT_MAP_AI_MIN_NEW_ASSETS = 0;
export const MAP_AI_MAX_NEW_ASSETS = 32;

export function normalizeMapAiMaxNewAssets(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAP_AI_MAX_NEW_ASSETS;
  return Math.round(Math.min(MAP_AI_MAX_NEW_ASSETS, Math.max(0, parsed)));
}

export function normalizeMapAiNewAssetRange(
  minimum: unknown,
  maximum: unknown
): { min: number; max: number } {
  const max = normalizeMapAiMaxNewAssets(maximum);
  const parsedMin = Number(minimum);
  const min = Number.isFinite(parsedMin)
    ? Math.round(Math.min(max, Math.max(0, parsedMin)))
    : Math.min(DEFAULT_MAP_AI_MIN_NEW_ASSETS, max);
  return { min, max };
}

export function planLimits(bounds: MapBounds): MapPlanLimits {
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const area = width * depth;
  const extent = Math.max(width, depth);
  const assetVariantRange = extent <= 48
    ? { min: 2, max: 4 }
    : extent <= 96
      ? { min: 6, max: 10 }
      : { min: 8, max: 14 };
  return {
    terrainBrushCount: Math.max(1, Math.round(area / 200)),
    brushRadiusMax: Math.min(width, depth) / 6,
    objectCount: Math.max(1, Math.floor(area / 90)),
    waterCount: Math.max(1, Math.round(area / 900)),
    assetRequestCount: assetVariantRange.max,
    assetVariantMin: assetVariantRange.min,
    assetVariantMax: assetVariantRange.max
  };
}
