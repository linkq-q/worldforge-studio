import {
  getMapBounds,
  type EditableMap,
  type MapAsset
} from './map';
import { applyMapOperations, type MapOperation } from './mapOperations';
import { planLimits } from './mapPlanning';
import { expandStructuredMapPlacement } from './mapPlacement';
import {
  evaluateMapScatterQuality,
  expandMapScatter,
  type MapScatterPlan,
  type MapScatterPlacement,
  type MapScatterQuality
} from './mapScatter';
import {
  estimateSceneZoneCoverage,
  sceneAssetCategory,
  sceneZoneWorldRegion,
  type SceneCompositionMetrics,
  type SceneCompositionPlan,
  type SceneBehaviorProfile,
  type ScenePlacementMode,
  type SceneZoneLayer
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
  const behaviorQuality: Record<string, MapScatterQuality> = {};
  const familyAssets = new Map(resolvedFamilies.map((resolved) => [resolved.family.id, resolved.assets]));
  const families = new Map(plan.assetFamilies.map((family) => [family.id, family]));
  const requiredFamilyIds = new Set(plan.intentRequirements.flatMap((requirement) => (
    requirement.kind === 'asset-family' && requirement.familyId ? [requirement.familyId] : []
  )));
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
  operations.push({
    type: 'terrain.refine',
    ...(plan.globalBrief.terrainRefinement ?? { erosion: 0.2, drainage: 0.08, iterations: 3, talus: 46 })
  });
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
      .filter((layer) => placementMode(layer) !== 'anchor')
      .map((layer) => ({ zone, layer })))
    .sort((left, right) => (
      Number(requiredFamilyIds.has(right.layer.familyId)) - Number(requiredFamilyIds.has(left.layer.familyId))
      || placementOrder(placementMode(left.layer)) - placementOrder(placementMode(right.layer))
      || right.zone.importance - left.zone.importance
    ));
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
    const family = families.get(entry.layer.familyId);
    const requiredLayerBudget = requiredFamilyIds.has(entry.layer.familyId)
      ? Math.max(1, Math.floor(remaining / scatterLayers.slice(index).filter((item) => (
          requiredFamilyIds.has(item.layer.familyId)
        )).length))
      : remaining;
    const placementLimit = libraryMetadata && (!libraryMetadata.repeatable || libraryMetadata.landmark)
      ? Math.min(1, remaining)
      : requiredLayerBudget;
    const structuredLimit = relationshipPlacementLimit(entry.layer, family, placementLimit);
    const mode = placementMode(entry.layer);
    const spacing = Math.max(
      entry.layer.placement?.spacing ?? 0,
      libraryMetadata?.minSpacing ?? 0,
      0.8,
      footprint * 1.8
    );
    const seed = derivedSeed(map.seed, `${entry.zone.id}:${entry.layer.familyId}:${index}`);
    const grouping = sceneBehaviorGrouping(family?.behavior);
    const scatterTarget = grouping
      ? Math.min(placementLimit, Math.max(1, Math.round(Math.PI * region.r * region.r * (libraryMetadata?.density ?? entry.layer.density))))
      : placementLimit;
    let scatterPlan: MapScatterPlan | undefined;
    const placements = mode === 'linear' || mode === 'layout' || mode === 'attached'
      ? expandStructuredMapPlacement(workingMap, {
          mode,
          pattern: entry.layer.placement?.pattern,
          intent: entry.layer.placement?.intent,
          assetIds: assets.map((asset) => asset.id),
          region: { kind: 'circle', ...region },
          density: libraryMetadata?.density ?? entry.layer.density,
          spacing,
          offset: entry.layer.placement?.offset ?? 0,
          direction: entry.layer.placement?.direction ?? 0,
          facing: entry.layer.placement?.facing ?? (mode === 'layout' ? 'inward' : 'guide'),
          avoidWater: 1,
          maxSlope: mode === 'layout' ? 18 : 24,
          scaleRange: libraryMetadata?.scaleRange ?? entry.layer.scaleRange,
          seed,
          guidePoints: sceneGuideWorldPoints(entry.layer, map),
          focus: placementFocus(workingMap, entry.layer, familyAssets) ?? { x: region.x, z: region.z },
          maxPerGroup: entry.layer.placement?.maxPerGroup,
          arcDegrees: entry.layer.placement?.arcDegrees,
          aisleEvery: entry.layer.placement?.aisleEvery,
          targets: attachmentTargets(workingMap, entry.layer, familyAssets),
          excludeRegions: excluded
        }, assets, structuredLimit, `composition-${entry.zone.id}-${entry.layer.familyId}`)
      : expandMapScatter(workingMap, scatterPlan = {
          assetIds: assets.map((asset) => asset.id),
          region: { kind: 'circle', ...region },
          density: libraryMetadata?.density ?? entry.layer.density,
          avoidWater: 1,
          maxSlope: scatterMaxSlope(entry.layer, 28),
          minSpacing: spacing,
          spacingByAssetId: spacingByAssetId(entry.layer, familyAssets),
          habitat: entry.layer.placement?.habitat,
          scaleRange: libraryMetadata?.scaleRange ?? entry.layer.scaleRange,
          seed,
          patchSeed: derivedSeed(map.seed, `${entry.zone.id}:shared-habitat`),
          edgeFalloff: Math.max(entry.layer.edgeFalloff, transitionFalloff(plan, entry.zone.id)),
          clusterStrength: scatterClusterStrength(family, mode),
          grouping,
          excludeRegions: excluded
        }, assets, scatterTarget, `composition-${entry.zone.id}-${entry.layer.familyId}`);
    if (scatterPlan && family?.behavior) {
      const quality = evaluateMapScatterQuality(scatterPlan, placements, scatterTarget);
      const previous = behaviorQuality[entry.layer.familyId];
      if (!previous || previous.status === 'pass' && quality.status === 'warning') {
        behaviorQuality[entry.layer.familyId] = quality;
      }
    }
    const placementOperations = placements.map((placement): MapOperation => ({
      type: 'object.add',
      object: {
        id: placement.id,
        name: placement.name,
        assetId: placement.assetId,
        transform: {
          position: [placement.x, placement.y + scenePlacementAltitude(family?.behavior, placement), placement.z],
          rotation: [0, libraryMetadata?.rotation === 'fixed' && !entry.layer.placement?.intent ? 0 : placement.rotationY, 0],
          scale: [placement.scale, placement.scale, placement.scale]
        },
        ...compileScenePlacementBehavior(family?.behavior, placement, seed)
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
      unresolvedFamilyIds,
      ...(Object.keys(behaviorQuality).length > 0 ? { behaviorQuality } : {})
    }
  };
}

export function sceneBehaviorGrouping(behavior: SceneBehaviorProfile | undefined): MapScatterPlan['grouping'] | undefined {
  if (!behavior || behavior.kind === 'static' || behavior.kind === 'solitary' || behavior.kind === 'territorial') return undefined;
  return {
    groupCount: behavior.groupCount,
    coreRatio: behavior.coreRatio,
    outlierMinDistance: behavior.outlierMinDistance
  };
}

export function scenePlacementAltitude(behavior: SceneBehaviorProfile | undefined, placement: MapScatterPlacement): number {
  if (!behavior || !isAirbornePlacement(behavior, placement)) return 0;
  const [min, max] = behavior.altitudeRange;
  return min + (max - min) * deterministicUnit(`altitude:${placement.id}`);
}

export function compileScenePlacementBehavior(
  behavior: SceneBehaviorProfile | undefined,
  placement: MapScatterPlacement,
  seed: number
): Pick<NonNullable<Extract<MapOperation, { type: 'object.add' }>['object']>, 'heightMode' | 'behavior'> {
  if (!behavior) return {};
  const airborne = isAirbornePlacement(behavior, placement);
  const state = placement.groupRole === 'outlier' ? behavior.outlierState : behavior.coreState;
  return {
    heightMode: airborne ? 'fixed' : 'terrain',
    behavior: {
      kind: behavior.kind,
      locomotion: airborne ? 'air' : behavior.locomotion === 'mixed' ? 'ground' : behavior.locomotion,
      groupRole: placement.groupRole,
      groupIndex: placement.groupIndex,
      ...(behavior.kind !== 'static' && behavior.locomotion !== 'static' ? { animation: {
        state,
        speed: 0.85 + deterministicUnit(`${seed}:${placement.id}:speed`) * 0.3,
        phase: deterministicUnit(`${seed}:${placement.id}:phase`)
      } } : {})
    }
  };
}

function isAirbornePlacement(behavior: SceneBehaviorProfile, placement: MapScatterPlacement): boolean {
  return behavior.locomotion === 'air'
    || behavior.locomotion === 'mixed' && placement.groupRole === 'outlier';
}

function compileZoneGrass(map: EditableMap, plan: SceneCompositionPlan): MapOperation[] {
  const operations: MapOperation[] = plan.grassFamilies.map((family, index) => ({
    type: 'grass.layer.add',
    layer: {
      id: grassLayerId(family.id),
      name: family.label,
      seed: derivedSeed(map.seed, `grass:${family.id}:${index}`),
      preset: family.preset,
      height: family.height,
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
    const region = sceneZoneWorldRegion(zone, map);
    if (zone.terrain.modifier) {
      operations.push({
        type: 'terrain.modify',
        modifier: zone.terrain.modifier,
        region: { kind: 'circle', x: region.x, z: region.z, radius: region.r },
        seed: derivedSeed(map.seed, `terrain:${zone.id}:${zone.terrain.modifier}`),
        amplitude: zone.terrain.amplitude,
        softness: zone.terrain.softness,
        direction: zone.terrain.direction,
        variation: zone.terrain.variation,
        layers: zone.terrain.layers,
        layout: zone.terrain.layout,
        access: zone.terrain.access
      });
    }
    if (zone.terrain.surface) {
      operations.push({
        type: 'terrain.surface',
        surface: zone.terrain.surface,
        region: { kind: 'circle', x: region.x, z: region.z, radius: region.r },
        intensity: 1,
        zoneId: `composition-surface-${zone.id}`
      });
    }
    if (zone.water || zone.terrain.modifier) continue;
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
    if (!zone.water || isImplicitOceanZone(plan, zone)) return [];
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
        points,
        shorelineSmoothness: 0.86,
        shorelineIrregularity: 0.16,
        seed: derivedSeed(map.seed, `water:${zone.id}`)
      }
    }];
  });
}

