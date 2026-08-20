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
import { evaluateIndoorLightCoverage } from './indoorLighting';
import { applyMapOperations, type MapOperation } from './mapOperations';
import { findSafeSpawnPosition, isSpawnPositionSafe } from './mapSpawnSafety';
import { isPointInsideWaterBody, waterSurfaceLevelAt } from './mapWater';

export type MapLintSeverity = 'info' | 'warning' | 'error';

export interface MapLintIssue {
  code: 'spawn.unsafe' | 'object.out-of-bounds' | 'object.off-ground' | 'object.duplicate'
    | 'object.above-ceiling' | 'object.too-small' | 'object.scale-mismatch' | 'object.overlap'
    | 'object.wall-mounted'
    | 'water.exposed-terrain' | 'scene.sparse' | 'room.path-blocked' | 'asset.unplaced'
    | 'asset.minimum-degraded' | 'asset.generation-degraded' | 'interior.light-coverage' | 'interior.style-drift'
    | 'interior.operational-clearance' | 'object.invalid-support' | 'outdoor.access-repaired' | 'outdoor.water-intrusion-repaired'
    | 'outdoor.clearance-repaired'
    | 'bridge.unresolved-crossing' | 'scene.design-missing' | 'scene.program-incomplete';
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
  lintInvalidSupports(map, removedIds, issues, repairOperations);
  lintObjectPlacement(map, removedIds, issues, repairOperations);
  let workingMap = repairOperations.length > 0 ? applyMapOperations(map, repairOperations) : map;
  lintOverlaps(workingMap, removedIds, issues, repairOperations);
  workingMap = repairOperations.length > 0 ? applyMapOperations(map, repairOperations) : map;
  lintRoomPaths(workingMap, issues, repairOperations);
  workingMap = repairOperations.length > 0 ? applyMapOperations(map, repairOperations) : map;
  lintOperationalClearance(workingMap, issues, repairOperations);
  workingMap = repairOperations.length > 0 ? applyMapOperations(map, repairOperations) : map;
  lintSpawn(workingMap, issues, repairOperations);
  lintWaterExposure(map, issues, repairOperations);
  lintInteriorQuality(workingMap, issues, repairOperations);
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
      // Prompts include the global room art direction, so identity-sensitive
      // scale rules must use the asset's own name/tags only.
      const target = indoorSemanticDimensions(map, mountSemantic);
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
      const genericMaximum = (asset?.sizeClass === 'small' ? 1.6 : asset?.sizeClass === 'medium' ? 3.2 : 5)
        * getMapPlayerMetrics(map).height;
      const maximumFit = Math.min(
        genericMaximum / Math.max(currentWidth, currentHeight, currentDepth),
        target.maximumWidth === null ? Number.POSITIVE_INFINITY : target.maximumWidth / currentWidth,
        target.maximumDepth === null ? Number.POSITIVE_INFINITY : target.maximumDepth / currentDepth,
        target.maximumHeight === null ? Number.POSITIVE_INFINITY : target.maximumHeight / currentHeight
      );
      if (maximumFit < 0.98) {
        horizontalFit = Math.min(horizontalFit, maximumFit);
        verticalFit = Math.min(verticalFit, maximumFit);
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
      if (wallMounted && currentBounds) {
        const scaleX = nextScale[0] / Math.max(0.001, object.transform.scale[0]);
        const scaleZ = nextScale[2] / Math.max(0.001, object.transform.scale[2]);
        const scaled = {
          minX: position[0] + (currentBounds.min[0] - position[0]) * scaleX,
          maxX: position[0] + (currentBounds.max[0] - position[0]) * scaleX,
          minZ: position[2] + (currentBounds.min[2] - position[2]) * scaleZ,
          maxZ: position[2] + (currentBounds.max[2] - position[2]) * scaleZ
        };
        const distances = [
          { wall: 'west', distance: Math.abs(scaled.minX - minX) },
          { wall: 'east', distance: Math.abs(maxX - scaled.maxX) },
          { wall: 'north', distance: Math.abs(scaled.minZ - minZ) },
          { wall: 'south', distance: Math.abs(maxZ - scaled.maxZ) }
        ].sort((left, right) => left.distance - right.distance);
        if (distances[0].wall === 'west') nextX = position[0] + minX - scaled.minX;
        if (distances[0].wall === 'east') nextX = position[0] + maxX - scaled.maxX;
        if (distances[0].wall === 'north') nextZ = position[2] + minZ - scaled.minZ;
        if (distances[0].wall === 'south') nextZ = position[2] + maxZ - scaled.maxZ;
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

function lintInvalidSupports(
  map: EditableMap,
  removed: Set<string>,
  issues: MapLintIssue[],
  repairs: MapOperation[]
): void {
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const objects = new Map(map.objects.map((object) => [object.id, object]));
  for (const child of map.objects) {
    const parent = child.parentId ? objects.get(child.parentId) : undefined;
    const childAsset = child.assetId ? assets.get(child.assetId) : undefined;
    const parentAsset = parent?.assetId ? assets.get(parent.assetId) : undefined;
    if (!parent || !childAsset || !parentAsset) continue;
    const childSemantic = `${childAsset.name} ${childAsset.prompt} ${(childAsset.tags ?? []).join(' ')}`;
    const parentSemantic = `${parentAsset.name} ${parentAsset.prompt} ${(parentAsset.tags ?? []).join(' ')}`;
    const parentIsBed = /\bbed\b|mattress|床铺|床垫|床架/i.test(parentSemantic);
    const childTags = new Set((childAsset.tags ?? []).map((tag) => tag.toLowerCase()));
    const explicitBedAssembly = childTags.has('bed') || childTags.has('mattress') || childTags.has('bedding');
    const looseBedDecor = !explicitBedAssembly && /pillow|small folded throw|cushion|枕|折叠毯|抱枕/i.test(childSemantic);
    const childIsBedAssembly = /\bbed\b|mattress|bedding|bed[-_ ]?linen|床品|床铺|床垫|床架/i.test(childSemantic);
    if (!parentIsBed || looseBedDecor || !childIsBedAssembly) continue;
    removed.add(child.id);
    repairs.push({ type: 'object.remove', objectId: child.id });
    issues.push({
      code: 'object.invalid-support', severity: 'warning',
      message: '已移除叠放在床上的床垫或整套床品；床只承载枕头、折叠毯等小件。',
      objectIds: [parent.id, child.id], repaired: true
    });
  }
}

function lintInteriorQuality(map: EditableMap, issues: MapLintIssue[], repairs: MapOperation[]): void {
  if (map.sceneMode !== 'indoor' || !map.room) return;
  const coverage = evaluateIndoorLightCoverage(map);
  if (coverage.ratio < 0.72) {
    issues.push({
      code: 'interior.light-coverage',
      severity: 'warning',
      message: coverage.practicalLightCount === 0
        ? '室内没有可用的实用灯光；生成规划应补充带光源元数据的顶灯或台灯。'
        : `夜间实用灯光仅覆盖约 ${Math.round(coverage.ratio * 100)}% 的房间采样点，建议增加或重新分布顶灯。`,
      repaired: false
    });
  }
  const art = map.interiorArtDirection;
  if (!art) return;
  const surfaces = Object.entries(art.surfaces).filter(([, surface]) => (
    surface.palette.every((color) => nearestPaletteDistance(color, art.palette) > 0.5)
  ));
  const rugs = art.rugs.filter((rug) => rug.palette.every((color) => nearestPaletteDistance(color, art.palette) > 0.5));
  if (surfaces.length === 0 && rugs.length === 0) return;
  const repairedArt = {
    ...art,
    surfaces: Object.fromEntries(Object.entries(art.surfaces).map(([name, surface]) => [
      name,
      surfaces.some(([surfaceName]) => surfaceName === name) ? { ...surface, palette: art.palette } : surface
    ])) as typeof art.surfaces,
    rugs: art.rugs.map((rug) => rugs.includes(rug) ? { ...rug, palette: art.palette } : rug)
  };
  repairs.push({ type: 'interior.art-direction.set', artDirection: repairedArt });
  issues.push({
    code: 'interior.style-drift',
    severity: 'warning',
    message: '已将脱离全局室内色板的表面或地毯颜色收束回统一美术方向。',
    repaired: true
  });
}

function lintOperationalClearance(map: EditableMap, issues: MapLintIssue[], repairs: MapOperation[]): void {
  const room = map.room;
  if (!room) return;
  const { radius, height } = getMapPlayerMetrics(map);
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const boundsById = aggregateObjectBounds(getMapObjectAabbs(map));
  const protectedIds = new Set<string>();
  const clearances: Array<{ ownerId: string; bounds: MapObjectAabb }> = room.openings
    .filter((opening) => opening.kind === 'door')
    .map((opening) => {
      const linked = map.objects.find((object) => object.roomOpeningId === opening.id);
      if (linked) protectedIds.add(linked.id);
      const depth = Math.max(1.1, height * 0.72);
      const halfWidth = opening.width / 2 + radius + 0.12;
      const [x, z] = roomDoorInsidePoint(room, opening, radius);
      const northSouth = opening.wall === 'north' || opening.wall === 'south';
      return {
        ownerId: linked?.id ?? `opening:${opening.id}`,
        bounds: {
          objectId: linked?.id ?? `opening:${opening.id}`,
          min: [x - (northSouth ? halfWidth : depth / 2), room.position[1], z - (northSouth ? depth / 2 : halfWidth)],
          max: [x + (northSouth ? halfWidth : depth / 2), room.position[1] + height, z + (northSouth ? depth / 2 : halfWidth)]
        }
      };
    });
  for (const object of map.objects) {
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    const bounds = boundsById.get(object.id);
    if (!asset || !bounds || object.parentId || object.roomOpeningId) continue;
    const semantic = `${asset.name} ${asset.prompt} ${(asset.tags ?? []).join(' ')}`;
    if (!/openable[-_ ]?front|cabinet|wardrobe|dresser|drawer|refrigerator|fridge|oven|dishwasher|washing machine|柜|衣橱|冰箱|烤箱|洗碗机|洗衣机/i.test(semantic)
      || /open shelf|bookshelf|bookcase|开放架|书架/i.test(semantic)) continue;
    protectedIds.add(object.id);
    clearances.push({ ownerId: object.id, bounds: frontClearanceBounds(room, object.transform.rotation[1], bounds, radius, height) });
  }

  const objectsWithChildren = new Set(map.objects.flatMap((object) => object.parentId ? [object.parentId] : []));
  const relocated = new Set<string>();
  let obstacles = [...boundsById.values()];
  for (const clearance of clearances) {
    const blockerBounds = obstacles.find((bounds) => (
      bounds.objectId !== clearance.ownerId
      && !protectedIds.has(bounds.objectId)
      && !relocated.has(bounds.objectId)
      && boundsOverlapWithClearance(bounds, clearance.bounds, 0)
    ));
    if (!blockerBounds) continue;
    const blocker = map.objects.find((object) => object.id === blockerBounds.objectId);
    const movable = blocker && !blocker.locked && !blocker.parentId && !blocker.roomOpeningId && !objectsWithChildren.has(blocker.id);
    let destination: [number, number, number] | null = null;
    if (movable) {
      for (const position of roomEdgePositions(room, blocker.transform.position, blockerBounds, radius)) {
        const moved = translateBounds(blockerBounds, position[0] - blocker.transform.position[0], position[2] - blocker.transform.position[2]);
        if (obstacles.some((other) => other.objectId !== blocker.id && boundsOverlapWithClearance(moved, other, 0.12))) continue;
        if (clearances.some((area) => area.ownerId !== blocker.id && boundsOverlapWithClearance(moved, area.bounds, 0))) continue;
        destination = position;
        obstacles = obstacles.map((item) => item.objectId === blocker.id ? moved : item);
        break;
      }
    }
    if (destination && blocker) {
      relocated.add(blocker.id);
      repairs.push({ type: 'object.update', objectId: blocker.id, patch: { transform: { position: destination } } });
    }
    issues.push({
      code: 'interior.operational-clearance', severity: 'warning',
      message: destination
        ? '已将遮挡门或柜体开启面的物体移到房间边缘，恢复操作净空。'
        : '门或柜体开启面前存在遮挡，当前没有可安全自动搬移的位置。',
      objectIds: [clearance.ownerId, blockerBounds.objectId], repaired: Boolean(destination)
    });
  }
}

function frontClearanceBounds(
  room: NonNullable<EditableMap['room']>,
  yaw: number,
  bounds: MapObjectAabb,
  playerRadius: number,
  playerHeight: number
): MapObjectAabb {
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  const distances = [
    { direction: [1, 0] as const, value: Math.abs(bounds.min[0] - (room.position[0] - room.size[0] / 2)) },
    { direction: [-1, 0] as const, value: Math.abs(bounds.max[0] - (room.position[0] + room.size[0] / 2)) },
    { direction: [0, 1] as const, value: Math.abs(bounds.min[2] - (room.position[2] - room.size[2] / 2)) },
    { direction: [0, -1] as const, value: Math.abs(bounds.max[2] - (room.position[2] + room.size[2] / 2)) }
  ].sort((left, right) => left.value - right.value);
  const nearWall = distances[0].value < Math.max(0.7, room.wallThickness + 0.35);
  const direction = nearWall ? distances[0].direction : [Math.sin(yaw), Math.cos(yaw)] as const;
  const alongX = Math.abs(direction[0]) > Math.abs(direction[1]);
  const depth = Math.max(0.9, playerHeight * 0.65);
  const halfWidth = (alongX ? bounds.max[2] - bounds.min[2] : bounds.max[0] - bounds.min[0]) / 2 + playerRadius;
  const edgeX = centerX + direction[0] * ((bounds.max[0] - bounds.min[0]) / 2 + depth / 2);
  const edgeZ = centerZ + direction[1] * ((bounds.max[2] - bounds.min[2]) / 2 + depth / 2);
  return {
    objectId: bounds.objectId,
    min: [edgeX - (alongX ? depth / 2 : halfWidth), room.position[1], edgeZ - (alongX ? halfWidth : depth / 2)],
    max: [edgeX + (alongX ? depth / 2 : halfWidth), room.position[1] + playerHeight, edgeZ + (alongX ? halfWidth : depth / 2)]
  };
}

function nearestPaletteDistance(color: string, palette: readonly string[]): number {
  const rgb = hexRgb(color);
  if (!rgb || palette.length === 0) return 0;
  return Math.min(...palette.flatMap((candidate) => {
    const other = hexRgb(candidate);
    return other ? [Math.hypot(rgb[0] - other[0], rgb[1] - other[1], rgb[2] - other[2]) / 441.7] : [];
  }));
}

function hexRgb(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return [value >> 16, value >> 8 & 255, value & 255];
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

function lintOverlaps(
  map: EditableMap,
  removedIds: Set<string>,
  issues: MapLintIssue[],
  repairs: MapOperation[]
): void {
  const room = map.room;
  if (!room) return;
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const objectsWithChildren = new Set(map.objects.flatMap((object) => object.parentId ? [object.parentId] : []));
  const ignoredIds = new Set(map.objects.flatMap((object) => {
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    const semantic = [object.name, asset?.name, asset?.prompt, ...(asset?.tags ?? [])].filter(Boolean).join(' ');
    return object.parentId
      || object.roomOpeningId
      || isElevatedWallSemantic(semantic)
      || isCeilingMountedSemantic(semantic)
      || /rug|carpet|doormat|floor[-_ ]?textile|地毯|地垫/i.test(semantic)
      ? [object.id]
      : [];
  }));
  const reportedPairs = new Set<string>();
  let workingMap = map;

  for (let pass = 0; pass < map.objects.length * 2; pass += 1) {
    const boundsById = aggregateObjectBounds(getMapObjectAabbs(workingMap).filter((box) => !removedIds.has(box.objectId)));
    const solidBounds = [...boundsById.values()].filter((bounds) => !ignoredIds.has(bounds.objectId));
    let overlap: [MapObjectAabb, MapObjectAabb] | null = null;
    for (let left = 0; left < solidBounds.length && !overlap; left += 1) {
      for (let right = left + 1; right < solidBounds.length; right += 1) {
        const pairKey = [solidBounds[left].objectId, solidBounds[right].objectId].sort().join(':');
        if (reportedPairs.has(pairKey) || !isMeaningfulSolidOverlap(solidBounds[left], solidBounds[right])) continue;
        overlap = [solidBounds[left], solidBounds[right]];
        break;
      }
    }
    if (!overlap) break;

    const [leftBounds, rightBounds] = overlap;
    const pairKey = [leftBounds.objectId, rightBounds.objectId].sort().join(':');
    reportedPairs.add(pairKey);
    const movable = [rightBounds, leftBounds]
      .flatMap((bounds) => {
        const object = workingMap.objects.find((item) => item.id === bounds.objectId);
        if (!object || object.locked || object.parentId || object.roomOpeningId || objectsWithChildren.has(object.id)) return [];
        return [{ object, bounds, area: footprintArea(bounds) }];
      })
      .sort((left, right) => left.area - right.area);
    let repair: MapOperation | null = null;
    for (const candidate of movable) {
      const otherBounds = solidBounds.filter((bounds) => bounds.objectId !== candidate.object.id);
      for (const position of roomEdgePositions(room, candidate.object.transform.position, candidate.bounds, getMapPlayerMetrics(map).radius)) {
        const moved = translateBounds(
          candidate.bounds,
          position[0] - candidate.object.transform.position[0],
          position[2] - candidate.object.transform.position[2]
        );
        if (otherBounds.some((bounds) => boundsOverlapWithClearance(moved, bounds, 0.12))) continue;
        repair = { type: 'object.update', objectId: candidate.object.id, patch: { transform: { position } } };
        break;
      }
      if (repair) break;
    }
    if (repair) {
      repairs.push(repair);
      workingMap = applyMapOperations(workingMap, [repair]);
    }
    issues.push({
      code: 'object.overlap',
      severity: 'warning',
      message: repair
        ? '检测到室内实体家具重叠，已将较易移动的物体移到房间边缘空位。'
        : '检测到室内实体家具重叠，但当前没有可安全自动搬移的位置。',
      objectIds: [leftBounds.objectId, rightBounds.objectId],
      repaired: Boolean(repair)
    });
  }
}

function isMeaningfulSolidOverlap(left: MapObjectAabb, right: MapObjectAabb): boolean {
  const height = Math.min(left.max[1], right.max[1]) - Math.max(left.min[1], right.min[1]);
  if (height <= 0.06) return false;
  // Keep this conservative because generated furniture colliders may enclose
  // intentional hollow space, such as a chair tucked slightly under a table.
  return overlapRatio(left, right) >= 0.25;
}

function footprintArea(bounds: MapObjectAabb): number {
  return Math.max(0.0001, bounds.max[0] - bounds.min[0]) * Math.max(0.0001, bounds.max[2] - bounds.min[2]);
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
