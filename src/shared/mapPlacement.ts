import {
  getMapBounds,
  getMapObjectAabbs,
  getMapPlayerMetrics,
  getTerrainCliffAabbs,
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset
} from './map';
import { mapAssetFootprintRadius, type MapScatterPlacement } from './mapScatter';
import { terrainFootprintSlopeDegrees } from './mapTerrainAnalysis';
import { isNearWater } from './mapWater';
import type { ScenePlacementIntent } from './sceneComposition';
import { isCeilingMountedSemantic, isElevatedWallSemantic } from './indoorScale';

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
  /** Extra deterministic candidates to try without increasing the requested placement count. */
  candidateCount?: number;
  symmetric?: boolean;
  excludeRegions?: Array<{ kind: 'circle'; x: number; z: number; r: number }>;
}

interface CandidateSlot {
  x: number;
  z: number;
  guideYaw: number;
  focusX: number;
  focusZ: number;
  targetIndex?: number;
}

interface HorizontalBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
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
  const audienceCount = plan.intent === 'audience' && map.room
    ? roomAudienceTargetCount(map.room, plan, spacing)
    : 0;
  const relationshipMinimum = plan.intent === 'social' || plan.intent === 'attached-service'
    ? Math.max(1, plan.targets?.length ?? 0) * Math.max(1, plan.maxPerGroup ?? 1)
    : plan.intent === 'viewpoint' ? Math.max(1, plan.maxPerGroup ?? 5) : 0;
  const count = Math.min(maxCount, Math.max(areaCount, audienceCount, relationshipMinimum));
  const candidateCount = Math.max(count, plan.candidateCount ?? (count === 1 && plan.intent === 'landmark' ? 25 : count));
  const slots = candidateSlots(map, plan, candidateCount, spacing, random);
  if (candidateCount > count) {
    slots.sort((left, right) => (
      Math.hypot(left.x - plan.region.x, left.z - plan.region.z)
      - Math.hypot(right.x - plan.region.x, right.z - plan.region.z)
    ));
  }
  const bounds = getMapBounds(map);
  const minScale = Math.max(0.1, Math.min(...plan.scaleRange));
  const maxScale = Math.max(minScale, Math.max(...plan.scaleRange));
  const placements: MapScatterPlacement[] = [];
  const occupiedBounds = existingFloorOccupiedBounds(map);
  const existingBoundsCount = occupiedBounds.length;
  const elevatedWallBounds = occupiedWallBounds(map);
  const ceilingBounds = occupiedCeilingBounds(map);
  const placedPairTargets = new Set<number>();

  for (const [index, slot] of slots.entries()) {
    if (placements.length >= count) break;
    if (plan.intent === 'paired' && slot.targetIndex !== undefined && placedPairTargets.has(slot.targetIndex)) continue;
    const asset = selectedAssets[Math.floor(random() * selectedAssets.length)];
    const scale = minScale + (maxScale - minScale) * random();
    const footprintRadius = mapAssetFootprintRadius(asset) * scale;
    const ceilingAsset = isCeilingIndoorAsset(asset);
    const elevatedWallAsset = isElevatedIndoorAsset(asset) && !ceilingAsset;
    const jitter = plan.symmetric || plan.intent === 'wall' || plan.intent === 'audience'
      ? 0
      : plan.mode === 'layout' ? spacing * 0.07 : spacing * 0.04;
    let x = slot.x + (random() - 0.5) * jitter;
    let z = slot.z + (random() - 0.5) * jitter;
    const rotationY = placementYaw(plan.facing, slot, x, z, random);
    let candidateBounds = transformedHorizontalBounds(asset, scale, rotationY, x, z);
    if (plan.intent === 'wall') {
      const snapped = snapToRoomWall(map, plan.direction, x, z, candidateBounds);
      x = snapped.x;
      z = snapped.z;
      candidateBounds = snapped.bounds;
    }
    if (!(map.room && (plan.intent === 'audience' || plan.intent === 'wall' || ceilingAsset))
      && Math.hypot(x - plan.region.x, z - plan.region.z) > plan.region.r) continue;
    if (plan.excludeRegions?.some((region) => Math.hypot(x - region.x, z - region.z) <= region.r)) continue;
    if (candidateBounds.minX < bounds.minX || candidateBounds.maxX > bounds.maxX
      || candidateBounds.minZ < bounds.minZ || candidateBounds.maxZ > bounds.maxZ) continue;
    if (isNearWater(map, x, z, Math.max(0, plan.avoidWater))) continue;
    if (terrainFootprintSlopeDegrees(map, x, z, footprintRadius) > Math.min(89, Math.max(0, plan.maxSlope))) continue;
    const collisionClearance = plan.intent === 'audience' || plan.intent === 'paired'
      || plan.intent === 'social' || plan.intent === 'viewpoint'
      ? -Math.min(0.45, footprintRadius * 0.35)
      : Math.min(0.24, spacing * 0.08);
    const collisionBounds = plan.intent === 'audience' || plan.intent === 'paired'
      || plan.intent === 'social' || plan.intent === 'viewpoint'
      ? occupiedBounds.slice(0, existingBoundsCount)
      : occupiedBounds;
    if ((!elevatedWallAsset && !ceilingAsset && collisionBounds.some((item) => horizontalBoundsOverlap(candidateBounds, item, collisionClearance)))
      || elevatedWallAsset && elevatedWallBounds.some((item) => horizontalBoundsOverlap(candidateBounds, item, 0.05))
      || ceilingAsset && ceilingBounds.some((item) => horizontalBoundsOverlap(candidateBounds, item, 0.05))
      || plan.intent === 'wall' && wallOpeningOverlap(map, plan.direction, candidateBounds)) continue;

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
    if (!elevatedWallAsset && !ceilingAsset) occupiedBounds.push(candidateBounds);
    if (elevatedWallAsset) elevatedWallBounds.push(candidateBounds);
    if (ceilingAsset) ceilingBounds.push(candidateBounds);
    if (plan.intent === 'paired' && slot.targetIndex !== undefined) placedPairTargets.add(slot.targetIndex);
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
  if (plan.mode === 'attached' && plan.intent === 'paired') {
    return pairedFurnitureSlots(plan, count, spacing);
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
  if (plan.intent === 'audience' && map.room) return roomAudienceSlots(map.room, plan, count, spacing);

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
    const minimumColumns = Math.max(1, Math.ceil(Math.sqrt(count)));
    const symmetricColumns = plan.symmetric ? symmetricGridColumns(count) : minimumColumns;
    const columns = plan.intent === 'audience' && symmetricColumns > 1 && symmetricColumns % 2 !== 0
      ? symmetricColumns + 1
      : symmetricColumns;
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

function symmetricGridColumns(count: number): number {
  for (let columns = Math.max(1, Math.ceil(Math.sqrt(count))); columns <= count; columns += 1) {
    if (count % columns === 0) return columns;
  }
  return count;
}

function roomAudienceSlots(
  room: NonNullable<EditableMap['room']>,
  plan: StructuredPlacementPlan,
  count: number,
  spacing: number
): CandidateSlot[] {
  const focusX = plan.focus?.x ?? room.position[0];
  const focusZ = plan.focus?.z ?? room.position[2] - room.size[2] * 0.35;
  const focusDistance = Math.hypot(focusX - room.position[0], focusZ - room.position[2]);
  const angle = plan.direction * Math.PI / 180;
  const forwardX = focusDistance > 0.001 ? (focusX - room.position[0]) / focusDistance : -Math.sin(angle);
  const forwardZ = focusDistance > 0.001 ? (focusZ - room.position[2]) / focusDistance : -Math.cos(angle);
  const lateralX = forwardZ;
  const lateralZ = -forwardX;
  const inset = room.wallThickness + 0.7;
  const usableWidth = Math.abs(lateralX) * Math.max(1, room.size[0] - inset * 2)
    + Math.abs(lateralZ) * Math.max(1, room.size[2] - inset * 2);
  const aisleWidth = Math.max(1.2, spacing * 0.9);
  const maximumColumnsRaw = Math.max(2, Math.floor((usableWidth - aisleWidth) / spacing) + 1);
  const maximumColumns = Math.max(2, maximumColumnsRaw % 2 === 0 ? maximumColumnsRaw : maximumColumnsRaw - 1);
  const desiredColumnsRaw = Math.max(2, Math.ceil(Math.sqrt(count)));
  const desiredColumns = desiredColumnsRaw % 2 === 0 ? desiredColumnsRaw : desiredColumnsRaw + 1;
  const columns = Math.max(2, Math.min(maximumColumns, desiredColumns));
  const frontGap = Math.max(1.4, spacing * 1.25);

  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const relativeColumn = column - (columns - 1) / 2;
    const centerAisle = columns % 2 === 0 ? 0 : Math.floor(columns / 2);
    const aisleSide = column < centerAisle ? -1 : 1;
    const lateral = relativeColumn * spacing + aisleSide * aisleWidth / 2;
    const backward = frontGap + row * spacing;
    return {
      x: focusX - forwardX * backward + lateralX * lateral,
      z: focusZ - forwardZ * backward + lateralZ * lateral,
      guideYaw: Math.atan2(forwardX, forwardZ),
      focusX,
      focusZ
    };
  });
}

