import {
  applyMapOperations,
  type MapAiSuggestion,
  type MapOperation
} from '../shared/mapOperations';
import {
  createId,
  DEFAULT_WATER_DEPTH,
  getMapBounds,
  MAX_WATER_DEPTH,
  normalizeMap,
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset,
  type TerrainBrushMode
} from '../shared/map';
import {
  CHAT_PROVIDER_OPTIONS,
  type AgentProgressEvent,
  type ChatProvider,
  type Vec3
} from '../shared/protocol';
import {
  normalizeMapAiMaxNewAssets,
  planLimits,
  type MapPlanLimits
} from '../shared/mapPlanning';
import {
  expandMapScatter,
  type MapScatterPlan
} from '../shared/mapScatter';
import {
  normalizeTerrainGenerationParams,
  normalizeTerrainModifierParams,
  normalizeTerrainSurfaceParams,
  terrainCapabilitySummary
} from '../shared/terrainGeneration';
import { findSafeSpawnPosition } from '../shared/mapSpawnSafety';
import { normalizeAssetTags } from '../shared/mapAssetMetadata';
import { validateMapSuggestion } from './mapSuggestionValidation';
import { llmChat } from './modelApi';
import {
  normalizeModelGenerationMode,
  type ModelGenerationMode
} from '../shared/modelGenerationMode';
import { runMapCompositionWorkflow } from './mapCompositionWorkflow';
import { completeMapVisualSemantics } from '../shared/mapVisualSemantics';
import { patchMapVisualZone, type VisualZonePatch } from '../shared/mapVisualSemantics';
import { VISUAL_ZONE_TAGS, normalizeMapVisualSemantics, type VisualZoneTag } from '../shared/visualDirection';

export interface MapAiOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
  reuseExistingAssets?: boolean;
  reusableAssetIds?: readonly string[];
  maxNewAssets?: number;
  /** Optional persisted visual-zone ID used to bound a refine pass. */
  targetVisualZoneId?: string;
}

export interface AssetGenerationRequest {
  name: string;
  prompt: string;
  tags: string[];
  mode: ModelGenerationMode;
}

export interface MapAgentOptions extends MapAiOptions {
  createAsset: (request: AssetGenerationRequest) => Promise<MapAsset>;
  mode?: 'generate' | 'refine';
}

export async function generateMapSuggestion(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapAiOptions = {}
): Promise<MapAiSuggestion> {
  const content = await requestMapPlan(prompt, map, assets, options, false, 'generate');
  return normalizeMapSuggestion(content, map, assets, 'generate');
}

export async function runMapAgent(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapAgentOptions
): Promise<MapAiSuggestion> {
  const mode = options.mode ?? 'generate';
  if (mode === 'generate') {
    const result = await runMapCompositionWorkflow(prompt, map, assets, options);
    const validated = finalizeMapAgentSuggestion(map, result.assets, result.suggestion, options);
    options.onProgress?.({ phase: 'complete', label: '场景构图、合成审查与地图预览已完成' });
    return validated;
  }
  options.onProgress?.({ phase: 'planning', label: mode === 'refine' ? '理解地图调整要求' : '规划地图内容' });
  const firstContent = await requestMapPlan(prompt, map, assets, options, false, mode);
  const maxNewAssets = normalizeMapAiMaxNewAssets(options.maxNewAssets);
  const requests = normalizeAssetRequests(
    parseJsonObject(firstContent).assetRequests,
    maxNewAssets,
    map.assetGenerationMode
  );
  options.onProgress?.({
    phase: 'checking-assets',
    label: requests.length > 0 ? `发现 ${requests.length} 个缺失资产` : '现有资产可以完成规划',
    current: 0,
    total: requests.length
  });
  if (requests.length === 0) {
    const firstSuggestion = normalizeMapSuggestion(firstContent, map, assets, mode, options.targetVisualZoneId);
    assertNoForbiddenAssetReuse(firstSuggestion, new Set(), options);
    if (hasSpatialOperations(firstSuggestion)) {
      const validated = finalizeMapAgentSuggestion(map, assets, firstSuggestion, options);
      options.onProgress?.({ phase: 'complete', label: '地图修改方案已完成' });
      return validated;
    }
    options.onProgress?.({ phase: 'replanning', label: '补充空间操作' });
    const retryContent = await requestMapPlan(prompt, map, assets, options, true, mode);
    const retrySuggestion = normalizeMapSuggestion(retryContent, map, assets, mode, options.targetVisualZoneId);
    assertNoForbiddenAssetReuse(retrySuggestion, new Set(), options);
    if (!hasSpatialOperations(retrySuggestion)) throw new Error('map_agent_no_spatial_plan');
    const validated = finalizeMapAgentSuggestion(map, assets, retrySuggestion, options);
    options.onProgress?.({ phase: 'complete', label: '地图修改方案已完成' });
    return validated;
  }

  const generatedAssets: MapAsset[] = [];
  for (const [index, request] of requests.entries()) {
    options.signal?.throwIfAborted();
    options.onProgress?.({
      phase: 'generating-asset',
      label: `生成资产 ${index + 1}/${requests.length}：${request.name}`,
      current: index + 1,
      total: requests.length
    });
    generatedAssets.push(await options.createAsset(request));
  }

  const expandedAssets = [...assets, ...generatedAssets];
  const generatedAssetIds = new Set(generatedAssets.map((asset) => asset.id));
  options.onProgress?.({ phase: 'replanning', label: '使用新资产重新规划地图' });
  const finalContent = await requestMapPlan(prompt, map, expandedAssets, options, true, mode, generatedAssetIds);
  if (normalizeAssetRequests(
    parseJsonObject(finalContent).assetRequests,
    maxNewAssets,
    map.assetGenerationMode
  ).length > 0) {
    throw new Error('map_agent_asset_limit');
  }
  const suggestion = {
    ...normalizeMapSuggestion(finalContent, map, expandedAssets, mode, options.targetVisualZoneId),
    generatedAssets: generatedAssets.map((asset) => ({ id: asset.id, name: asset.name }))
  };
  assertNoForbiddenAssetReuse(suggestion, generatedAssetIds, options);
  if (!hasSpatialOperations(suggestion)) throw new Error('map_agent_no_spatial_plan');
  const validated = finalizeMapAgentSuggestion(map, expandedAssets, suggestion, options);
  options.onProgress?.({ phase: 'complete', label: '地图修改方案已完成' });
  return validated;
}

