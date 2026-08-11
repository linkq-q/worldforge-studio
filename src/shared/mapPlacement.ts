import {
  getMapBounds,
  getMapObjectAabbs,
  getTerrainCliffAabbs,
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset
} from './map';
import { mapAssetFootprintRadius, type MapScatterPlacement } from './mapScatter';
import { terrainFootprintSlopeDegrees } from './mapTerrainAnalysis';
import { isNearWater } from './mapWater';

export type StructuredPlacementMode = 'linear' | 'layout' | 'attached';
export type StructuredLayoutPattern = 'row' | 'courtyard' | 'radial' | 'grid';

export interface StructuredPlacementPlan {
  mode: StructuredPlacementMode;
  pattern?: StructuredLayoutPattern;
  assetIds: string[];
  region: { kind: 'circle'; x: number; z: number; r: number };
  density: number;
  spacing: number;
  offset: number;
  direction: number;
  facing: 'random' | 'guide' | 'inward' | 'outward';
  avoidWater: number;
  maxSlope: number;
  scaleRange: [number, number];
  seed: number;
  targets?: Array<{ x: number; z: number }>;
  excludeRegions?: Array<{ kind: 'circle'; x: number; z: number; r: number }>;
}

interface CandidateSlot {
  x: number;
  z: number;
  guideYaw: number;
  focusX: number;
  focusZ: number;
}

interface OccupiedCircle {
  x: number;
  z: number;
  radius: number;
}

