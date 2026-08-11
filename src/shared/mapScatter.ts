import {
  getMapBounds,
  getMapObjectAabbs,
  getTerrainCliffAabbs,
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset
} from './map';
import { distanceToWater, isNearWater } from './mapWater';
import { terrainFootprintSlopeDegrees } from './mapTerrainAnalysis';

export interface MapScatterPlan {
  assetIds: string[];
  region: {
    kind: 'circle';
    x: number;
    z: number;
    r: number;
  };
  density: number;
  avoidWater: number;
  maxSlope: number;
  minSpacing: number;
  scaleRange: [number, number];
  seed: number;
  edgeFalloff?: number;
  clusterStrength?: number;
  /** Shared by related families so they occupy one habitat instead of separate obvious blobs. */
  patchSeed?: number;
  /** Pair-specific ecological spacing; hard collider separation still applies. */
  spacingByAssetId?: Record<string, number>;
  habitat?: {
    /** Outer minimum, preferred minimum, preferred maximum, outer maximum. */
    height?: [number, number, number, number];
    slope?: [number, number, number, number];
    waterDistance?: [number, number, number, number];
  };
  excludeRegions?: Array<{
    kind: 'circle';
    x: number;
    z: number;
    r: number;
  }>;
}

export interface MapScatterPlacement {
  id: string;
  assetId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  scale: number;
}

interface OccupiedCircle {
  x: number;
  z: number;
  radius: number;
  assetId?: string;
}

export function expandMapScatter(
  map: EditableMap,
  plan: MapScatterPlan,
  assets: readonly MapAsset[],
  maxCount: number,
  idPrefix = 'scatter'
): MapScatterPlacement[] {
  if (maxCount <= 0 || plan.assetIds.length === 0) return [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const selectedAssets = plan.assetIds
    .map((assetId) => assetById.get(assetId))
    .filter((asset): asset is MapAsset => Boolean(asset));
  if (selectedAssets.length === 0) return [];

  const random = mulberry32(plan.seed);
  const bounds = getMapBounds(map);
  const density = clamp(plan.density, 0.0001, 1);
  const minSpacing = clamp(plan.minSpacing, 0.1, Math.max(map.box.size[0], map.box.size[2]));
  const cellSize = Math.max(minSpacing, Math.sqrt(1 / density));
  const regionRadius = clamp(plan.region.r, cellSize / 2, Math.min(map.box.size[0], map.box.size[2]) / 2);
  const minScale = clamp(Math.min(...plan.scaleRange), 0.1, 8);
  const maxScale = clamp(Math.max(...plan.scaleRange), minScale, 8);
  const edgeFalloff = clamp(plan.edgeFalloff ?? 0, 0, 1);
  const clusterStrength = clamp(plan.clusterStrength ?? 0, 0, 1);
  const maxSlope = clamp(plan.maxSlope, 0, 89);
  const excludeRegions = plan.excludeRegions ?? [];
  const occupied = existingOccupiedCircles(map);
  const accepted: MapScatterPlacement[] = [];
  const minGridX = Math.floor((plan.region.x - regionRadius) / cellSize);
  const maxGridX = Math.ceil((plan.region.x + regionRadius) / cellSize);
  const minGridZ = Math.floor((plan.region.z - regionRadius) / cellSize);
  const maxGridZ = Math.ceil((plan.region.z + regionRadius) / cellSize);
  let candidateIndex = 0;

  for (let gridZ = minGridZ; gridZ <= maxGridZ && accepted.length < maxCount; gridZ += 1) {
    for (let gridX = minGridX; gridX <= maxGridX && accepted.length < maxCount; gridX += 1) {
      const x = (gridX + 0.15 + random() * 0.7) * cellSize;
      const z = (gridZ + 0.15 + random() * 0.7) * cellSize;
      const asset = selectedAssets[Math.floor(random() * selectedAssets.length)];
      const scale = minScale + (maxScale - minScale) * random();
      const footprintRadius = mapAssetFootprintRadius(asset) * scale;
      candidateIndex += 1;

      const normalizedDistance = Math.hypot(x - plan.region.x, z - plan.region.z) / regionRadius;
      if (normalizedDistance > 1) continue;
      if (excludeRegions.some((region) => Math.hypot(x - region.x, z - region.z) <= Math.max(0, region.r))) continue;
      const edgeProbability = edgeFalloff <= 0
        ? 1
        : clamp((1 - normalizedDistance) / edgeFalloff, 0, 1);
      const patchX = x / Math.max(1, cellSize * 4);
      const patchZ = z / Math.max(1, cellSize * 4);
      const sharedPatch = clusterNoise(patchX, patchZ, plan.patchSeed ?? plan.seed);
      const familyDetail = clusterNoise(patchX * 1.9, patchZ * 1.9, plan.seed + 7919);
      const habitatPatch = sharedPatch * 0.72 + familyDetail * 0.28;
      const clusterProbability = 1 - clusterStrength
        + clusterStrength * (0.35 + smooth(habitatPatch) * 0.65);
      const y = sampleTerrainHeight(map, x, z);
      const slope = terrainFootprintSlopeDegrees(map, x, z, footprintRadius);
      if (slope > maxSlope) continue;
      const waterSuitability = plan.habitat?.waterDistance
        ? bandSuitability(distanceToWater(map, x, z), plan.habitat.waterDistance)
        : 1;
      const habitatProbability = bandSuitability(y, plan.habitat?.height)
        * bandSuitability(slope, plan.habitat?.slope)
        * waterSuitability
        * slopeSuitability(slope, maxSlope);
      if (random() > edgeProbability * clusterProbability * habitatProbability) continue;
      if (x < bounds.minX + footprintRadius || x > bounds.maxX - footprintRadius) continue;
      if (z < bounds.minZ + footprintRadius || z > bounds.maxZ - footprintRadius) continue;
      if (isNearWater(map, x, z, Math.max(0, plan.avoidWater))) continue;
      if (occupied.some((item) =>
        Math.hypot(x - item.x, z - item.z) < Math.max(
          item.assetId ? Math.max(0, plan.spacingByAssetId?.[item.assetId] ?? minSpacing) : minSpacing,
          footprintRadius + item.radius
        )
      )) continue;

      accepted.push({
        id: `${idPrefix}-${candidateIndex}`,
        assetId: asset.id,
        name: asset.name,
        x,
        y,
        z,
        rotationY: random() * Math.PI * 2,
        scale
      });
      occupied.push({ x, z, radius: footprintRadius, assetId: asset.id });
    }
  }
  return accepted;
}

function clusterNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  return lerp(
    lerp(hashNoise(x0, z0, seed), hashNoise(x0 + 1, z0, seed), tx),
    lerp(hashNoise(x0, z0 + 1, seed), hashNoise(x0 + 1, z0 + 1, seed), tx),
    tz
  );
}