function finalizeMapAgentSuggestion(
  map: EditableMap,
  assets: readonly MapAsset[],
  suggestion: MapAiSuggestion,
  options: MapAiOptions
): MapAiSuggestion {
  options.onProgress?.({ phase: 'validating', label: '检查出生点、贴地、水体与物体重叠' });
  const validated = validateMapSuggestion(normalizeMap({ ...map, assets: [...assets] }), suggestion);
  validated.suggestion.reusedAssets = collectReusedAssets(validated.suggestion, assets, options);
  if (validated.repairCount > 0) {
    options.onProgress?.({
      phase: 'repairing',
      label: `自动修复 ${validated.repairCount} 项确定性问题`,
      current: validated.repairCount,
      total: validated.repairCount,
      detail: validated.issues.filter((issue) => issue.repaired).map((issue) => issue.code).join(', ')
    });
  }
  const preview = applyMapOperations(
    normalizeMap({ ...map, assets: [...assets] }),
    validated.suggestion.operations
  );
  const visualSemantics = completeMapVisualSemantics(preview);
  if (JSON.stringify(visualSemantics) === JSON.stringify(preview.visualSemantics)) return validated.suggestion;
  return {
    ...validated.suggestion,
    operations: [...validated.suggestion.operations, { type: 'map.update', visualSemantics }]
  };
}

async function requestMapPlan(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapAiOptions,
  finalPass: boolean,
  mode: 'generate' | 'refine',
  generatedAssetIds: ReadonlySet<string> = new Set()
): Promise<string> {
  const cleanPrompt = prompt.trim().slice(0, 1200);
  if (!cleanPrompt) throw new Error('missing_prompt');
  const provider = options.provider ?? 'gpt';
  const providerOption = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
  if (!providerOption || providerOption.disabled) throw new Error('provider_unavailable');
  const content = await llmChat([
    { role: 'system', content: buildSystemPrompt(map, assets, finalPass, mode, options, generatedAssetIds) },
    { role: 'user', content: cleanPrompt }
  ], {
    apiBase: options.apiBase,
    provider,
    temperature: 0.2,
    maxTokens: 4096,
    fetchImpl: options.fetchImpl,
    signal: options.signal
  });
  return content;
}

export function normalizeMapSuggestion(
  content: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  mode: 'generate' | 'refine' = 'generate',
  targetVisualZoneId?: string
): MapAiSuggestion {
  const input = parseJsonObject(content);

  const bounds = getMapBounds(map);
  const limits = planLimits(bounds);
  const renderPromptSuggestions = normalizeTextList(input.renderPromptSuggestions, 8, 80);
  const operations: MapOperation[] = renderPromptSuggestions.length > 0
    ? [{ type: 'map.update', renderPromptSuggestions }]
    : [];
  operations.push(...normalizeVisualZoneUpdateOperations(input.visualZoneUpdates, map, targetVisualZoneId));
  if (input.terrainGeneration !== undefined && input.terrainGeneration !== null) {
    operations.push({
      type: 'terrain.generate',
      ...normalizeTerrainGenerationParams(input.terrainGeneration, map)
    });
  }
  const terrainOperations = normalizeTerrainOperations(input.terrain, bounds, limits);
  operations.push(...terrainOperations);
  operations.push(...normalizeTerrainModifierOperations(input.terrainModifiers, map, limits));
  operations.push(...normalizeTerrainSurfaceOperations(input.terrainSurfaces, map));
  const waterRefineOperations = mode === 'refine'
    ? normalizeWaterRefineOperations(input.waterUpdates, input.waterRemovals, map, bounds)
    : [];
  operations.push(...waterRefineOperations);
  const waterOperations = normalizeWaterOperations(input.waters, bounds, limits);
  operations.push(...waterOperations);
  const earlyOperations = operations.filter((operation) => (
    operation.type === 'terrain.generate'
    || operation.type === 'terrain.brush'
    || operation.type === 'terrain.modify'
    || operation.type === 'terrain.surface'
    || operation.type === 'water.update'
    || operation.type === 'water.remove'
    || operation.type === 'water.add'
  ));
  const spatialPreview = earlyOperations.length > 0
    ? applyMapOperations({ ...map, assets: [...assets] }, earlyOperations)
    : normalizeMap({ ...map, assets: [...assets] });
  const objectRefineOperations = mode === 'refine'
    ? normalizeObjectRefineOperations(input.objectUpdates, input.objectRemovals, spatialPreview)
    : [];
  operations.push(...objectRefineOperations);
  const refinedPreview = objectRefineOperations.length > 0
    ? applyMapOperations(spatialPreview, objectRefineOperations)
    : spatialPreview;
  const objectOperations = normalizeObjectOperations(input.objects, refinedPreview, assets, limits.objectCount);
  operations.push(...objectOperations);
  const scatterPreview = objectOperations.length > 0
    ? applyMapOperations(refinedPreview, objectOperations)
    : refinedPreview;
  const scatterOperations = normalizeScatterOperations(
    input.scatters ?? input.scatter,
    scatterPreview,
    assets,
    Math.max(0, limits.objectCount - objectOperations.length)
  );
  operations.push(...scatterOperations);
  const populatedPreview = scatterOperations.length > 0
    ? applyMapOperations(scatterPreview, scatterOperations)
    : scatterPreview;
  const spawnOperation = normalizeSpawnOperation(input.spawn, populatedPreview);
  if (spawnOperation) operations.push(spawnOperation);
  const scopedOperations = targetVisualZoneId
    ? scopeMapOperationsToVisualZone(operations, map, targetVisualZoneId)
    : operations;
  if (scopedOperations.length === 0) throw new Error('empty_map_suggestion');

  applyMapOperations(map, scopedOperations);
  return {
    summary: cleanText(input.summary, 'AI 地图建议', 200),
    operations: scopedOperations,
    renderPromptSuggestions,
    generatedAssets: []
  };
}

