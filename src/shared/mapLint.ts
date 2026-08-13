import {
  getMapBounds,
  getMapObjectAabbs,
  getMapObjectVisualAabbs,
  getMapPlayerMetrics,
  worldScaleProfileMultiplier,
  sampleTerrainHeight,
  terrainPointAt,
  type EditableMap,
  type MapObjectAabb
} from './map';
import { assetFootprintRadius } from './mapAssetMetadata';
import { indoorSemanticDimensions, isCeilingMountedSemantic, isElevatedWallSemantic } from './indoorScale';
import { applyMapOperations, type MapOperation } from './mapOperations';
import { findSafeSpawnPosition, isSpawnPositionSafe } from './mapSpawnSafety';
import { isPointInsideWaterBody, waterSurfaceLevelAt } from './mapWater';

export type MapLintSeverity = 'info' | 'warning' | 'error';

export interface MapLintIssue {
  code: 'spawn.unsafe' | 'object.out-of-bounds' | 'object.off-ground' | 'object.duplicate'
    | 'object.above-ceiling' | 'object.too-small' | 'object.scale-mismatch' | 'object.overlap'
    | 'object.wall-mounted'
    | 'water.exposed-terrain' | 'scene.sparse' | 'room.path-blocked' | 'asset.unplaced'
    | 'asset.minimum-degraded';
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
  let workingMap = repairOperations.length > 0 ? applyMapOperations(map, repairOperations) : map;
  lintRoomPaths(workingMap, issues, repairOperations);
  workingMap = repairOperations.length > 0 ? applyMapOperations(map, repairOperations) : map;
  lintSpawn(workingMap, issues, repairOperations);
  lintWaterExposure(map, issues, repairOperations);
  lintOverlaps(workingMap, removedIds, issues);
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
  const objectBounds = aggregateObjectBounds(getMapObjectVisualAabbs(map));
  for (const object of map.objects) {
    if (!object.assetId || object.parentId || object.locked || removedIds.has(object.id)) continue;
    const position = [...object.transform.position] as [number, number, number];
    const asset = assets.get(object.assetId);
    const currentBounds = objectBounds.get(object.id);
    const radius = (asset?.footprintRadius ?? (asset ? assetFootprintRadius(asset.colliderPlan) : 0.5))
      * Math.max(object.transform.scale[0], object.transform.scale[2]);
    const minX = room ? room.position[0] - room.size[0] / 2 + room.wallThickness : bounds.minX;
    const maxX = room ? room.position[0] + room.size[0] / 2 - room.wallThickness : bounds.maxX;
    const minZ = room ? room.position[2] - room.size[2] / 2 + room.wallThickness : bounds.minZ;
    const maxZ = room ? room.position[2] + room.size[2] / 2 - room.wallThickness : bounds.maxZ;
    const leftExtent = currentBounds ? position[0] - currentBounds.min[0] : radius;
    const rightExtent = currentBounds ? currentBounds.max[0] - position[0] : radius;
    const nearExtent = currentBounds ? position[2] - currentBounds.min[2] : radius;
    const farExtent = currentBounds ? currentBounds.max[2] - position[2] : radius;
    let nextX = clamp(position[0], minX + leftExtent, maxX - rightExtent);
    let nextZ = clamp(position[2], minZ + nearExtent, maxZ - farExtent);
    const fixedHeight = object.heightMode === 'fixed' || Boolean(object.roomOpeningId);
    const floorY = room?.position[1] ?? sampleTerrainHeight(map, nextX, nextZ);
    let nextY = fixedHeight ? position[1] : floorY;
    let nextScale = [...object.transform.scale] as [number, number, number];
    let aboveCeiling = false;
    let tooSmall = false;
    let scaleMismatch = false;
    const semantic = [
      asset?.name,
      asset?.prompt,
      ...(asset?.tags ?? [])
    ].filter(Boolean).join(' ');
    const mountSemantic = [asset?.name, ...(asset?.tags ?? [])].filter(Boolean).join(' ');
    const wallMounted = Boolean(object.roomOpeningId) || isElevatedWallSemantic(mountSemantic);
    const ceilingMounted = isCeilingMountedSemantic(semantic);
    const elevated = wallMounted || ceilingMounted;
    let wallMountAdjusted = false;
    if (room && wallMounted && !object.roomOpeningId && currentBounds) {
      const distances = [
        { wall: 'west', distance: Math.abs(currentBounds.min[0] - minX) },
        { wall: 'east', distance: Math.abs(maxX - currentBounds.max[0]) },
        { wall: 'north', distance: Math.abs(currentBounds.min[2] - minZ) },
        { wall: 'south', distance: Math.abs(maxZ - currentBounds.max[2]) }
      ].sort((left, right) => left.distance - right.distance);
      if (distances[0].wall === 'west') nextX = position[0] + minX - currentBounds.min[0];
      if (distances[0].wall === 'east') nextX = position[0] + maxX - currentBounds.max[0];
      if (distances[0].wall === 'north') nextZ = position[2] + minZ - currentBounds.min[2];
      if (distances[0].wall === 'south') nextZ = position[2] + maxZ - currentBounds.max[2];
      if (currentBounds.min[1] < floorY + 0.35) {
        const centerOffset = (currentBounds.min[1] + currentBounds.max[1]) / 2 - position[1];
        const mountCenter = floorY + Math.min(room.size[1] * 0.58, getMapPlayerMetrics(map).height * 1.15);
        nextY = mountCenter - centerOffset;
        wallMountAdjusted = true;
      }
    }
    if (!room && currentBounds) {
      const { height: playerHeight } = getMapPlayerMetrics(map);
      const profile = worldScaleProfileMultiplier(map.worldScaleProfile);
      const majorExtent = Math.max(
        currentBounds.max[0] - currentBounds.min[0],
        currentBounds.max[1] - currentBounds.min[1],
        currentBounds.max[2] - currentBounds.min[2]
      );
      const explicitlyTiny = /tiny|miniature|pebble|gravel|seedling|小石子|碎石|幼苗/i.test(semantic);
      const minimumExtent = /tree|pine|oak|palm|树|松|橡树|棕榈/i.test(semantic)
        ? playerHeight * 2.6 * profile
        : /rock|stone|boulder|石|岩/i.test(semantic)
          ? playerHeight * 0.45 * profile
          : explicitlyTiny ? playerHeight / 24 : playerHeight / 6;
      const fit = minimumExtent / Math.max(0.001, majorExtent);
      tooSmall = fit > 1.01;
      if (tooSmall) {
        nextScale = nextScale.map((value) => value * fit) as [number, number, number];
        nextY = floorY - (currentBounds.min[1] - position[1]) * fit;
      }
    }
    if (room && currentBounds) {
      const ceilingY = room.position[1] + room.size[1];
      const currentHeight = Math.max(0.001, currentBounds.max[1] - currentBounds.min[1]);
      const target = indoorSemanticDimensions(map, semantic);
      const currentWidth = Math.max(0.001, currentBounds.max[0] - currentBounds.min[0]);
      const currentDepth = Math.max(0.001, currentBounds.max[2] - currentBounds.min[2]);
      let verticalFit = 1;
      if (!elevated && target.targetHeight !== null
        && (currentHeight < target.targetHeight * 0.88 || currentHeight > target.targetHeight * 1.12)) {
        verticalFit = target.targetHeight / currentHeight;
        scaleMismatch = true;
      }
      const widthFit = target.minimumWidth / currentWidth;
      const depthFit = target.minimumDepth / currentDepth;
      let horizontalFit = verticalFit;
      if (!elevated && (widthFit > 1.08 || depthFit > 1.08)) {
        horizontalFit = Math.max(horizontalFit, widthFit, depthFit);
        scaleMismatch = true;
      }
      const ceilingFit = Math.max(0.05, (room.size[1] - 0.02) / currentHeight);
      aboveCeiling = currentBounds.max[1] > ceilingY + 0.01 || currentHeight * verticalFit > room.size[1] - 0.02;
      verticalFit = Math.min(verticalFit, ceilingFit);
      if (Math.abs(horizontalFit - 1) > 0.001 || Math.abs(verticalFit - 1) > 0.001) {
        nextScale = [
          nextScale[0] * horizontalFit,
          nextScale[1] * verticalFit,
          nextScale[2] * horizontalFit
        ];
      }
      if (ceilingMounted) {
        const topOffset = (currentBounds.max[1] - position[1]) * verticalFit;
        nextY = ceilingY - room.wallThickness - topOffset;
      } else if (!elevated) {
        const bottomOffset = (currentBounds.min[1] - position[1]) * verticalFit;
        nextY = floorY - bottomOffset;
      } else if (aboveCeiling) {
        const centerOffset = ((currentBounds.min[1] + currentBounds.max[1]) / 2 - position[1]) * verticalFit;
        nextY = floorY + room.size[1] / 2 - centerOffset;
      }
    }
    const outOfBounds = Math.abs(nextX - position[0]) > 0.001 || Math.abs(nextZ - position[2]) > 0.001;
    const offGround = Math.abs(nextY - position[1]) > 0.05 && !wallMountAdjusted;
    if (!outOfBounds && !offGround && !wallMountAdjusted && !aboveCeiling && !tooSmall && !scaleMismatch) continue;
    repairs.push({
      type: 'object.update',
      objectId: object.id,
      patch: { transform: { position: [nextX, nextY, nextZ], scale: nextScale } }
    });
    if (outOfBounds) issues.push({
      code: 'object.out-of-bounds', severity: 'warning', message: '物体已移回地图边界内。',
      objectIds: [object.id], repaired: true
    });
    if (offGround) issues.push({
      code: 'object.off-ground', severity: 'warning', message: '物体已重新贴合地形。',
      objectIds: [object.id], repaired: true
    });
    if (wallMountAdjusted) issues.push({
      code: 'object.wall-mounted', severity: 'warning', message: '墙面物体已贴墙并提升到可读高度。',
      objectIds: [object.id], repaired: true
    });
    if (aboveCeiling) issues.push({
      code: 'object.above-ceiling', severity: 'warning', message: '物体已等比缩放并重新贴地，最高点不会超过天花板。',
      objectIds: [object.id], repaired: true
    });
    if (tooSmall) issues.push({
      code: 'object.too-small', severity: 'warning', message: '物体相对角色过小，已按语义尺度等比放大并重新贴地。',
      objectIds: [object.id], repaired: true
    });
    if (scaleMismatch) issues.push({
      code: 'object.scale-mismatch', severity: 'warning', message: '室内家具的可见高度与角色尺度不协调，已按家具语义等比修正并重新贴地。',
      objectIds: [object.id], repaired: true
    });
  }
}

