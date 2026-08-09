import {
  getMapBounds,
  type EditableMap,
  type MapAsset
} from './map';
import { applyMapOperations, type MapOperation } from './mapOperations';
import { planLimits } from './mapPlanning';
import { expandMapScatter } from './mapScatter';
import {
  estimateSceneZoneCoverage,
  sceneZoneWorldRegion,
  type SceneCompositionMetrics,
  type SceneCompositionPlan
} from './sceneComposition';
import type { ResolvedSceneFamily } from './sceneCompositionAssets';
import { compileMapVisualSemantics } from './mapVisualSemantics';

export interface CompiledSceneComposition {
  operations: MapOperation[];
  metrics: SceneCompositionMetrics;
}

export function compileSceneComposition(
  map: EditableMap,
  plan: SceneCompositionPlan,
  resolvedFamilies: readonly ResolvedSceneFamily[]
): CompiledSceneComposition {
  const operations: MapOperation[] = [];
  const familyCounts: Record<string, number> = {};
  const zoneCounts: Record<string, number> = Object.fromEntries(plan.zones.map((zone) => [zone.id, 0]));
  const familyAssets = new Map(resolvedFamilies.map((resolved) => [resolved.family.id, resolved.assets]));
  const unresolvedFamilyIds = resolvedFamilies
    .filter((resolved) => resolved.assets.length === 0)
    .map((resolved) => resolved.family.id);
  operations.push({
    type: 'map.update',
    renderPromptSuggestions: plan.renderPromptSuggestions,
    visualSemantics: compileMapVisualSemantics(map, plan)
  });
  operations.push({ type: 'terrain.generate', ...plan.globalBrief.terrainBase });
  operations.push(...compileZoneTerrain(map, plan));
  operations.push(...compileZoneWater(map, plan));
  operations.push(...compileZoneGrass(map, plan));

  let workingMap = applyMapOperations(map, operations);
  const limits = planLimits(getMapBounds(map));
  let remaining = limits.objectCount;

  const accentOperations = compileAccents(workingMap, plan, familyAssets, remaining, familyCounts, zoneCounts);
  if (accentOperations.length > 0) {
    operations.push(...accentOperations);
    workingMap = applyMapOperations(workingMap, accentOperations);
    remaining -= accentOperations.filter((operation) => operation.type === 'object.add').length;
  }

  const scatterLayers = plan.zones
    .flatMap((zone) => zone.layers
      .filter((layer) => layer.distribution !== 'accent')
      .map((layer) => ({ zone, layer })))
    .sort((left, right) => right.zone.importance - left.zone.importance);
  for (const [index, entry] of scatterLayers.entries()) {
    if (remaining <= 0) break;
    const assets = familyAssets.get(entry.layer.familyId) ?? [];
    if (assets.length === 0 || entry.zone.role === 'negative-space') continue;
    const region = sceneZoneWorldRegion(entry.zone, map);
    const excludedZoneIds = new Set([
      ...entry.zone.excludeZoneIds,
      ...plan.zones.filter((zone) => zone.role === 'negative-space' && zone.id !== entry.zone.id).map((zone) => zone.id)
    ]);
    const excluded = [...excludedZoneIds]
      .map((zoneId) => plan.zones.find((zone) => zone.id === zoneId))
      .filter((zone): zone is SceneCompositionPlan['zones'][number] => Boolean(zone))
      .map((zone) => ({ kind: 'circle' as const, ...sceneZoneWorldRegion(zone, map) }));
    const footprint = Math.max(...assets.map((asset) => asset.footprintRadius ?? 0.5));
    const libraryMetadata = assets[0]?.libraryMetadata;
    const placementLimit = libraryMetadata && (!libraryMetadata.repeatable || libraryMetadata.landmark)
      ? Math.min(1, remaining)
      : remaining;
    const placements = expandMapScatter(workingMap, {
      assetIds: assets.map((asset) => asset.id),
      region: { kind: 'circle', ...region },
      density: libraryMetadata?.density ?? entry.layer.density,
      avoidWater: 1,
      maxSlope: 32,
      minSpacing: Math.max(libraryMetadata?.minSpacing ?? 0, 0.8, footprint * 1.8),
      scaleRange: libraryMetadata?.scaleRange ?? entry.layer.scaleRange,
      seed: derivedSeed(map.seed, `${entry.zone.id}:${entry.layer.familyId}:${index}`),
      edgeFalloff: Math.max(entry.layer.edgeFalloff, transitionFalloff(plan, entry.zone.id)),
      clusterStrength: entry.layer.distribution === 'clustered' ? 0.72 : 0,
      excludeRegions: excluded
    }, assets, placementLimit, `composition-${entry.zone.id}-${entry.layer.familyId}`);
    const placementOperations = placements.map((placement): MapOperation => ({
      type: 'object.add',
      object: {
        id: placement.id,
        name: placement.name,
        assetId: placement.assetId,
        transform: {
          position: [placement.x, placement.y, placement.z],
          rotation: [0, libraryMetadata?.rotation === 'fixed' ? 0 : placement.rotationY, 0],
          scale: [placement.scale, placement.scale, placement.scale]
        }
      }
    }));
    if (placementOperations.length === 0) continue;
    operations.push(...placementOperations);
    workingMap = applyMapOperations(workingMap, placementOperations);
    remaining -= placementOperations.length;
    familyCounts[entry.layer.familyId] = (familyCounts[entry.layer.familyId] ?? 0) + placementOperations.length;
    zoneCounts[entry.zone.id] = (zoneCounts[entry.zone.id] ?? 0) + placementOperations.length;
  }

  const changedHeights = workingMap.terrain.heights.filter((height, index) => (
    Math.abs(height - (map.terrain.heights[index] ?? 0)) > 0.01
  ));
  return {
    operations,
    metrics: {
      zoneCoverage: estimateSceneZoneCoverage(plan),
      zoneCount: plan.zones.length,
      objectCount: Math.max(0, workingMap.objects.length - map.objects.length),
      waterCount: Math.max(0, workingMap.waterBodies.length - map.waterBodies.length),
      terrainRelief: Math.max(...workingMap.terrain.heights) - Math.min(...workingMap.terrain.heights),
      terrainChangedCells: changedHeights.length,
      familyCounts,
      zoneCounts,
      unresolvedFamilyIds
    }
  };
}