function assertNoForbiddenAssetReuse(
  suggestion: MapAiSuggestion,
  generatedAssetIds: ReadonlySet<string>,
  options: Pick<MapAiOptions, 'reuseExistingAssets' | 'reusableAssetIds'>
): void {
  const explicit = options.reusableAssetIds ? new Set(options.reusableAssetIds) : null;
  if (options.reuseExistingAssets && !explicit) return;
  const reused = suggestion.operations.find((operation) => (
    operation.type === 'object.add'
    && Boolean(operation.object.assetId)
    && !generatedAssetIds.has(operation.object.assetId as string)
    && !(explicit?.has(operation.object.assetId as string) ?? false)
  ));
  if (reused) throw new Error('map_agent_existing_asset_reuse_disabled');
}

function collectReusedAssets(
  suggestion: MapAiSuggestion,
  assets: readonly MapAsset[],
  options: Pick<MapAiOptions, 'reusableAssetIds'>
): Array<{ id: string; name: string; libraryId: string }> {
  const allowed = new Set(options.reusableAssetIds ?? []);
  if (allowed.size === 0) return [];
  const used = new Set(suggestion.operations
    .filter((operation) => operation.type === 'object.add' && operation.object.assetId)
    .map((operation) => operation.type === 'object.add' ? operation.object.assetId as string : ''));
  return assets
    .filter((asset) => allowed.has(asset.id) && used.has(asset.id) && asset.libraryId)
    .map((asset) => ({ id: asset.id, name: asset.name, libraryId: asset.libraryId as string }));
}

function normalizeVisualZoneUpdateOperations(
  value: unknown,
  map: EditableMap,
  targetVisualZoneId?: string
): MapOperation[] {
  if (!Array.isArray(value)) return [];
  let semantics = map.visualSemantics;
  for (const item of value.slice(0, 16)) {
    if (!item || typeof item !== 'object') throw new Error('invalid_visual_zone_update');
    const input = item as Record<string, unknown>;
    const zoneId = typeof input.zoneId === 'string' ? input.zoneId.trim() : '';
    if (!zoneId || (targetVisualZoneId && zoneId !== targetVisualZoneId)) continue;
    const patch: VisualZonePatch = {};
    if (Array.isArray(input.center) && input.center.length >= 2) {
      patch.center = [
        requiredNumber(input.center[0], 'invalid_visual_zone_update'),
        requiredNumber(input.center[1], 'invalid_visual_zone_update')
      ];
    }
    if (input.radius !== undefined) patch.radius = requiredNumber(input.radius, 'invalid_visual_zone_update');
    if (input.intensity !== undefined) patch.intensity = requiredNumber(input.intensity, 'invalid_visual_zone_update');
    if (Array.isArray(input.tags)) {
      patch.tags = input.tags.filter((tag): tag is VisualZoneTag => (
        typeof tag === 'string'
        && VISUAL_ZONE_TAGS.includes(tag as VisualZoneTag)
      ));
    }
    semantics = normalizeMapVisualSemantics(patchMapVisualZone(semantics, zoneId, patch));
  }
  return JSON.stringify(semantics) === JSON.stringify(map.visualSemantics)
    ? []
    : [{ type: 'map.update', visualSemantics: semantics }];
}

