import {
  getMapBounds,
  getMapPlayerMetrics,
  type EditableMap,
  type MapAsset
} from './map';
import { applyMapOperations, type MapOperation } from './mapOperations';
import { expandMapScatter } from './mapScatter';
import { expandStructuredMapPlacement } from './mapPlacement';
import { planLimits } from './mapPlanning';
import {
  sceneAssetCategory,
  sceneZoneWorldRegion,
  type SceneCompositionPlan,
  type SceneIntentRequirement
} from './sceneComposition';
import type { ResolvedSceneFamily } from './sceneCompositionAssets';
import { calculateModelVisualBounds } from './modelBounds';
import {
  compileScenePlacementBehavior,
  compileZoneWater,
  isImplicitOceanZone,
  sceneBehaviorGrouping,
  scenePlacementAltitude,
  type CompiledSceneComposition
} from './sceneCompositionCompiler';

export interface SceneOutcomeCheck {
  requirementId: string;
  kind: SceneIntentRequirement['kind'] | 'population' | 'furniture';
  status: 'pass' | 'repaired' | 'warning';
  message: string;
}

export interface SceneCompositionOutcome {
  compiled: CompiledSceneComposition;
  checks: SceneOutcomeCheck[];
  repairCount: number;
}

/** Ensures the director's explicit physical requirements survived deterministic compilation. */
export function ensureSceneCompositionOutcome(
  map: EditableMap,
  plan: SceneCompositionPlan,
  resolvedFamilies: readonly ResolvedSceneFamily[],
  compiled: CompiledSceneComposition
): SceneCompositionOutcome {
  const operations = [...compiled.operations];
  const familyCounts = { ...compiled.metrics.familyCounts };
  const zoneCounts = { ...compiled.metrics.zoneCounts };
  let candidate = applyMapOperations(map, operations);
  const checks: SceneOutcomeCheck[] = [];
  let repairCount = 0;

  for (const requirement of plan.intentRequirements) {
    if (requirement.kind === 'terrain') {
      const changed = terrainChangedCellCount(map, candidate);
      if (changed < minimumTerrainCells(map)) {
        const repair = terrainRepair(map, plan, requirement);
        operations.push(repair);
        candidate = applyMapOperations(candidate, [repair]);
        repairCount += 1;
        checks.push({
          requirementId: requirement.id,
          kind: requirement.kind,
          status: 'repaired',
          message: '地形基底未产生足够变化，已按导演选择的焦点区补充确定性塑形。'
        });
      } else {
        checks.push({ requirementId: requirement.id, kind: requirement.kind, status: 'pass', message: '地形高度场已生成。' });
      }
      continue;
    }

    if (requirement.kind === 'water') {
      const targetZone = plan.zones.find((zone) => zone.id === requirement.targetZoneId);
      const usesTerrainOcean = targetZone ? isImplicitOceanZone(plan, targetZone) : false;
      const expectedId = requirement.targetZoneId ? `composition-water-${requirement.targetZoneId}` : null;
      const count = usesTerrainOcean
        ? candidate.waterBodies.filter((water) => water.type === 'ocean').length
        : expectedId
        ? candidate.waterBodies.filter((water) => water.id === expectedId).length
        : candidate.waterBodies.length - map.waterBodies.length;
      if (count < requirement.minCount) {
        const repairs = compileZoneWater(map, {
          ...plan,
          zones: plan.zones.filter((zone) => zone.id === requirement.targetZoneId)
        }).filter((operation) => operation.type === 'water.add');
        if (repairs.length === 0) {
          checks.push({
            requirementId: requirement.id,
            kind: requirement.kind,
            status: 'warning',
            message: `水体要求“${requirement.description}”无法安全重建，已降级跳过并保留其余场景。`
          });
          continue;
        }
        operations.push(...repairs);
        candidate = applyMapOperations(candidate, repairs);
        repairCount += repairs.length;
        checks.push({
          requirementId: requirement.id,
          kind: requirement.kind,
          status: 'repaired',
          message: '结构化水体在编译结果中缺失，已从对应区块简报重建。'
        });
      } else {
        checks.push({ requirementId: requirement.id, kind: requirement.kind, status: 'pass', message: '结构化水体已生成并完成岸坡雕刻。' });
      }
      continue;
    }

    const currentCount = familyCounts[requirement.familyId ?? ''] ?? 0;
    if (currentCount >= requirement.minCount) {
      checks.push({ requirementId: requirement.id, kind: requirement.kind, status: 'pass', message: '必要资产家族已落位。' });
      continue;
    }
    const repairs = requiredFamilyRepairs(map, candidate, plan, resolvedFamilies, requirement, requirement.minCount - currentCount);
    if (repairs.length === 0) {
      checks.push({
        requirementId: requirement.id,
        kind: requirement.kind,
        status: 'warning',
        message: `必要资产“${requirement.description}”在自动缩放、贴墙和补摆后仍无合法位置，已降级跳过并保留其余场景。`
      });
      continue;
    }
    operations.push(...repairs);
    candidate = applyMapOperations(candidate, repairs);
    familyCounts[requirement.familyId!] = currentCount + repairs.length;
    repairCount += repairs.length;
    checks.push({
      requirementId: requirement.id,
      kind: requirement.kind,
      status: 'repaired',
      message: `必要资产家族缺少实例，已补充 ${repairs.length} 个可编辑实例。`
    });
  }

  const checkedFamilyIds = new Set(plan.intentRequirements.flatMap((requirement) => (
    requirement.kind === 'asset-family' && requirement.familyId ? [requirement.familyId] : []
  )));
  for (const resolved of resolvedFamilies) {
    if (resolved.assets.length === 0) {
      if (!checkedFamilyIds.has(resolved.family.id)) checks.push({
        requirementId: `family-unavailable-${resolved.family.id}`,
        kind: 'asset-family',
        status: 'warning',
        message: `资产“${resolved.family.label}”没有可生成或复用的模型，已降级跳过并保留其余场景。`
      });
      continue;
    }
    const zone = plan.zones.find((item) => (
      item.role !== 'negative-space'
      && item.layers.some((layer) => layer.familyId === resolved.family.id)
    ));
    if (!zone) continue;
    const layers = zone.layers.filter((layer) => layer.familyId === resolved.family.id);
    const minimum = sceneAssetCategory(resolved.family) === 'facility'
      && layers.some((layer) => layer.placement?.intent === 'playground')
      ? 2
      : 1;
    const currentCount = familyCounts[resolved.family.id] ?? 0;
    if (currentCount >= minimum) continue;
    const available = Math.max(0, planLimits(getMapBounds(map), map.sceneMode).objectCount - (candidate.objects.length - map.objects.length));
    const missing = Math.min(minimum - currentCount, available);
    const requirement: SceneIntentRequirement = {
      id: `family-presence-${resolved.family.id}`,
      kind: 'asset-family',
      description: `${resolved.family.label} must be represented in the compiled scene.`,
      targetZoneId: zone.id,
      familyId: resolved.family.id,
      minCount: minimum
    };
    const repairs = missing > 0
      ? requiredFamilyRepairs(map, candidate, plan, resolvedFamilies, requirement, missing)
      : [];
    if (repairs.length > 0) {
      operations.push(...repairs);
      candidate = applyMapOperations(candidate, repairs);
      familyCounts[resolved.family.id] = currentCount + repairs.length;
      zoneCounts[zone.id] = (zoneCounts[zone.id] ?? 0) + repairs.length;
      repairCount += repairs.length;
    }
    const repairedCount = currentCount + repairs.length;
    checks.push({
      requirementId: requirement.id,
      kind: 'asset-family',
      status: repairedCount >= minimum ? 'repaired' : 'warning',
      message: repairedCount >= minimum
        ? `${resolved.family.label} 未进入初始布局，已补入 ${repairs.length} 个实例。`
        : `${resolved.family.label} 仍缺少可用落位空间。`
    });
  }

  const population = repairNaturalPopulation(map, candidate, plan, resolvedFamilies);
  if (population.target > 0) {
    const currentCount = candidate.objects.length - map.objects.length;
    if (currentCount < population.target && population.operations.length > 0) {
      operations.push(...population.operations);
      candidate = applyMapOperations(candidate, population.operations);
      repairCount += population.operations.length;
      for (const [familyId, count] of Object.entries(population.familyCounts)) {
        familyCounts[familyId] = (familyCounts[familyId] ?? 0) + count;
      }
      for (const [zoneId, count] of Object.entries(population.zoneCounts)) {
        zoneCounts[zoneId] = (zoneCounts[zoneId] ?? 0) + count;
      }
      checks.push({
        requirementId: 'scene-population',
        kind: 'population',
        status: 'repaired',
        message: `可重复自然资产密度不足，已按区块简报补充 ${population.operations.length} 个散布实例。`
      });
    } else {
      checks.push({
        requirementId: 'scene-population',
        kind: 'population',
        status: 'pass',
        message: '可重复自然资产的散布密度已达到场景规模下限。'
      });
    }
  }
  checks.push(...auditFurnitureOutcome(plan, candidate, resolvedFamilies));

  return {
    compiled: {
      operations,
      metrics: {
        ...compiled.metrics,
        objectCount: Math.max(0, candidate.objects.length - map.objects.length),
        waterCount: Math.max(0, candidate.waterBodies.length - map.waterBodies.length),
        terrainRelief: Math.max(...candidate.terrain.heights) - Math.min(...candidate.terrain.heights),
        terrainChangedCells: terrainChangedCellCount(map, candidate),
        familyCounts,
        zoneCounts
      }
    },
    checks,
    repairCount
  };
}

