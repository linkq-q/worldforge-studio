import {
  getMapBounds,
  getMapAssetLocalBounds,
  getMapObjectVisualAabbs,
  getMapPlayerMetrics,
  sampleTerrainHeight,
  worldScaleProfileMultiplier,
  type EditableMap,
  type MapAsset,
  type RoomWall
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
import {
  indoorFallbackTargetHeight,
  indoorSemanticDimensions,
  isElevatedWallSemantic
} from './indoorScale';
import { compileMapVisualSemantics } from './mapVisualSemantics';
import type { TerrainRegion } from './terrainGeneration';

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
  if (map.sceneMode !== 'outdoor' && plan.globalBrief.interiorArtDirection) {
    operations.push({
      type: 'interior.art-direction.set',
      artDirection: plan.globalBrief.interiorArtDirection
    });
  }
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

  const planningAssets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  for (const resolved of resolvedFamilies) {
    for (const asset of resolved.assets) planningAssets.set(asset.id, asset);
  }
  let workingMap = applyMapOperations({ ...map, assets: [...planningAssets.values()] }, operations);
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
    if (map.sceneMode === 'indoor' && entry.layer.placement?.intent === 'supported' && family) {
      const supportedOperations = compileSupportedObjects(
        workingMap,
        entry.layer,
        family,
        assets,
        familyAssets,
        Math.min(structuredLimit, remaining),
        `composition-${entry.zone.id}-${entry.layer.familyId}`
      );
      if (supportedOperations.length === 0) continue;
      operations.push(...supportedOperations);
      workingMap = applyMapOperations(workingMap, supportedOperations);
      remaining -= supportedOperations.length;
      familyCounts[entry.layer.familyId] = (familyCounts[entry.layer.familyId] ?? 0) + supportedOperations.length;
      zoneCounts[entry.zone.id] = (zoneCounts[entry.zone.id] ?? 0) + supportedOperations.length;
      continue;
    }
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
          symmetric: map.sceneMode === 'indoor' && entry.zone.symmetry !== 'asymmetric',
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
        ? indoorPlacementTransform(map, family, asset, placement, rotationY)
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
    const executableOperations = family
      ? bindIndoorRoomOpenings(workingMap, family, assets, placementOperations)
      : placementOperations;
    const placedCount = executableOperations.filter((operation) => operation.type === 'object.add').length;
    operations.push(...executableOperations);
    workingMap = applyMapOperations(workingMap, executableOperations);
    remaining -= placedCount;
    familyCounts[entry.layer.familyId] = (familyCounts[entry.layer.familyId] ?? 0) + placedCount;
    zoneCounts[entry.zone.id] = (zoneCounts[entry.zone.id] ?? 0) + placedCount;
  }

  if (map.sceneMode === 'indoor' && map.room) {
    const windows = resolvedFamilies.find((entry) => isWindowFamily(entry.family) && entry.assets.length > 0);
    if (windows) {
      const windowOperations = completeIndoorWindowCoverage(workingMap, windows, plan);
      const placedCount = windowOperations.filter((operation) => operation.type === 'object.add').length;
      if (placedCount > 0) {
        operations.push(...windowOperations);
        workingMap = applyMapOperations(workingMap, windowOperations);
        familyCounts[windows.family.id] = (familyCounts[windows.family.id] ?? 0) + placedCount;
      }
    }
  }

  const changedHeights = workingMap.terrain.heights.filter((height, index) => (
    Math.abs(height - (map.terrain.heights[index] ?? 0)) > 0.01
  ));
  const indoorOccupancy = indoorOccupancyMetrics(map, workingMap);
  return {
    operations,
    metrics: {
      zoneCoverage: estimateSceneZoneCoverage(plan),
      zoneCount: plan.zones.length,
      objectCount: Math.max(0, workingMap.objects.length - map.objects.length),
      waterCount: Math.max(0, workingMap.waterBodies.length - map.waterBodies.length),
      terrainRelief: Math.max(...workingMap.terrain.heights) - Math.min(...workingMap.terrain.heights),
      terrainChangedCells: changedHeights.length,
      ...indoorOccupancy,
      familyCounts,
      zoneCounts,
      unresolvedFamilyIds,
      ...(Object.keys(behaviorQuality).length > 0 ? { behaviorQuality } : {})
    }
  };
}