function scopeMapOperationsToVisualZone(
  operations: readonly MapOperation[],
  map: EditableMap,
  zoneId: string
): MapOperation[] {
  const zone = map.visualSemantics.zones.find((item) => item.id === zoneId);
  if (!zone) throw new Error('unknown_visual_zone');
  const contains = (x: number, z: number) => Math.hypot(x - zone.center[0], z - zone.center[1]) <= zone.radius;
  const objectInside = (objectId: string, nextPosition?: Vec3) => {
    const object = map.objects.find((item) => item.id === objectId);
    const current = object?.transform.position;
    return Boolean(
      current
      && contains(current[0], current[2])
      && (!nextPosition || contains(nextPosition[0], nextPosition[2]))
    );
  };
  const waterInside = (waterId: string) => {
    const water = map.waterBodies.find((item) => item.id === waterId);
    if (!water || water.points.length === 0) return false;
    const x = water.points.reduce((sum, point) => sum + point[0], 0) / water.points.length;
    const z = water.points.reduce((sum, point) => sum + point[1], 0) / water.points.length;
    return contains(x, z);
  };
  const regionInside = (region: Extract<MapOperation, { type: 'terrain.modify' | 'terrain.surface' }>['region']) => {
    if (region.kind === 'circle') return contains(region.x, region.z);
    if (region.points.length === 0) return false;
    const x = region.points.reduce((sum, point) => sum + point[0], 0) / region.points.length;
    const z = region.points.reduce((sum, point) => sum + point[1], 0) / region.points.length;
    return contains(x, z);
  };
  return operations.filter((operation) => {
    switch (operation.type) {
      case 'map.update': return true;
      case 'terrain.brush': return contains(operation.point[0], operation.point[2]);
      case 'terrain.modify': return regionInside(operation.region);
      case 'terrain.surface': return regionInside(operation.region);
      case 'paint.add': return contains(operation.stroke.point[0], operation.stroke.point[2]);
      case 'object.add': return contains(operation.object.transform?.position?.[0] ?? 0, operation.object.transform?.position?.[2] ?? 0);
      case 'object.update': return objectInside(operation.objectId, operation.patch.transform?.position);
      case 'object.remove': return objectInside(operation.objectId);
      case 'water.add': {
        const points = operation.water.points ?? [];
        if (points.length === 0) return false;
        const x = points.reduce((sum, point) => sum + point[0], 0) / points.length;
        const z = points.reduce((sum, point) => sum + point[1], 0) / points.length;
        return contains(x, z);
      }
      case 'water.update':
      case 'water.remove': return waterInside(operation.waterId);
      case 'reference.set': return contains(operation.point[0], operation.point[2]);
      case 'terrain.generate':
      case 'terrain.set':
      case 'grass.layer.add':
      case 'grass.layer.update':
      case 'grass.layer.remove':
      case 'grass.fill':
      case 'grass.brush':
      case 'grass.generate':
      case 'sun.set': return false;
    }
  });
}

function normalizeObjectRefineOperations(
  updatesValue: unknown,
  removalsValue: unknown,
  map: EditableMap
): MapOperation[] {
  const operations: MapOperation[] = [];
  const bounds = getMapBounds(map);
  const objectsById = new Map(map.objects.map((object) => [object.id, object]));
  if (Array.isArray(removalsValue)) {
    const removed = new Set<string>();
    for (const item of removalsValue.slice(0, 64)) {
      if (!item || typeof item !== 'object') throw new Error('invalid_object_refine_plan');
      const input = item as Record<string, unknown>;
      const explicitIds = Array.isArray(input.objectIds)
        ? input.objectIds.filter((id): id is string => typeof id === 'string')
        : [];
      const assetId = typeof input.assetId === 'string' ? input.assetId : '';
      const candidates = (explicitIds.length > 0
        ? explicitIds
            .map((id) => objectsById.get(id))
            .filter((object): object is EditableMap['objects'][number] => Boolean(object))
        : map.objects.filter((object) => assetId && object.assetId === assetId))
        .filter((object) => !removed.has(object.id))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (candidates.length === 0) throw new Error('unknown_object_refine_target');
      const count = Math.min(candidates.length, Math.max(1, Math.floor(optionalNumber(input.count, explicitIds.length || 1))));
      const selected = selectDeterministic(candidates, count, optionalNumber(input.seed, 1));
      for (const object of selected) {
        removed.add(object.id);
        operations.push({ type: 'object.remove', objectId: object.id });
      }
    }
  }
  if (Array.isArray(updatesValue)) {
    for (const item of updatesValue.slice(0, 64)) {
      if (!item || typeof item !== 'object') throw new Error('invalid_object_refine_plan');
      const input = item as Record<string, unknown>;
      const objectId = typeof input.objectId === 'string' ? input.objectId : '';
      const object = objectsById.get(objectId);
      if (!object || operations.some((operation) => operation.type === 'object.remove' && operation.objectId === objectId)) {
        throw new Error('unknown_object_refine_target');
      }
      const position = [...object.transform.position] as Vec3;
      if (input.x !== undefined) position[0] = clamp(requiredNumber(input.x, 'invalid_object_refine_plan'), bounds.minX, bounds.maxX);
      if (input.z !== undefined) position[2] = clamp(requiredNumber(input.z, 'invalid_object_refine_plan'), bounds.minZ, bounds.maxZ);
      position[1] = sampleTerrainHeight(map, position[0], position[2]);
      const scaleValue = input.scale === undefined
        ? object.transform.scale[0]
        : clamp(requiredNumber(input.scale, 'invalid_object_refine_plan'), 0.1, 8);
      const rotationY = input.rotationYDeg === undefined
        ? object.transform.rotation[1]
        : requiredNumber(input.rotationYDeg, 'invalid_object_refine_plan') * Math.PI / 180;
      operations.push({
        type: 'object.update',
        objectId,
        patch: {
          transform: {
            position,
            rotation: [object.transform.rotation[0], rotationY, object.transform.rotation[2]],
            scale: [scaleValue, scaleValue, scaleValue]
          }
        }
      });
    }
  }
  return operations;
}