function auditFurnitureOutcome(
  plan: SceneCompositionPlan,
  candidate: EditableMap,
  resolvedFamilies: readonly ResolvedSceneFamily[]
): SceneOutcomeCheck[] {
  const assetsByFamily = new Map(resolvedFamilies.map((resolved) => [
    resolved.family.id,
    new Set(resolved.assets.map((asset) => asset.id))
  ]));
  return plan.assetFamilies.flatMap((family): SceneOutcomeCheck[] => {
    const category = sceneAssetCategory(family);
    if (category !== 'furniture' && category !== 'facility') return [];
    const layers = plan.zones.flatMap((zone) => zone.layers.filter((layer) => layer.familyId === family.id));
    if (layers.length === 0) return [];
    const semantic = `${family.label} ${family.role} ${family.tags.join(' ')} ${family.generationBrief}`;
    const explicitCircle = /amphitheater|circular seating|ceremony|ritual|圆形剧场|环形座位|仪式/i.test(semantic);
    const assetIds = assetsByFamily.get(family.id) ?? new Set<string>();
    const objects = candidate.objects.filter((object) => object.assetId && assetIds.has(object.assetId));
    const issues: string[] = [];

    if (category === 'furniture' && layers.some((layer) => (
      !layer.placement?.intent
      || layer.placement.mode === 'field'
      || layer.placement.mode === 'patch'
      || !explicitCircle && (layer.placement.pattern === 'courtyard' || layer.placement.pattern === 'radial')
    ))) issues.push('家具仍在使用未声明用途的散布或完整环形布局');
    if (category === 'facility' && layers.some((layer) => (
      layer.placement?.intent === 'playground'
      && (layer.placement.mode !== 'layout' || layer.placement.pattern !== 'arc')
    ))) issues.push('游乐设施没有使用分组稀疏布局');

    const expectedMax = layers.reduce((sum, layer) => sum + furnitureLayerLimit(layer), 0);
    if (objects.length > expectedMax) issues.push(`实例数 ${objects.length} 超过关系布局上限 ${expectedMax}`);
    if (!explicitCircle && formsClosedFurnitureRing(objects)) issues.push('实例围成了未经请求的近似完整闭环');

    return [{
      requirementId: `furniture-${family.id}`,
      kind: 'furniture',
      status: issues.length > 0 ? 'warning' : 'pass',
      message: issues.length > 0
        ? `${family.label}：${issues.join('；')}。`
        : `${family.label} 的数量、用途和朝向布局已通过家具验收。`
    }];
  });
}

