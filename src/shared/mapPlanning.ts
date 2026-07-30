import type { MapBounds } from './map';

export interface MapPlanLimits {
  terrainBrushCount: number;
  brushRadiusMax: number;
  objectCount: number;
  waterCount: number;
  assetRequestCount: number;
}

export function planLimits(bounds: MapBounds): MapPlanLimits {
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  const area = width * depth;
  const extent = Math.max(width, depth);
  return {
    terrainBrushCount: Math.max(1, Math.round(area / 200)),
    brushRadiusMax: Math.min(width, depth) / 6,
    objectCount: Math.max(1, Math.floor(area / 90)),
    waterCount: Math.max(1, Math.round(area / 900)),
    assetRequestCount: extent <= 48 ? 3 : extent <= 96 ? 5 : 8
  };
}