function normalizeWaterRefineOperations(
  updatesValue: unknown,
  removalsValue: unknown,
  map: EditableMap,
  bounds: ReturnType<typeof getMapBounds>
): MapOperation[] {
  const operations: MapOperation[] = [];
  const watersById = new Map(map.waterBodies.map((water) => [water.id, water]));
  const removed = new Set<string>();
  if (Array.isArray(removalsValue)) {
    for (const waterId of removalsValue.slice(0, 32)) {
      if (typeof waterId !== 'string' || !watersById.has(waterId) || removed.has(waterId)) {
        throw new Error('unknown_water_refine_target');
      }
      removed.add(waterId);
      operations.push({ type: 'water.remove', waterId });
    }
  }
  if (Array.isArray(updatesValue)) {
    for (const item of updatesValue.slice(0, 32)) {
      if (!item || typeof item !== 'object') throw new Error('invalid_water_refine_plan');
      const input = item as Record<string, unknown>;
      const waterId = typeof input.waterId === 'string' ? input.waterId : '';
      const water = watersById.get(waterId);
      if (!water || removed.has(waterId)) throw new Error('unknown_water_refine_target');
      const patch: { level?: number; depth?: number; width?: number } = {};
      if (input.level !== undefined) patch.level = clamp(requiredNumber(input.level, 'invalid_water_refine_plan'), 0.02, bounds.maxY - 0.05);
      if (input.depth !== undefined) patch.depth = clamp(requiredNumber(input.depth, 'invalid_water_refine_plan'), 0.1, MAX_WATER_DEPTH);
      if (input.width !== undefined) {
        patch.width = clamp(
          requiredNumber(input.width, 'invalid_water_refine_plan'),
          0.3,
          Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2
        );
      }
      if (Object.keys(patch).length > 0) operations.push({ type: 'water.update', waterId, patch });
    }
  }
  return operations;
}

function normalizeWaterOperations(
  value: unknown,
  bounds: ReturnType<typeof getMapBounds>,
  limits: MapPlanLimits
): MapOperation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limits.waterCount).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid_water_plan');
    const input = item as Record<string, unknown>;
    const type = input.type;
    if (type !== 'lake' && type !== 'river') throw new Error('invalid_water_plan');
    if (!Array.isArray(input.points)) throw new Error('invalid_water_plan');
    const points = input.points.slice(0, 64).map((raw): [number, number] => {
      if (!raw || typeof raw !== 'object') throw new Error('invalid_water_plan');
      if (Array.isArray(raw)) {
        return [
          clamp(requiredNumber(raw[0], 'invalid_water_plan'), bounds.minX, bounds.maxX),
          clamp(requiredNumber(raw[1], 'invalid_water_plan'), bounds.minZ, bounds.maxZ)
        ];
      }
      const point = raw as Record<string, unknown>;
      return [
        clamp(requiredNumber(point.x, 'invalid_water_plan'), bounds.minX, bounds.maxX),
        clamp(requiredNumber(point.z, 'invalid_water_plan'), bounds.minZ, bounds.maxZ)
      ];
    });
    if (points.length < (type === 'lake' ? 3 : 2)) throw new Error('invalid_water_plan');
    return {
      type: 'water.add',
      water: {
        id: createId('water'),
        name: cleanText(input.name, type === 'lake' ? '湖泊' : '河流', 48),
        type,
        level: clamp(optionalNumber(input.level, 0.2), 0.02, bounds.maxY - 0.05),
        depth: clamp(optionalNumber(input.depth, DEFAULT_WATER_DEPTH), 0.1, MAX_WATER_DEPTH),
        width: clamp(optionalNumber(input.width, 1.2), 0.3, Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2),
        points
      }
    };
  });
}

function normalizeTerrainOperations(
  value: unknown,
  bounds: ReturnType<typeof getMapBounds>,
  limits: MapPlanLimits
): MapOperation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limits.terrainBrushCount).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid_terrain_plan');
    const input = item as Record<string, unknown>;
    const mode = input.mode;
    if (mode !== 'raise' && mode !== 'lower' && mode !== 'flatten') throw new Error('invalid_terrain_plan');
    const x = requiredNumber(input.x, 'invalid_terrain_plan');
    const z = requiredNumber(input.z, 'invalid_terrain_plan');
    const operation: MapOperation = {
      type: 'terrain.brush',
      mode: mode as TerrainBrushMode,
      point: [
        clamp(x, bounds.minX, bounds.maxX),
        clamp(optionalNumber(input.targetHeight, 0), bounds.minY, bounds.maxY - 0.1),
        clamp(z, bounds.minZ, bounds.maxZ)
      ],
      size: clamp(optionalNumber(input.size, 2), 0.3, limits.brushRadiusMax),
      strength: clamp(optionalNumber(input.strength, 0.4), 0.02, 1.5)
    };
    if (mode === 'flatten') {
      operation.targetHeight = clamp(optionalNumber(input.targetHeight, 0), 0, bounds.maxY - 0.1);
    }
    return operation;
  });
}

function normalizeTerrainModifierOperations(
  value: unknown,
  map: EditableMap,
  limits: MapPlanLimits
): MapOperation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limits.terrainBrushCount).map((item) => ({
    type: 'terrain.modify' as const,
    ...normalizeTerrainModifierParams(item, map)
  }));
}

