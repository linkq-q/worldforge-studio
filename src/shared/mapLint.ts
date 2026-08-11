import {
  getMapBounds,
  getMapObjectAabbs,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  sampleTerrainHeight,
  terrainPointAt,
  type EditableMap,
  type MapObjectAabb
} from './map';
import { assetFootprintRadius } from './mapAssetMetadata';
import type { MapOperation } from './mapOperations';
import { findSafeSpawnPosition, isSpawnPositionSafe } from './mapSpawnSafety';
import { isPointInsideWaterBody, waterSurfaceLevelAt } from './mapWater';

export type MapLintSeverity = 'info' | 'warning' | 'error';

export interface MapLintIssue {
  code: 'spawn.unsafe' | 'object.out-of-bounds' | 'object.off-ground' | 'object.duplicate'
    | 'object.overlap' | 'water.exposed-terrain' | 'scene.sparse' | 'room.path-blocked';
  severity: MapLintSeverity;
  message: string;
  objectIds?: string[];
  repaired: boolean;
}

export interface MapLintResult {
  issues: MapLintIssue[];
  repairOperations: MapOperation[];
}

export function lintMap(map: EditableMap): MapLintResult {
  const issues: MapLintIssue[] = [];
  const repairOperations: MapOperation[] = [];
  const removedIds = findExactDuplicates(map, issues, repairOperations);
  lintObjectPlacement(map, removedIds, issues, repairOperations);
  lintSpawn(map, issues, repairOperations);
  lintRoomPaths(map, issues);
  lintWaterExposure(map, issues, repairOperations);
  lintOverlaps(map, removedIds, issues);
  if (map.objects.length < Math.max(2, Math.floor(map.box.size[0] * map.box.size[2] / 3000))) {
    issues.push({
      code: 'scene.sparse',
      severity: 'info',
      message: '场景空间内容较少，建议在 Refine 中补充地标或分区。',
      repaired: false
    });
  }
  return { issues, repairOperations };
}

function findExactDuplicates(
  map: EditableMap,
  issues: MapLintIssue[],
  repairs: MapOperation[]
): Set<string> {
  const seen = new Map<string, string>();
  const removed = new Set<string>();
  for (const object of map.objects) {
    if (!object.assetId || object.parentId) continue;
    const [x, y, z] = object.transform.position;
    const key = [object.assetId, round(x), round(y), round(z)].join(':');
    const firstId = seen.get(key);
    if (!firstId) {
      seen.set(key, object.id);
      continue;
    }
    removed.add(object.id);
    repairs.push({ type: 'object.remove', objectId: object.id });
    issues.push({
      code: 'object.duplicate',
      severity: 'warning',
      message: `移除与 ${firstId} 完全重叠的重复物体。`,
      objectIds: [firstId, object.id],
      repaired: true
    });
  }
  return removed;
}

function lintObjectPlacement(
  map: EditableMap,
  removedIds: Set<string>,
  issues: MapLintIssue[],
  repairs: MapOperation[]
): void {
  const bounds = getMapBounds(map);
  const room = map.sceneMode === 'indoor' ? map.room : null;
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  for (const object of map.objects) {
    if (!object.assetId || object.parentId || removedIds.has(object.id)) continue;
    const position = [...object.transform.position] as [number, number, number];
    const asset = assets.get(object.assetId);
    const radius = (asset?.footprintRadius ?? (asset ? assetFootprintRadius(asset.colliderPlan) : 0.5))
      * Math.max(object.transform.scale[0], object.transform.scale[2]);
    const minX = room ? room.position[0] - room.size[0] / 2 + room.wallThickness : bounds.minX;
    const maxX = room ? room.position[0] + room.size[0] / 2 - room.wallThickness : bounds.maxX;
    const minZ = room ? room.position[2] - room.size[2] / 2 + room.wallThickness : bounds.minZ;
    const maxZ = room ? room.position[2] + room.size[2] / 2 - room.wallThickness : bounds.maxZ;
    const nextX = clamp(position[0], minX + radius, maxX - radius);
    const nextZ = clamp(position[2], minZ + radius, maxZ - radius);
    const fixedHeight = object.heightMode === 'fixed' || Boolean(object.roomOpeningId);
    const nextY = fixedHeight ? position[1] : room?.position[1] ?? sampleTerrainHeight(map, nextX, nextZ);
    const outOfBounds = Math.abs(nextX - position[0]) > 0.001 || Math.abs(nextZ - position[2]) > 0.001;
    const offGround = !fixedHeight && Math.abs(nextY - position[1]) > 0.05;
    if (!outOfBounds && !offGround) continue;
    repairs.push({
      type: 'object.update',
      objectId: object.id,
      patch: { transform: { position: [nextX, nextY, nextZ] } }
    });
    if (outOfBounds) issues.push({
      code: 'object.out-of-bounds', severity: 'warning', message: '物体已移回地图边界内。',
      objectIds: [object.id], repaired: true
    });
    if (offGround) issues.push({
      code: 'object.off-ground', severity: 'warning', message: '物体已重新贴合地形。',
      objectIds: [object.id], repaired: true
    });
  }
}