function furnitureLayerLimit(layer: SceneCompositionPlan['zones'][number]['layers'][number]): number {
  const intent = layer.placement?.intent;
  if (intent === 'playground') return 2;
  if (intent === 'viewpoint') return layer.placement?.maxPerGroup ?? 5;
  if (intent === 'street-edge') return (layer.placement?.maxPerGroup ?? 4) * 3;
  if (intent === 'audience') return Number.POSITIVE_INFINITY;
  if (intent === 'social' || intent === 'attached-service') return (layer.placement?.maxPerGroup ?? 6) * 8;
  if (intent === 'wall') return layer.placement?.maxPerGroup ?? 10;
  return Number.POSITIVE_INFINITY;
}

function formsClosedFurnitureRing(objects: EditableMap['objects']): boolean {
  if (objects.length < 6) return false;
  const centerX = objects.reduce((sum, object) => sum + object.transform.position[0], 0) / objects.length;
  const centerZ = objects.reduce((sum, object) => sum + object.transform.position[2], 0) / objects.length;
  const radii = objects.map((object) => Math.hypot(
    object.transform.position[0] - centerX,
    object.transform.position[2] - centerZ
  ));
  const meanRadius = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
  if (meanRadius < 0.5) return false;
  const deviation = Math.sqrt(radii.reduce((sum, radius) => sum + (radius - meanRadius) ** 2, 0) / radii.length);
  if (deviation / meanRadius > 0.28) return false;
  const angles = objects.map((object) => Math.atan2(
    object.transform.position[2] - centerZ,
    object.transform.position[0] - centerX
  )).sort((left, right) => left - right);
  const gaps = angles.map((angle, index) => {
    const next = angles[(index + 1) % angles.length] + (index === angles.length - 1 ? Math.PI * 2 : 0);
    return next - angle;
  });
  return Math.max(...gaps) < Math.PI * 0.56;
}