function normalizeTerrainSurfaceOperations(value: unknown, map: EditableMap): MapOperation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).map((item) => ({
    type: 'terrain.surface' as const,
    ...normalizeTerrainSurfaceParams(item, map)
  }));
}

function normalizeObjectOperations(
  value: unknown,
  map: EditableMap,
  assets: readonly MapAsset[],
  maxCount: number
): MapOperation[] {
  if (!Array.isArray(value)) return [];
  const bounds = getMapBounds(map);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  return value.slice(0, maxCount).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('invalid_object_plan');
    const input = item as Record<string, unknown>;
    const assetId = typeof input.assetId === 'string' ? input.assetId : '';
    const asset = assetById.get(assetId);
    if (!asset) throw new Error('unknown_map_asset');
    const x = clamp(requiredNumber(input.x, 'invalid_object_plan'), bounds.minX, bounds.maxX);
    const z = clamp(requiredNumber(input.z, 'invalid_object_plan'), bounds.minZ, bounds.maxZ);
    const scale = clamp(optionalNumber(input.scale, 1), 0.1, 8);
    const rotationY = optionalNumber(input.rotationYDeg, 0) * Math.PI / 180;
    return {
      type: 'object.add',
      object: {
        id: createId('obj'),
        name: cleanText(input.name, asset.name, 48),
        assetId,
        transform: {
          position: [x, sampleTerrainHeight(map, x, z), z],
          rotation: [0, rotationY, 0],
          scale: [scale, scale, scale]
        }
      }
    };
  });
}