function compileZoneGrass(map: EditableMap, plan: SceneCompositionPlan): MapOperation[] {
  const operations: MapOperation[] = plan.grassFamilies.map((family, index) => ({
    type: 'grass.layer.add',
    layer: {
      id: grassLayerId(family.id),
      name: family.label,
      seed: derivedSeed(map.seed, `grass:${family.id}:${index}`),
      mix: family.mix
    }
  }));
  for (const zone of plan.zones) {
    const region = sceneZoneWorldRegion(zone, map);
    for (const layer of zone.grassLayers) {
      operations.push({
        type: 'grass.generate',
        layerId: grassLayerId(layer.grassFamilyId),
        region: { kind: 'circle', center: [region.x, region.z], radius: region.r },
        density: layer.density,
        variation: layer.variation,
        softness: Math.max(layer.edgeFalloff, transitionFalloff(plan, zone.id)),
        seed: derivedSeed(map.seed, `grass:${zone.id}:${layer.grassFamilyId}`)
      });
    }
  }
  return operations;
}

function compileZoneTerrain(map: EditableMap, plan: SceneCompositionPlan): MapOperation[] {
  const maxHeight = map.box.size[1] - 0.1;
  const baseHeight = plan.globalBrief.terrainBase.amplitude * 0.4;
  const maxBrushes = planLimits(getMapBounds(map)).terrainBrushCount;
  const operations: MapOperation[] = [];
  for (const zone of plan.zones) {
    if (operations.length >= maxBrushes) break;
    if (zone.water) continue;
    const region = sceneZoneWorldRegion(zone, map);
    const targetHeight = clamp(baseHeight + zone.terrain.elevation * map.box.size[1] * 0.22, 0, maxHeight);
    if (zone.terrain.flatness >= 0.25) {
      operations.push({
        type: 'terrain.brush',
        mode: 'flatten',
        point: [region.x, targetHeight, region.z],
        targetHeight,
        size: region.r,
        strength: 0.2 + zone.terrain.flatness * 0.8
      });
    } else if (Math.abs(zone.terrain.elevation) >= 0.05) {
      operations.push({
        type: 'terrain.brush',
        mode: zone.terrain.elevation > 0 ? 'raise' : 'lower',
        point: [region.x, targetHeight, region.z],
        size: region.r,
        strength: Math.abs(zone.terrain.elevation) * map.box.size[1] * 0.18
      });
    }
    const detailCount = Math.min(3, Math.floor(zone.terrain.roughness * 4));
    for (let index = 0; index < detailCount && operations.length < maxBrushes; index += 1) {
      const angle = deterministicUnit(`${map.seed}:${zone.id}:detail-angle:${index}`) * Math.PI * 2;
      const distance = region.r * (0.18 + deterministicUnit(`${map.seed}:${zone.id}:detail-distance:${index}`) * 0.42);
      operations.push({
        type: 'terrain.brush',
        mode: deterministicUnit(`${map.seed}:${zone.id}:detail-mode:${index}`) > 0.35 ? 'raise' : 'lower',
        point: [region.x + Math.cos(angle) * distance, targetHeight, region.z + Math.sin(angle) * distance],
        size: region.r * (0.16 + deterministicUnit(`${map.seed}:${zone.id}:detail-size:${index}`) * 0.18),
        strength: zone.terrain.roughness * map.box.size[1] * 0.025
      });
    }
  }
  return operations;
}