export function indoorOccupancyMetrics(
  source: EditableMap,
  result: EditableMap
): Pick<SceneCompositionMetrics, 'indoorFloorOccupancy' | 'indoorObjectSpread'> {
  const room = result.sceneMode === 'indoor' ? result.room : null;
  if (!room) return {};
  const existingIds = new Set(source.objects.map((object) => object.id));
  const assets = new Map((result.assets ?? []).map((asset) => [asset.id, asset]));
  const floorObjectIds = new Set(result.objects
    .filter((object) => !existingIds.has(object.id))
    .filter((object) => {
      const asset = object.assetId ? assets.get(object.assetId) : undefined;
      const semantic = asset ? `${asset.name} ${asset.prompt} ${(asset.tags ?? []).join(' ')}` : '';
      return !isElevatedWallSemantic(semantic);
    })
    .map((object) => object.id));
  const inset = room.wallThickness;
  const roomMinX = room.position[0] - room.size[0] / 2 + inset;
  const roomMaxX = room.position[0] + room.size[0] / 2 - inset;
  const roomMinZ = room.position[2] - room.size[2] / 2 + inset;
  const roomMaxZ = room.position[2] + room.size[2] / 2 - inset;
  const usableArea = Math.max(0.01, (roomMaxX - roomMinX) * (roomMaxZ - roomMinZ));
  const boxes = getMapObjectVisualAabbs(result).filter((box) => floorObjectIds.has(box.objectId));
  if (boxes.length === 0) return { indoorFloorOccupancy: 0, indoorObjectSpread: 0 };
  const occupiedArea = boxes.reduce((sum, box) => {
    const width = Math.max(0, Math.min(roomMaxX, box.max[0]) - Math.max(roomMinX, box.min[0]));
    const depth = Math.max(0, Math.min(roomMaxZ, box.max[2]) - Math.max(roomMinZ, box.min[2]));
    return sum + width * depth;
  }, 0);
  const spreadMinX = Math.max(roomMinX, Math.min(...boxes.map((box) => box.min[0])));
  const spreadMaxX = Math.min(roomMaxX, Math.max(...boxes.map((box) => box.max[0])));
  const spreadMinZ = Math.max(roomMinZ, Math.min(...boxes.map((box) => box.min[2])));
  const spreadMaxZ = Math.min(roomMaxZ, Math.max(...boxes.map((box) => box.max[2])));
  return {
    indoorFloorOccupancy: clamp(occupiedArea / usableArea, 0, 1),
    indoorObjectSpread: clamp((spreadMaxX - spreadMinX) * (spreadMaxZ - spreadMinZ) / usableArea, 0, 1)
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
        ? expandStructuredMapPlacement(workingMap, {
            mode: 'layout', pattern: 'grid', intent: 'landmark',
            assetIds: assets.map((asset) => asset.id),
            region: { kind: 'circle', ...region },
            density: Math.max(0.01, layer.density),
            spacing: Math.max(1, footprint * 1.8),
            offset: layer.placement?.offset ?? 0,
            direction: layer.placement?.direction ?? 0,
            facing: layer.placement?.facing ?? 'guide',
            avoidWater: 0,
            maxSlope: 89,
            scaleRange: [scale, scale],
            seed: derivedSeed(map.seed, `${zone.id}:${layer.familyId}:indoor-anchor`),
            symmetric: zone.symmetry !== 'asymmetric'
          }, assets, 1, `composition-${zone.id}-${layer.familyId}-accent`)[0]
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
        ? indoorPlacementTransform(map, family, assets[0], placement, rotationY)
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
      const executableOperations = family
        ? bindIndoorRoomOpenings(workingMap, family, assets, [operation])
        : [operation];
      operations.push(...executableOperations);
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
      workingMap = applyMapOperations(workingMap, [...executableOperations, ...grassResidualOperations]);
      familyCounts[layer.familyId] = (familyCounts[layer.familyId] ?? 0) + 1;
      zoneCounts[zone.id] = (zoneCounts[zone.id] ?? 0) + 1;
    }
  }
  return operations;
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
  const bounds = getMapAssetLocalBounds(asset);
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
  const dimensions = indoorSemanticDimensions(map, semantic);
  const targetHeight = dimensions.targetHeight ?? indoorFallbackTargetHeight(map, family.sizeClass);
  const horizontalRadius = Math.max(0.1, asset.footprintRadius ?? 0.5);
  const direction = (placement?.direction ?? 0) * Math.PI / 180;
  const rotatedWidth = Math.abs(Math.cos(direction)) * width + Math.abs(Math.sin(direction)) * depth;
  const rotatedDepth = Math.abs(Math.sin(direction)) * width + Math.abs(Math.cos(direction)) * depth;
  const wallLength = Math.abs(Math.sin(direction)) > Math.abs(Math.cos(direction)) ? room.size[2] : room.size[0];
  const wallExtent = Math.abs(Math.sin(direction)) > Math.abs(Math.cos(direction)) ? rotatedDepth : rotatedWidth;
  const horizontalLimit = placement?.intent === 'wall'
    ? Math.max(0.05, (wallLength - (room.wallThickness + 0.25) * 2) / Math.max(0.1, wallExtent))
    : Math.min(room.size[0], room.size[2]) * 0.22 / horizontalRadius;
  const targetScale = Math.max(
    targetHeight / height,
    dimensions.minimumWidth / width,
    dimensions.minimumDepth / depth
  );
  const semanticLimits = [
    dimensions.maximumWidth === null ? Number.POSITIVE_INFINITY : dimensions.maximumWidth / width,
    dimensions.maximumDepth === null ? Number.POSITIVE_INFINITY : dimensions.maximumDepth / depth,
    dimensions.maximumHeight === null ? Number.POSITIVE_INFINITY : dimensions.maximumHeight / height
  ];
  const sizeClassMaximum = (family.sizeClass === 'small' ? 1.6 : family.sizeClass === 'medium' ? 3.2 : 5)
    * playerHeight / majorExtent;
  const upperLimit = Math.min(horizontalLimit, sizeClassMaximum, ...semanticLimits);
  const minimum = Math.min(targetScale * 0.82, upperLimit);
  const maximum = Math.min(targetScale * 1.18, upperLimit);
  return clamp(requested, Math.min(minimum, maximum), Math.max(minimum, maximum));
}