function normalizeScatterOperations(
  value: unknown,
  map: EditableMap,
  assets: readonly MapAsset[],
  maxCount: number
): MapOperation[] {
  if (!Array.isArray(value) || maxCount <= 0) return [];
  const assetIds = new Set(assets.map((asset) => asset.id));
  const bounds = getMapBounds(map);
  const operations: MapOperation[] = [];
  let workingMap = map;
  for (const [planIndex, item] of value.slice(0, 16).entries()) {
    if (operations.length >= maxCount) break;
    if (!item || typeof item !== 'object') throw new Error('invalid_scatter_plan');
    const input = item as Record<string, unknown>;
    const regionInput = input.region as Record<string, unknown> | undefined;
    const rawAssetIds = Array.isArray(input.assetIds)
      ? input.assetIds.filter((assetId): assetId is string => typeof assetId === 'string')
      : [];
    const selectedAssetIds = [...new Set(rawAssetIds)];
    if (selectedAssetIds.length === 0 || selectedAssetIds.some((assetId) => !assetIds.has(assetId))) {
      throw new Error('unknown_map_asset');
    }
    if (!regionInput || regionInput.kind !== 'circle') throw new Error('invalid_scatter_plan');
    const rawScaleRange = Array.isArray(input.scaleRange) ? input.scaleRange : [1, 1];
    const plan: MapScatterPlan = {
      assetIds: selectedAssetIds,
      region: {
        kind: 'circle',
        x: clamp(requiredNumber(regionInput.x, 'invalid_scatter_plan'), bounds.minX, bounds.maxX),
        z: clamp(requiredNumber(regionInput.z, 'invalid_scatter_plan'), bounds.minZ, bounds.maxZ),
        r: requiredNumber(regionInput.r, 'invalid_scatter_plan')
      },
      density: optionalNumber(input.density, 0.04),
      avoidWater: optionalNumber(input.avoidWater, 1),
      maxSlope: optionalNumber(input.maxSlope, 30),
      minSpacing: optionalNumber(input.minSpacing, 2),
      scaleRange: [
        optionalNumber(rawScaleRange[0], 0.9),
        optionalNumber(rawScaleRange[1], 1.1)
      ],
      seed: optionalNumber(input.seed, planIndex + 1)
    };
    const placements = expandMapScatter(
      workingMap,
      plan,
      assets,
      maxCount - operations.length,
      `scatter-${map.id}-${map.updatedAt}-${planIndex}`
    );
    const placementOperations = placements.map((placement): MapOperation => ({
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
    operations.push(...placementOperations);
    if (placementOperations.length > 0) {
      workingMap = applyMapOperations(workingMap, placementOperations);
    }
  }
  return operations;
}

function normalizeSpawnOperation(value: unknown, map: EditableMap): MapOperation | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const bounds = getMapBounds(map);
  const x = clamp(requiredNumber(input.x, 'invalid_spawn_plan'), bounds.minX, bounds.maxX);
  const z = clamp(requiredNumber(input.z, 'invalid_spawn_plan'), bounds.minZ, bounds.maxZ);
  const [safeX, safeZ] = findSafeSpawnPosition(map, x, z);
  const point: Vec3 = [safeX, sampleTerrainHeight(map, safeX, safeZ), safeZ];
  return {
    type: 'reference.set',
    point,
    yaw: optionalNumber(input.yawDeg, 0) * Math.PI / 180
  };
}

function buildSystemPrompt(
  map: EditableMap,
  assets: readonly MapAsset[],
  finalPass: boolean,
  mode: 'generate' | 'refine',
  options: Pick<MapAiOptions, 'reuseExistingAssets' | 'reusableAssetIds' | 'maxNewAssets' | 'targetVisualZoneId'> = {},
  generatedAssetIds: ReadonlySet<string> = new Set()
): string {
  const bounds = getMapBounds(map);
  const limits = planLimits(bounds);
  const placedAssetIds = new Set(map.objects.map((object) => object.assetId).filter((id): id is string => Boolean(id)));
  const reusableIds = options.reusableAssetIds ? new Set(options.reusableAssetIds) : null;
  const visibleAssets = options.reuseExistingAssets
    ? assets.filter((asset) => !reusableIds || reusableIds.has(asset.id) || placedAssetIds.has(asset.id) || generatedAssetIds.has(asset.id))
    : assets.filter((asset) => placedAssetIds.has(asset.id) || generatedAssetIds.has(asset.id));
  const assetLibrary = visibleAssets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    description: asset.prompt,
    tags: asset.tags ?? [],
    sizeClass: asset.sizeClass,
    footprintRadius: asset.footprintRadius
  }));
  const objectsByAsset = new Map<string, EditableMap['objects']>();
  for (const object of map.objects) {
    const key = object.assetId ?? 'primitive';
    const list = objectsByAsset.get(key) ?? [];
    list.push(object);
    objectsByAsset.set(key, list);
  }
  const currentObjects = [...objectsByAsset.entries()].map(([assetId, objects]) => ({
    assetId,
    count: objects.length,
    objectIds: objects.slice(0, 80).map((object) => object.id)
  }));
  const maxNewAssets = normalizeMapAiMaxNewAssets(options.maxNewAssets);
  const targetZone = options.targetVisualZoneId
    ? map.visualSemantics.zones.find((zone) => zone.id === options.targetVisualZoneId)
    : null;
  if (options.targetVisualZoneId && !targetZone) throw new Error('unknown_visual_zone');
  const assetReuseInstructions = options.reuseExistingAssets
    ? [
        'Existing asset reuse is enabled. Reuse only when the asset identity, scale, and scene role genuinely fit; broad category tags alone are insufficient.'
      ]
    : [
        'Existing asset reuse is disabled for this request.',
        'Existing asset IDs listed because they are already placed may only be used by objectUpdates/objectRemovals. Never use them in objects or scatters.',
        'Every newly introduced reusable object type must be requested in assetRequests, then placed with the newly generated asset ID during the final pass.'
      ];
  const refineInstructions = mode === 'refine'
    ? [
        'This is a refinement pass over the current map. The refinement rules below replace the earlier generate-only restriction on editing existing content.',
        'Preserve everything the user did not ask to change. Prefer small delta operations instead of rebuilding the scene.',
        'To reduce repeated objects, use objectRemovals: [{"assetId":"existing asset id","count":3,"seed":1}]. You may instead provide exact objectIds.',
        'To move, rotate, or scale an existing object, use objectUpdates: [{"objectId":"existing object id","x":0,"z":0,"rotationYDeg":0,"scale":1}].',
        'To adjust water, use waterUpdates: [{"waterId":"existing water id","level":0.2,"depth":1.5,"width":2}]. To delete water, use waterRemovals: ["existing water id"].',
        `Current object groups: ${JSON.stringify(currentObjects)}`,
        `Current waters: ${JSON.stringify(map.waterBodies)}`,
        `Current visual zones: ${JSON.stringify(map.visualSemantics.zones)}`,
        ...(targetZone ? [
          `This refine is strictly scoped to visual zone "${targetZone.id}" (${JSON.stringify(targetZone)}).`,
          'Only change content whose position lies inside that zone. Do not regenerate the terrain base or change content in other zones.',
          'Use visualZoneUpdates only for this exact zone ID. Locked zone fields are user-authored and will be preserved by the server.'
        ] : [
          'When the user names a visual zone ID, use visualZoneUpdates to adjust only that persisted zone.'
        ])
      ]
    : [
        'This is a new-content planning pass. objectUpdates, objectRemovals, waterUpdates, and waterRemovals must be empty.'
      ];
  return [
    ...refineInstructions,
    ...assetReuseInstructions,
    'visualZoneUpdates format: [{"zoneId":"existing-zone-id","center":[0,0],"radius":8,"tags":["grass"],"intensity":0.8}]. Omit unchanged fields.',
    '你是 WorldForge 的地图规划器。只规划空间内容，不决定最终渲染风格。',
    '你可以选择确定性地形基底、使用地形笔刷微调、创建湖泊/河流、放置已有资产，以及设置出生点；不得删除或修改已有物体，不得编造资产 ID。',
    '根据田园、峡谷、海岛等场景词主动推导一个简单、合理的空间构图，不要求用户提供坐标。',
    finalPass
      ? '这是最终规划轮次。assetRequests 必须为空；必须至少生成一项地形、物体摆放或出生点操作，使用现有资产完成地图，无法使用的内容直接省略。'
      : `若场景需要新的可复用物体，在 assetRequests 中请求生成，最多 ${maxNewAssets} 项；请求资产时不要提前编造其 assetId。`,
    'assetRequests.tags 必须使用简短英文语义标签，例如 tree、vegetation、rock、building、prop、landmark、shrub、grass、fence 或 bridge；不要把 bark、foliage 等模型内部材质标签写进资产标签。',
    `本地图新资产的默认生成模式是 ${map.assetGenerationMode}；缺失资产由代码使用这个模式生成，但摆放时允许复用资产库中的其他模式资产。`,
    `地图范围：X ${bounds.minX} 到 ${bounds.maxX}，Z ${bounds.minZ} 到 ${bounds.maxZ}，最大高度 ${bounds.maxY}。`,
    `本地图配额：terrain 最多 ${limits.terrainBrushCount} 笔、笔刷半径最多 ${limits.brushRadiusMax}、waters 最多 ${limits.waterCount} 个、最终物体总数最多 ${limits.objectCount} 个。`,
    `terrainGeneration 是整体地形基底；可用能力：${JSON.stringify(terrainCapabilitySummary())}。新地图应优先选择一个基底；坐标由代码根据地图 seed 确定性生成。`,
    'terrain 每项格式：{"mode":"raise|lower|flatten","x":0,"z":0,"size":2,"strength":0.4,"targetHeight":0}，只用于地形基底之后的局部微调。',
    'terrainModifiers 用于可复用的局部地貌能力，每项格式：{"modifier":"cliff|terrace|dune|island","region":{"kind":"circle","x":0,"z":0,"radius":8},"amplitude":5,"softness":0.2,"direction":90,"variation":0.45,"layers":4,"layout":"plateau|coast|canyon|wall|terraces"}。region 也可为 path（points + width）或 polygon（points）；island 只用 circle/polygon。高山、梯田、峡谷等组合场景应主动调用合适的 modifier，不要把它们绑定到某个固定 preset。',
    'terrainSurfaces 用于局部地表语义，每项格式：{"surface":"grass|sand|rock","region":{"kind":"circle","x":0,"z":0,"radius":8},"intensity":1,"zoneId":"stable-zone-id"}。沙漠或沙丘区域应同时选择 sand。',
    `waters 每项格式：{"type":"lake|river","name":"名称","level":0.2,"depth":${DEFAULT_WATER_DEPTH},"width":1.2,"points":[{"x":0,"z":0}]}。湖泊 points 是至少 3 点的边界；河流 points 是至少 2 点的中心线且 width 生效。`,
    `湖泊的 depth 是水面以下的盆地深度（0.1 到 ${MAX_WATER_DEPTH}），代码会自动把湖底挖进地形，不要再用 terrain 笔刷压低湖区。小水塘用 0.6 左右，深湖用 3 以上。`,
    'objects 只用于少量独立物体，格式：{"assetId":"已有ID","name":"名称","x":0,"z":0,"rotationYDeg":0,"scale":1}。',
    '大量植被、岩石等重复物体必须优先使用 scatters，让代码生成坐标。scatters 每项格式：{"assetIds":["已有ID"],"region":{"kind":"circle","x":0,"z":0,"r":20},"density":0.04,"avoidWater":1,"maxSlope":30,"minSpacing":2,"scaleRange":[0.8,1.2],"seed":7}。',
    '若用户写了雾、光照、素描等氛围词，只放入 renderPromptSuggestions，不要用它改变地图。',
    '只返回一个 JSON 对象，不要 Markdown：',
    '{"summary":"简短摘要","assetRequests":[{"name":"资产名","prompt":"独立低多边形物体描述，无地面和背景","tags":["tree","vegetation"]}],"terrainGeneration":{"preset":"hills","amplitude":5,"roughness":0.55},"terrain":[],"terrainModifiers":[],"terrainSurfaces":[],"waters":[],"waterUpdates":[],"waterRemovals":[],"objects":[],"objectUpdates":[],"objectRemovals":[],"scatters":[],"spawn":null,"renderPromptSuggestions":[]}',
    `已有资产：${JSON.stringify(assetLibrary)}`
  ].join('\n');
}

