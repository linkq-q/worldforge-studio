import type { EditableMap, MapAsset } from './map';
import type { SceneAssetFamily, SceneCompositionPlan } from './sceneComposition';

export interface ResolvedSceneFamily {
  family: SceneAssetFamily;
  assets: MapAsset[];
  missingCount: number;
}

export interface SceneAssetGap {
  familyId: string;
  name: string;
  prompt: string;
  tags: string[];
}

export function fitSceneAssetVariantBudget(
  plan: SceneCompositionPlan,
  minimum: number,
  maximum: number
): SceneCompositionPlan {
  if (plan.assetFamilies.length === 0) return plan;
  if (plan.assetFamilies.length > maximum) throw new Error('scene_asset_family_count_above_max');

  const families = plan.assetFamilies.map((family) => ({ ...family }));
  let total = families.reduce((sum, family) => sum + family.desiredVariants, 0);
  const byPriority = [...families].sort((left, right) => right.priority - left.priority);

  while (total < minimum) {
    let changed = false;
    for (const family of byPriority) {
      if (family.desiredVariants >= 3 || total >= minimum) continue;
      family.desiredVariants += 1;
      total += 1;
      changed = true;
    }
    if (!changed) throw new Error('scene_asset_variant_count_below_min');
  }

  while (total > maximum) {
    const family = [...families]
      .sort((left, right) => left.priority - right.priority)
      .find((item) => item.desiredVariants > 1);
    if (!family) throw new Error('scene_asset_variant_count_above_max');
    family.desiredVariants -= 1;
    total -= 1;
  }

  return { ...plan, assetFamilies: families };
}

export function resolveSceneFamilies(
  plan: SceneCompositionPlan,
  map: EditableMap,
  assets: readonly MapAsset[],
  generationBudget: number
): { families: ResolvedSceneFamily[]; gaps: SceneAssetGap[] } {
  const claimed = new Set<string>();
  const families = [...plan.assetFamilies]
    .sort((left, right) => right.priority - left.priority)
    .map((family): ResolvedSceneFamily => {
      const candidates = assets
        .filter((asset) => !claimed.has(asset.id) && matchesFamily(asset, family))
        .sort((left, right) => scoreAsset(right, family) - scoreAsset(left, family) || left.id.localeCompare(right.id));
      const selected = candidates.slice(0, family.desiredVariants);
      selected.forEach((asset) => claimed.add(asset.id));
      return {
        family,
        assets: selected,
        missingCount: Math.max(0, family.desiredVariants - selected.length)
      };
    });

  const gaps: SceneAssetGap[] = [];
  for (const resolved of families) {
    for (let index = 0; index < resolved.missingCount && gaps.length < generationBudget; index += 1) {
      gaps.push({
        familyId: resolved.family.id,
        name: resolved.family.desiredVariants > 1
          ? `${resolved.family.label} ${resolved.assets.length + index + 1}`
          : resolved.family.label,
        prompt: buildFamilyPrompt(resolved.family, plan.globalBrief.assetArtDirection, index),
        tags: resolved.family.tags
      });
    }
  }
  return { families, gaps };
}

export function attachGeneratedSceneAssets(
  families: ResolvedSceneFamily[],
  generated: ReadonlyArray<{ familyId: string; asset: MapAsset }>
): ResolvedSceneFamily[] {
  return families.map((resolved) => ({
    ...resolved,
    assets: [
      ...resolved.assets,
      ...generated.filter((entry) => entry.familyId === resolved.family.id).map((entry) => entry.asset)
    ],
    missingCount: Math.max(
      0,
      resolved.family.desiredVariants
        - resolved.assets.length
        - generated.filter((entry) => entry.familyId === resolved.family.id).length
    )
  }));
}

function matchesFamily(asset: MapAsset, family: SceneAssetFamily): boolean {
  const tags = new Set(asset.tags ?? []);
  const tagMatch = family.tags.length === 0 || family.tags.some((tag) => tags.has(tag));
  const sizeMatch = !asset.sizeClass || asset.sizeClass === family.sizeClass;
  return tagMatch && sizeMatch;
}

function scoreAsset(asset: MapAsset, family: SceneAssetFamily): number {
  const tags = new Set(asset.tags ?? []);
  const matchingTags = family.tags.filter((tag) => tags.has(tag)).length;
  return matchingTags * 10 + (asset.sizeClass === family.sizeClass ? 4 : 0);
}

function buildFamilyPrompt(family: SceneAssetFamily, artDirection: string, variantIndex: number): string {
  return [
    family.generationBrief,
    artDirection ? `全局资产美术方向：${artDirection}` : '',
    `资产角色：${family.role}；目标尺度：${family.sizeClass}。`,
    family.desiredVariants > 1 ? `这是同一家族的第 ${variantIndex + 1} 个可辨识变体，轮廓应有变化但风格一致。` : '',
    '只生成一个可复用的独立物体，不要生成地面、背景、天空、完整场景或多个分散物体。'
  ].filter(Boolean).join('\n').slice(0, 900);
}
