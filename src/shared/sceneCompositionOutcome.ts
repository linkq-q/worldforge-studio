import {
  getMapBounds,
  type EditableMap,
  type MapAsset
} from './map';
import { applyMapOperations, type MapOperation } from './mapOperations';
import { expandMapScatter } from './mapScatter';
import { planLimits } from './mapPlanning';
import {
  sceneZoneWorldRegion,
  type SceneCompositionPlan,
  type SceneIntentRequirement
} from './sceneComposition';
import type { ResolvedSceneFamily } from './sceneCompositionAssets';
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
  kind: SceneIntentRequirement['kind'] | 'population';
  status: 'pass' | 'repaired';
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
        if (repairs.length === 0) throw new Error(`scene_outcome_missing_water:${requirement.id}`);
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
    if (repairs.length === 0) throw new Error(`scene_outcome_missing_asset_family:${requirement.id}`);
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
      && isRepeatableNaturalFamily(entry.resolved.family)
      && (entry.layer.distribution !== 'accent' || isPopulationZone(entry.zone))
    ))
    .sort((left, right) => (
      Number(left.layer.distribution === 'accent') - Number(right.layer.distribution === 'accent')
      || right.zone.importance - left.zone.importance
      || right.resolved.family.priority - left.resolved.family.priority
    ));
  if (entries.length === 0) return { target: 0, operations: [], familyCounts: {}, zoneCounts: {} };

  const limits = planLimits(getMapBounds(baseMap));
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

function isRepeatableNaturalFamily(family: ResolvedSceneFamily['family']): boolean {
  return /tree|forest|wood|pine|oak|bush|shrub|fern|vegetation|plant|foliage|rock|stone|flower|grass|树|林|灌|蕨|植|岩|石|花|草/i
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
  const footprint = Math.max(...resolved.assets.map((asset) => asset.footprintRadius ?? 0.5)) * 1.1;
  const regions = requiredPlacementRegions(baseMap, plan, requirement, footprint);
  const operations: MapOperation[] = [];
  let workingMap = candidate;
  let remaining = Math.min(missing, planLimits(getMapBounds(baseMap)).objectCount);

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