function roomAudienceTargetCount(
  room: NonNullable<EditableMap['room']>,
  plan: StructuredPlacementPlan,
  spacing: number
): number {
  const inset = room.wallThickness + 0.7;
  const usableWidth = Math.max(1, room.size[0] - inset * 2);
  const usableDepth = Math.max(1, room.size[2] - inset * 2 - Math.max(1.4, spacing * 1.25));
  const aisleWidth = Math.max(1.2, spacing * 0.9);
  const columns = Math.max(2, Math.floor((usableWidth - aisleWidth) / spacing));
  const rows = Math.max(1, Math.floor(usableDepth / spacing));
  const fill = Math.min(0.92, Math.max(0.5, Math.sqrt(Math.max(0.0001, plan.density)) * 2));
  return Math.max(1, Math.ceil(columns * rows * fill));
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

function pairedFurnitureSlots(
  plan: StructuredPlacementPlan,
  count: number,
  spacing: number
): CandidateSlot[] {
  const targets = plan.targets ?? [];
  const slots: CandidateSlot[] = [];
  for (let attempt = 0; slots.length < count && attempt < Math.ceil(count / Math.max(1, targets.length)); attempt += 1) {
    for (const [targetIndex, target] of targets.entries()) {
      if (slots.length >= count) break;
      const targetYaw = target.yaw ?? plan.direction * Math.PI / 180;
      const angle = targetYaw + Math.PI;
      const distance = Math.max(Math.abs(plan.offset), (target.footprintRadius ?? 0) + spacing * 0.58) * (1 + attempt * 0.08);
      slots.push({
        x: target.x + Math.sin(angle) * distance,
        z: target.z + Math.cos(angle) * distance,
        guideYaw: targetYaw,
        focusX: target.x,
        focusZ: target.z,
        targetIndex
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

function existingFloorOccupiedBounds(map: EditableMap): HorizontalBounds[] {
  const elevatedIds = new Set((map.assets ?? [])
    .filter(isElevatedIndoorAsset)
    .map((asset) => asset.id));
  const elevatedObjectIds = new Set(map.objects
    .filter((object) => object.assetId && elevatedIds.has(object.assetId))
    .map((object) => object.id));
  return [...getMapObjectAabbs(map).filter((box) => !elevatedObjectIds.has(box.objectId)), ...getTerrainCliffAabbs(map)].map((box) => ({
    minX: box.min[0], maxX: box.max[0], minZ: box.min[2], maxZ: box.max[2]
  })).concat(roomDoorClearanceBounds(map));
}

function occupiedWallBounds(map: EditableMap): HorizontalBounds[] {
  const wallAssetIds = new Set((map.assets ?? [])
    .filter((asset) => isElevatedIndoorAsset(asset) && !isCeilingIndoorAsset(asset))
    .map((asset) => asset.id));
  const wallObjectIds = new Set(map.objects
    .filter((object) => object.assetId && wallAssetIds.has(object.assetId))
    .map((object) => object.id));
  return getMapObjectAabbs(map)
    .filter((box) => wallObjectIds.has(box.objectId))
    .map((box) => ({ minX: box.min[0], maxX: box.max[0], minZ: box.min[2], maxZ: box.max[2] }));
}

function occupiedCeilingBounds(map: EditableMap): HorizontalBounds[] {
  const ceilingAssetIds = new Set((map.assets ?? []).filter(isCeilingIndoorAsset).map((asset) => asset.id));
  const objectIds = new Set(map.objects
    .filter((object) => object.assetId && ceilingAssetIds.has(object.assetId))
    .map((object) => object.id));
  return getMapObjectAabbs(map)
    .filter((box) => objectIds.has(box.objectId))
    .map((box) => ({ minX: box.min[0], maxX: box.max[0], minZ: box.min[2], maxZ: box.max[2] }));
}

function isElevatedIndoorAsset(asset: MapAsset): boolean {
  const semantic = `${asset.name} ${asset.prompt} ${(asset.tags ?? []).join(' ')}`;
  return isElevatedWallSemantic(semantic) || isCeilingMountedSemantic(semantic);
}

function isCeilingIndoorAsset(asset: MapAsset): boolean {
  const semantic = `${asset.name} ${asset.prompt} ${(asset.tags ?? []).join(' ')}`;
  return isCeilingMountedSemantic(semantic);
}

function roomDoorClearanceBounds(map: EditableMap): HorizontalBounds[] {
  const room = map.room;
  if (!room) return [];
  const { radius, height } = getMapPlayerMetrics(map);
  const halfWidth = radius + 0.3;
  const depth = Math.max(1.2, height * 0.9);
  return room.openings.filter((opening) => opening.kind === 'door').map((opening) => {
    const along = opening.offset;
    if (opening.wall === 'north' || opening.wall === 'south') {
      const z = room.position[2] + (opening.wall === 'north'
        ? -room.size[2] / 2 + room.wallThickness + depth / 2
        : room.size[2] / 2 - room.wallThickness - depth / 2);
      const x = room.position[0] + along;
      return { minX: x - halfWidth, maxX: x + halfWidth, minZ: z - depth / 2, maxZ: z + depth / 2 };
    }
    const x = room.position[0] + (opening.wall === 'west'
      ? -room.size[0] / 2 + room.wallThickness + depth / 2
      : room.size[0] / 2 - room.wallThickness - depth / 2);
    const z = room.position[2] + along;
    return { minX: x - depth / 2, maxX: x + depth / 2, minZ: z - halfWidth, maxZ: z + halfWidth };
  });
}

function transformedHorizontalBounds(
  asset: MapAsset,
  scale: number,
  rotationY: number,
  x: number,
  z: number
): HorizontalBounds {
  const boxes = asset.colliderPlan?.boxes ?? [];
  if (boxes.length === 0) {
    const radius = mapAssetFootprintRadius(asset) * scale;
    return { minX: x - radius, maxX: x + radius, minZ: z - radius, maxZ: z + radius };
  }
  const cosine = Math.cos(rotationY);
  const sine = Math.sin(rotationY);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    for (const localX of [box.min[0], box.max[0]]) {
      for (const localZ of [box.min[2], box.max[2]]) {
        const worldX = x + (cosine * localX + sine * localZ) * scale;
        const worldZ = z + (-sine * localX + cosine * localZ) * scale;
        minX = Math.min(minX, worldX);
        maxX = Math.max(maxX, worldX);
        minZ = Math.min(minZ, worldZ);
        maxZ = Math.max(maxZ, worldZ);
      }
    }
  }
  return { minX, maxX, minZ, maxZ };
}

function horizontalBoundsOverlap(left: HorizontalBounds, right: HorizontalBounds, clearance: number): boolean {
  return left.minX < right.maxX + clearance && left.maxX > right.minX - clearance
    && left.minZ < right.maxZ + clearance && left.maxZ > right.minZ - clearance;
}

function wallOpeningOverlap(map: EditableMap, direction: number, bounds: HorizontalBounds): boolean {
  const room = map.room;
  if (!room) return false;
  const normalized = ((direction % 360) + 360) % 360;
  const wall = normalized >= 45 && normalized < 135 ? 'east'
    : normalized >= 135 && normalized < 225 ? 'south'
    : normalized >= 225 && normalized < 315 ? 'west'
    : 'north';
  const alongMin = wall === 'north' || wall === 'south'
    ? bounds.minX - room.position[0]
    : bounds.minZ - room.position[2];
  const alongMax = wall === 'north' || wall === 'south'
    ? bounds.maxX - room.position[0]
    : bounds.maxZ - room.position[2];
  return room.openings.some((opening) => (
    opening.wall === wall
    && alongMin < opening.offset + opening.width / 2 + 0.2
    && alongMax > opening.offset - opening.width / 2 - 0.2
  ));
}

function snapToRoomWall(
  map: EditableMap,
  direction: number,
  x: number,
  z: number,
  bounds: HorizontalBounds
): { x: number; z: number; bounds: HorizontalBounds } {
  const room = map.room;
  if (!room) return { x, z, bounds };
  const normalized = ((direction % 360) + 360) % 360;
  const wall = normalized >= 45 && normalized < 135 ? 'east'
    : normalized >= 135 && normalized < 225 ? 'south'
    : normalized >= 225 && normalized < 315 ? 'west'
    : 'north';
  const clearance = room.wallThickness + 0.05;
  const deltaX = wall === 'east'
    ? room.position[0] + room.size[0] / 2 - clearance - bounds.maxX
    : wall === 'west'
      ? room.position[0] - room.size[0] / 2 + clearance - bounds.minX
      : 0;
  const deltaZ = wall === 'south'
    ? room.position[2] + room.size[2] / 2 - clearance - bounds.maxZ
    : wall === 'north'
      ? room.position[2] - room.size[2] / 2 + clearance - bounds.minZ
      : 0;
  return {
    x: x + deltaX,
    z: z + deltaZ,
    bounds: {
      minX: bounds.minX + deltaX,
      maxX: bounds.maxX + deltaX,
      minZ: bounds.minZ + deltaZ,
      maxZ: bounds.maxZ + deltaZ
    }
  };
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