function lintRoomPaths(map: EditableMap, issues: MapLintIssue[], repairs: MapOperation[]): void {
  const room = map.room;
  if (!room) return;
  const doors = room.openings.filter((opening) => opening.kind === 'door');
  if (doors.length === 0) return;
  let pathMap = map;
  const start = map.spawnPoints[0] ?? room.position;
  const { radius, height } = getMapPlayerMetrics(map);
  for (const door of doors) {
    const linkedObjectByOpening = new Map(pathMap.objects
      .filter((object) => object.roomOpeningId)
      .map((object) => [object.roomOpeningId as string, object.id]));
    const allObstacles = getMapObjectAabbs(pathMap);
    const linkedObjectId = linkedObjectByOpening.get(door.id);
    const obstacles = linkedObjectId
      ? allObstacles.filter((obstacle) => obstacle.objectId !== linkedObjectId)
      : allObstacles;
    const goal = roomDoorInsidePoint(room, door, radius);
    if (hasRoomPath(room, [start[0], start[2]], goal, obstacles, radius, height)) continue;
    const relocation = findRoomPathRelocation(pathMap, room, [start[0], start[2]], goal, obstacles, radius, height);
    if (relocation) {
      const operation: MapOperation = {
        type: 'object.update',
        objectId: relocation.objectId,
        patch: { transform: { position: relocation.position } }
      };
      repairs.push(operation);
      pathMap = applyMapOperations(pathMap, [operation]);
      issues.push({
        code: 'room.path-blocked',
        severity: 'warning',
        message: `已将阻挡出生点到门口 ${door.id} 的物体移到房间边缘，恢复至少 ${(radius * 2).toFixed(1)}m 宽的连续通道。`,
        objectIds: [relocation.objectId],
        repaired: true
      });
      continue;
    }
    issues.push({
      code: 'room.path-blocked',
      severity: 'warning',
      message: `出生点到门口 ${door.id} 没有至少 ${(radius * 2).toFixed(1)}m 宽的连续通道。`,
      repaired: false
    });
  }
}