function repairNaturalPopulation(
  baseMap: EditableMap,
  candidate: EditableMap,
  plan: SceneCompositionPlan,
  resolvedFamilies: readonly ResolvedSceneFamily[]
): {
  target: number;
  operations: MapOperation[];
  familyCounts: Record<string, number>;
  zoneCounts: Record<string, number>;
} {
  if (baseMap.sceneMode === 'indoor') {
    return { target: 0, operations: [], familyCounts: {}, zoneCounts: {} };
  }
  const assetsByFamily = new Map(resolvedFamilies.map((resolved) => [resolved.family.id, resolved]));
  const entries = plan.zones
    .filter((zone) => zone.role !== 'negative-space' && !zone.water)
    .flatMap((zone) => zone.layers.map((layer) => {
      const resolved = assetsByFamily.get(layer.familyId);
      return resolved ? { zone, layer, resolved } : null;
    }))
    .filter((entry): entry is { zone: SceneCompositionPlan['zones'][number]; layer: SceneCompositionPlan['zones'][number]['layers'][number]; resolved: ResolvedSceneFamily } => (
      entry !== null
      && entry.resolved.assets.length > 0
      && isRepeatableVegetationFamily(entry.resolved.family)
      && (entry.layer.distribution !== 'accent' || isPopulationZone(entry.zone))
    ))
    .sort((left, right) => (
      Number(left.layer.distribution === 'accent') - Number(right.layer.distribution === 'accent')
      || right.zone.importance - left.zone.importance
      || right.resolved.family.priority - left.resolved.family.priority
    ));
  if (entries.length === 0) return { target: 0, operations: [], familyCounts: {}, zoneCounts: {} };

  const limits = planLimits(getMapBounds(baseMap), baseMap.sceneMode);
  const target = Math.min(limits.objectCount, Math.max(10, Math.round(limits.objectCount * Math.min(0.52, 0.14 + entries.length * 0.12))));
  let remaining = Math.max(0, target - (candidate.objects.length - baseMap.objects.length));
  let workingMap = candidate;
  const operations: MapOperation[] = [];
  const familyCounts: Record<string, number> = {};
  const zoneCounts: Record<string, number> = {};

  for (const [index, entry] of entries.entries()) {
    if (remaining <= 0) break;
    const region = sceneZoneWorldRegion(entry.zone, baseMap);
    const footprint = Math.max(...entry.resolved.assets.map((asset) => asset.footprintRadius ?? 0.5));
    const remainingEntries = entries.length - index;
    const quota = Math.max(1, Math.ceil(remaining / remainingEntries));
    const density = Math.max(entry.layer.density, quota / Math.max(1, Math.PI * region.r * region.r));
    const placements = expandMapScatter(workingMap, {
      assetIds: entry.resolved.assets.map((asset) => asset.id),
      region: { kind: 'circle', ...region },
      density,
      avoidWater: 0.8,
      maxSlope: 34,
      minSpacing: Math.max(0.8, footprint * 1.8),
      scaleRange: entry.layer.scaleRange,
      seed: hashSeed(baseMap.seed, `population:${entry.zone.id}:${entry.layer.familyId}`),
      edgeFalloff: Math.max(0.08, entry.layer.edgeFalloff),
      clusterStrength: entry.layer.distribution === 'even' ? 0.2 : 0.68,
      excludeRegions: entry.zone.excludeZoneIds
        .map((zoneId) => plan.zones.find((zone) => zone.id === zoneId))
        .filter((zone): zone is SceneCompositionPlan['zones'][number] => Boolean(zone))
        .map((zone) => ({ kind: 'circle' as const, ...sceneZoneWorldRegion(zone, baseMap) }))
    }, entry.resolved.assets as MapAsset[], quota, `population-${entry.zone.id}-${entry.layer.familyId}`)
      .map((placement): MapOperation => ({
        type: 'object.add',
        object: {
          id: placement.id,
          name: placement.name,
          assetId: placement.assetId,
          transform: {
            position: [placement.x, placement.y, placement.z],
            rotation: [0, placement.rotationY, 0],
            scale: [placement.scale, placement.scale, placement.scale]
          }
        }
      }));
    if (placements.length === 0) continue;
    operations.push(...placements);
    workingMap = applyMapOperations(workingMap, placements);
    remaining -= placements.length;
    familyCounts[entry.layer.familyId] = (familyCounts[entry.layer.familyId] ?? 0) + placements.length;
    zoneCounts[entry.zone.id] = (zoneCounts[entry.zone.id] ?? 0) + placements.length;
  }
  return { target, operations, familyCounts, zoneCounts };
}