function lintRoomPaths(map: EditableMap, issues: MapLintIssue[]): void {
  const room = map.room;
  if (!room) return;
  const doors = room.openings.filter((opening) => opening.kind === 'door');
  if (doors.length === 0) return;
  const linkedObjectByOpening = new Map(map.objects
    .filter((object) => object.roomOpeningId)
    .map((object) => [object.roomOpeningId as string, object.id]));
  const allObstacles = getMapObjectAabbs(map);
  const start = map.spawnPoints[0] ?? room.position;
  for (const door of doors) {
    const linkedObjectId = linkedObjectByOpening.get(door.id);
    const obstacles = linkedObjectId
      ? allObstacles.filter((obstacle) => obstacle.objectId !== linkedObjectId)
      : allObstacles;
    if (hasRoomPath(room, [start[0], start[2]], roomDoorInsidePoint(room, door), obstacles)) continue;
    issues.push({
      code: 'room.path-blocked',
      severity: 'warning',
      message: `出生点到门口 ${door.id} 没有至少 ${(PLAYER_RADIUS * 2).toFixed(1)}m 宽的连续通道。`,
      repaired: false
    });
  }
}

function hasRoomPath(
  room: NonNullable<EditableMap['room']>,
  start: [number, number],
  goal: [number, number],
  obstacles: MapObjectAabb[]
): boolean {
  const step = 0.4;
  const minX = room.position[0] - room.size[0] / 2 + room.wallThickness + PLAYER_RADIUS;
  const maxX = room.position[0] + room.size[0] / 2 - room.wallThickness - PLAYER_RADIUS;
  const minZ = room.position[2] - room.size[2] / 2 + room.wallThickness + PLAYER_RADIUS;
  const maxZ = room.position[2] + room.size[2] / 2 - room.wallThickness - PLAYER_RADIUS;
  const width = Math.max(1, Math.floor((maxX - minX) / step) + 1);
  const depth = Math.max(1, Math.floor((maxZ - minZ) / step) + 1);
  const cellOf = ([x, z]: [number, number]): [number, number] => [
    clamp(Math.round((x - minX) / step), 0, width - 1),
    clamp(Math.round((z - minZ) / step), 0, depth - 1)
  ];
  const [startX, startZ] = cellOf(start);
  const [goalX, goalZ] = cellOf(goal);
  const queue: Array<[number, number]> = [[startX, startZ]];
  const visited = new Set([`${startX},${startZ}`]);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [xIndex, zIndex] = queue[cursor];
    if (xIndex === goalX && zIndex === goalZ) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nextX = xIndex + dx;
      const nextZ = zIndex + dz;
      const key = `${nextX},${nextZ}`;
      if (nextX < 0 || nextX >= width || nextZ < 0 || nextZ >= depth || visited.has(key)) continue;
      const worldX = minX + nextX * step;
      const worldZ = minZ + nextZ * step;
      if (obstacles.some((obstacle) => roomPathPointBlocked(room.position[1], worldX, worldZ, obstacle))) continue;
      visited.add(key);
      queue.push([nextX, nextZ]);
    }
  }
  return false;
}