function findRoomPathRelocation(
  map: EditableMap,
  room: NonNullable<EditableMap['room']>,
  start: [number, number],
  goal: [number, number],
  obstacles: MapObjectAabb[],
  playerRadius: number,
  playerHeight: number
): { objectId: string; position: [number, number, number] } | null {
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const boundsByObject = aggregateObjectBounds(obstacles);
  const objectsWithChildren = new Set(map.objects.flatMap((object) => object.parentId ? [object.parentId] : []));
  const candidates = map.objects
    .filter((object) => object.assetId && !object.parentId && !object.locked && !object.roomOpeningId && !objectsWithChildren.has(object.id))
    .flatMap((object) => {
      const bounds = boundsByObject.get(object.id);
      const asset = object.assetId ? assets.get(object.assetId) : undefined;
      const semantic = [asset?.name, asset?.prompt, ...(asset?.tags ?? [])].filter(Boolean).join(' ');
      if (!bounds || isElevatedWallSemantic(semantic) || isCeilingMountedSemantic(semantic)) return [];
      if (bounds.max[1] <= room.position[1] + 0.05 || bounds.min[1] >= room.position[1] + playerHeight) return [];
      const center: [number, number] = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
      return [{ object, bounds, routeDistance: pointSegmentDistance(center, start, goal) }];
    })
    .sort((left, right) => left.routeDistance - right.routeDistance);

  for (const candidate of candidates) {
    const otherObstacles = obstacles.filter((obstacle) => obstacle.objectId !== candidate.object.id);
    for (const position of roomEdgePositions(room, candidate.object.transform.position, candidate.bounds, playerRadius)) {
      const moved = translateBounds(candidate.bounds, position[0] - candidate.object.transform.position[0], position[2] - candidate.object.transform.position[2]);
      if (otherObstacles.some((obstacle) => boundsOverlapWithClearance(moved, obstacle, 0.12))) continue;
      const movedObstacles = [...otherObstacles, moved];
      if (!hasRoomPath(room, start, goal, movedObstacles, playerRadius, playerHeight)) continue;
      return { objectId: candidate.object.id, position };
    }
  }
  return null;
}

