import { createMapObject, sampleTerrainHeight, type EditableMap, type MapAsset, type MapObject } from './map';
import { planMapObjectAttachment } from './mapAttachment';
import type { MapDesignRelation, MapDesignSemantics } from './mapDesign';
import type { MapOperation } from './mapOperations';
import { expandMapScatter, mapAssetFootprintRadius } from './mapScatter';

const NATURAL_DETAIL = /\b(?:tree|pine|bamboo|plant|shrub|bush|flower|rock|stone|boulder)\b|树木?|松柏?|松树|竹林?|竹丛|植被|植物|灌木|花木|花卉|花丛|太湖石|假山|山石|景石|石块|岩石|巨石/i;
const VEGETATION_DETAIL = /\b(?:tree|pine|bamboo|plant|shrub|bush|flower)\b|树木?|松柏?|松树|竹林?|竹丛|植被|植物|灌木|花木|花卉|花丛/i;
const ROCK_DETAIL = /\b(?:rock|stone|boulder)\b|太湖石|假山|山石|景石|石块|岩石|巨石/i;
const MAX_DESIGN_FILL_OBJECTS = 96;

/** Deterministic semantic layout pass; hard support remains owned by placeOn/mountOn. */
export function compileMapDesignRelations(map: EditableMap, design: MapDesignSemantics): MapOperation[] {
  const updates = new Map<string, [number, number, number]>();
  const supportUpdates = new Map<string, Extract<MapOperation, { type: 'object.update' }>['patch']>();
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  for (const relation of design.relations) {
    const sources = selectObjects(map, relation.sourceSelector, relation.sourceGroupId, assets);
    if (sources.length === 0) continue;
    if (relation.kind === 'support') {
      compileSupportRelation(map, sources, relation, assets, supportUpdates);
    } else if (relation.kind === 'attract') {
      const target = selectObjects(map, relation.targetSelector ?? '', relation.targetGroupId, assets)[0];
      if (!target) continue;
      arrangeAround(map, sources.filter((source) => source.id !== target.id), target, relation, assets, updates);
    } else {
      spreadApart(map, sources, relation, assets, updates);
    }
  }
  return [
    ...[...updates].filter(([objectId]) => !supportUpdates.has(objectId)).map(([objectId, position]) => ({
    type: 'object.update' as const,
    objectId,
    patch: { transform: { position } }
    })),
    ...[...supportUpdates].map(([objectId, patch]) => ({ type: 'object.update' as const, objectId, patch }))
  ];
}

function compileSupportRelation(
  map: EditableMap,
  sources: MapObject[],
  relation: MapDesignRelation,
  assets: Map<string, MapAsset>,
  updates: Map<string, Extract<MapOperation, { type: 'object.update' }>['patch']>
): void {
  const target = selectObjects(map, relation.targetSelector ?? '', relation.targetGroupId, assets)[0];
  if (!target) return;
  const candidates = sources.filter((source) => source.id !== target.id && source.assetId && assets.has(source.assetId));
  const spacing = relation.strength === 'tight' ? 0.35 : relation.strength === 'open' ? 0.9 : 0.6;
  candidates.forEach((source, index) => {
    const asset = assets.get(source.assetId!);
    if (!asset) return;
    const column = index - (candidates.length - 1) / 2;
    try {
      const planned = planMapObjectAttachment({
        ...map,
        objects: map.objects.filter((object) => object.id !== source.id)
      }, {
        id: source.id,
        name: source.name,
        parentId: target.id,
        asset,
        kind: 'supported',
        scale: Math.max(source.transform.scale[0], source.transform.scale[2]),
        yaw: source.transform.rotation[1],
        offset: [column * spacing, 0],
        contact: 0.02
      });
      updates.set(source.id, {
        parentId: planned.parentId,
        heightMode: planned.heightMode,
        transform: planned.transform
      });
    } catch {
      // Invalid support remains editable in its original position.
    }
  });
}

