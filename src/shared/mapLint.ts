import {
  getMapBounds,
  getMapObjectAabbs,
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
    | 'object.overlap' | 'water.exposed-terrain' | 'scene.sparse';
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
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  for (const object of map.objects) {
    if (!object.assetId || object.parentId || removedIds.has(object.id)) continue;
    const position = [...object.transform.position] as [number, number, number];
    const asset = assets.get(object.assetId);
    const radius = (asset?.footprintRadius ?? (asset ? assetFootprintRadius(asset.colliderPlan) : 0.5))
      * Math.max(object.transform.scale[0], object.transform.scale[2]);
    const nextX = clamp(position[0], bounds.minX + radius, bounds.maxX - radius);
    const nextZ = clamp(position[2], bounds.minZ + radius, bounds.maxZ - radius);
    const nextY = sampleTerrainHeight(map, nextX, nextZ);
    const outOfBounds = Math.abs(nextX - position[0]) > 0.001 || Math.abs(nextZ - position[2]) > 0.001;
    const offGround = Math.abs(nextY - position[1]) > 0.05;
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