function isRepeatableVegetationFamily(family: ResolvedSceneFamily['family']): boolean {
  if (sceneAssetCategory(family) !== 'nature') return false;
  return /tree|forest|pine|oak|bush|shrub|fern|vegetation|plant|foliage|flower|grass|树|林|灌|蕨|植|花|草/i
    .test(`${family.label} ${family.role} ${family.tags.join(' ')}`);
}

function isPopulationZone(zone: SceneCompositionPlan['zones'][number]): boolean {
  return /forest|woodland|grove|thicket|meadow|shrubland|vegetation|林|森林|林地|树林|树丛|灌木|草甸/i.test([
    zone.label,
    zone.role,
    zone.brief.atmosphere,
    zone.brief.hierarchy,
    zone.brief.transitionIntent
  ].join(' '));
}

function terrainRepair(
  map: EditableMap,
  plan: SceneCompositionPlan,
  requirement: SceneIntentRequirement
): MapOperation {
  const zone = plan.zones.find((item) => item.id === requirement.targetZoneId)
    ?? plan.zones.find((item) => item.id === plan.globalBrief.focalZoneId)
    ?? plan.zones[0];
  const region = sceneZoneWorldRegion(zone, map);
  const sign = zone.terrain.elevation < 0 ? -1 : 1;
  return {
    type: 'terrain.brush',
    mode: sign < 0 ? 'lower' : 'raise',
    point: [region.x, 0, region.z],
    size: Math.max(2, region.r * 0.55),
    strength: Math.max(0.4, map.box.size[1] * 0.045)
  };
}

function requiredFamilyRepairs(
  baseMap: EditableMap,
  candidate: EditableMap,
  plan: SceneCompositionPlan,
  resolvedFamilies: readonly ResolvedSceneFamily[],
  requirement: SceneIntentRequirement,
  missing: number
): MapOperation[] {
  const resolved = resolvedFamilies.find((entry) => entry.family.id === requirement.familyId);
  if (!resolved || resolved.assets.length === 0) return [];
  if (baseMap.sceneMode === 'indoor') {
    return indoorRequiredFamilyRepairs(baseMap, candidate, plan, resolved, requirement, missing);
  }
  const footprint = Math.max(...resolved.assets.map((asset) => asset.footprintRadius ?? 0.5)) * 1.1;
  const regions = requiredPlacementRegions(baseMap, plan, requirement, footprint);
  const operations: MapOperation[] = [];
  let workingMap = candidate;
  let remaining = Math.min(missing, planLimits(getMapBounds(baseMap), baseMap.sceneMode).objectCount);

  for (const [regionIndex, region] of regions.entries()) {
    if (remaining <= 0) break;
    const seed = hashSeed(baseMap.seed, `${requirement.id}:${regionIndex}`);
    const placements = expandMapScatter(workingMap, {
      assetIds: resolved.assets.map((asset) => asset.id),
      region: { kind: 'circle', ...region },
      density: 0.25,
      avoidWater: 0.8,
      maxSlope: 34,
      minSpacing: 0.8,
      scaleRange: [0.9, 1.1],
      seed,
      edgeFalloff: 0,
      clusterStrength: 0,
      grouping: sceneBehaviorGrouping(resolved.family.behavior)
    }, resolved.assets as MapAsset[], remaining, `required-${requirement.id}-${regionIndex}`);
    const placementOperations = placements.map((placement): MapOperation => ({
      type: 'object.add',
      object: {
        id: placement.id,
        name: placement.name,
        assetId: placement.assetId,
        transform: {
          position: [placement.x, placement.y + scenePlacementAltitude(resolved.family.behavior, placement), placement.z],
          rotation: [0, placement.rotationY, 0],
          scale: [placement.scale, placement.scale, placement.scale]
        },
        ...compileScenePlacementBehavior(resolved.family.behavior, placement, seed)
      }
    }));
    if (placementOperations.length === 0) continue;
    operations.push(...placementOperations);
    workingMap = applyMapOperations(workingMap, placementOperations);
    remaining -= placementOperations.length;
  }
  return operations;
}