function roomPathPointBlocked(floorY: number, x: number, z: number, obstacle: MapObjectAabb): boolean {
  if (obstacle.max[1] <= floorY + 0.05 || obstacle.min[1] >= floorY + PLAYER_HEIGHT) return false;
  const closestX = clamp(x, obstacle.min[0], obstacle.max[0]);
  const closestZ = clamp(z, obstacle.min[2], obstacle.max[2]);
  return Math.hypot(x - closestX, z - closestZ) < PLAYER_RADIUS + 0.05;
}

function roomDoorInsidePoint(
  room: NonNullable<EditableMap['room']>,
  door: NonNullable<EditableMap['room']>['openings'][number]
): [number, number] {
  const inset = room.wallThickness + PLAYER_RADIUS + 0.1;
  if (door.wall === 'north') return [room.position[0] + door.offset, room.position[2] - room.size[2] / 2 + inset];
  if (door.wall === 'south') return [room.position[0] + door.offset, room.position[2] + room.size[2] / 2 - inset];
  if (door.wall === 'east') return [room.position[0] + room.size[0] / 2 - inset, room.position[2] + door.offset];
  return [room.position[0] - room.size[0] / 2 + inset, room.position[2] + door.offset];
}

function lintSpawn(map: EditableMap, issues: MapLintIssue[], repairs: MapOperation[]): void {
  const current = map.spawnPoints[0];
  if (!current || isSpawnPositionSafe(map, current[0], current[2])) return;
  const [x, z] = findSafeSpawnPosition(map, current[0], current[2]);
  repairs.push({
    type: 'reference.set',
    point: [x, sampleTerrainHeight(map, x, z), z],
    yaw: map.spawnYaw
  });
  issues.push({
    code: 'spawn.unsafe', severity: 'error', message: '出生点已移动到附近可站立位置。', repaired: true
  });
}

function lintWaterExposure(map: EditableMap, issues: MapLintIssue[], repairs: MapOperation[]): void {
  for (const water of map.waterBodies) {
    if (water.type === 'ocean') continue;
    let exposed = false;
    for (let z = 0; z < map.terrain.resolutionZ && !exposed; z += 1) {
      for (let x = 0; x < map.terrain.resolutionX; x += 1) {
        const point = terrainPointAt(map, x, z);
        if (isPointInsideWaterBody(water, point[0], point[2], map)
          && point[1] > waterSurfaceLevelAt(water, point[0], point[2]) + 0.001) {
          exposed = true;
          break;
        }
      }
    }
    if (!exposed) continue;
    repairs.push({ type: 'water.update', waterId: water.id, patch: {} });
    issues.push({
      code: 'water.exposed-terrain', severity: 'error', message: '水体盆地或河床已重新刻蚀，修复水面穿地。', repaired: true
    });
  }
}

function lintOverlaps(map: EditableMap, removedIds: Set<string>, issues: MapLintIssue[]): void {
  const boxes = getMapObjectAabbs(map).filter((box) => !removedIds.has(box.objectId));
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      if (overlapRatio(boxes[left], boxes[right]) < 0.65) continue;
      issues.push({
        code: 'object.overlap',
        severity: 'warning',
        message: '检测到明显物体重叠；保留现状并建议在 Refine 中调整。',
        objectIds: [boxes[left].objectId, boxes[right].objectId],
        repaired: false
      });
    }
  }
}

function overlapRatio(a: MapObjectAabb, b: MapObjectAabb): number {
  const width = Math.max(0, Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]));
  const depth = Math.max(0, Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]));
  const smallest = Math.min(
    Math.max(0.0001, (a.max[0] - a.min[0]) * (a.max[2] - a.min[2])),
    Math.max(0.0001, (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]))
  );
  return width * depth / smallest;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
