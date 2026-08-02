import type { EditableMap } from './map';
import {
  normalizeSceneCompositionPlan,
  SCENE_COMPOSITION_LIMITS,
  type SceneCompositionPlan,
  type SceneDistribution,
  type SceneZoneGrassLayer,
  type SceneZoneLayer
} from './sceneComposition';

export interface SceneAdviceFinding {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export type ScenePlanPatch =
  | {
      type: 'zone.update';
      zoneId: string;
      center?: [number, number];
      radius?: number;
      importance?: number;
      brief?: Partial<SceneCompositionPlan['zones'][number]['brief']>;
      terrain?: Partial<SceneCompositionPlan['zones'][number]['terrain']>;
    }
  | {
      type: 'layer.update';
      zoneId: string;
      familyId: string;
      density?: number;
      scaleRange?: [number, number];
      distribution?: SceneDistribution;
      edgeFalloff?: number;
    }
  | { type: 'layer.add'; zoneId: string; layer: SceneZoneLayer }
  | { type: 'layer.remove'; zoneId: string; familyId: string }
  | {
      type: 'grass.update';
      zoneId: string;
      grassFamilyId: string;
      density?: number;
      variation?: number;
      edgeFalloff?: number;
      residualDensity?: number;
    }
  | { type: 'grass.add'; zoneId: string; layer: SceneZoneGrassLayer }
  | { type: 'grass.remove'; zoneId: string; grassFamilyId: string }
  | { type: 'water.update'; zoneId: string; level?: number; depth?: number }
  | { type: 'water.remove'; zoneId: string };

export interface ScenePlanAdvice {
  summary: string;
  findings: SceneAdviceFinding[];
  patches: ScenePlanPatch[];
}

export interface SceneReviewResult extends ScenePlanAdvice {
  status: 'pass' | 'revise';
}

export function normalizeScenePlanAdvice(
  value: unknown,
  plan: SceneCompositionPlan,
  map: EditableMap,
  maxPatches: number = SCENE_COMPOSITION_LIMITS.reviewPatchCount
): ScenePlanAdvice {
  const input = requireRecord(value, 'invalid_scene_advice');
  for (const forbidden of ['assetRequests', 'assetFamilies', 'operations', 'spawn', 'spawnPoints']) {
    if (input[forbidden] !== undefined) throw new Error('forbidden_scene_advice_capability');
  }
  return {
    summary: cleanText(input.summary, '', 240),
    findings: normalizeFindings(input.findings),
    patches: Array.isArray(input.patches)
      ? input.patches.slice(0, maxPatches).map((patch) => normalizePatch(patch, plan, map))
      : []
  };
}

export function normalizeSceneReview(
  value: unknown,
  plan: SceneCompositionPlan,
  map: EditableMap
): SceneReviewResult {
  const input = requireRecord(value, 'invalid_scene_review');
  const advice = normalizeScenePlanAdvice(
    input.status === 'revise' ? input : { ...input, patches: [] },
    plan,
    map
  );
  return {
    ...advice,
    status: input.status === 'revise' ? 'revise' : 'pass',
    patches: input.status === 'revise' ? advice.patches : []
  };
}

export function applySceneAdvice(
  plan: SceneCompositionPlan,
  advice: Pick<ScenePlanAdvice, 'patches'>,
  map: EditableMap
): SceneCompositionPlan {
  if (advice.patches.length === 0) return plan;
  const next = structuredClone(plan);
  for (const patch of advice.patches) {
    const zone = next.zones.find((item) => item.id === patch.zoneId);
    if (!zone) throw new Error('unknown_scene_advice_zone');
    switch (patch.type) {
      case 'zone.update':
        if (patch.center) zone.region.center = patch.center;
        if (patch.radius !== undefined) zone.region.radius = patch.radius;
        if (patch.importance !== undefined) zone.importance = patch.importance;
        if (patch.brief) Object.assign(zone.brief, patch.brief);
        if (patch.terrain) Object.assign(zone.terrain, patch.terrain);
        break;
      case 'layer.update': {
        const layer = zone.layers.find((item) => item.familyId === patch.familyId);
        if (!layer) throw new Error('unknown_scene_advice_layer');
        if (patch.density !== undefined) layer.density = patch.density;
        if (patch.scaleRange) layer.scaleRange = patch.scaleRange;
        if (patch.distribution) layer.distribution = patch.distribution;
        if (patch.edgeFalloff !== undefined) layer.edgeFalloff = patch.edgeFalloff;
        break;
      }
      case 'layer.add':
        zone.layers.push(patch.layer);
        break;
      case 'layer.remove':
        zone.layers = zone.layers.filter((item) => item.familyId !== patch.familyId);
        break;
      case 'grass.update': {
        const layer = zone.grassLayers.find((item) => item.grassFamilyId === patch.grassFamilyId);
        if (!layer) throw new Error('unknown_scene_advice_grass_layer');
        if (patch.density !== undefined) layer.density = patch.density;
        if (patch.variation !== undefined) layer.variation = patch.variation;
        if (patch.edgeFalloff !== undefined) layer.edgeFalloff = patch.edgeFalloff;
        if (patch.residualDensity !== undefined) layer.residualDensity = patch.residualDensity;
        break;
      }
      case 'grass.add':
        zone.grassLayers.push(patch.layer);
        break;
      case 'grass.remove':
        zone.grassLayers = zone.grassLayers.filter((item) => item.grassFamilyId !== patch.grassFamilyId);
        break;
      case 'water.update':
        if (!zone.water) throw new Error('unknown_scene_advice_water');
        if (patch.level !== undefined) zone.water.level = patch.level;
        if (patch.depth !== undefined) zone.water.depth = patch.depth;
        break;
      case 'water.remove':
        delete zone.water;
        break;
    }
  }
  return normalizeSceneCompositionPlan(next, map);
}

function normalizePatch(value: unknown, plan: SceneCompositionPlan, map: EditableMap): ScenePlanPatch {
  const input = requireRecord(value, 'invalid_scene_advice_patch');
  const zoneId = requireId(input.zoneId, 'invalid_scene_advice_patch');
  const zone = plan.zones.find((item) => item.id === zoneId);
  if (!zone) throw new Error('unknown_scene_advice_zone');
  if (input.type === 'zone.update') {
    const center = input.center === undefined ? undefined : requirePair(input.center, 'invalid_scene_advice_patch');
    const brief = input.brief === undefined ? undefined : normalizeBriefPatch(input.brief);
    const terrain = input.terrain === undefined ? undefined : normalizeTerrainPatch(input.terrain);
    return {
      type: 'zone.update',
      zoneId,
      ...(center ? { center: [clamp(center[0], -1, 1), clamp(center[1], -1, 1)] as [number, number] } : {}),
      ...(input.radius === undefined ? {} : { radius: clamp(finiteNumber(input.radius, 0.25), 0.05, 0.9) }),
      ...(input.importance === undefined ? {} : { importance: clamp(finiteNumber(input.importance, 0.5), 0, 1) }),
      ...(brief ? { brief } : {}),
      ...(terrain ? { terrain } : {})
    };
  }
  if (input.type === 'layer.add') {
    const layer = normalizeLayerPatch(input.layer, plan);
    if (zone.layers.some((item) => item.familyId === layer.familyId)) throw new Error('duplicate_scene_advice_layer');
    return { type: 'layer.add', zoneId, layer };
  }
  if (input.type === 'layer.update' || input.type === 'layer.remove') {
    const familyId = requireId(input.familyId, 'invalid_scene_advice_patch');
    if (!zone.layers.some((layer) => layer.familyId === familyId)) throw new Error('unknown_scene_advice_layer');
    if (input.type === 'layer.remove') return { type: 'layer.remove', zoneId, familyId };
    const scaleRange = input.scaleRange === undefined ? undefined : normalizeScaleRange(input.scaleRange);
    return {
      type: 'layer.update',
      zoneId,
      familyId,
      ...(input.density === undefined ? {} : { density: clamp(finiteNumber(input.density, 0.04), 0.0001, 1) }),
      ...(scaleRange ? { scaleRange } : {}),
      ...(isDistribution(input.distribution) ? { distribution: input.distribution } : {}),
      ...(input.edgeFalloff === undefined ? {} : { edgeFalloff: clamp(finiteNumber(input.edgeFalloff, 0.25), 0, 1) })
    };
  }
  if (input.type === 'grass.add') {
    const layer = normalizeGrassLayerPatch(input.layer, plan);
    if (zone.grassLayers.some((item) => item.grassFamilyId === layer.grassFamilyId)) {
      throw new Error('duplicate_scene_advice_grass_layer');
    }
    return { type: 'grass.add', zoneId, layer };
  }
  if (input.type === 'grass.update' || input.type === 'grass.remove') {
    const grassFamilyId = requireId(input.grassFamilyId, 'invalid_scene_advice_patch');
    if (!zone.grassLayers.some((layer) => layer.grassFamilyId === grassFamilyId)) {
      throw new Error('unknown_scene_advice_grass_layer');
    }
    if (input.type === 'grass.remove') return { type: 'grass.remove', zoneId, grassFamilyId };
    return {
      type: 'grass.update',
      zoneId,
      grassFamilyId,
      ...(input.density === undefined ? {} : { density: clamp(finiteNumber(input.density, 0.65), 0, 1) }),
      ...(input.variation === undefined ? {} : { variation: clamp(finiteNumber(input.variation, 0.2), 0, 1) }),
      ...(input.edgeFalloff === undefined ? {} : { edgeFalloff: clamp(finiteNumber(input.edgeFalloff, 0.25), 0, 1) }),
      ...(input.residualDensity === undefined ? {} : { residualDensity: clamp(finiteNumber(input.residualDensity, 0.08), 0, 1) })
    };
  }
  if (input.type === 'water.update') {
    if (!zone.water) throw new Error('unknown_scene_advice_water');
    return {
      type: 'water.update',
      zoneId,
      ...(input.level === undefined ? {} : { level: clamp(finiteNumber(input.level, 0.2), 0.02, map.box.size[1] - 0.05) }),
      ...(input.depth === undefined ? {} : { depth: clamp(finiteNumber(input.depth, 1.5), 0.1, 8) })
    };
  }
  if (input.type === 'water.remove') {
    if (!zone.water) throw new Error('unknown_scene_advice_water');
    if (plan.intentRequirements.some((requirement) => (
      requirement.kind === 'water' && requirement.targetZoneId === zoneId
    ))) throw new Error('required_scene_water_cannot_be_removed');
    return { type: 'water.remove', zoneId };
  }
  throw new Error('invalid_scene_advice_patch');
}

function normalizeLayerPatch(value: unknown, plan: SceneCompositionPlan): SceneZoneLayer {
  const input = requireRecord(value, 'invalid_scene_advice_layer');
  const familyId = requireId(input.familyId, 'invalid_scene_advice_layer');
  if (!plan.assetFamilies.some((family) => family.id === familyId)) throw new Error('unknown_scene_advice_family');
  return {
    familyId,
    density: clamp(finiteNumber(input.density, 0.04), 0.0001, 1),
    scaleRange: normalizeScaleRange(input.scaleRange ?? [0.9, 1.1]),
    distribution: isDistribution(input.distribution) ? input.distribution : 'even',
    edgeFalloff: clamp(finiteNumber(input.edgeFalloff, 0.25), 0, 1)
  };
}

function normalizeGrassLayerPatch(value: unknown, plan: SceneCompositionPlan): SceneZoneGrassLayer {
  const input = requireRecord(value, 'invalid_scene_advice_grass_layer');
  const grassFamilyId = requireId(input.grassFamilyId, 'invalid_scene_advice_grass_layer');
  if (!plan.grassFamilies.some((family) => family.id === grassFamilyId)) {
    throw new Error('unknown_scene_advice_grass_family');
  }
  return {
    grassFamilyId,
    density: clamp(finiteNumber(input.density, 0.65), 0, 1),
    variation: clamp(finiteNumber(input.variation, 0.2), 0, 1),
    edgeFalloff: clamp(finiteNumber(input.edgeFalloff, 0.25), 0, 1),
    residualDensity: clamp(finiteNumber(input.residualDensity, 0.08), 0, 1)
  };
}

function normalizeFindings(value: unknown): SceneAdviceFinding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((finding): SceneAdviceFinding => {
    const item = requireRecord(finding, 'invalid_scene_advice_finding');
    const severity = item.severity === 'error' || item.severity === 'warning' ? item.severity : 'info';
    return {
      code: cleanId(item.code) || 'composition.note',
      severity,
      message: cleanText(item.message, 'Scene composition note', 200)
    };
  });
}