function indoorRequiredFamilyRepairs(
  baseMap: EditableMap,
  candidate: EditableMap,
  plan: SceneCompositionPlan,
  resolved: ResolvedSceneFamily,
  requirement: SceneIntentRequirement,
  missing: number
): MapOperation[] {
  const room = baseMap.room;
  if (!room) return [];
  const zone = plan.zones.find((item) => item.id === requirement.targetZoneId)
    ?? plan.zones.find((item) => item.layers.some((layer) => layer.familyId === resolved.family.id));
  const layer = zone?.layers.find((item) => item.familyId === resolved.family.id);
  const intent = layer?.placement?.intent;
  const { height: playerHeight } = getMapPlayerMetrics(baseMap);
  const operations: MapOperation[] = [];
  let workingMap = candidate;
  let remaining = Math.min(missing, planLimits(getMapBounds(baseMap), 'indoor').objectCount);

  for (const [stage, backoff] of [1, 0.8, 0.6].entries()) {
    if (remaining <= 0) break;
    const asset = resolved.assets[stage % resolved.assets.length];
    const bounds = localAssetBounds(asset);
    const localHeight = Math.max(0.01, bounds.max[1] - bounds.min[1]);
    const targetHeight = /chair|seat|pew|stool|椅|座椅|长凳/i.test(`${resolved.family.label} ${resolved.family.tags.join(' ')}`)
      ? playerHeight * 0.64
      : playerHeight;
    const ceilingScale = Math.max(0.05, (room.size[1] - 0.02) / localHeight);
    const direction = (layer?.placement?.direction ?? 0) * Math.PI / 180;
    const localWidth = Math.max(0.01, bounds.max[0] - bounds.min[0]);
    const localDepth = Math.max(0.01, bounds.max[2] - bounds.min[2]);
    const wallLength = Math.abs(Math.sin(direction)) > Math.abs(Math.cos(direction)) ? room.size[2] : room.size[0];
    const wallExtent = Math.abs(Math.sin(direction)) > Math.abs(Math.cos(direction))
      ? Math.abs(Math.sin(direction)) * localWidth + Math.abs(Math.cos(direction)) * localDepth
      : Math.abs(Math.cos(direction)) * localWidth + Math.abs(Math.sin(direction)) * localDepth;
    const wallScale = intent === 'wall'
      ? Math.max(0.05, (wallLength - (room.wallThickness + 0.25) * 2) / wallExtent)
      : Number.POSITIVE_INFINITY;
    const scale = Math.min(ceilingScale, wallScale, Math.max(0.05, targetHeight / localHeight) * backoff);
    const spacing = Math.max(0.55, playerHeight * 0.78 * backoff, (asset.footprintRadius ?? 0.5) * scale * 2.05);
    const placements = expandStructuredMapPlacement(workingMap, {
      mode: intent === 'wall' ? 'linear' : 'layout',
      pattern: intent === 'audience' ? 'grid' : 'grid',
      intent,
      assetIds: resolved.assets.map((item) => item.id),
      region: {
        kind: 'circle',
        x: room.position[0],
        z: room.position[2],
        r: Math.max(1, Math.min(room.size[0], room.size[2]) / 2 - room.wallThickness)
      },
      density: Math.max(0.08, layer?.density ?? 0.08),
      spacing,
      offset: layer?.placement?.offset ?? 0,
      direction: layer?.placement?.direction ?? 0,
      facing: layer?.placement?.facing ?? (intent === 'audience' ? 'inward' : 'guide'),
      avoidWater: 0,
      maxSlope: 89,
      scaleRange: [scale, scale],
      seed: hashSeed(baseMap.seed, `${requirement.id}:indoor:${stage}`),
      focus: { x: room.position[0], z: room.position[2] - room.size[2] * 0.35 },
      maxPerGroup: layer?.placement?.maxPerGroup,
      aisleEvery: layer?.placement?.aisleEvery
    }, resolved.assets, remaining, `required-${requirement.id}-indoor-${stage}`);
    const repairs = placements.map((placement): MapOperation => {
      const placedAsset = resolved.assets.find((item) => item.id === placement.assetId) ?? asset;
      const placedBounds = localAssetBounds(placedAsset);
      return {
        type: 'object.add',
        object: {
          id: placement.id,
          name: placement.name,
          assetId: placement.assetId,
          heightMode: 'fixed',
          transform: {
            position: [placement.x, room.position[1] - placedBounds.min[1] * placement.scale, placement.z],
            rotation: [0, placement.rotationY, 0],
            scale: [placement.scale, placement.scale, placement.scale]
          }
        }
      };
    });
    if (repairs.length === 0) continue;
    operations.push(...repairs);
    workingMap = applyMapOperations(workingMap, repairs);
    remaining -= repairs.length;
  }
  return operations;
}

