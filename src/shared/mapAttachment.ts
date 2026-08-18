import {
  createMapObject,
  getMapAssetLocalBounds,
  getMapBounds,
  getMapObjectAabbs,
  getObjectWorldTransforms,
  type EditableMap,
  type MapAsset,
  type MapObject,
  type RoomWall,
  type WorldTransform
} from './map';
import type { Vec3 } from './protocol';

export const MAX_MAP_OBJECT_HIERARCHY_DEPTH = 4;

export interface MapObjectAttachmentInput {
  id: string;
  name: string;
  parentId: string;
  asset: MapAsset;
  kind: 'supported' | 'mounted';
  side?: RoomWall;
  scale?: number;
  yaw?: number;
  /** supported: local X/Z; mounted: local horizontal/vertical offset. */
  offset?: [number, number];
  /** World-space contact gap for supported objects or embed depth for mounted objects. */
  contact?: number;
}

export function planMapObjectAttachment(map: EditableMap, input: MapObjectAttachmentInput): MapObject {
  if (map.objects.some((object) => object.id === input.id)) throw new Error('duplicate_object_id');
  const parent = map.objects.find((object) => object.id === input.parentId);
  if (!parent) throw new Error('map_attachment_parent_not_found');
  if (mapObjectAncestorDepth(map, parent.id) >= MAX_MAP_OBJECT_HIERARCHY_DEPTH) {
    throw new Error('map_attachment_depth_exceeded');
  }
  const parentAsset = parent.assetId ? (map.assets ?? []).find((asset) => asset.id === parent.assetId) : undefined;
  if (!parentAsset) throw new Error('map_attachment_parent_asset_missing');
  const parentWorld = getObjectWorldTransforms(map).get(parent.id);
  if (!parentWorld) throw new Error('map_attachment_parent_not_found');
  const parentBounds = getMapAssetLocalBounds(parentAsset);
  const childBounds = getMapAssetLocalBounds(input.asset);
  const desiredScale = boundedNumber(input.scale, 1, 0.1, 8);
  const localScale: Vec3 = parentWorld.scale.map((scale) => desiredScale / safeScaleMagnitude(scale)) as Vec3;
  const offset = input.offset ?? [0, 0];
  const contact = boundedNumber(input.contact, 0.02, 0, 2);
  const object = createMapObject(input.name, input.asset.id);
  object.id = input.id;
  object.parentId = parent.id;
  object.heightMode = 'fixed';
  object.transform.scale = localScale;
  object.transform.rotation[1] = boundedNumber(input.yaw, 0, -Math.PI * 8, Math.PI * 8);
  object.transform.position = input.kind === 'supported'
    ? supportedPosition(parentBounds, childBounds, localScale, parentWorld, offset, contact)
    : mountedPosition(parentBounds, childBounds, localScale, parentWorld, input.side, offset, contact);

  assertAttachmentFitsMap(map, object, input.asset);
  assertNoUnrelatedOverlap(map, object, input.asset);
  return object;
}

export function canReparentMapObject(map: EditableMap, objectId: string, parentId: string | null): boolean {
  try {
    validateReparent(map, objectId, parentId);
    return true;
  } catch {
    return false;
  }
}

export function reparentMapObjectInPlace(map: EditableMap, objectId: string, parentId: string | null): void {
  const object = validateReparent(map, objectId, parentId);
  if (object.parentId === parentId) return;
  const world = getObjectWorldTransforms(map).get(object.id);
  if (!world) throw new Error('map_object_not_found');
  const parentWorld = parentId ? getObjectWorldTransforms(map).get(parentId) : undefined;
  object.parentId = parentId;
  object.heightMode = 'fixed';
  if (!parentWorld) {
    object.transform.position = [...world.position];
    object.transform.rotation = [...world.rotation];
    object.transform.scale = divideVec3(world.scale, object.transform.size);
    return;
  }
  object.transform.position = divideVec3(
    inverseRotateEuler(subtractVec3(world.position, parentWorld.position), parentWorld.rotation),
    parentWorld.scale
  );
  object.transform.rotation = subtractVec3(world.rotation, parentWorld.rotation);
  object.transform.scale = divideVec3(divideVec3(world.scale, parentWorld.scale), object.transform.size);
}