/** Bind semantic focus selectors after placement IDs are known. */
export function resolveMapDesignFocusObjects(map: EditableMap, design: MapDesignSemantics): MapDesignSemantics {
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  return {
    ...design,
    focuses: design.focuses.map((focus) => {
      if (focus.objectId && map.objects.some((object) => object.id === focus.objectId)) return focus;
      const object = selectObjects(map, focus.selector ?? '', focus.groupId, assets)[0];
      return object ? { ...focus, objectId: object.id } : focus;
    })
  };
}

/**
 * The Code pass may deliberately over-place small scenery. This deterministic
 * pass removes only AI-marked layer 3/4 decoration, never anchors, locked
 * structures, focus objects, or the last use of an asset family.
 */
export function compileMapDesignPruning(map: EditableMap, design: MapDesignSemantics): MapOperation[] {
  const protectedIds = new Set([
    ...design.focuses.flatMap((focus) => focus.objectId ? [focus.objectId] : []),
    ...design.groups.flatMap((group) => group.protectedObjectIds)
  ]);
  const assetCounts = new Map<string, number>();
  for (const object of map.objects) {
    if (object.assetId) assetCounts.set(object.assetId, (assetCounts.get(object.assetId) ?? 0) + 1);
  }
  const removals: MapOperation[] = [];
  for (const group of design.groups) {
    const removableIds = new Set(group.removableObjectIds);
    if (removableIds.size === 0) continue;
    for (const layer of group.layers.filter((item) => item.level >= 3)) {
      const candidates = map.objects.filter((object) => (
        object.designGroupId === group.id
        && object.compositionLayer === layer.level
        && !object.locked
        && !protectedIds.has(object.id)
      ));
      if (candidates.length < 5 && !candidates.some((object) => removableIds.has(object.id))) continue;
      const keepRatio = layer.density === 'tight' ? 1 : layer.density === 'open' ? 0.65 : 0.8;
      const keepCount = Math.max(1, Math.ceil(candidates.length * keepRatio));
      const ordered = [...candidates].sort((left, right) => stableObjectScore(left) - stableObjectScore(right));
      for (const object of ordered.slice(keepCount)) {
        if (!removableIds.has(object.id)) continue;
        if (object.assetId && (assetCounts.get(object.assetId) ?? 0) <= 1) continue;
        removals.push({ type: 'object.remove', objectId: object.id });
        if (object.assetId) assetCounts.set(object.assetId, (assetCounts.get(object.assetId) ?? 1) - 1);
      }
    }
  }
  return removals;
}

/** Functional paving and AI-declared clearings are hard no-growth masks for loose natural decoration. */
export function compileMapNaturalClearance(map: EditableMap): MapOperation[] {
  const clearZones = map.visualSemantics.zones.filter((zone) => zone.tags.includes('clear') && zone.region);
  if (clearZones.length === 0) return [];
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  return map.objects.flatMap((object): MapOperation[] => {
    if (object.locked || ![3, 4].includes(object.compositionLayer ?? 0) || !objectMatchesNaturalDetail(object, map.assets ?? [])) return [];
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    const radius = Math.max(0.2, (asset ? mapAssetFootprintRadius(asset) : 0.4)
      * Math.max(object.transform.scale[0], object.transform.scale[2]));
    const [x, , z] = object.transform.position;
    return clearZones.some((zone) => regionContains(zone.region!, x, z, radius + 0.25))
      ? [{ type: 'object.remove', objectId: object.id }]
      : [];
  });
}