function hashNoise(x: number, z: number, seed: number): number {
  let value = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 69069);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 4294967295;
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function lerp(left: number, right: number, amount: number): number {
  return left + (right - left) * amount;
}

function existingOccupiedCircles(map: EditableMap): OccupiedCircle[] {
  const assetByObjectId = new Map(map.objects.map((object) => [object.id, object.assetId ?? undefined]));
  return [...getMapObjectAabbs(map), ...getTerrainCliffAabbs(map)].map((box) => ({
    x: (box.min[0] + box.max[0]) / 2,
    z: (box.min[2] + box.max[2]) / 2,
    radius: Math.hypot(box.max[0] - box.min[0], box.max[2] - box.min[2]) / 2,
    assetId: assetByObjectId.get(box.objectId)
  }));
}

function bandSuitability(value: number, band: [number, number, number, number] | undefined): number {
  if (!band) return 1;
  const [outerMin, preferredMin, preferredMax, outerMax] = band;
  if (value <= outerMin || value >= outerMax) return 0;
  if (value >= preferredMin && value <= preferredMax) return 1;
  if (value < preferredMin) return smooth((value - outerMin) / Math.max(0.0001, preferredMin - outerMin));
  return smooth((outerMax - value) / Math.max(0.0001, outerMax - preferredMax));
}

function slopeSuitability(slope: number, maxSlope: number): number {
  const fadeStart = maxSlope * 0.55;
  if (slope <= fadeStart) return 1;
  return smooth((maxSlope - slope) / Math.max(0.0001, maxSlope - fadeStart));
}

export function mapAssetFootprintRadius(asset: MapAsset): number {
  const storedRadius = asset.footprintRadius;
  if (typeof storedRadius === 'number' && Number.isFinite(storedRadius)) return Math.max(0.1, storedRadius);
  const boxes = asset.colliderPlan?.boxes ?? [];
  if (boxes.length === 0) return 0.5;
  return Math.max(0.1, ...boxes.map((box) => Math.max(
    Math.abs(box.min[0]),
    Math.abs(box.max[0]),
    Math.abs(box.min[2]),
    Math.abs(box.max[2])
  )));
}

function mulberry32(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