function roomEdgePositions(
  room: NonNullable<EditableMap['room']>,
  position: [number, number, number],
  bounds: MapObjectAabb,
  playerRadius: number
): Array<[number, number, number]> {
  const minX = room.position[0] - room.size[0] / 2 + room.wallThickness;
  const maxX = room.position[0] + room.size[0] / 2 - room.wallThickness;
  const minZ = room.position[2] - room.size[2] / 2 + room.wallThickness;
  const maxZ = room.position[2] + room.size[2] / 2 - room.wallThickness;
  const left = position[0] - bounds.min[0];
  const right = bounds.max[0] - position[0];
  const near = position[2] - bounds.min[2];
  const far = bounds.max[2] - position[2];
  const step = Math.max(0.6, playerRadius * 2);
  const result: Array<[number, number, number]> = [];
  for (let z = minZ + near; z <= maxZ - far + 0.001; z += step) {
    result.push([minX + left, position[1], z], [maxX - right, position[1], z]);
  }
  for (let x = minX + left; x <= maxX - right + 0.001; x += step) {
    result.push([x, position[1], minZ + near], [x, position[1], maxZ - far]);
  }
  return result
    .filter((candidate) => Math.hypot(candidate[0] - position[0], candidate[2] - position[2]) > 0.1)
    .sort((leftPosition, rightPosition) => (
      Math.hypot(leftPosition[0] - position[0], leftPosition[2] - position[2])
      - Math.hypot(rightPosition[0] - position[0], rightPosition[2] - position[2])
    ));
}