function indoorPlacementTransform(
  map: EditableMap,
  family: SceneCompositionPlan['assetFamilies'][number],
  asset: MapAsset,
  placement: MapScatterPlacement,
  rotationY: number
): {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
} {
  const room = map.room!;
  const bounds = getMapAssetLocalBounds(asset);
  const height = bounds.max[1] - bounds.min[1];
  const semantic = `${family.label} ${family.role} ${family.tags.join(' ')} ${family.generationBrief}`;
  const dimensions = indoorSemanticDimensions(map, semantic);
  const wallMounted = dimensions.wallMounted;
  const verticalScale = Math.min(
    placement.scale,
    Math.max(0.05, (dimensions.targetHeight ?? height * placement.scale) / Math.max(0.01, height)),
    Math.max(0.05, (room.size[1] - 0.02) / Math.max(0.01, height))
  );
  const y = dimensions.ceilingMounted
    ? room.position[1] + room.size[1] - room.wallThickness - bounds.max[1] * verticalScale
    : wallMounted
    ? room.position[1] + room.size[1] * 0.56 - (bounds.min[1] + height / 2) * verticalScale
    : room.position[1] - bounds.min[1] * verticalScale;
  return {
    position: [placement.x, y, placement.z],
    rotation: [0, rotationY, 0],
    scale: [placement.scale, verticalScale, placement.scale]
  };
}