/** Keep AI-authored natural detail layers from collapsing into a handful of isolated props. */
export function compileMapDesignDensityFill(map: EditableMap, design: MapDesignSemantics): MapOperation[] {
  const operations: Extract<MapOperation, { type: 'object.add' }>[] = [];
  let workingMap = map;
  for (const group of design.groups) {
    if (!group.region) continue;
    const scatterRegion = enclosingCircle(group.region);
    for (const layer of group.layers.filter((item) => item.level >= 3)) {
      const scoped = workingMap.objects.filter((object) => (
        object.designGroupId === group.id && object.compositionLayer === layer.level
      ));
      const naturalObjects = scoped.filter((object) => objectMatchesNaturalDetail(object, workingMap.assets ?? []));
      const intent = `${group.intent} ${layer.intent}`;
      const intentRequestsNature = NATURAL_DETAIL.test(intent);
      if (naturalObjects.length === 0 && !intentRequestsNature) continue;
      const targetCount = naturalLayerTarget(scatterRegion.r, layer.density);
      const families = [
        { id: 'vegetation', pattern: VEGETATION_DETAIL, target: targetCount },
        { id: 'rock', pattern: ROCK_DETAIL, target: Math.max(4, Math.ceil(targetCount * 0.35)) }
      ].filter((family) => (
        family.pattern.test(intent)
        || naturalObjects.some((object) => objectMatchesPattern(object, workingMap.assets ?? [], family.pattern))
      ));
      if (families.length === 0 && intentRequestsNature) {
        const fallbackPattern = (workingMap.assets ?? []).some((asset) => assetMatchesPattern(asset, VEGETATION_DETAIL))
          ? VEGETATION_DETAIL
          : ROCK_DETAIL;
        families.push({ id: fallbackPattern === VEGETATION_DETAIL ? 'vegetation' : 'rock', pattern: fallbackPattern, target: targetCount });
      }
      for (const family of families) {
        const familyObjects = scoped.filter((object) => objectMatchesPattern(object, workingMap.assets ?? [], family.pattern));
        const assetIds = [...new Set(familyObjects.flatMap((object) => object.assetId ? [object.assetId] : []))];
        if (assetIds.length === 0) {
          assetIds.push(...(workingMap.assets ?? [])
            .filter((asset) => assetMatchesPattern(asset, family.pattern))
            .slice(0, 4)
            .map((asset) => asset.id));
        }
        if (assetIds.length === 0) continue;
        const remainingBudget = MAX_DESIGN_FILL_OBJECTS - operations.length;
        const requestedCount = Math.min(remainingBudget, Math.max(0, family.target - familyObjects.length));
        if (requestedCount <= 0) continue;
        const spacing = layer.density === 'tight' ? 4.2 : layer.density === 'open' ? 7 : 5.2;
        const largestFootprint = Math.max(
          0.5,
          ...(workingMap.assets ?? [])
            .filter((asset) => assetIds.includes(asset.id))
            .map(mapAssetFootprintRadius)
        );
        const placements = expandMapScatter(workingMap, {
          assetIds,
          region: scatterRegion,
          density: 1 / (spacing * spacing),
          avoidWater: 0.8,
          maxSlope: 32,
          minSpacing: Math.max(largestFootprint * 2.1, spacing * 0.58),
          scaleRange: [0.88, 1.12],
          seed: hashText(map.seed, `${group.id}:${layer.level}:${family.id}`),
          edgeFalloff: 0.02,
          clusterStrength: 0
        }, workingMap.assets ?? [], requestedCount * 4, `design-fill-${safeId(group.id)}-${layer.level}-${family.id}`)
          .filter((placement) => regionContains(group.region!, placement.x, placement.z))
          .filter((placement) => !pointInNaturalClearance(workingMap, placement.x, placement.z, largestFootprint + 0.25))
          .slice(0, requestedCount);
        const objects = placements.map((placement) => {
          const object = createMapObject(placement.name, placement.assetId);
          object.id = placement.id;
          object.heightMode = 'terrain';
          object.designGroupId = group.id;
          object.compositionLayer = layer.level;
          object.transform.position = [placement.x, placement.y, placement.z];
          object.transform.rotation = [0, placement.rotationY, 0];
          object.transform.scale = [placement.scale, placement.scale, placement.scale];
          return object;
        });
        operations.push(...objects.map((object) => ({ type: 'object.add' as const, object })));
        if (objects.length > 0) workingMap = { ...workingMap, objects: [...workingMap.objects, ...objects] };
        if (operations.length >= MAX_DESIGN_FILL_OBJECTS) return operations;
      }
    }
  }
  return operations;
}

