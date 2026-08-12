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
  const safeMaximum = Math.max(0, Math.round(maximum));
  const safeMinimum = Math.min(safeMaximum, Math.max(0, Math.round(minimum)));
  const requiredFamilyIds = new Set(plan.intentRequirements.flatMap((requirement) => (
    requirement.kind === 'asset-family' && requirement.familyId ? [requirement.familyId] : []
  )));
  const selectedIds = new Set([...plan.assetFamilies]
    .sort((left, right) => (
      Number(requiredFamilyIds.has(right.id)) - Number(requiredFamilyIds.has(left.id))
      || right.priority - left.priority
    ))
    .slice(0, safeMaximum)
    .map((family) => family.id));
  const families = plan.assetFamilies
    .filter((family) => selectedIds.has(family.id))
    .map((family) => ({ ...family, desiredVariants: Math.max(1, family.desiredVariants) }));
  const trimmedPlan: SceneCompositionPlan = {
    ...plan,
    assetFamilies: families,
    zones: plan.zones.map((zone) => ({
      ...zone,
      layers: zone.layers.filter((layer) => selectedIds.has(layer.familyId))
    })),
    intentRequirements: plan.intentRequirements.filter((requirement) => (
      requirement.kind !== 'asset-family' || Boolean(requirement.familyId && selectedIds.has(requirement.familyId))
    ))
  };
  if (families.length === 0) return trimmedPlan;
  let total = families.reduce((sum, family) => sum + family.desiredVariants, 0);
  const byPriority = [...families].sort((left, right) => right.priority - left.priority);

  while (total < safeMinimum) {
    for (const family of byPriority) {
      if (total >= safeMinimum) break;
      family.desiredVariants += 1;
      total += 1;
    }
  }

  while (total > safeMaximum) {
    const family = [...families]
      .sort((left, right) => left.priority - right.priority)
      .find((item) => item.desiredVariants > 1);
    if (!family) break;
    family.desiredVariants -= 1;
    total -= 1;
  }

  return { ...trimmedPlan, assetFamilies: families };
}

export function resolveSceneFamilies(
  plan: SceneCompositionPlan,
  _map: EditableMap,
  assets: readonly MapAsset[],
  generationBudget: number,
  minimumGeneration = 0
): { families: ResolvedSceneFamily[]; gaps: SceneAssetGap[] } {
  const claimed = new Set<string>();
  const families = [...plan.assetFamilies]
    .sort((left, right) => right.priority - left.priority)
    .map((family): ResolvedSceneFamily => {
      const candidates = assets
        .filter((asset) => !claimed.has(asset.id) && matchesFamily(asset, family, familyZoneTags(plan, family.id)))
        .sort((left, right) => scoreAsset(right, family) - scoreAsset(left, family) || left.id.localeCompare(right.id));
      const selected = candidates.slice(0, family.desiredVariants);
      selected.forEach((asset) => claimed.add(asset.id));
      return {
        family,
        assets: selected,
        missingCount: Math.max(0, family.desiredVariants - selected.length)
      };
    });

  let missingTotal = families.reduce((sum, family) => sum + family.missingCount, 0);
  for (const resolved of [...families].sort((left, right) => left.family.priority - right.family.priority)) {
    while (missingTotal < minimumGeneration && resolved.assets.length > 0) {
      resolved.assets.pop();
      resolved.missingCount += 1;
      missingTotal += 1;
    }
  }

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

function matchesFamily(asset: MapAsset, family: SceneAssetFamily, zoneTags: ReadonlySet<string>): boolean {
  const tags = new Set([...(asset.tags ?? []), ...(asset.libraryMetadata?.tags ?? [])]);
  const identityMatch = family.identityTags.length === 0
    || family.identityTags.some((tag) => tags.has(tag));
  const tagMatch = identityMatch
    && (family.tags.length === 0 || family.tags.some((tag) => tags.has(tag)));
  const sizeMatch = !asset.sizeClass || asset.sizeClass === family.sizeClass;
  const applicableZones = asset.libraryMetadata?.applicableZones ?? ['any'];
  const zoneMatch = applicableZones.includes('any') || applicableZones.some((zone) => zoneTags.has(zone));
  return tagMatch && sizeMatch && zoneMatch;
}

function scoreAsset(asset: MapAsset, family: SceneAssetFamily): number {
  const tags = new Set([...(asset.tags ?? []), ...(asset.libraryMetadata?.tags ?? [])]);
  const matchingTags = family.tags.filter((tag) => tags.has(tag)).length;
  const matchingIdentityTags = family.identityTags.filter((tag) => tags.has(tag)).length;
  return (asset.libraryMetadata?.priority ?? 0.5) * 1_000
    + matchingIdentityTags * 100
    + matchingTags * 10
    + (asset.sizeClass === family.sizeClass ? 4 : 0)
    + Math.min(3, asset.updatedAt / 1e15);
}

function familyZoneTags(plan: SceneCompositionPlan, familyId: string): Set<string> {
  const result = new Set<string>();
  for (const zone of plan.zones.filter((item) => item.layers.some((layer) => layer.familyId === familyId))) {
    const text = `${zone.label} ${zone.brief.atmosphere} ${zone.brief.hierarchy}`.toLowerCase();
    if (zone.water) result.add('water');
    if (/forest|wood|grove|tree/.test(text)) result.add('forest');
    if (/grass|meadow|field|plain/.test(text)) result.add('grass');
    if (/rock|cliff|mountain|canyon/.test(text)) result.add('rocky');
    if (/village|town|city|settlement|camp|ruin/.test(text)) result.add('settlement');
    if (/dry|desert|dune|arid/.test(text)) result.add('dry');
    if (/lowland|valley|basin/.test(text)) result.add('lowland');
  }
  if (result.size === 0) result.add('any');
  return result;
}

function buildFamilyPrompt(family: SceneAssetFamily, artDirection: string, variantIndex: number): string {
  const foliage = /tree|forest|woodland|grove|foliage|leaf|树|林|叶/i.test(
    `${family.label} ${family.role} ${family.tags.join(' ')}`
  );
  return [
    family.generationBrief,
    artDirection ? `全局资产美术方向：${artDirection}` : '',
    `资产角色：${family.role}；目标尺度：${family.sizeClass}。`,
    family.desiredVariants > 1 ? `这是同一家族的第 ${variantIndex + 1} 个可辨识变体，轮廓应有变化但风格一致。` : '',
    foliage
      ? 'Keep foliage base colors clearly chromatic rather than gray, with enough brightness to remain readable after normal self-shadowing; do not use near-black leaf colors.'
      : '',
    '只生成一个可复用的独立物体，不要生成地面、背景、天空、完整场景或多个分散物体。'
  ].filter(Boolean).join('\n').slice(0, 900);
}