function normalizeBriefPatch(value: unknown): Partial<SceneCompositionPlan['zones'][number]['brief']> {
  const input = requireRecord(value, 'invalid_scene_advice_brief');
  return {
    ...(input.atmosphere === undefined ? {} : { atmosphere: cleanText(input.atmosphere, '', 160) }),
    ...(input.hierarchy === undefined ? {} : { hierarchy: cleanText(input.hierarchy, '', 200) }),
    ...(input.openness === undefined ? {} : { openness: clamp(finiteNumber(input.openness, 0.5), 0, 1) }),
    ...(input.transitionIntent === undefined ? {} : { transitionIntent: cleanText(input.transitionIntent, '', 160) })
  };
}

function normalizeTerrainPatch(value: unknown): Partial<SceneCompositionPlan['zones'][number]['terrain']> {
  const input = requireRecord(value, 'invalid_scene_advice_terrain');
  return {
    ...(input.elevation === undefined ? {} : { elevation: clamp(finiteNumber(input.elevation, 0), -1, 1) }),
    ...(input.roughness === undefined ? {} : { roughness: clamp(finiteNumber(input.roughness, 0.5), 0, 1) }),
    ...(input.flatness === undefined ? {} : { flatness: clamp(finiteNumber(input.flatness, 0), 0, 1) })
  };
}

function normalizeScaleRange(value: unknown): [number, number] {
  const pair = requirePair(value, 'invalid_scene_advice_scale');
  return [
    clamp(Math.min(pair[0], pair[1]), 0.1, 8),
    clamp(Math.max(pair[0], pair[1]), 0.1, 8)
  ];
}

function isDistribution(value: unknown): value is SceneDistribution {
  return value === 'even' || value === 'clustered' || value === 'accent';
}

function requireRecord(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function requirePair(value: unknown, error: string): [number, number] {
  if (!Array.isArray(value) || value.length < 2) throw new Error(error);
  const left = Number(value[0]);
  const right = Number(value[1]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error(error);
  return [left, right];
}

function requireId(value: unknown, error: string): string {
  const id = cleanId(value);
  if (!id) throw new Error(error);
  return id;
}

function cleanId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 64)
    : '';
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