export function compileZoneWater(map: EditableMap, plan: SceneCompositionPlan): MapOperation[] {
  return plan.zones.flatMap((zone): MapOperation[] => {
    if (!zone.water) return [];
    const region = sceneZoneWorldRegion(zone, map);
    const radius = region.r * 0.82;
    const points = Array.from({ length: 12 }, (_, index): [number, number] => {
      const angle = index / 12 * Math.PI * 2;
      const wobble = 0.9 + deterministicUnit(`${map.seed}:${zone.id}:${index}`) * 0.18;
      return [region.x + Math.cos(angle) * radius * wobble, region.z + Math.sin(angle) * radius * wobble];
    });
    return [{
      type: 'water.add',
      water: {
        id: `composition-water-${zone.id}`,
        name: zone.label,
        type: 'lake',
        level: zone.water.level,
        depth: zone.water.depth,
        width: 1.2,
        points
      }
    }];
  });
}

function compileAccents(
  map: EditableMap,
  plan: SceneCompositionPlan,
  familyAssets: ReadonlyMap<string, MapAsset[]>,
  maxCount: number,
  familyCounts: Record<string, number>,
  zoneCounts: Record<string, number>
): MapOperation[] {
  const operations: MapOperation[] = [];
  let objectCount = 0;
  let workingMap = map;
  const zones = [...plan.zones].sort((left, right) => right.importance - left.importance);
  for (const zone of zones) {
    for (const layer of zone.layers) {
      if (layer.distribution !== 'accent' || objectCount >= maxCount || zone.water) continue;
      const assets = familyAssets.get(layer.familyId) ?? [];
      if (assets.length === 0) continue;
      const region = sceneZoneWorldRegion(zone, map);
      const libraryMetadata = assets[0]?.libraryMetadata;
      const chosenScaleRange = libraryMetadata?.scaleRange ?? layer.scaleRange;
      const scale = (chosenScaleRange[0] + chosenScaleRange[1]) / 2;
      const footprint = Math.max(...assets.map((asset) => asset.footprintRadius ?? 0.5)) * scale;
      const placement = expandMapScatter(workingMap, {
        assetIds: assets.map((asset) => asset.id),
        region: { kind: 'circle', ...region },
        density: Math.max(0.02, libraryMetadata?.density ?? layer.density),
        avoidWater: 1,
        maxSlope: 28,
        minSpacing: Math.max(libraryMetadata?.minSpacing ?? 0, 1, footprint * 1.8),
        scaleRange: [scale, scale],
        seed: derivedSeed(map.seed, `${zone.id}:${layer.familyId}:accent`),
        edgeFalloff: Math.max(layer.edgeFalloff, transitionFalloff(plan, zone.id)),
        clusterStrength: 0,
        excludeRegions: zone.excludeZoneIds
          .map((zoneId) => plan.zones.find((item) => item.id === zoneId))
          .filter((item): item is SceneCompositionPlan['zones'][number] => Boolean(item))
          .map((item) => ({ kind: 'circle' as const, ...sceneZoneWorldRegion(item, map) }))
      }, assets, 1, `composition-${zone.id}-${layer.familyId}-accent`)[0];
      if (!placement) continue;
      const operation: MapOperation = {
        type: 'object.add',
        object: {
          id: placement.id,
          name: placement.name,
          assetId: placement.assetId,
          transform: {
            position: [placement.x, placement.y, placement.z],
            rotation: [0, libraryMetadata?.rotation === 'fixed' ? 0 : placement.rotationY, 0],
            scale: [placement.scale, placement.scale, placement.scale]
          }
        }
      };
      operations.push(operation);
      objectCount += 1;
      const family = plan.assetFamilies.find((item) => item.id === layer.familyId);
      const grassResidualOperations = family && shouldClearGrass(family)
        ? zone.grassLayers.map((grass): MapOperation => ({
            type: 'grass.brush',
            layerId: grassLayerId(grass.grassFamilyId),
            mode: 'density',
            point: [placement.x, placement.z],
            size: Math.max(1.2, footprint * 2.4),
            strength: 1,
            targetDensity: grass.residualDensity
          }))
        : [];
      operations.push(...grassResidualOperations);
      workingMap = applyMapOperations(workingMap, [operation, ...grassResidualOperations]);
      familyCounts[layer.familyId] = (familyCounts[layer.familyId] ?? 0) + 1;
      zoneCounts[zone.id] = (zoneCounts[zone.id] ?? 0) + 1;
    }
  }
  return operations;
}

function shouldClearGrass(family: SceneCompositionPlan['assetFamilies'][number]): boolean {
  const semantic = `${family.role} ${family.tags.join(' ')}`.toLowerCase();
  return /\b(building|structure|house|cabin|camp|road|path|trail)\b/.test(semantic);
}

function grassLayerId(familyId: string): string {
  return `composition-grass-${familyId}`.slice(0, 80);
}

function transitionFalloff(plan: SceneCompositionPlan, zoneId: string): number {
  return Math.max(0, ...plan.transitions
    .filter((transition) => transition.fromZoneId === zoneId || transition.toZoneId === zoneId)
    .map((transition) => transition.width));
}

function derivedSeed(seed: number, key: string): number {
  let value = seed >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    value = Math.imul(value ^ key.charCodeAt(index), 16777619) >>> 0;
  }
  return value;
}

function deterministicUnit(key: string): number {
  return derivedSeed(2166136261, key) / 4294967295;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
