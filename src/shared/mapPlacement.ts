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
import type { ScenePlacementIntent } from './sceneComposition';

export type StructuredPlacementMode = 'linear' | 'layout' | 'attached';
export type StructuredLayoutPattern = 'row' | 'courtyard' | 'radial' | 'grid' | 'arc';

export interface StructuredPlacementPlan {
  mode: StructuredPlacementMode;
  pattern?: StructuredLayoutPattern;
  intent?: ScenePlacementIntent;
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
  targets?: Array<{ x: number; z: number; yaw?: number; footprintRadius?: number }>;
  guidePoints?: Array<[number, number]>;
  focus?: { x: number; z: number };
  maxPerGroup?: number;
  arcDegrees?: number;
  aisleEvery?: number;
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
  const relationshipMinimum = plan.intent === 'social' || plan.intent === 'attached-service'
    ? Math.max(1, plan.targets?.length ?? 0) * Math.max(1, plan.maxPerGroup ?? 1)
    : plan.intent === 'viewpoint' ? Math.max(1, plan.maxPerGroup ?? 5) : 0;
  const count = Math.min(maxCount, Math.max(areaCount, relationshipMinimum));
  const slots = candidateSlots(map, plan, count, spacing, random);
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
    const jitter = plan.intent === 'wall' ? 0 : plan.mode === 'layout' ? spacing * 0.07 : spacing * 0.04;
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
  map: EditableMap,
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
  if (plan.mode === 'attached' && (plan.intent === 'social' || plan.intent === 'attached-service')) {
    return furnitureAttachmentSlots(plan, count, spacing);
  }
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