function isWindowFamily(family: SceneCompositionPlan['assetFamilies'][number]): boolean {
  return /\bwindow\b|窗户|窗框/i.test(`${family.label} ${family.role} ${family.tags.join(' ')} ${family.generationBrief}`);
}

export function completeIndoorWindowCoverage(
  map: EditableMap,
  resolved: ResolvedSceneFamily,
  plan?: SceneCompositionPlan
): MapOperation[] {
  const room = map.room;
  if (!room) return [];
  const occupiedWalls = new Set(room.openings.filter((opening) => opening.kind === 'window').map((opening) => opening.wall));
  const planSemantic = plan
    ? `${plan.summary} ${plan.globalBrief.spatialTheme} ${plan.globalBrief.assetArtDirection}`
    : '';
  const targetWallCount = /single[- ]sided (?:daylight|lighting|windows?)|windows? (?:only )?on (?:a |one )?single wall|单侧采光|单面采光|只在一面墙(?:上)?(?:开窗|有窗)/i.test(planSemantic)
    ? 1
    : 4;
  if (occupiedWalls.size >= targetWallCount) return [];
  const operations: MapOperation[] = [];
  let workingMap = map;
  const scaleRange = semanticScaleRange(workingMap, resolved.family, resolved.assets, [1, 1.15], {
    mode: 'linear', pattern: 'row', intent: 'wall', direction: 0, offset: 0.15, facing: 'inward', maxPerGroup: 1
  });
  const directions: Array<[RoomWall, number]> = [['north', 0], ['east', 90], ['south', 180], ['west', 270]];
  for (const [wall, direction] of directions) {
    if (occupiedWalls.size >= targetWallCount) break;
    if (occupiedWalls.has(wall)) continue;
    const placements = expandStructuredMapPlacement(workingMap, {
      mode: 'linear', pattern: 'row', intent: 'wall',
      assetIds: resolved.assets.map((asset) => asset.id),
      region: { kind: 'circle', x: room.position[0], z: room.position[2], r: Math.max(room.size[0], room.size[2]) },
      density: 0.001, spacing: Math.max(1.6, getMapPlayerMetrics(map).height * 1.35), offset: 0.15,
      direction, facing: 'inward', avoidWater: 0, maxSlope: 89, scaleRange,
      seed: derivedSeed(map.seed, `window-coverage:${wall}`), candidateCount: 5, symmetric: true
    }, resolved.assets, 1, `window-coverage-${wall}`);
    const placement = placements[0];
    if (!placement) continue;
    const asset = resolved.assets.find((item) => item.id === placement.assetId) ?? resolved.assets[0];
    const objectOperation: MapOperation = {
      type: 'object.add',
      object: {
        id: placement.id, name: asset.name, assetId: asset.id, heightMode: 'fixed',
        transform: indoorPlacementTransform(map, resolved.family, asset, placement, placement.rotationY)
      }
    };
    const executable = bindIndoorRoomOpenings(workingMap, resolved.family, resolved.assets, [objectOperation]);
    operations.push(...executable);
    workingMap = applyMapOperations(workingMap, executable);
    occupiedWalls.add(wall);
  }
  return operations;
}

function isInvalidBedSupport(asset: MapAsset, targetAssets: readonly MapAsset[]): boolean {
  const targetIsBed = targetAssets.some((target) => /\bbed\b|mattress|床铺|床垫|床架/i.test(
    `${target.name} ${target.prompt} ${(target.tags ?? []).join(' ')}`
  ));
  if (!targetIsBed) return false;
  const semantic = `${asset.name} ${asset.prompt} ${(asset.tags ?? []).join(' ')}`;
  const tags = new Set((asset.tags ?? []).map((tag) => tag.toLowerCase()));
  const explicitBedAssembly = tags.has('bed') || tags.has('mattress') || tags.has('bedding');
  if (!explicitBedAssembly && /pillow|small folded throw|cushion|枕|折叠毯|抱枕/i.test(semantic)) return false;
  return /\bbed\b|mattress|bedding|bed[-_ ]?linen|床品|床铺|床垫|床架/i.test(semantic);
}