function localAssetBounds(asset: MapAsset): { min: [number, number, number]; max: [number, number, number] } {
  if (asset.colliderPlan?.fallbackUsed && asset.colliderPlan.sourceMeshCount === 0) {
    const radius = Math.max(0.1, asset.footprintRadius ?? 0.5);
    const height = asset.sizeClass === 'large' ? 3 : asset.sizeClass === 'medium' ? 1.8 : 1;
    return { min: [-radius, 0, -radius], max: [radius, height, radius] };
  }
  return calculateModelVisualBounds(asset.modelJson);
}

function requiredPlacementRegions(
  map: EditableMap,
  plan: SceneCompositionPlan,
  requirement: SceneIntentRequirement,
  footprint: number
): Array<{ x: number; z: number; r: number }> {
  const preferredZones = [
    plan.zones.find((zone) => zone.id === requirement.targetZoneId),
    ...plan.zones.filter((zone) => zone.layers.some((layer) => layer.familyId === requirement.familyId)),
    plan.zones.find((zone) => zone.id === plan.globalBrief.focalZoneId),
    ...[...plan.zones]
      .filter((zone) => !zone.water && zone.role !== 'negative-space')
      .sort((left, right) => right.importance - left.importance)
  ].filter((zone): zone is SceneCompositionPlan['zones'][number] => Boolean(zone));
  const seen = new Set<string>();
  const regions = preferredZones.flatMap((zone) => {
    if (seen.has(zone.id)) return [];
    seen.add(zone.id);
    const fitted = fitRequiredRegion(map, sceneZoneWorldRegion(zone, map), footprint);
    return fitted ? [fitted] : [];
  });
  const bounds = getMapBounds(map);
  const mapRegion = fitRequiredRegion(map, {
    x: (bounds.minX + bounds.maxX) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
    r: Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2
  }, footprint);
  return mapRegion ? [...regions, mapRegion] : regions;
}

function fitRequiredRegion(
  map: EditableMap,
  region: { x: number; z: number; r: number },
  footprint: number
): { x: number; z: number; r: number } | null {
  const bounds = getMapBounds(map);
  const maximumRadius = Math.min(
    (bounds.maxX - bounds.minX) / 2 - footprint,
    (bounds.maxZ - bounds.minZ) / 2 - footprint
  );
  if (maximumRadius <= 0) return null;
  const r = Math.min(region.r, maximumRadius);
  return {
    x: clamp(region.x, bounds.minX + footprint + r, bounds.maxX - footprint - r),
    z: clamp(region.z, bounds.minZ + footprint + r, bounds.maxZ - footprint - r),
    r
  };
}

function terrainChangedCellCount(before: EditableMap, after: EditableMap): number {
  return after.terrain.heights.reduce((count, height, index) => (
    count + (Math.abs(height - (before.terrain.heights[index] ?? 0)) > 0.01 ? 1 : 0)
  ), 0);
}

function minimumTerrainCells(map: EditableMap): number {
  return Math.max(9, Math.round(map.terrain.heights.length * 0.005));
}

function hashSeed(seed: number, value: string): number {
  let result = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0;
  return result;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