  if (plan.intent === 'street-edge' && plan.guidePoints && plan.guidePoints.length >= 2) {
    return guidePathSlots(plan, count, spacing);
  }
  if (plan.intent === 'wall' && map.room) return roomWallSlots(map.room, plan, count, spacing);

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
    const focusX = plan.focus?.x ?? plan.region.x;
    const focusZ = plan.focus?.z ?? plan.region.z;
    const focusDistance = Math.hypot(focusX - plan.region.x, focusZ - plan.region.z);
    const forwardX = plan.intent === 'audience'
      ? focusDistance > 0.001 ? (focusX - plan.region.x) / focusDistance : normalX
      : normalX;
    const forwardZ = plan.intent === 'audience'
      ? focusDistance > 0.001 ? (focusZ - plan.region.z) / focusDistance : normalZ
      : normalZ;
    const rowX = plan.intent === 'audience' ? forwardZ : tangentX;
    const rowZ = plan.intent === 'audience' ? -forwardX : tangentZ;
    const originX = plan.intent === 'audience' ? focusX - forwardX * spacing * (rows + 1) / 2 : plan.region.x;
    const originZ = plan.intent === 'audience' ? focusZ - forwardZ * spacing * (rows + 1) / 2 : plan.region.z;
    return Array.from({ length: count }, (_, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const aisleEvery = plan.intent === 'audience' ? Math.max(2, plan.aisleEvery ?? 4) : 0;
      const aisleOffset = aisleEvery > 0 ? Math.floor(column / aisleEvery) * spacing * 0.75 : 0;
      const centeredAisleOffset = aisleOffset - (aisleEvery > 0 ? Math.floor((columns - 1) / aisleEvery) * spacing * 0.375 : 0);
      const localX = (column - (columns - 1) / 2) * spacing + centeredAisleOffset;
      const localZ = (row - (rows - 1) / 2) * spacing;
      return {
        x: originX + rowX * localX + forwardX * localZ,
        z: originZ + rowZ * localX + forwardZ * localZ,
        guideYaw,
        focusX,
        focusZ
      };
    });
  }

  if (pattern === 'arc') {
    const limitedCount = Math.min(count, Math.max(1, plan.maxPerGroup ?? 5));
    const arc = Math.min(320, Math.max(20, plan.arcDegrees ?? 110)) * Math.PI / 180;
    const radius = Math.min(plan.region.r * 0.62, Math.max(spacing, limitedCount * spacing / Math.max(0.5, arc)));
    return Array.from({ length: limitedCount }, (_, index) => {
      const theta = angle + (limitedCount <= 1 ? 0 : index / (limitedCount - 1) * arc - arc / 2);
      return {
        x: plan.region.x + Math.cos(theta) * radius,
        z: plan.region.z + Math.sin(theta) * radius,
        guideYaw,
        focusX: plan.focus?.x ?? plan.region.x,
        focusZ: plan.focus?.z ?? plan.region.z
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

function guidePathSlots(plan: StructuredPlacementPlan, count: number, spacing: number): CandidateSlot[] {
  const points = plan.guidePoints ?? [];
  const segments = points.slice(1).map((point, index) => {
    const start = points[index];
    const length = Math.hypot(point[0] - start[0], point[1] - start[1]);
    return { start, end: point, length };
  }).filter((segment) => segment.length > 0.001);
  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (segments.length === 0 || totalLength <= 0) return [];
  const groupSize = Math.max(1, Math.round(plan.maxPerGroup ?? count));
  const groupGap = spacing * 1.6;
  const requestedLength = Math.max(0, (count - 1) * spacing + Math.floor((count - 1) / groupSize) * groupGap);
  const startDistance = Math.max(0, (totalLength - Math.min(totalLength, requestedLength)) / 2);
  return Array.from({ length: count }, (_, index) => {
    const distance = Math.min(
      totalLength,
      startDistance + index * spacing + Math.floor(index / groupSize) * groupGap
    );
    let traversed = 0;
    const segment = segments.find((candidate) => {
      if (distance <= traversed + candidate.length) return true;
      traversed += candidate.length;
      return false;
    }) ?? segments[segments.length - 1];
    const t = Math.min(1, Math.max(0, (distance - traversed) / segment.length));
    const tangentX = (segment.end[0] - segment.start[0]) / segment.length;
    const tangentZ = (segment.end[1] - segment.start[1]) / segment.length;
    const x = segment.start[0] + (segment.end[0] - segment.start[0]) * t - tangentZ * plan.offset;
    const z = segment.start[1] + (segment.end[1] - segment.start[1]) * t + tangentX * plan.offset;
    return {
      x,
      z,
      guideYaw: Math.atan2(tangentX, tangentZ),
      focusX: x + tangentZ,
      focusZ: z - tangentX
    };
  });
}

function furnitureAttachmentSlots(
  plan: StructuredPlacementPlan,
  count: number,
  spacing: number
): CandidateSlot[] {
  const targets = plan.targets ?? [];
  if (targets.length === 0) return [];
  const perTarget = Math.max(1, Math.min(plan.maxPerGroup ?? (plan.intent === 'social' ? 6 : 1), count));
  const slots: CandidateSlot[] = [];
  for (const target of targets) {
    const slotCount = Math.min(perTarget, count - slots.length);
    if (slotCount <= 0) break;
    const distance = Math.max(spacing, Math.abs(plan.offset), (target.footprintRadius ?? 0) + spacing * 0.55);
    for (let index = 0; index < slotCount; index += 1) {
      const angle = plan.intent === 'attached-service'
        ? (target.yaw ?? plan.direction * Math.PI / 180) + (index % 2 === 0 ? Math.PI / 2 : -Math.PI / 2)
        : (target.yaw ?? 0) + index / slotCount * Math.PI * 2;
      slots.push({
        x: target.x + Math.sin(angle) * distance,
        z: target.z + Math.cos(angle) * distance,
        guideYaw: target.yaw ?? 0,
        focusX: target.x,
        focusZ: target.z
      });
    }
  }
  return slots;
}

function roomWallSlots(
  room: NonNullable<EditableMap['room']>,
  plan: StructuredPlacementPlan,
  count: number,
  spacing: number
): CandidateSlot[] {
  const direction = ((plan.direction % 360) + 360) % 360;
  const wall = direction >= 45 && direction < 135 ? 'east'
    : direction >= 135 && direction < 225 ? 'south'
    : direction >= 225 && direction < 315 ? 'west'
    : 'north';
  const alongX = wall === 'north' || wall === 'south';
  const length = alongX ? room.size[0] : room.size[2];
  const edgeClearance = Math.max(room.wallThickness, Math.min(1.2, spacing * 0.3));
  const availableLength = Math.max(0, length - edgeClearance * 2);
  const slotCount = Math.min(count, Math.max(1, Math.floor(availableLength / spacing) + 1));
  const usableLength = Math.min(availableLength, Math.max(0, (slotCount - 1) * spacing));
  const openings = room.openings.filter((opening) => opening.wall === wall);
  const slots: CandidateSlot[] = [];
  for (let index = 0; index < slotCount; index += 1) {
    const along = slotCount <= 1 ? 0 : index / (slotCount - 1) * usableLength - usableLength / 2;
    if (openings.some((opening) => Math.abs(along - opening.offset) < opening.width / 2 + 0.8)) continue;
    const inset = room.wallThickness + Math.max(0.5, Math.abs(plan.offset), Math.min(1.2, spacing * 0.3));
    const x = alongX
      ? room.position[0] + along
      : room.position[0] + (wall === 'east' ? room.size[0] / 2 - inset : -room.size[0] / 2 + inset);
    const z = alongX
      ? room.position[2] + (wall === 'north' ? -room.size[2] / 2 + inset : room.size[2] / 2 - inset)
      : room.position[2] + along;
    slots.push({
      x,
      z,
      guideYaw: wall === 'north' ? 0 : wall === 'east' ? -Math.PI / 2 : wall === 'south' ? Math.PI : Math.PI / 2,
      focusX: x + (wall === 'east' ? -1 : wall === 'west' ? 1 : 0),
      focusZ: z + (wall === 'north' ? 1 : wall === 'south' ? -1 : 0)
    });
  }
  return slots;
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