/** Converts planned door/window models into real room-shell reservations and links the objects to them. */
export function bindIndoorRoomOpenings(
  map: EditableMap,
  family: SceneCompositionPlan['assetFamilies'][number],
  assets: readonly MapAsset[],
  operations: readonly MapOperation[]
): MapOperation[] {
  const room = map.sceneMode === 'indoor' ? map.room : null;
  if (!room) return [...operations];
  const semantic = `${family.label} ${family.role} ${family.tags.join(' ')} ${family.generationBrief}`;
  const kind = /loading door|warehouse door|\bdoor\b|房门|门扇|装卸门|仓库门/i.test(semantic)
    ? 'door' as const
    : /\bwindow\b|窗户|窗框|仓库窗/i.test(semantic)
      ? 'window' as const
      : null;
  if (!kind) return [...operations];

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const openings = [...room.openings];
  let changed = false;
  const linked = operations.map((operation): MapOperation => {
    if (operation.type !== 'object.add' || !operation.object.assetId || operation.object.roomOpeningId) return operation;
    const asset = assetById.get(operation.object.assetId);
    const transform = operation.object.transform;
    if (!asset || !transform?.position || !transform.rotation || !transform.scale) return operation;
    const bounds = getMapAssetLocalBounds(asset);
    const wall = nearestRoomWall(room, transform.position[0], transform.position[2]);
    const width = Math.max(0.4, bounds.max[0] - bounds.min[0]) * Math.abs(transform.scale[0]);
    const height = Math.max(0.4, bounds.max[1] - bounds.min[1]) * Math.abs(transform.scale[1]);
    const wallLength = wall === 'north' || wall === 'south' ? room.size[0] : room.size[2];
    const openingWidth = Math.min(width + 0.08, wallLength - room.wallThickness * 2);
    const openingHeight = Math.min(height + 0.08, room.size[1] - room.wallThickness);
    const rawOffset = wall === 'north' || wall === 'south'
      ? transform.position[0] - room.position[0]
      : transform.position[2] - room.position[2];
    const offset = clamp(
      rawOffset,
      -wallLength / 2 + openingWidth / 2 + room.wallThickness,
      wallLength / 2 - openingWidth / 2 - room.wallThickness
    );
    const visualBottom = transform.position[1] - room.position[1] + bounds.min[1] * transform.scale[1];
    const bottom = kind === 'door'
      ? 0
      : clamp(visualBottom, room.wallThickness, room.size[1] - room.wallThickness - openingHeight);
    const roomOpeningId = `${operation.object.id}-opening`;
    openings.push({ id: roomOpeningId, kind, wall, offset, bottom, width: openingWidth, height: openingHeight });
    changed = true;
    return { ...operation, object: { ...operation.object, roomOpeningId } };
  });
  return changed
    ? [{ type: 'room.set', room: { ...room, openings } }, ...linked]
    : linked;
}