function parseJsonObject(content: string): Record<string, unknown> {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('invalid_map_ai_json');
  try {
    return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('invalid_map_ai_json');
  }
}

function normalizeAssetRequests(
  value: unknown,
  maxCount: number,
  selectedMode: ModelGenerationMode
): AssetGenerationRequest[] {
  if (!Array.isArray(value)) return [];
  const requests: AssetGenerationRequest[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const input = item as Record<string, unknown>;
    const name = cleanText(input.name, '', 42);
    const prompt = cleanText(input.prompt, '', 500);
    const tags = normalizeAssetTags(input.tags) ?? [];
    const mode = normalizeModelGenerationMode(selectedMode);
    const key = `${name}\n${prompt}`;
    if (!name || !prompt || seen.has(key)) continue;
    seen.add(key);
    requests.push({ name, prompt, tags, mode });
    if (requests.length === maxCount) break;
  }
  return requests;
}

function hasSpatialOperations(suggestion: MapAiSuggestion): boolean {
  return suggestion.operations.some((operation) =>
    (operation.type === 'map.update' && operation.visualSemantics !== undefined)
    || operation.type === 'terrain.brush'
    || operation.type === 'terrain.modify'
    || operation.type === 'terrain.surface'
    || operation.type === 'terrain.generate'
    || operation.type === 'terrain.set'
    || operation.type === 'water.add'
    || operation.type === 'water.update'
    || operation.type === 'water.remove'
    || operation.type === 'object.add'
    || operation.type === 'object.update'
    || operation.type === 'object.remove'
    || operation.type === 'reference.set'
  );
}

function selectDeterministic<T>(items: readonly T[], count: number, seed: number): T[] {
  const pool = [...items];
  let state = Math.trunc(seed) >>> 0;
  const random = () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [pool[index], pool[other]] = [pool[other], pool[index]];
  }
  return pool.slice(0, count);
}

function normalizeTextList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function requiredNumber(value: unknown, error: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(error);
  return number;
}

function optionalNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