function arrangeAround(
  map: EditableMap,
  sources: MapObject[],
  target: MapObject,
  relation: MapDesignRelation,
  assets: Map<string, MapAsset>,
  updates: Map<string, [number, number, number]>
): void {
  if (sources.length === 0) return;
  const targetRadius = footprint(target, assets);
  const tone = relation.strength === 'tight' ? 0.9 : relation.strength === 'open' ? 1.45 : 1.12;
  const ordered = [...sources].sort((left, right) => left.id.localeCompare(right.id));
  const startAngle = Math.atan2(
    ordered[0].transform.position[2] - target.transform.position[2],
    ordered[0].transform.position[0] - target.transform.position[0]
  );
  ordered.forEach((source, index) => {
    const natural = (targetRadius + footprint(source, assets) + 0.2) * tone;
    const radius = clamp(natural, relation.minDistance ?? 0.2, relation.maxDistance ?? Math.max(1, natural * 1.2));
    const angle = startAngle + index * Math.PI * 2 / ordered.length;
    const x = target.transform.position[0] + Math.cos(angle) * radius;
    const z = target.transform.position[2] + Math.sin(angle) * radius;
    updates.set(source.id, [x, groundedY(map, source, x, z), z]);
  });
}

function spreadApart(
  map: EditableMap,
  sources: MapObject[],
  relation: MapDesignRelation,
  assets: Map<string, MapAsset>,
  updates: Map<string, [number, number, number]>
): void {
  if (sources.length < 2) return;
  const center = sources.reduce((sum, object) => [
    sum[0] + object.transform.position[0],
    sum[1] + object.transform.position[2]
  ], [0, 0]).map((value) => value / sources.length) as [number, number];
  const averageRadius = sources.reduce((sum, source) => sum + footprint(source, assets), 0) / sources.length;
  const tone = relation.strength === 'tight' ? 1 : relation.strength === 'open' ? 1.8 : 1.35;
  const radius = Math.max(relation.minDistance ?? 0, averageRadius * tone, sources.length * averageRadius / Math.PI);
  [...sources].sort((left, right) => left.id.localeCompare(right.id)).forEach((source, index) => {
    const angle = index * Math.PI * 2 / sources.length;
    const x = center[0] + Math.cos(angle) * radius;
    const z = center[1] + Math.sin(angle) * radius;
    updates.set(source.id, [x, groundedY(map, source, x, z), z]);
  });
}

function selectObjects(
  map: EditableMap,
  selector: string,
  groupId: string | undefined,
  assets: Map<string, MapAsset>
): MapObject[] {
  const needle = selector.trim().toLowerCase();
  return map.objects.filter((object) => {
    if (groupId && object.designGroupId !== groupId) return false;
    if (!needle) return Boolean(groupId);
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    return object.id.toLowerCase() === needle
      || object.name.toLowerCase().includes(needle)
      || asset?.id.toLowerCase() === needle
      || asset?.name.toLowerCase().includes(needle)
      || asset?.tags?.some((tag) => tag.toLowerCase() === needle || tag.toLowerCase().includes(needle));
  });
}

function footprint(object: MapObject, assets: Map<string, MapAsset>): number {
  const radius = object.assetId ? assets.get(object.assetId)?.footprintRadius : undefined;
  return Math.max(0.15, (radius ?? Math.max(object.transform.size[0], object.transform.size[2]) / 2)
    * Math.max(object.transform.scale[0], object.transform.scale[2]));
}