export function isImplicitOceanZone(
  plan: SceneCompositionPlan,
  zone: SceneCompositionPlan['zones'][number]
): boolean {
  const hasIslandTerrain = plan.globalBrief.terrainBase.preset === 'island'
    || plan.globalBrief.terrainBase.preset === 'archipelago'
    || plan.zones.some((item) => item.terrain.modifier === 'island');
  if (!hasIslandTerrain || !zone.water) return false;
  const identity = `${zone.id} ${zone.label}`;
  const namesInlandWater = /pond|lake|pool|lagoon|池|湖|塘|泻湖/i.test(identity);
  return !namesInlandWater && /sea|ocean|marine|海/i.test(identity);
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
      if (placementMode(layer) !== 'anchor' || objectCount >= maxCount || zone.water) continue;
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

function placementMode(layer: SceneZoneLayer): ScenePlacementMode {
  return layer.placement?.mode
    ?? (layer.distribution === 'accent' ? 'anchor' : layer.distribution === 'clustered' ? 'patch' : 'field');
}

function scatterClusterStrength(
  family: SceneCompositionPlan['assetFamilies'][number] | undefined,
  mode: ScenePlacementMode
): number {
  if (mode !== 'patch') return 0;
  const semantic = family ? `${family.label} ${family.role} ${family.tags.join(' ')}` : '';
  return /rock|stone|boulder|outcrop|岩|石/i.test(semantic) ? 0.28 : 0.72;
}

function relationshipPlacementLimit(
  layer: SceneZoneLayer,
  family: SceneCompositionPlan['assetFamilies'][number] | undefined,
  limit: number
): number {
  const intent = layer.placement?.intent;
  if (intent === 'viewpoint') return Math.min(limit, layer.placement?.maxPerGroup ?? 5);
  if (intent === 'playground') return Math.min(limit, 2);
  if (intent === 'wall') return Math.min(limit, layer.placement?.maxPerGroup ?? 10);
  if (intent === 'street-edge') return Math.min(limit, (layer.placement?.maxPerGroup ?? 4) * 3);
  if (intent === 'social' || intent === 'attached-service') return Math.min(limit, (layer.placement?.maxPerGroup ?? 6) * 8);
  if (intent === 'audience') return Math.min(limit, layer.placement?.maxPerGroup ?? 24);
  return family && sceneAssetCategory(family) === 'furniture' ? Math.min(limit, 5) : limit;
}

function scatterMaxSlope(layer: SceneZoneLayer, fallback: number): number {
  const habitatLimit = layer.placement?.habitat?.slope?.[3];
  return habitatLimit === undefined ? fallback : Math.max(fallback, habitatLimit);
}

function placementOrder(mode: ScenePlacementMode): number {
  if (mode === 'layout') return 0;
  if (mode === 'linear') return 1;
  if (mode === 'field' || mode === 'patch') return 2;
  if (mode === 'attached') return 3;
  return -1;
}

function spacingByAssetId(
  layer: SceneZoneLayer,
  familyAssets: ReadonlyMap<string, MapAsset[]>
): Record<string, number> | undefined {
  const byFamily = layer.placement?.spacingByFamily;
  if (!byFamily) return undefined;
  const result: Record<string, number> = {};
  for (const [familyId, spacing] of Object.entries(byFamily)) {
    for (const asset of familyAssets.get(familyId) ?? []) result[asset.id] = spacing;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function attachmentTargets(
  map: EditableMap,
  layer: SceneZoneLayer,
  familyAssets: ReadonlyMap<string, MapAsset[]>
): Array<{ x: number; z: number; yaw: number; footprintRadius: number }> | undefined {
  const targetFamilyId = layer.placement?.targetFamilyId;
  if (!targetFamilyId) return undefined;
  const targetAssets = familyAssets.get(targetFamilyId) ?? [];
  const targetAssetIds = new Set(targetAssets.map((asset) => asset.id));
  const radiusByAssetId = new Map(targetAssets.map((asset) => [asset.id, asset.footprintRadius ?? 0.5]));
  return map.objects
    .filter((object) => object.assetId && targetAssetIds.has(object.assetId))
    .map((object) => ({
      x: object.transform.position[0],
      z: object.transform.position[2],
      yaw: object.transform.rotation[1],
      footprintRadius: (radiusByAssetId.get(object.assetId!) ?? 0.5) * Math.max(object.transform.scale[0], object.transform.scale[2])
    }));
}

function placementFocus(
  map: EditableMap,
  layer: SceneZoneLayer,
  familyAssets: ReadonlyMap<string, MapAsset[]>
): { x: number; z: number } | undefined {
  const focusFamilyId = layer.placement?.focusFamilyId ?? layer.placement?.targetFamilyId;
  if (!focusFamilyId) return undefined;
  const assetIds = new Set((familyAssets.get(focusFamilyId) ?? []).map((asset) => asset.id));
  const target = map.objects.find((object) => object.assetId && assetIds.has(object.assetId));
  return target ? { x: target.transform.position[0], z: target.transform.position[2] } : undefined;
}

function sceneGuideWorldPoints(layer: SceneZoneLayer, map: EditableMap): Array<[number, number]> | undefined {
  const points = layer.placement?.guidePoints;
  if (!points) return undefined;
  const bounds = getMapBounds(map);
  const halfWidth = (bounds.maxX - bounds.minX) / 2;
  const halfDepth = (bounds.maxZ - bounds.minZ) / 2;
  return points.map(([x, z]) => [x * halfWidth, z * halfDepth]);
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