function supportedPosition(
  parent: ReturnType<typeof getMapAssetLocalBounds>,
  child: ReturnType<typeof getMapAssetLocalBounds>,
  localScale: Vec3,
  parentWorld: WorldTransform,
  offset: [number, number],
  contact: number
): Vec3 {
  const x = (parent.min[0] + parent.max[0]) / 2 + finiteNumber(offset[0], 0);
  const z = (parent.min[2] + parent.max[2]) / 2 + finiteNumber(offset[1], 0);
  if (x < parent.min[0] || x > parent.max[0] || z < parent.min[2] || z > parent.max[2]) {
    throw new Error('map_attachment_outside_parent_surface');
  }
  return [
    x - ((child.min[0] + child.max[0]) / 2) * localScale[0],
    parent.max[1] - child.min[1] * localScale[1] + contact / safeScaleMagnitude(parentWorld.scale[1]),
    z - ((child.min[2] + child.max[2]) / 2) * localScale[2]
  ];
}

function mountedPosition(
  parent: ReturnType<typeof getMapAssetLocalBounds>,
  child: ReturnType<typeof getMapAssetLocalBounds>,
  localScale: Vec3,
  parentWorld: WorldTransform,
  side: RoomWall | undefined,
  offset: [number, number],
  contact: number
): Vec3 {
  if (side !== 'north' && side !== 'south' && side !== 'east' && side !== 'west') {
    throw new Error('map_attachment_side_required');
  }
  const horizontal = finiteNumber(offset[0], 0);
  const vertical = finiteNumber(offset[1], 0);
  const centerX = (parent.min[0] + parent.max[0]) / 2;
  const centerY = (parent.min[1] + parent.max[1]) / 2;
  const centerZ = (parent.min[2] + parent.max[2]) / 2;
  const childCenterX = (child.min[0] + child.max[0]) / 2;
  const childCenterY = (child.min[1] + child.max[1]) / 2;
  const childCenterZ = (child.min[2] + child.max[2]) / 2;
  const anchorX = centerX + (side === 'north' || side === 'south' ? horizontal : 0);
  const anchorY = centerY + vertical;
  const anchorZ = centerZ + (side === 'east' || side === 'west' ? horizontal : 0);
  if (anchorX < parent.min[0] || anchorX > parent.max[0]
    || anchorY < parent.min[1] || anchorY > parent.max[1]
    || anchorZ < parent.min[2] || anchorZ > parent.max[2]) {
    throw new Error('map_attachment_outside_parent_surface');
  }
  const insetX = contact / safeScaleMagnitude(parentWorld.scale[0]);
  const insetZ = contact / safeScaleMagnitude(parentWorld.scale[2]);
  if (side === 'east') return [
    parent.max[0] - child.min[0] * localScale[0] - insetX,
    anchorY - childCenterY * localScale[1],
    anchorZ - childCenterZ * localScale[2]
  ];
  if (side === 'west') return [
    parent.min[0] - child.max[0] * localScale[0] + insetX,
    anchorY - childCenterY * localScale[1],
    anchorZ - childCenterZ * localScale[2]
  ];
  if (side === 'south') return [
    anchorX - childCenterX * localScale[0],
    anchorY - childCenterY * localScale[1],
    parent.max[2] - child.min[2] * localScale[2] - insetZ
  ];
  return [
    anchorX - childCenterX * localScale[0],
    anchorY - childCenterY * localScale[1],
    parent.min[2] - child.max[2] * localScale[2] + insetZ
  ];
}

function assertAttachmentFitsMap(map: EditableMap, object: MapObject, asset: MapAsset): void {
  const preview = attachmentPreviewMap(map, object, asset);
  const bounds = getMapBounds(map);
  const boxes = getMapObjectAabbs(preview).filter((box) => box.objectId === object.id);
  if (boxes.some((box) => box.min[0] < bounds.minX || box.max[0] > bounds.maxX
    || box.min[2] < bounds.minZ || box.max[2] > bounds.maxZ)) {
    throw new Error('map_attachment_out_of_bounds');
  }
}