function translateBounds(bounds: MapObjectAabb, dx: number, dz: number): MapObjectAabb {
  return {
    objectId: bounds.objectId,
    min: [bounds.min[0] + dx, bounds.min[1], bounds.min[2] + dz],
    max: [bounds.max[0] + dx, bounds.max[1], bounds.max[2] + dz]
  };
}

function boundsOverlapWithClearance(left: MapObjectAabb, right: MapObjectAabb, clearance: number): boolean {
  if (left.max[1] <= right.min[1] + 0.02 || left.min[1] >= right.max[1] - 0.02) return false;
  return left.min[0] < right.max[0] + clearance
    && left.max[0] > right.min[0] - clearance
    && left.min[2] < right.max[2] + clearance
    && left.max[2] > right.min[2] - clearance;
}

function pointSegmentDistance(point: [number, number], start: [number, number], end: [number, number]): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0.0001) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const amount = clamp(((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared, 0, 1);
  return Math.hypot(point[0] - (start[0] + dx * amount), point[1] - (start[1] + dz * amount));
}

function hasRoomPath(
  room: NonNullable<EditableMap['room']>,
  start: [number, number],
  goal: [number, number],
  obstacles: MapObjectAabb[],
  playerRadius: number,
  playerHeight: number
): boolean {
  const step = 0.4;
  const minX = room.position[0] - room.size[0] / 2 + room.wallThickness + playerRadius;
  const maxX = room.position[0] + room.size[0] / 2 - room.wallThickness - playerRadius;
  const minZ = room.position[2] - room.size[2] / 2 + room.wallThickness + playerRadius;
  const maxZ = room.position[2] + room.size[2] / 2 - room.wallThickness - playerRadius;
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
      if (obstacles.some((obstacle) => roomPathPointBlocked(room.position[1], worldX, worldZ, obstacle, playerRadius, playerHeight))) continue;
      visited.add(key);
      queue.push([nextX, nextZ]);
    }
  }
  return false;
}

function roomPathPointBlocked(floorY: number, x: number, z: number, obstacle: MapObjectAabb, playerRadius: number, playerHeight: number): boolean {
  if (obstacle.max[1] <= floorY + 0.05 || obstacle.min[1] >= floorY + playerHeight) return false;
  const closestX = clamp(x, obstacle.min[0], obstacle.max[0]);
  const closestZ = clamp(z, obstacle.min[2], obstacle.max[2]);
  return Math.hypot(x - closestX, z - closestZ) < playerRadius + 0.05;
}

function roomDoorInsidePoint(
  room: NonNullable<EditableMap['room']>,
  door: NonNullable<EditableMap['room']>['openings'][number],
  playerRadius: number
): [number, number] {
  const inset = room.wallThickness + playerRadius + 0.1;
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

function aggregateObjectBounds(boxes: MapObjectAabb[]): Map<string, MapObjectAabb> {
  const result = new Map<string, MapObjectAabb>();
  for (const box of boxes) {
    const current = result.get(box.objectId);
    if (!current) {
      result.set(box.objectId, { objectId: box.objectId, min: [...box.min], max: [...box.max] });
      continue;
    }
    current.min = current.min.map((value, axis) => Math.min(value, box.min[axis])) as [number, number, number];
    current.max = current.max.map((value, axis) => Math.max(value, box.max[axis])) as [number, number, number];
  }
  return result;
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