function nearestRoomWall(
  room: NonNullable<EditableMap['room']>,
  x: number,
  z: number
): RoomWall {
  const distances: Array<[RoomWall, number]> = [
    ['north', Math.abs(z - (room.position[2] - room.size[2] / 2))],
    ['south', Math.abs(z - (room.position[2] + room.size[2] / 2))],
    ['west', Math.abs(x - (room.position[0] - room.size[0] / 2))],
    ['east', Math.abs(x - (room.position[0] + room.size[0] / 2))]
  ];
  return distances.sort((left, right) => left[1] - right[1])[0][0];
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
  // maxPerGroup describes one relationship group (for example four chairs per
  // dining table), not a hidden cap on how many groups a whole zone may own.
  if (intent === 'social' || intent === 'attached-service' || intent === 'paired' || intent === 'supported') {
    return limit;
  }
  if (intent === 'functional-group') {
    const semantic = family ? `${family.label} ${family.role} ${family.tags.join(' ')}` : '';
    return /ceiling[-_ ]?mounted|ceiling[-_ ]?light|overhead[-_ ]?light|pendant[-_ ]?light|industrial[-_ ]?light|顶灯|吊灯|天花灯|工业照明/i.test(semantic)
      ? Math.min(limit, layer.placement?.maxPerGroup ?? 12)
      : limit;
  }
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
  if (mode === 'linear') return 0;
  if (mode === 'layout') return 1;
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

function compileSupportedObjects(
  map: EditableMap,
  layer: SceneZoneLayer,
  family: SceneCompositionPlan['assetFamilies'][number],
  assets: readonly MapAsset[],
  familyAssets: ReadonlyMap<string, MapAsset[]>,
  limit: number,
  idPrefix: string
): MapOperation[] {
  const targetFamilyId = layer.placement?.targetFamilyId;
  if (!targetFamilyId || assets.length === 0 || limit <= 0) return [];
  const targetAssets = familyAssets.get(targetFamilyId) ?? [];
  const usableAssets = assets.filter((asset) => !isInvalidBedSupport(asset, targetAssets));
  if (usableAssets.length === 0) return [];
  const targetByAssetId = new Map(targetAssets.map((asset) => [asset.id, asset]));
  const dependentAssetIds = new Set(usableAssets.map((asset) => asset.id));
  const occupiedParents = new Set(map.objects
    .filter((object) => object.parentId && object.assetId && dependentAssetIds.has(object.assetId))
    .map((object) => object.parentId!));
  const targets = map.objects.filter((object) => (
    object.assetId && targetByAssetId.has(object.assetId) && !occupiedParents.has(object.id)
  ));
  const scaleRange = semanticScaleRange(map, family, usableAssets, layer.scaleRange, layer.placement);
  const desiredScale = (scaleRange[0] + scaleRange[1]) / 2;
  return targets.slice(0, limit).map((target, index): MapOperation => {
    const asset = usableAssets[index % usableAssets.length];
    const targetAsset = targetByAssetId.get(target.assetId!)!;
    const supportBounds = getMapAssetLocalBounds(targetAsset);
    const itemBounds = getMapAssetLocalBounds(asset);
    const parentScale: [number, number, number] = [0, 1, 2].map((axis) => Math.max(
      0.001,
      Math.abs(target.transform.scale[axis] * target.transform.size[axis])
    )) as [number, number, number];
    const localScale: [number, number, number] = [
      desiredScale / parentScale[0],
      desiredScale / parentScale[1],
      desiredScale / parentScale[2]
    ];
    const supportCenterX = (supportBounds.min[0] + supportBounds.max[0]) / 2;
    const supportCenterZ = (supportBounds.min[2] + supportBounds.max[2]) / 2;
    const itemCenterX = (itemBounds.min[0] + itemBounds.max[0]) / 2;
    const itemCenterZ = (itemBounds.min[2] + itemBounds.max[2]) / 2;
    return {
      type: 'object.add',
      object: {
        id: `${idPrefix}-${index + 1}`.slice(0, 80),
        name: `${family.label} ${index + 1}`,
        parentId: target.id,
        assetId: asset.id,
        heightMode: 'fixed',
        transform: {
          position: [
            supportCenterX - itemCenterX * localScale[0],
            supportBounds.max[1] - itemBounds.min[1] * localScale[1] + 0.02 / parentScale[1],
            supportCenterZ - itemCenterZ * localScale[2]
          ],
          rotation: [0, 0, 0],
          scale: localScale
        }
      }
    };
  });
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