export function expandStructuredMapPlacement(
  map: EditableMap,
  plan: StructuredPlacementPlan,
  assets: readonly MapAsset[],
  maxCount: number,
  idPrefix = 'placement'
): MapScatterPlacement[] {
  if (maxCount <= 0 || plan.assetIds.length === 0) return [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const selectedAssets = plan.assetIds
    .map((assetId) => assetById.get(assetId))
    .filter((asset): asset is MapAsset => Boolean(asset));
  if (selectedAssets.length === 0) return [];

  const random = mulberry32(plan.seed);
  const spacing = Math.max(0.1, plan.spacing);
  const areaCount = Math.max(1, Math.round(Math.PI * plan.region.r ** 2 * Math.max(0.0001, plan.density)));
  const count = Math.min(maxCount, areaCount);
  const slots = candidateSlots(plan, count, spacing, random);
  const occupied = existingOccupiedCircles(map);
  const bounds = getMapBounds(map);
  const minScale = Math.max(0.1, Math.min(...plan.scaleRange));
  const maxScale = Math.max(minScale, Math.max(...plan.scaleRange));
  const placements: MapScatterPlacement[] = [];

  for (const [index, slot] of slots.entries()) {
    if (placements.length >= maxCount) break;
    const asset = selectedAssets[Math.floor(random() * selectedAssets.length)];
    const scale = minScale + (maxScale - minScale) * random();
    const footprintRadius = mapAssetFootprintRadius(asset) * scale;
    const jitter = plan.mode === 'layout' ? spacing * 0.07 : spacing * 0.04;
    const x = slot.x + (random() - 0.5) * jitter;
    const z = slot.z + (random() - 0.5) * jitter;
    if (Math.hypot(x - plan.region.x, z - plan.region.z) > plan.region.r) continue;
    if (plan.excludeRegions?.some((region) => Math.hypot(x - region.x, z - region.z) <= region.r)) continue;
    if (x < bounds.minX + footprintRadius || x > bounds.maxX - footprintRadius) continue;
    if (z < bounds.minZ + footprintRadius || z > bounds.maxZ - footprintRadius) continue;
    if (isNearWater(map, x, z, Math.max(0, plan.avoidWater))) continue;
    if (terrainFootprintSlopeDegrees(map, x, z, footprintRadius) > Math.min(89, Math.max(0, plan.maxSlope))) continue;
    if (occupied.some((item) => (
      Math.hypot(x - item.x, z - item.z) < Math.max(spacing * 0.9, footprintRadius + item.radius)
    ))) continue;

    const rotationY = placementYaw(plan.facing, slot, x, z, random);
    placements.push({
      id: `${idPrefix}-${index + 1}`,
      assetId: asset.id,
      name: asset.name,
      x,
      y: sampleTerrainHeight(map, x, z),
      z,
      rotationY,
      scale
    });
    occupied.push({ x, z, radius: footprintRadius });
  }
  return placements;
}

function candidateSlots(
  plan: StructuredPlacementPlan,
  count: number,
  spacing: number,
  random: () => number
): CandidateSlot[] {
  const angle = plan.direction * Math.PI / 180;
  const tangentX = Math.cos(angle);
  const tangentZ = Math.sin(angle);
  const normalX = -tangentZ;
  const normalZ = tangentX;
  const guideYaw = Math.atan2(tangentX, tangentZ);
  if (plan.mode === 'attached') {
    return (plan.targets ?? []).slice(0, count).map((target, index) => {
      const targetAngle = angle + index * 2.399963229728653 + (random() - 0.5) * 0.4;
      const distance = Math.max(spacing, Math.abs(plan.offset) || spacing);
      return {
        x: target.x + Math.cos(targetAngle) * distance,
        z: target.z + Math.sin(targetAngle) * distance,
        guideYaw,
        focusX: target.x,
        focusZ: target.z
      };
    });
  }

  const pattern = plan.mode === 'linear' ? 'row' : plan.pattern ?? 'courtyard';
  if (pattern === 'row') {
    const usableLength = Math.min(plan.region.r * 1.6, Math.max(0, (count - 1) * spacing));
    return Array.from({ length: count }, (_, index) => {
      const along = count <= 1 ? 0 : index / (count - 1) * usableLength - usableLength / 2;
      return {
        x: plan.region.x + tangentX * along + normalX * plan.offset,
        z: plan.region.z + tangentZ * along + normalZ * plan.offset,
        guideYaw,
        focusX: plan.region.x,
        focusZ: plan.region.z
      };
    });
  }
  if (pattern === 'grid') {
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / columns));
    return Array.from({ length: count }, (_, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const localX = (column - (columns - 1) / 2) * spacing;
      const localZ = (row - (rows - 1) / 2) * spacing;
      return {
        x: plan.region.x + tangentX * localX + normalX * localZ,
        z: plan.region.z + tangentZ * localX + normalZ * localZ,
        guideYaw,
        focusX: plan.region.x,
        focusZ: plan.region.z
      };
    });
  }

  const radius = Math.min(plan.region.r * 0.62, Math.max(spacing, count * spacing / (Math.PI * 2)));
  return Array.from({ length: count }, (_, index) => {
    const theta = angle + index / count * Math.PI * 2;
    let unitX = Math.cos(theta);
    let unitZ = Math.sin(theta);
    if (pattern === 'courtyard') {
      const squareScale = 1 / Math.max(Math.abs(unitX), Math.abs(unitZ), 0.001);
      unitX *= squareScale;
      unitZ *= squareScale;
    }
    return {
      x: plan.region.x + unitX * radius,
      z: plan.region.z + unitZ * radius,
      guideYaw,
      focusX: plan.region.x,
      focusZ: plan.region.z
    };
  });
}

function placementYaw(
  facing: StructuredPlacementPlan['facing'],
  slot: CandidateSlot,
  x: number,
  z: number,
  random: () => number
): number {
  if (facing === 'guide') return slot.guideYaw;
  if (facing === 'inward') return Math.atan2(slot.focusX - x, slot.focusZ - z);
  if (facing === 'outward') return Math.atan2(x - slot.focusX, z - slot.focusZ);
  return random() * Math.PI * 2;
}

function existingOccupiedCircles(map: EditableMap): OccupiedCircle[] {
  return [...getMapObjectAabbs(map), ...getTerrainCliffAabbs(map)].map((box) => ({
    x: (box.min[0] + box.max[0]) / 2,
    z: (box.min[2] + box.max[2]) / 2,
    radius: Math.hypot(box.max[0] - box.min[0], box.max[2] - box.min[2]) / 2
  }));
}

function mulberry32(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
