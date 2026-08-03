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
