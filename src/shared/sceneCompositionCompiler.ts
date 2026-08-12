import {
  getMapBounds,
  getMapPlayerMetrics,
  sampleTerrainHeight,
  worldScaleProfileMultiplier,
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
  isNaturalRockFamily,
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
import type { TerrainRegion } from './terrainGeneration';
import { calculateModelVisualBounds } from './modelBounds';

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
  if (map.sceneMode !== 'indoor') {
    operations.push({ type: 'terrain.generate', ...plan.globalBrief.terrainBase });
    operations.push(...compileZoneTerrain(map, plan));
    operations.push({
      type: 'terrain.refine',
      ...(plan.globalBrief.terrainRefinement ?? { erosion: 0.2, drainage: 0.08, iterations: 3, talus: 46 })
    });
    operations.push(...compileZoneWater(map, plan));
    operations.push(...compileZoneGrass(map, plan));
  }

  let workingMap = applyMapOperations(map, operations);
  const limits = planLimits(getMapBounds(map), map.sceneMode);
  let remaining = limits.objectCount;

  const accentOperations = compileAccents(workingMap, plan, familyAssets, remaining, familyCounts, zoneCounts);
  if (accentOperations.length > 0) {
    operations.push(...accentOperations);
    workingMap = applyMapOperations(workingMap, accentOperations);
    remaining -= accentOperations.filter((operation) => operation.type === 'object.add').length;
  }

  const rawScatterLayers = plan.zones
    .flatMap((zone) => zone.layers
      .filter((layer) => placementMode(layer) !== 'anchor')
      .map((layer) => ({ zone, layer })))
    .sort((left, right) => (
      Number(requiredFamilyIds.has(right.layer.familyId)) - Number(requiredFamilyIds.has(left.layer.familyId))
      || placementOrder(placementMode(left.layer)) - placementOrder(placementMode(right.layer))
      || right.zone.importance - left.zone.importance
    ));
  const indoorAudienceFamilies = new Set<string>();
  const scatterLayers = rawScatterLayers.filter(({ layer }) => {
    if (map.sceneMode !== 'indoor' || layer.placement?.intent !== 'audience') return true;
    if (indoorAudienceFamilies.has(layer.familyId)) return false;
    indoorAudienceFamilies.add(layer.familyId);
    return true;
  });
  for (const [index, entry] of scatterLayers.entries()) {
    if (remaining <= 0) break;
    const assets = familyAssets.get(entry.layer.familyId) ?? [];
    if (assets.length === 0 || entry.zone.role === 'negative-space') continue;
    const region = sceneZoneWorldRegion(entry.zone, map);
    const excludedZoneIds = new Set([
      ...entry.zone.excludeZoneIds,
      ...plan.zones.filter((zone) => zone.role === 'negative-space' && zone.id !== entry.zone.id).map((zone) => zone.id)
    ]);
    const family = families.get(entry.layer.familyId);
    const indoorAudience = map.sceneMode === 'indoor' && entry.layer.placement?.intent === 'audience';
    const excluded = indoorAudience ? [] : [...excludedZoneIds]
      .map((zoneId) => plan.zones.find((zone) => zone.id === zoneId))
      .filter((zone): zone is SceneCompositionPlan['zones'][number] => Boolean(zone))
      .map((zone) => ({ kind: 'circle' as const, ...sceneZoneWorldRegion(zone, map) }));
    const libraryMetadata = assets[0]?.libraryMetadata;
    const layoutDensity = indoorAudience
      ? rawScatterLayers
          .filter((item) => item.layer.familyId === entry.layer.familyId && item.layer.placement?.intent === 'audience')
          .reduce((sum, item) => sum + item.layer.density, 0)
      : libraryMetadata?.density ?? entry.layer.density;
    const requestedScaleRange = libraryMetadata?.scaleRange ?? entry.layer.scaleRange;
    const scaleRange = semanticScaleRange(map, family, assets, requestedScaleRange, entry.layer.placement);
    const footprint = Math.max(...assets.map((asset) => (asset.footprintRadius ?? 0.5) * scaleRange[1]));
    const placementRegion = indoorAudience && map.room
      ? {
          x: map.room.position[0],
          z: map.room.position[2],
          r: Math.max(1, Math.min(map.room.size[0], map.room.size[2]) / 2 - map.room.wallThickness)
        }
      : region;
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
    const requestedSpacing = Math.max(
      entry.layer.placement?.spacing ?? 0,
      libraryMetadata?.minSpacing ?? 0,
      0.8,
      footprint * 1.8
    );
    const spacing = indoorAudience
      ? clamp(requestedSpacing, Math.max(footprint * 2.05, getMapPlayerMetrics(map).height * 0.52), getMapPlayerMetrics(map).height * 0.9)
      : requestedSpacing;
    const seed = derivedSeed(map.seed, `${entry.zone.id}:${entry.layer.familyId}:${index}`);
    const grouping = sceneBehaviorGrouping(family?.behavior);
    const scatterLimit = family && isNaturalRockFamily(family) ? structuredLimit : placementLimit;
    const scatterTarget = grouping
      ? Math.min(scatterLimit, Math.max(1, Math.round(Math.PI * region.r * region.r * (libraryMetadata?.density ?? entry.layer.density))))
      : scatterLimit;
    let scatterPlan: MapScatterPlan | undefined;
    const placements = mode === 'linear' || mode === 'layout' || mode === 'attached'
      ? expandStructuredMapPlacement(workingMap, {
          mode,
          pattern: entry.layer.placement?.pattern,
          intent: entry.layer.placement?.intent,
          assetIds: assets.map((asset) => asset.id),
          region: { kind: 'circle', ...placementRegion },
          density: layoutDensity,
          spacing,
          offset: entry.layer.placement?.offset ?? 0,
          direction: entry.layer.placement?.direction ?? 0,
          facing: entry.layer.placement?.facing ?? (mode === 'layout' ? 'inward' : 'guide'),
          avoidWater: 1,
          maxSlope: mode === 'layout' ? 18 : 24,
          scaleRange,
          seed,
          guidePoints: sceneGuideWorldPoints(entry.layer, map),
          focus: placementFocus(workingMap, entry.layer, familyAssets) ?? { x: placementRegion.x, z: placementRegion.z },
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
          scaleRange,
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
    const placementOperations = placements.map((placement): MapOperation => {
      const asset = assets.find((candidate) => candidate.id === placement.assetId);
      const rockTransform = family && isNaturalRockFamily(family)
        ? naturalRockTransform(workingMap, placement, family.sizeClass, asset)
        : undefined;
      const rotationY = libraryMetadata?.rotation === 'fixed' && !entry.layer.placement?.intent
        ? 0
        : placement.rotationY;
      const indoorTransform = map.sceneMode === 'indoor' && family && asset
        ? indoorPlacementTransform(map, family, asset, placement, rotationY, entry.layer.placement?.intent)
        : undefined;
      return {
        type: 'object.add',
        object: {
          id: placement.id,
          name: placement.name,
          assetId: placement.assetId,
          transform: rockTransform ?? indoorTransform ?? {
            position: [placement.x, placement.y + scenePlacementAltitude(family?.behavior, placement), placement.z],
            rotation: [0, rotationY, 0],
            scale: [placement.scale, placement.scale, placement.scale]
          },
          ...(rockTransform || indoorTransform
            ? { heightMode: 'fixed' as const }
            : compileScenePlacementBehavior(family?.behavior, placement, seed))
        }
      };
    });
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
  const maxBrushes = planLimits(getMapBounds(map), map.sceneMode).terrainBrushCount;
  const operations: MapOperation[] = [];
  for (const zone of plan.zones) {
    if (operations.length >= maxBrushes) break;
    const region = sceneZoneWorldRegion(zone, map);
    const terrainRegion = scenicMountainRegion(zone, region);
    if (zone.terrain.modifier) {
      operations.push({
        type: 'terrain.modify',
        modifier: zone.terrain.modifier,
        region: terrainRegion,
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
        region: terrainRegion,
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
      const family = plan.assetFamilies.find((item) => item.id === layer.familyId);
      const libraryMetadata = assets[0]?.libraryMetadata;
      const chosenScaleRange = libraryMetadata?.scaleRange ?? layer.scaleRange;
      const fittedScaleRange = semanticScaleRange(map, family, assets, chosenScaleRange, layer.placement);
      const scale = (fittedScaleRange[0] + fittedScaleRange[1]) / 2;
      const footprint = Math.max(...assets.map((asset) => asset.footprintRadius ?? 0.5)) * scale;
      const placement = map.sceneMode === 'indoor'
        ? indoorAnchorPlacement(map, zone.id, layer, assets[0], region, footprint, scale)
        : expandMapScatter(workingMap, {
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
      const rotationY = libraryMetadata?.rotation === 'fixed' ? 0 : placement.rotationY;
      const indoorTransform = map.sceneMode === 'indoor' && family
        ? indoorPlacementTransform(map, family, assets[0], placement, rotationY, layer.placement?.intent)
        : undefined;
      const operation: MapOperation = {
        type: 'object.add',
        object: {
          id: placement.id,
          name: placement.name,
          assetId: placement.assetId,
          transform: indoorTransform ?? {
            position: [placement.x, placement.y, placement.z],
            rotation: [0, rotationY, 0],
            scale: [placement.scale, placement.scale, placement.scale]
          },
          ...(indoorTransform ? { heightMode: 'fixed' as const } : {})
        }
      };
      operations.push(operation);
      objectCount += 1;
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

function indoorAnchorPlacement(
  map: EditableMap,
  zoneId: string,
  layer: SceneZoneLayer,
  asset: MapAsset,
  region: { x: number; z: number },
  footprint: number,
  scale: number
): MapScatterPlacement {
  const room = map.room;
  const bounds = getMapBounds(map);
  const inset = (room?.wallThickness ?? 0) + footprint;
  return {
    id: `composition-${zoneId}-${layer.familyId}-accent-1`,
    assetId: asset.id,
    name: asset.name,
    x: clamp(region.x, bounds.minX + inset, bounds.maxX - inset),
    y: room?.position[1] ?? 0,
    z: clamp(region.z, bounds.minZ + inset, bounds.maxZ - inset),
    rotationY: (layer.placement?.direction ?? 0) * Math.PI / 180,
    scale
  };
}

function semanticScaleRange(
  map: EditableMap,
  family: SceneCompositionPlan['assetFamilies'][number] | undefined,
  assets: readonly MapAsset[],
  requested: [number, number],
  placement?: SceneZoneLayer['placement']
): [number, number] {
  if (!family || assets.length === 0) return requested;
  const minimum = Math.min(...assets.map((asset) => fitSemanticAssetScale(map, family, asset, requested[0], placement)));
  const maximum = Math.min(...assets.map((asset) => fitSemanticAssetScale(map, family, asset, requested[1], placement)));
  return [Math.min(minimum, maximum), Math.max(minimum, maximum)];
}

function fitSemanticAssetScale(
  map: EditableMap,
  family: SceneCompositionPlan['assetFamilies'][number],
  asset: MapAsset,
  requested: number,
  placement?: SceneZoneLayer['placement']
): number {
  const bounds = mapAssetLocalBounds(asset);
  const height = Math.max(0.01, bounds.max[1] - bounds.min[1]);
  const width = Math.max(0.01, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(0.01, bounds.max[2] - bounds.min[2]);
  const majorExtent = Math.max(height, width, depth);
  const semantic = `${family.label} ${family.role} ${family.tags.join(' ')} ${family.generationBrief}`;
  const { height: playerHeight } = getMapPlayerMetrics(map);
  if (map.sceneMode !== 'indoor' || !map.room) {
    const profile = worldScaleProfileMultiplier(map.worldScaleProfile);
    const explicitlyTiny = /tiny|miniature|pebble|gravel|seedling|小石子|碎石|幼苗/i.test(semantic);
    const semanticMinimum = /tree|pine|oak|palm|树|松|橡树|棕榈/i.test(semantic)
      ? playerHeight * 2.6 * profile
      : /building|house|tower|chapel|建筑|房屋|塔|教堂/i.test(semantic)
        ? playerHeight * 2.2 * profile
        : /rock|stone|boulder|石|岩/i.test(semantic)
          ? playerHeight * 0.45 * profile
          : explicitlyTiny ? playerHeight / 24 : playerHeight / 6;
    return clamp(Math.max(requested, semanticMinimum / majorExtent), 0.05, 40);
  }
  const room = map.room;
  const usableHeight = Math.max(0.5, room.size[1] - room.wallThickness * 2);
  const targetHeight = /chair|seat|pew|stool|椅|座椅|长凳/i.test(semantic)
    ? Math.min(playerHeight * 0.64, usableHeight * 0.42)
    : /table|desk|餐桌|书桌|课桌/i.test(semantic)
      ? Math.min(playerHeight * 0.58, usableHeight * 0.4)
      : /lectern|pulpit|altar|讲台|祭坛/i.test(semantic)
        ? Math.min(playerHeight * 0.88, usableHeight * 0.58)
        : /door|门/i.test(semantic)
          ? Math.min(playerHeight * 1.35, usableHeight * 0.92)
          : /cross|window|wall|十字架|窗|墙/i.test(semantic)
            ? Math.min(playerHeight * 1.05, usableHeight * 0.72)
            : Math.min(playerHeight, usableHeight * 0.72);
  const horizontalRadius = Math.max(0.1, asset.footprintRadius ?? 0.5);
  const direction = (placement?.direction ?? 0) * Math.PI / 180;
  const rotatedWidth = Math.abs(Math.cos(direction)) * width + Math.abs(Math.sin(direction)) * depth;
  const rotatedDepth = Math.abs(Math.sin(direction)) * width + Math.abs(Math.cos(direction)) * depth;
  const wallLength = Math.abs(Math.sin(direction)) > Math.abs(Math.cos(direction)) ? room.size[2] : room.size[0];
  const wallExtent = Math.abs(Math.sin(direction)) > Math.abs(Math.cos(direction)) ? rotatedDepth : rotatedWidth;
  const horizontalLimit = placement?.intent === 'wall'
    ? Math.max(0.05, (wallLength - (room.wallThickness + 0.25) * 2) / Math.max(0.1, wallExtent))
    : Math.min(room.size[0], room.size[2]) * 0.22 / horizontalRadius;
  const targetScale = targetHeight / height;
  const minimum = Math.min(targetScale * 0.82, horizontalLimit);
  const maximum = Math.min(targetScale * 1.18, usableHeight * 0.9 / height, horizontalLimit);
  return clamp(requested, Math.min(minimum, maximum), Math.max(minimum, maximum));
}

function indoorPlacementTransform(
  map: EditableMap,
  family: SceneCompositionPlan['assetFamilies'][number],
  asset: MapAsset,
  placement: MapScatterPlacement,
  rotationY: number,
  intent: NonNullable<SceneZoneLayer['placement']>['intent']
): {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
} {
  const room = map.room!;
  const bounds = mapAssetLocalBounds(asset);
  const height = bounds.max[1] - bounds.min[1];
  const semantic = `${family.label} ${family.role} ${family.tags.join(' ')} ${family.generationBrief}`;
  const wallMounted = intent === 'wall' || /wall-prop|wall mounted|cross|window|墙面|壁挂|十字架|窗/i.test(semantic);
  const y = wallMounted
    ? room.position[1] + room.size[1] * 0.56 - (bounds.min[1] + height / 2) * placement.scale
    : room.position[1] - bounds.min[1] * placement.scale;
  return {
    position: [placement.x, y, placement.z],
    rotation: [0, rotationY, 0],
    scale: [placement.scale, placement.scale, placement.scale]
  };
}

function mapAssetLocalBounds(asset: MapAsset): { min: [number, number, number]; max: [number, number, number] } {
  if (asset.colliderPlan?.fallbackUsed && asset.colliderPlan.sourceMeshCount === 0) {
    const radius = Math.max(0.1, asset.footprintRadius ?? 0.5);
    const height = asset.sizeClass === 'large' ? 3 : asset.sizeClass === 'medium' ? 1.8 : 1;
    return { min: [-radius, 0, -radius], max: [radius, height, radius] };
  }
  return calculateModelVisualBounds(asset.modelJson);
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
  if (intent === 'audience') return limit;
  if (family && isNaturalRockFamily(family)) {
    return Math.min(limit, family.sizeClass === 'large' ? 4 : family.sizeClass === 'medium' ? 6 : 12);
  }
  return limit;
}

function scenicMountainRegion(
  zone: SceneCompositionPlan['zones'][number],
  region: { x: number; z: number; r: number }
): TerrainRegion {
  if (zone.terrain.modifier !== 'mountain' || zone.terrain.access !== 'scenic') {
    return { kind: 'circle', x: region.x, z: region.z, radius: region.r };
  }
  const angle = (zone.terrain.direction ?? 0) * Math.PI / 180;
  const along = [Math.cos(angle), Math.sin(angle)] as const;
  const across = [-along[1], along[0]] as const;
  const points = [-0.72, -0.24, 0.26, 0.72].map((distance, index): [number, number] => {
    const bend = [0, 0.09, -0.11, 0.02][index] * region.r;
    return [
      region.x + along[0] * region.r * distance + across[0] * bend,
      region.z + along[1] * region.r * distance + across[1] * bend
    ];
  });
  return { kind: 'path', points, width: region.r * 1.18 };
}

function naturalRockTransform(
  map: EditableMap,
  placement: MapScatterPlacement,
  sizeClass: SceneCompositionPlan['assetFamilies'][number]['sizeClass'],
  asset: MapAsset | undefined
): {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
} {
  const stepX = map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1);
  const stepZ = map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1);
  const riseX = (
    sampleTerrainHeight(map, placement.x + stepX, placement.z)
    - sampleTerrainHeight(map, placement.x - stepX, placement.z)
  ) / (2 * stepX);
  const riseZ = (
    sampleTerrainHeight(map, placement.x, placement.z + stepZ)
    - sampleTerrainHeight(map, placement.x, placement.z - stepZ)
  ) / (2 * stepZ);
  const tiltStrength = 0.34;
  const tiltLimit = 16 * Math.PI / 180;
  const verticalScale = sizeClass === 'large' ? 0.58 : sizeClass === 'medium' ? 0.68 : 0.8;
  const burial = clamp((asset?.footprintRadius ?? 0.5) * placement.scale * 0.24, 0.08, 0.55);
  return {
    position: [placement.x, placement.y - burial, placement.z],
    rotation: [
      clamp(Math.atan(riseZ) * tiltStrength, -tiltLimit, tiltLimit),
      placement.rotationY,
      clamp(-Math.atan(riseX) * tiltStrength, -tiltLimit, tiltLimit)
    ],
    scale: [placement.scale, placement.scale * verticalScale, placement.scale]
  };
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
