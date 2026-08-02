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
  compileZoneWater,
  type CompiledSceneComposition
} from './sceneCompositionCompiler';

export interface SceneOutcomeCheck {
  requirementId: string;
  kind: SceneIntentRequirement['kind'];
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
      const expectedId = requirement.targetZoneId ? `composition-water-${requirement.targetZoneId}` : null;
      const count = expectedId
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

  return {
    compiled: {
      operations,
      metrics: {
        ...compiled.metrics,
        objectCount: Math.max(0, candidate.objects.length - map.objects.length),
        waterCount: Math.max(0, candidate.waterBodies.length - map.waterBodies.length),
        terrainRelief: Math.max(...candidate.terrain.heights) - Math.min(...candidate.terrain.heights),
        terrainChangedCells: terrainChangedCellCount(map, candidate),
        familyCounts
      }
    },
    checks,
    repairCount
  };
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
  const zone = plan.zones.find((item) => item.id === requirement.targetZoneId)
    ?? plan.zones.find((item) => item.layers.some((layer) => layer.familyId === requirement.familyId))
    ?? plan.zones.find((item) => item.id === plan.globalBrief.focalZoneId);
  if (!zone) return [];
  const region = sceneZoneWorldRegion(zone, baseMap);
  const footprint = Math.max(...resolved.assets.map((asset) => asset.footprintRadius ?? 0.5));
  return expandMapScatter(candidate, {
    assetIds: resolved.assets.map((asset) => asset.id),
    region: { kind: 'circle', ...region },
    density: 0.04,
    avoidWater: 0.8,
    maxSlope: 34,
    minSpacing: Math.max(0.8, footprint * 1.5),
    scaleRange: [0.9, 1.1],
    seed: hashSeed(baseMap.seed, requirement.id),
    edgeFalloff: 0.15,
    clusterStrength: 0
  }, resolved.assets as MapAsset[], Math.min(missing, planLimits(getMapBounds(baseMap)).objectCount), `required-${requirement.id}`)
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