function groundedY(map: EditableMap, object: MapObject, x: number, z: number): number {
  return object.heightMode === 'terrain' ? sampleTerrainHeight(map, x, z) : object.transform.position[1];
}

function stableObjectScore(object: MapObject): number {
  let hash = 2166136261;
  for (const character of object.id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function objectMatchesNaturalDetail(object: MapObject, assets: readonly MapAsset[]): boolean {
  const asset = object.assetId ? assets.find((item) => item.id === object.assetId) : undefined;
  return NATURAL_DETAIL.test([object.name, asset?.name, ...(asset?.tags ?? [])].filter(Boolean).join(' '));
}

function objectMatchesPattern(object: MapObject, assets: readonly MapAsset[], pattern: RegExp): boolean {
  const asset = object.assetId ? assets.find((item) => item.id === object.assetId) : undefined;
  return pattern.test([object.name, asset?.name, ...(asset?.tags ?? [])].filter(Boolean).join(' '));
}

function assetMatchesPattern(asset: MapAsset, pattern: RegExp): boolean {
  return pattern.test([asset.name, ...(asset.tags ?? [])].join(' '));
}

function naturalLayerTarget(radius: number, density: 'tight' | 'normal' | 'open'): number {
  const spacing = density === 'tight' ? 4.5 : density === 'open' ? 8 : 6;
  const maximum = density === 'tight' ? 48 : density === 'open' ? 24 : 36;
  return clamp(Math.round(Math.PI * 2 * Math.max(1, radius) / spacing), 4, maximum);
}

function hashText(seed: number, value: string): number {
  let hash = Math.trunc(seed) >>> 0;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return hash;
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48) || 'group';
}

function enclosingCircle(region: NonNullable<MapDesignSemantics['groups'][number]['region']>): {
  kind: 'circle'; x: number; z: number; r: number;
} {
  if (region.kind === 'circle') return { kind: 'circle', x: region.x, z: region.z, r: region.radius };
  const points = region.points;
  const center = points.reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0])
    .map((value) => value / Math.max(1, points.length)) as [number, number];
  const padding = region.kind === 'path' ? region.width / 2 : 0;
  return {
    kind: 'circle',
    x: center[0],
    z: center[1],
    r: Math.max(0.1, padding, ...points.map((point) => Math.hypot(point[0] - center[0], point[1] - center[1]) + padding))
  };
}

function regionContains(
  region: NonNullable<MapDesignSemantics['groups'][number]['region']>,
  x: number,
  z: number,
  padding = 0
): boolean {
  if (region.kind === 'circle') return Math.hypot(x - region.x, z - region.z) <= region.radius + padding;
  if (region.kind === 'path') {
    return region.points.slice(1).some((point, index) => (
      pointSegmentDistance(x, z, region.points[index], point) <= region.width / 2 + padding
    ));
  }
  let inside = false;
  for (let index = 0, previous = region.points.length - 1; index < region.points.length; previous = index++) {
    const left = region.points[index];
    const right = region.points[previous];
    if ((left[1] > z) !== (right[1] > z)
      && x < (right[0] - left[0]) * (z - left[1]) / (right[1] - left[1]) + left[0]) {
      inside = !inside;
    }
  }
  if (inside || padding <= 0) return inside;
  return region.points.some((point, index) => (
    pointSegmentDistance(x, z, point, region.points[(index + 1) % region.points.length]) <= padding
  ));
}

function pointInNaturalClearance(map: EditableMap, x: number, z: number, padding: number): boolean {
  return map.visualSemantics.zones.some((zone) => (
    zone.tags.includes('clear') && zone.region && regionContains(zone.region, x, z, padding)
  ));
}

function pointSegmentDistance(x: number, z: number, start: [number, number], end: [number, number]): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared <= 0.000001
    ? 0
    : clamp(((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared, 0, 1);
  return Math.hypot(x - (start[0] + dx * amount), z - (start[1] + dz * amount));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