function assertNoUnrelatedOverlap(map: EditableMap, object: MapObject, asset: MapAsset): void {
  const preview = attachmentPreviewMap(map, object, asset);
  const boxes = getMapObjectAabbs(preview);
  const candidate = boxes.filter((box) => box.objectId === object.id);
  const relatedIds = mapObjectAncestorIds(preview, object.parentId!);
  relatedIds.add(object.id);
  const unrelated = boxes.filter((box) => !relatedIds.has(box.objectId));
  if (candidate.some((left) => unrelated.some((right) => aabbIntersects(left, right)))) {
    throw new Error('map_attachment_unrelated_overlap');
  }
}

function attachmentPreviewMap(map: EditableMap, object: MapObject, asset: MapAsset): EditableMap {
  const currentAssets = map.assets ?? [];
  const assets = currentAssets.some((item) => item.id === asset.id) ? currentAssets : [...currentAssets, asset];
  return { ...map, assets, objects: [...map.objects, object] };
}

function validateReparent(map: EditableMap, objectId: string, parentId: string | null): MapObject {
  const object = map.objects.find((item) => item.id === objectId);
  if (!object) throw new Error('map_object_not_found');
  if (parentId === objectId) throw new Error('map_object_parent_cycle');
  if (parentId && !map.objects.some((item) => item.id === parentId)) throw new Error('map_object_parent_not_found');
  const ancestorIds = parentId ? mapObjectAncestorIds(map, parentId) : new Set<string>();
  if (ancestorIds.has(objectId)) throw new Error('map_object_parent_cycle');
  const parentDepth = parentId ? mapObjectAncestorDepth(map, parentId) : 0;
  if (parentDepth + mapObjectSubtreeDepth(map, objectId) > MAX_MAP_OBJECT_HIERARCHY_DEPTH) {
    throw new Error('map_attachment_depth_exceeded');
  }
  return object;
}

function mapObjectAncestorDepth(map: EditableMap, objectId: string): number {
  return mapObjectAncestorIds(map, objectId).size;
}

function mapObjectAncestorIds(map: EditableMap, objectId: string): Set<string> {
  const byId = new Map(map.objects.map((object) => [object.id, object]));
  const result = new Set<string>();
  let current = byId.get(objectId);
  while (current) {
    if (result.has(current.id)) throw new Error('map_object_parent_cycle');
    result.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return result;
}

function mapObjectSubtreeDepth(map: EditableMap, objectId: string, visiting = new Set<string>()): number {
  if (visiting.has(objectId)) throw new Error('map_object_parent_cycle');
  const nextVisiting = new Set(visiting).add(objectId);
  const childDepths = map.objects
    .filter((object) => object.parentId === objectId)
    .map((object) => mapObjectSubtreeDepth(map, object.id, nextVisiting));
  return 1 + Math.max(0, ...childDepths);
}

function aabbIntersects(
  left: { min: Vec3; max: Vec3 },
  right: { min: Vec3; max: Vec3 }
): boolean {
  const epsilon = 0.015;
  return left.min[0] < right.max[0] - epsilon && left.max[0] > right.min[0] + epsilon
    && left.min[1] < right.max[1] - epsilon && left.max[1] > right.min[1] + epsilon
    && left.min[2] < right.max[2] - epsilon && left.max[2] > right.min[2] + epsilon;
}

function inverseRotateEuler(vector: Vec3, rotation: Vec3): Vec3 {
  const [rx, ry, rz] = rotation;
  const cz = Math.cos(-rz);
  const sz = Math.sin(-rz);
  const cy = Math.cos(-ry);
  const sy = Math.sin(-ry);
  const cx = Math.cos(-rx);
  const sx = Math.sin(-rx);
  const x1 = vector[0] * cz - vector[1] * sz;
  const y1 = vector[0] * sz + vector[1] * cz;
  const x2 = x1 * cy + vector[2] * sy;
  const z2 = -x1 * sy + vector[2] * cy;
  return [x2, y1 * cx - z2 * sx, y1 * sx + z2 * cx];
}

function divideVec3(left: Vec3, right: Vec3): Vec3 {
  return [
    left[0] / safeScale(right[0]),
    left[1] / safeScale(right[1]),
    left[2] / safeScale(right[2])
  ];
}

function subtractVec3(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = finiteNumber(value, fallback);
  return Math.min(max, Math.max(min, number));
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeScale(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) < 0.0001) throw new Error('map_object_parent_scale_invalid');
  return value;
}

function safeScaleMagnitude(value: number): number {
  return Math.abs(safeScale(value));
}
