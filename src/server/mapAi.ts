import {
  applyMapOperations,
  type MapAiSuggestion,
  type MapOperation,
  type MapWaterBodyPatch
} from '../shared/mapOperations';
import {
  createId,
  DEFAULT_WATER_DEPTH,
  getMapBounds,
  getMapPlayerMetrics,
  MAX_WATER_DEPTH,
  normalizeMap,
  normalizeMapRoom,
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset,
  type MapRoom,
  type TerrainBrushMode
} from '../shared/map';
import {
  CHAT_PROVIDER_OPTIONS,
  type AgentProgressEvent,
  type ChatProvider,
  type Vec3
} from '../shared/protocol';
import {
  normalizeMapAiNewAssetRange,
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
  normalizeTerrainRefinementParams,
  normalizeTerrainSurfaceParams,
  terrainCapabilitySummary
} from '../shared/terrainGeneration';
import { findSafeSpawnPosition } from '../shared/mapSpawnSafety';
import { normalizeAssetTags, normalizeMapAssetLight, type MapAssetLight } from '../shared/mapAssetMetadata';
import { validateMapSuggestion } from './mapSuggestionValidation';
import { llmChat } from './modelApi';
import {
  normalizeModelGenerationMode,
  type ModelGenerationMode
} from '../shared/modelGenerationMode';
import { runMapCompositionWorkflow } from './mapCompositionWorkflow';
import type { SceneCompositionPlan } from '../shared/sceneComposition';
import { completeMapVisualSemantics } from '../shared/mapVisualSemantics';
import { patchMapVisualZone, type VisualZonePatch } from '../shared/mapVisualSemantics';
import { VISUAL_ZONE_TAGS, normalizeMapVisualSemantics, type VisualZoneTag } from '../shared/visualDirection';
import { runAssetGenerationPool, type AssetTaskReporter } from './assetGenerationPool';
import { generateMapCodeSuggestion } from './mapCodePlanner';
import {
  findAdjacentMapRegion,
  isPointInsidePlayableArea,
  pointInMapRegion,
  regionCenter
} from '../shared/mapLayout';

export interface MapAiOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
  onPreview?: (suggestion: MapAiSuggestion) => void;
  reuseExistingAssets?: boolean;
  reusableAssetIds?: readonly string[];
  minNewAssets?: number;
  maxNewAssets?: number;
  /** Optional persisted visual-zone ID used to bound a refine pass. */
  targetVisualZoneId?: string;
  /** Optional editable ecology region used for independent generation. */
  targetRegionId?: string;
  /** Restrict a refine pass to the one shared terrain height field. */
  baseTerrainOnly?: boolean;
  /** User-approved director plan; skips a second director pass. */
  approvedCompositionPlan?: SceneCompositionPlan;
  /** Use one unified bounded Scene Code program for outdoor generation. */
  sceneAgent?: boolean;
  /** Return an indoor Code candidate and asset declaration list without generating assets. */
  discoveryOnly?: boolean;
  /** Continue from a user-approved indoor Code candidate. */
  approvedCode?: string;
}

export interface AssetGenerationRequest {
  name: string;
  prompt: string;
  tags: string[];
  light?: MapAssetLight;
  mode: ModelGenerationMode;
}

export interface MapAgentOptions extends MapAiOptions {
  createAsset: (request: AssetGenerationRequest, report: AssetTaskReporter) => Promise<MapAsset>;
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
  if (mode === 'generate' && map.sceneMode === 'outdoor' && requestsIndoorScene(prompt)) {
    throw new Error('indoor_prompt_requires_indoor_map');
  }
  if (map.sceneMode === 'indoor' || (map.sceneMode === 'outdoor' && options.sceneAgent)) {
    return generateMapCodeSuggestion(prompt, map, assets, {
      ...options,
      mode,
      scope: 'scene'
    });
  }
  if (mode === 'generate' && map.sceneMode !== 'mixed') {
    const result = await runMapCompositionWorkflow(prompt, map, assets, options);
    const generatedAssetIds = new Set(result.suggestion.generatedAssets.map((asset) => asset.id));
    const completeSuggestion = addDeterministicGeneratedAssetPlacements(
      map,
      result.assets,
      result.suggestion,
      generatedAssetIds
    );
    const validated = finalizeMapAgentSuggestion(map, result.assets, completeSuggestion, options);
    options.onProgress?.({ phase: 'complete', label: '场景构图、合成审查与地图预览已完成' });
    return validated;
  }
  options.onProgress?.({ phase: 'planning', label: mode === 'refine' ? '理解地图调整要求' : '规划地图内容' });
  let firstContent = await requestMapPlan(prompt, map, assets, options, false, mode);
  const assetRange = normalizeMapAiNewAssetRange(options.minNewAssets, options.maxNewAssets);
  const maxNewAssets = assetRange.max;
  let requests = normalizeAssetRequests(
    parseJsonObject(firstContent).assetRequests,
    maxNewAssets,
    map.assetGenerationMode
  );
  let minimumAssetShortfall = 0;
  if (requests.length < assetRange.min) {
    options.onProgress?.({ phase: 'replanning', label: `补足至少 ${assetRange.min} 个新资产请求` });
    firstContent = await requestMapPlan(
      `${prompt}\n\nThe user requires at least ${assetRange.min} genuinely new reusable assets in assetRequests.`,
      map,
      assets,
      options,
      false,
      mode
    );
    requests = normalizeAssetRequests(parseJsonObject(firstContent).assetRequests, maxNewAssets, map.assetGenerationMode);
    minimumAssetShortfall = Math.max(0, assetRange.min - requests.length);
    if (minimumAssetShortfall > 0) {
      options.onProgress?.({
        phase: 'repairing',
        label: `AI 仍少规划 ${minimumAssetShortfall} 个新资产，已按现有规划局部降级并继续`,
        detail: `目标至少 ${assetRange.min} 个，当前可执行 ${requests.length} 个`
      });
    }
  }
  options.onProgress?.({
    phase: 'checking-assets',
    label: requests.length > 0 ? `发现 ${requests.length} 个缺失资产` : '现有资产可以完成规划',
    current: 0,
    total: requests.length
  });
  if (requests.length === 0) {
    let firstSuggestion: MapAiSuggestion;
    try {
      firstSuggestion = normalizeMapSuggestion(firstContent, map, assets, mode, options.targetVisualZoneId, options.targetRegionId, options.baseTerrainOnly);
    } catch (error) {
      if (!options.baseTerrainOnly || !(error instanceof Error) || error.message !== 'empty_map_suggestion') throw error;
      options.onProgress?.({ phase: 'replanning', label: '补充全局基础地形参数' });
      firstContent = await requestMapPlan(
        `${prompt}\n\nYour previous response omitted terrainGeneration. Return exactly one terrainGeneration and leave every other operation array empty.`,
        map,
        assets,
        options,
        true,
        mode
      );
      firstSuggestion = normalizeMapSuggestion(firstContent, map, assets, mode, options.targetVisualZoneId, options.targetRegionId, options.baseTerrainOnly);
    }
    assertNoForbiddenAssetReuse(firstSuggestion, new Set(), options);
    if (hasSpatialOperations(firstSuggestion)) {
      const validated = finalizeMapAgentSuggestion(map, assets, firstSuggestion, options);
      options.onProgress?.({ phase: 'complete', label: '地图修改方案已完成' });
      return withAssetMinimumWarning(validated, assetRange.min, requests.length);
    }
    options.onProgress?.({ phase: 'replanning', label: '补充空间操作' });
    const retryContent = await requestMapPlan(prompt, map, assets, options, true, mode);
    const retrySuggestion = normalizeMapSuggestion(retryContent, map, assets, mode, options.targetVisualZoneId, options.targetRegionId, options.baseTerrainOnly);
    assertNoForbiddenAssetReuse(retrySuggestion, new Set(), options);
    if (!hasSpatialOperations(retrySuggestion)) throw new Error('map_agent_no_spatial_plan');
    const validated = finalizeMapAgentSuggestion(map, assets, retrySuggestion, options);
    options.onProgress?.({ phase: 'complete', label: '地图修改方案已完成' });
    return withAssetMinimumWarning(validated, assetRange.min, requests.length);
  }

  const generatedAssets = await runAssetGenerationPool(
    requests,
    (request, _index, report) => options.createAsset(request, report),
    { signal: options.signal, onProgress: options.onProgress }
  );

  const expandedAssets = [...assets, ...generatedAssets];
  const generatedAssetIds = new Set(generatedAssets.map((asset) => asset.id));
  options.onProgress?.({ phase: 'replanning', label: '使用新资产重新规划地图' });
  let finalContent = await requestMapPlan(prompt, map, expandedAssets, options, true, mode, generatedAssetIds);
  assertFinalPassRequestsNoAssets(finalContent, maxNewAssets, map.assetGenerationMode);
  let suggestion = {
    ...normalizeMapSuggestion(finalContent, map, expandedAssets, mode, options.targetVisualZoneId, options.targetRegionId, options.baseTerrainOnly),
    generatedAssets: generatedAssets.map((asset) => ({ id: asset.id, name: asset.name }))
  };
  let missingAssetIds = missingPlacedAssetIds(suggestion, generatedAssetIds);
  if (missingAssetIds.length > 0) {
    const operationCount = suggestion.operations.length;
    suggestion = addDeterministicGeneratedAssetPlacements(
      map,
      expandedAssets,
      suggestion,
      generatedAssetIds,
      options.targetRegionId
    );
    missingAssetIds = missingPlacedAssetIds(suggestion, generatedAssetIds);
    options.onProgress?.({
      phase: 'repairing',
      label: missingAssetIds.length > 0
        ? `自动补摆后仍有 ${missingAssetIds.length} 项无合法位置，已局部降级`
        : `自动补摆 ${suggestion.operations.length - operationCount} 个遗漏的新资产`,
      detail: missingAssetIds.length > 0 ? missingAssetIds.join(', ') : undefined
    });
  }
  assertNoForbiddenAssetReuse(suggestion, generatedAssetIds, options);
  if (!hasSpatialOperations(suggestion)) throw new Error('map_agent_no_spatial_plan');
  const validated = finalizeMapAgentSuggestion(map, expandedAssets, suggestion, options);
  options.onProgress?.({ phase: 'complete', label: '地图修改方案已完成' });
  return withAssetMinimumWarning(validated, assetRange.min, requests.length);
}

function withAssetMinimumWarning(
  suggestion: MapAiSuggestion,
  minimum: number,
  actual: number
): MapAiSuggestion {
  if (actual >= minimum) return suggestion;
  return {
    ...suggestion,
    diagnostics: [...(suggestion.diagnostics ?? []), {
      code: 'asset.minimum-degraded',
      severity: 'warning',
      message: `AI 仅规划出 ${actual} 个可执行的新资产，低于设置的最少 ${minimum} 个；系统已保留可执行内容并继续，没有中断本次生成。`,
      repaired: false
    }]
  };
}

function requestsIndoorScene(prompt: string): boolean {
  return /室内|内部|房间|教堂内|礼拜堂内|\b(?:interior|indoors?|inside (?:a|the))\b/i.test(prompt);
}

function assertFinalPassRequestsNoAssets(
  content: string,
  maxNewAssets: number,
  mode: ModelGenerationMode
): void {
  if (normalizeAssetRequests(parseJsonObject(content).assetRequests, maxNewAssets, mode).length > 0) {
    throw new Error('map_agent_asset_limit');
  }
}

function missingPlacedAssetIds(
  suggestion: Pick<MapAiSuggestion, 'operations'>,
  generatedAssetIds: ReadonlySet<string>
): string[] {
  const placed = new Set(suggestion.operations.flatMap((operation) => (
    operation.type === 'object.add' && operation.object.assetId ? [operation.object.assetId] : []
  )));
  return [...generatedAssetIds].filter((assetId) => !placed.has(assetId));
}

function addDeterministicGeneratedAssetPlacements(
  map: EditableMap,
  assets: readonly MapAsset[],
  suggestion: MapAiSuggestion,
  generatedAssetIds: ReadonlySet<string>,
  targetRegionId?: string
): MapAiSuggestion {
  const missingAssetIds = missingPlacedAssetIds(suggestion, generatedAssetIds);
  if (missingAssetIds.length === 0) return suggestion;
  const region = targetRegionId ? map.layout.regions.find((item) => item.id === targetRegionId) : null;
  const center = region ? regionCenter(region) : [0, 0] as [number, number];
  const radius = region
    ? Math.max(1, ...region.points.map(([x, z]) => Math.hypot(x - center[0], z - center[1])))
    : Math.hypot(map.box.size[0], map.box.size[2]) / 2;
  const generationId = region ? createId('generation') : '';
  let workingMap = applyMapOperations(normalizeMap({ ...map, assets: [...assets] }), suggestion.operations);
  const operations: MapOperation[] = [];

  for (const [index, assetId] of missingAssetIds.entries()) {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset) continue;
    const footprint = Math.max(0.5, asset.footprintRadius ?? 0.5);
    const candidates = expandMapScatter(workingMap, {
      assetIds: [assetId],
      region: { kind: 'circle', x: center[0], z: center[1], r: radius },
      density: 1,
      avoidWater: 0.8,
      maxSlope: 34,
      minSpacing: footprint * 2 + 0.25,
      scaleRange: [1, 1],
      seed: map.seed + index * 977 + 1
    }, assets, 96, `generated-fallback-${assetId}`);
    const placement = candidates.find((candidate) => (
      isPointInsidePlayableArea(map.layout, map.box.size, candidate.x, candidate.z)
      && (!region || pointInMapRegion(region, candidate.x, candidate.z))
    ));
    if (!placement) continue;
    const operation: MapOperation = {
      type: 'object.add',
      object: {
        id: placement.id,
        name: placement.name,
        assetId: placement.assetId,
        transform: {
          position: [placement.x, placement.y, placement.z],
          rotation: [0, placement.rotationY, 0],
          scale: [placement.scale, placement.scale, placement.scale]
        },
        ...(region ? { generation: { kind: 'region' as const, id: region.id, generationId } } : {})
      }
    };
    operations.push(operation);
    workingMap = applyMapOperations(workingMap, [operation]);
  }

  const repaired = { ...suggestion, operations: [...suggestion.operations, ...operations] };
  const unplacedAssetIds = missingPlacedAssetIds(repaired, generatedAssetIds);
  if (unplacedAssetIds.length === 0) return repaired;
  const names = unplacedAssetIds.map((assetId) => assets.find((asset) => asset.id === assetId)?.name ?? assetId);
  return {
    ...repaired,
    diagnostics: [...(repaired.diagnostics ?? []), {
      code: 'asset.unplaced',
      severity: 'warning',
      message: `新资产“${names.join('、')}”在边界、坡度、水体和碰撞约束内无合法位置，已降级跳过；其余地图内容仍可预览。`,
      repaired: false
    }]
  };
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
  targetVisualZoneId?: string,
  targetRegionId?: string,
  baseTerrainOnly = false
): MapAiSuggestion {
  const input = parseJsonObject(content);

  const bounds = getMapBounds(map);
  const limits = planLimits(bounds, map.sceneMode);
  const renderPromptSuggestions = normalizeTextList(input.renderPromptSuggestions, 8, 80);
  const operations: MapOperation[] = renderPromptSuggestions.length > 0
    ? [{ type: 'map.update', renderPromptSuggestions }]
    : [];
  operations.push(...normalizeRoomOperations(input.room, map));
  operations.push(...normalizeVisualZoneUpdateOperations(input.visualZoneUpdates, map, targetVisualZoneId));
  if (map.sceneMode !== 'indoor' && input.terrainGeneration !== undefined && input.terrainGeneration !== null) {
    operations.push({
      type: 'terrain.generate',
      ...normalizeTerrainGenerationParams(input.terrainGeneration, map)
    });
  }
  const terrainOperations = map.sceneMode === 'indoor' ? [] : normalizeTerrainOperations(input.terrain, bounds, limits);
  operations.push(...terrainOperations);
  if (map.sceneMode !== 'indoor') operations.push(...normalizeTerrainModifierOperations(input.terrainModifiers, map, limits));
  if (map.sceneMode !== 'indoor' && input.terrainRefinement !== undefined && input.terrainRefinement !== null) {
    operations.push({ type: 'terrain.refine', ...normalizeTerrainRefinementParams(input.terrainRefinement) });
  }
  if (map.sceneMode !== 'indoor') operations.push(...normalizeTerrainSurfaceOperations(input.terrainSurfaces, map));
  const waterRefineOperations = mode === 'refine' && map.sceneMode !== 'indoor'
    ? normalizeWaterRefineOperations(input.waterUpdates, input.waterRemovals, map, bounds)
    : [];
  operations.push(...waterRefineOperations);
  const waterOperations = map.sceneMode === 'indoor' ? [] : normalizeWaterOperations(input.waters, bounds, limits, map.seed);
  operations.push(...waterOperations);
  const earlyOperations = operations.filter((operation) => (
    operation.type === 'room.set'
    || operation.type === 'terrain.generate'
    || operation.type === 'terrain.brush'
    || operation.type === 'terrain.modify'
    || operation.type === 'terrain.refine'
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
    Math.max(0, limits.objectCount - objectOperations.length),
    targetRegionId
  );
  operations.push(...scatterOperations);
  const populatedPreview = scatterOperations.length > 0
    ? applyMapOperations(scatterPreview, scatterOperations)
    : scatterPreview;
  const spawnOperation = normalizeSpawnOperation(input.spawn, populatedPreview);
  if (spawnOperation) operations.push(spawnOperation);
  const scopedOperations = baseTerrainOnly
    ? operations.filter((operation) => operation.type === 'terrain.generate')
    : targetRegionId
    ? scopeMapOperationsToEcologyRegion(operations, map, targetRegionId)
    : targetVisualZoneId
    ? scopeMapOperationsToVisualZone(operations, map, targetVisualZoneId)
    : operations;
  // Refine responses can become empty when every referenced object was saved,
  // removed, or replaced while the request was running. Let the agent's
  // existing no-spatial-plan retry ask for a fresh delta instead of failing
  // with an opaque stale-reference error.
  if (scopedOperations.length === 0 && (mode !== 'refine' || baseTerrainOnly)) throw new Error('empty_map_suggestion');

  if (scopedOperations.length > 0) applyMapOperations(map, scopedOperations);
  return {
    summary: cleanText(input.summary, 'AI 地图建议', 200),
    operations: scopedOperations,
    renderPromptSuggestions,
    generatedAssets: []
  };
}

function normalizeRoomOperations(value: unknown, map: EditableMap): MapOperation[] {
  if (map.sceneMode === 'outdoor' || value === undefined || value === null) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_room_plan');
  return [{
    type: 'room.set',
    room: normalizeMapRoom(value as Partial<MapRoom>, map.box.size, map.room ?? undefined)
  }];
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
  zoneId: string,
  containsOverride?: (x: number, z: number) => boolean,
  strictFootprints = false,
  allowMapUpdate = true,
  allowTerrainOverlap = false
): MapOperation[] {
  const zone = map.visualSemantics.zones.find((item) => item.id === zoneId);
  if (!zone && !containsOverride) throw new Error('unknown_visual_zone');
  const contains = containsOverride
    ?? ((x: number, z: number) => Math.hypot(x - zone!.center[0], z - zone!.center[1]) <= zone!.radius);
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
  const regionInside = (
    region: Extract<MapOperation, { type: 'terrain.modify' | 'terrain.surface' }>['region'],
    allowOverlap = false
  ) => {
    if (region.kind === 'circle') {
      if (!contains(region.x, region.z)) return false;
      return !strictFootprints || allowOverlap || circleInside(region.x, region.z, region.radius, contains);
    }
    if (region.points.length === 0) return false;
    if (strictFootprints && !allowOverlap && !region.points.every((point) => contains(point[0], point[1]))) return false;
    const x = region.points.reduce((sum, point) => sum + point[0], 0) / region.points.length;
    const z = region.points.reduce((sum, point) => sum + point[1], 0) / region.points.length;
    return contains(x, z);
  };
  return operations.filter((operation) => {
    switch (operation.type) {
      case 'map.update': return allowMapUpdate;
      case 'room.set': return false;
      case 'terrain.brush': return strictFootprints && !allowTerrainOverlap
        ? circleInside(operation.point[0], operation.point[2], operation.size ?? 1, contains)
        : contains(operation.point[0], operation.point[2]);
      case 'terrain.modify': return regionInside(operation.region, allowTerrainOverlap);
      case 'terrain.surface': return regionInside(operation.region);
      case 'paint.add': return contains(operation.stroke.point[0], operation.stroke.point[2]);
      case 'object.add': return contains(operation.object.transform?.position?.[0] ?? 0, operation.object.transform?.position?.[2] ?? 0);
      case 'object.update': return objectInside(operation.objectId, operation.patch.transform?.position);
      case 'object.remove': return objectInside(operation.objectId);
      case 'water.add': {
        const points = operation.water.points ?? [];
        if (points.length === 0) return false;
        if (strictFootprints && !points.every((point) => contains(point[0], point[1]))) return false;
        const x = points.reduce((sum, point) => sum + point[0], 0) / points.length;
        const z = points.reduce((sum, point) => sum + point[1], 0) / points.length;
        return contains(x, z);
      }
      case 'water.update':
      case 'water.remove': return waterInside(operation.waterId);
      case 'reference.set': return contains(operation.point[0], operation.point[2]);
      case 'terrain.generate':
      case 'terrain.refine':
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

function scopeMapOperationsToEcologyRegion(
  operations: readonly MapOperation[],
  map: EditableMap,
  regionId: string
): MapOperation[] {
  const region = map.layout.regions.find((item) => item.id === regionId);
  if (!region) throw new Error('unknown_ecology_region');
  if (region.contentLocked) throw new Error('ecology_region_content_locked');
  const generationId = createId('generation');
  const cleanup: MapOperation[] = [
    ...map.objects
      .filter((object) => !object.locked && object.generation?.kind === 'region' && object.generation.id === regionId)
      .map((object) => ({ type: 'object.remove' as const, objectId: object.id })),
    ...map.waterBodies
      .filter((water) => water.generation?.kind === 'region' && water.generation.id === regionId)
      .map((water) => ({ type: 'water.remove' as const, waterId: water.id }))
  ];
  const cleanupObjectIds = new Set(cleanup.flatMap((operation) => operation.type === 'object.remove' ? [operation.objectId] : []));
  const cleanupWaterIds = new Set(cleanup.flatMap((operation) => operation.type === 'water.remove' ? [operation.waterId] : []));
  const scoped = scopeMapOperationsToVisualZone(
    operations,
    map,
    '',
    (x, z) => pointInMapRegion(region, x, z),
    true,
    false,
    true
  ).filter((operation) => (
    !(operation.type === 'object.remove' && cleanupObjectIds.has(operation.objectId))
    && !(operation.type === 'water.remove' && cleanupWaterIds.has(operation.waterId))
  )).map((operation): MapOperation => {
    if (operation.type === 'object.add') {
      return {
        ...operation,
        object: { ...operation.object, generation: { kind: 'region', id: regionId, generationId } }
      };
    }
    if (operation.type === 'water.add') {
      return {
        ...operation,
        water: { ...operation.water, generation: { kind: 'region', id: regionId, generationId } }
      };
    }
    return operation;
  });
  return [...cleanup, ...scoped];
}

function circleInside(
  x: number,
  z: number,
  radius: number,
  contains: (x: number, z: number) => boolean
): boolean {
  if (!contains(x, z)) return false;
  const safeRadius = Math.max(0, radius);
  for (let index = 0; index < 8; index += 1) {
    const angle = index / 8 * Math.PI * 2;
    if (!contains(x + Math.cos(angle) * safeRadius, z + Math.sin(angle) * safeRadius)) return false;
  }
  return true;
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
        .filter((object) => !object.locked && !removed.has(object.id))
        .sort((a, b) => a.id.localeCompare(b.id));
      // A long-running refine may finish after the user has saved an earlier
      // round. Ignore stale model references and keep any still-valid edits.
      if (candidates.length === 0) continue;
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
      if (!object || object.locked || operations.some((operation) => operation.type === 'object.remove' && operation.objectId === objectId)) continue;
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
      const patch: MapWaterBodyPatch = {};
      if (input.level !== undefined) patch.level = clamp(requiredNumber(input.level, 'invalid_water_refine_plan'), 0.02, bounds.maxY - 0.05);
      if (input.depth !== undefined) patch.depth = clamp(requiredNumber(input.depth, 'invalid_water_refine_plan'), 0.1, MAX_WATER_DEPTH);
      if (input.width !== undefined) {
        patch.width = clamp(
          requiredNumber(input.width, 'invalid_water_refine_plan'),
          0.3,
          Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2
        );
      }
      if (input.shorelineSmoothness !== undefined) {
        patch.shorelineSmoothness = clamp(
          requiredNumber(input.shorelineSmoothness, 'invalid_water_refine_plan'),
          0,
          1
        );
      }
      if (input.shorelineIrregularity !== undefined) {
        patch.shorelineIrregularity = clamp(
          requiredNumber(input.shorelineIrregularity, 'invalid_water_refine_plan'),
          0,
          water.type === 'lake' ? 0.4 : 0
        );
      }
      if (input.seed !== undefined) {
        patch.seed = Math.trunc(requiredNumber(input.seed, 'invalid_water_refine_plan'));
      }
      if (input.levels !== undefined) {
        if (water.type !== 'river' || !Array.isArray(input.levels)
          || input.levels.length !== water.points.length) {
          throw new Error('invalid_water_refine_plan');
        }
        patch.levels = descendingLevels(input.levels.map((level) => (
          clamp(requiredNumber(level, 'invalid_water_refine_plan'), 0.02, bounds.maxY - 0.05)
        )));
      }
      if (Object.keys(patch).length > 0) operations.push({ type: 'water.update', waterId, patch });
    }
  }
  return operations;
}

function normalizeWaterOperations(
  value: unknown,
  bounds: ReturnType<typeof getMapBounds>,
  limits: MapPlanLimits,
  mapSeed: number
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
    const levels = type === 'river' && Array.isArray(input.levels)
      ? descendingLevels(input.levels.map((level) => clamp(requiredNumber(level, 'invalid_water_plan'), 0.02, bounds.maxY - 0.05)))
      : undefined;
    if (levels && levels.length !== points.length) throw new Error('invalid_water_plan');
    return {
      type: 'water.add',
      water: {
        id: createId('water'),
        name: cleanText(input.name, type === 'lake' ? '湖泊' : '河流', 48),
        type,
        level: clamp(optionalNumber(input.level, 0.2), 0.02, bounds.maxY - 0.05),
        depth: clamp(optionalNumber(input.depth, DEFAULT_WATER_DEPTH), 0.1, MAX_WATER_DEPTH),
        width: clamp(optionalNumber(input.width, 1.2), 0.3, Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2),
        points,
        ...(levels ? { levels } : {}),
        shorelineSmoothness: clamp(optionalNumber(input.shorelineSmoothness, type === 'lake' ? 0.85 : 0.8), 0, 1),
        shorelineIrregularity: clamp(optionalNumber(input.shorelineIrregularity, type === 'lake' ? 0.16 : 0), 0, 0.4),
        seed: Math.trunc(optionalNumber(input.seed, mapSeed))
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
    const y = finiteNumber(input.y);
    const roomOpeningId = typeof input.roomOpeningId === 'string'
      && map.room?.openings.some((opening) => opening.id === input.roomOpeningId)
      ? input.roomOpeningId
      : undefined;
    return {
      type: 'object.add',
      object: {
        id: createId('obj'),
        name: cleanText(input.name, asset.name, 48),
        assetId,
        heightMode: y !== null || roomOpeningId ? 'fixed' : 'terrain',
        roomOpeningId,
        transform: {
          position: [x, y === null ? sampleTerrainHeight(map, x, z) : clamp(y, bounds.minY, bounds.maxY), z],
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
  maxCount: number,
  targetRegionId?: string
): MapOperation[] {
  if (!Array.isArray(value) || maxCount <= 0) return [];
  const assetIds = new Set(assets.map((asset) => asset.id));
  const operations: MapOperation[] = [];
  let workingMap = map;
  for (const [planIndex, item] of value.slice(0, 16).entries()) {
    if (operations.length >= maxCount) break;
    if (!item || typeof item !== 'object') throw new Error('invalid_scatter_plan');
    const input = item as Record<string, unknown>;
    const rawAssetIds = Array.isArray(input.assetIds)
      ? input.assetIds.filter((assetId): assetId is string => typeof assetId === 'string')
      : [];
    const selectedAssetIds = [...new Set(rawAssetIds)];
    if (selectedAssetIds.length === 0 || selectedAssetIds.some((assetId) => !assetIds.has(assetId))) {
      throw new Error('unknown_map_asset');
    }
    const rawScaleRange = Array.isArray(input.scaleRange) ? input.scaleRange : [1, 1];
    const plan: MapScatterPlan = {
      assetIds: selectedAssetIds,
      region: normalizeScatterRegion(input.region, map, targetRegionId),
      density: optionalNumber(input.density, 0.04),
      avoidWater: optionalNumber(input.avoidWater, 1),
      maxSlope: optionalNumber(input.maxSlope, 30),
      minSpacing: optionalNumber(input.minSpacing, 2),
      scaleRange: [
        optionalNumber(rawScaleRange[0], 0.9),
        optionalNumber(rawScaleRange[1], 1.1)
      ],
      seed: optionalNumber(input.seed, planIndex + 1),
      edgeFalloff: optionalNumber(input.edgeFalloff, 0),
      clusterStrength: optionalNumber(input.clusterStrength, 0),
      patchSeed: optionalNumber(input.patchSeed, optionalNumber(input.seed, planIndex + 1)),
      spacingByAssetId: normalizeScatterSpacing(input.spacingByAssetId, assetIds),
      habitat: normalizeScatterHabitat(input.habitat)
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

function normalizeScatterSpacing(value: unknown, assetIds: ReadonlySet<string>): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [assetId, spacing] of Object.entries(value as Record<string, unknown>)) {
    if (!assetIds.has(assetId)) continue;
    result[assetId] = clamp(optionalNumber(spacing, 1), 0.1, 64);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeScatterHabitat(value: unknown): MapScatterPlan['habitat'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const band = (raw: unknown, minimum: number, maximum: number) => {
    if (!Array.isArray(raw) || raw.length < 4) return undefined;
    const values = raw.slice(0, 4).map((item) => clamp(optionalNumber(item, minimum), minimum, maximum));
    values.sort((left, right) => left - right);
    return values as [number, number, number, number];
  };
  const height = band(input.height, -32, 32);
  const slope = band(input.slope, 0, 89);
  const waterDistance = band(input.waterDistance, 0, 2048);
  return height || slope || waterDistance
    ? { ...(height ? { height } : {}), ...(slope ? { slope } : {}), ...(waterDistance ? { waterDistance } : {}) }
    : undefined;
}

function normalizeScatterRegion(
  value: unknown,
  map: EditableMap,
  targetRegionId?: string
): MapScatterPlan['region'] {
  const bounds = getMapBounds(map);
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const center = normalizeScatterPoint(input?.center);
  const x = finiteNumber(input?.x) ?? center?.[0] ?? null;
  const z = finiteNumber(input?.z) ?? center?.[1] ?? null;
  const radius = finiteNumber(input?.r) ?? finiteNumber(input?.radius);
  if ((input?.kind === undefined || input.kind === 'circle') && x !== null && z !== null && radius !== null) {
    return {
      kind: 'circle',
      x: clamp(x, bounds.minX, bounds.maxX),
      z: clamp(z, bounds.minZ, bounds.maxZ),
      r: Math.max(0.1, radius)
    };
  }

  const points = Array.isArray(input?.points)
    ? input.points.map(normalizeScatterPoint).filter((point): point is [number, number] => Boolean(point))
    : [];
  if (points.length >= (input?.kind === 'path' ? 2 : 3)) {
    return scatterCircleFromPoints(points, bounds, input?.kind === 'path' ? Math.max(0, finiteNumber(input.width) ?? 0) / 2 : 0);
  }

  const targetRegion = targetRegionId
    ? map.layout.regions.find((region) => region.id === targetRegionId)
    : null;
  if (targetRegion && targetRegion.points.length >= 3) {
    return scatterCircleFromPoints(targetRegion.points, bounds);
  }
  throw new Error('invalid_scatter_plan');
}

function scatterCircleFromPoints(
  points: readonly [number, number][],
  bounds: ReturnType<typeof getMapBounds>,
  padding = 0
): MapScatterPlan['region'] {
  const x = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const z = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return {
    kind: 'circle',
    x: clamp(x, bounds.minX, bounds.maxX),
    z: clamp(z, bounds.minZ, bounds.maxZ),
    r: Math.max(0.1, ...points.map((point) => Math.hypot(point[0] - x, point[1] - z) + padding))
  };
}

function normalizeScatterPoint(value: unknown): [number, number] | null {
  if (Array.isArray(value)) {
    const x = finiteNumber(value[0]);
    const z = finiteNumber(value[1]);
    return x !== null && z !== null ? [x, z] : null;
  }
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const x = finiteNumber(input.x);
  const z = finiteNumber(input.z);
  return x !== null && z !== null ? [x, z] : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSpawnOperation(value: unknown, map: EditableMap): MapOperation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const requestedX = finiteNumber(input.x);
  const requestedZ = finiteNumber(input.z);
  if (requestedX === null || requestedZ === null) return null;
  const bounds = getMapBounds(map);
  const x = clamp(requestedX, bounds.minX, bounds.maxX);
  const z = clamp(requestedZ, bounds.minZ, bounds.maxZ);
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
  options: Pick<MapAiOptions, 'reuseExistingAssets' | 'reusableAssetIds' | 'minNewAssets' | 'maxNewAssets' | 'targetVisualZoneId' | 'targetRegionId' | 'baseTerrainOnly'> = {},
  generatedAssetIds: ReadonlySet<string> = new Set()
): string {
  const bounds = getMapBounds(map);
  const limits = planLimits(bounds, map.sceneMode);
  const player = getMapPlayerMetrics(map);
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
  const assetRange = normalizeMapAiNewAssetRange(options.minNewAssets, options.maxNewAssets);
  const targetZone = options.targetVisualZoneId
    ? map.visualSemantics.zones.find((zone) => zone.id === options.targetVisualZoneId)
    : null;
  const targetRegion = options.targetRegionId
    ? map.layout.regions.find((region) => region.id === options.targetRegionId)
    : null;
  const adjacentRegion = targetRegion ? findAdjacentMapRegion(map.layout.regions, targetRegion) : null;
  if (options.targetVisualZoneId && !targetZone) throw new Error('unknown_visual_zone');
  if (options.targetRegionId && !targetRegion) throw new Error('unknown_ecology_region');
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
        'Keep spawn null unless the user explicitly asks to move the existing spawn point.',
        'To reduce repeated objects, use objectRemovals: [{"assetId":"existing asset id","count":3,"seed":1}]. You may instead provide exact objectIds.',
        'To move, rotate, or scale an existing object, use objectUpdates: [{"objectId":"existing object id","x":0,"z":0,"rotationYDeg":0,"scale":1}].',
        'To adjust water, use waterUpdates: [{"waterId":"existing water id","level":0.2,"depth":1.5,"width":2,"shorelineSmoothness":0.85,"shorelineIrregularity":0.16,"seed":7}]. River updates may also include levels matching the existing centerline point count. To delete water, use waterRemovals: ["existing water id"].',
        `Current object groups: ${JSON.stringify(currentObjects)}`,
        `Current waters: ${JSON.stringify(map.waterBodies)}`,
        `Current visual zones: ${JSON.stringify(map.visualSemantics.zones)}`,
        ...(targetZone ? [
          `This refine is strictly scoped to visual zone "${targetZone.id}" (${JSON.stringify(targetZone)}).`,
          'Only change content whose position lies inside that zone. Do not regenerate the terrain base or change content in other zones.',
          'Use visualZoneUpdates only for this exact zone ID. Locked zone fields are user-authored and will be preserved by the server.'
        ] : [
          'When the user names a visual zone ID, use visualZoneUpdates to adjust only that persisted zone.'
        ]),
        ...(targetRegion ? [
          `This generation is strictly scoped to ecology region "${targetRegion.id}" (${JSON.stringify(targetRegion.points)}).`,
          `The region-specific prompt is: ${targetRegion.prompt || '(empty: base terrain only)'}.`,
          'Keep water and objects inside this polygon. Local height brushes and terrain modifiers may softly overlap the shared boundary to form a natural transition, but never regenerate the terrain base.',
          'Use broad, soft terrain masses and low-density edge content up to the shared boundary. Do not leave an artificial empty strip between ecology regions unless the user explicitly asks for open negative space.',
          ...(adjacentRegion ? [
            `The primary adjacent region is "${adjacentRegion.name}": ${adjacentRegion.prompt || '(base terrain only)'}. Blend elevation and ground density naturally toward that neighbor without copying its focal content.`
          ] : [])
        ] : [])
      ]
    : [
        'This is a new-content planning pass. objectUpdates, objectRemovals, waterUpdates, and waterRemovals must be empty.'
      ];
  const baseTerrainInstructions = options.baseTerrainOnly
    ? [
        'This pass creates only the one shared base height field for the complete map before ecology-region content generation.',
        'Return exactly one terrainGeneration operation. Keep assetRequests, terrain, terrainModifiers, terrainSurfaces, waters, objects, scatters and spawn empty.',
        'Do not place vegetation, buildings, props, water, local landmarks or region-specific content.'
      ]
    : [];
  const roomInstructions = map.sceneMode === 'outdoor'
    ? []
    : [
        `Scene mode is ${map.sceneMode}. The parameterized room is structural map data, not a generated whole-room asset.`,
        'Return room as {"position":[x,y,z],"size":[width,height,depth],"wallThickness":0.16,"openings":[{"id":"door-main","kind":"door|window","wall":"north|south|east|west","offset":0,"bottom":0,"width":1.2,"height":2.1}]}. Use one rectangular room only.',
        'Walls are assembled from modular segments around room.openings; do not request wall, floor, or ceiling assets and do not use CSG.',
        'Every door/window asset request must include the English tag door or window. In the final objects list, bind it with roomOpeningId matching one room opening and include y.',
        'A window asset prompt must explicitly request a visible transparent glass pane whose material is tagged base:glass; keep base:glass out of assetRequests.tags.',
        'Keep a continuous walkable route at least 0.8m wide from spawn to every door. Place wall items against their wall, ceiling items below the ceiling, and floor furniture on the room floor.',
        ...(map.sceneMode === 'indoor' ? [
          'This is a standalone indoor map. Keep terrainGeneration, terrain, terrainModifiers, terrainRefinement, terrainSurfaces, waters, waterUpdates, waterRemovals and scatters empty.'
        ] : [
          'This is a mixed indoor/outdoor map. Room content and outdoor terrain may coexist in the same map.'
        ]),
        `Current room: ${JSON.stringify(map.room)}`
      ];
  return [
    ...baseTerrainInstructions,
    ...roomInstructions,
    ...refineInstructions,
    ...assetReuseInstructions,
    `角色高度是 ${player.height.toFixed(2)} 米，世界尺度档位是 ${map.worldScaleProfile}。普通可见物体的最大边不要小于 ${(player.height / 6).toFixed(2)} 米；只有明确要求的小物件才能低至 ${(player.height / 24).toFixed(2)} 米。树木必须明显高于人物。`,
    '大房间中的重复家具数量必须随可用面积增长，并铺开使用房间；保留通道，不要把固定少量家具挤在中心。',
    'visualZoneUpdates format: [{"zoneId":"existing-zone-id","center":[0,0],"radius":8,"tags":["grass"],"intensity":0.8}]. Omit unchanged fields.',
    '你是 WorldForge 的地图规划器。玩家通常只写一句简短场景描述；请自行推导整体构图、坐标、数量、密度、留白和自然过渡，不要求玩家补充技术参数。',
    '只规划空间内容，不决定最终渲染风格。你可以选择地形、湖泊/河流、已有资产和出生点；不得删除或修改未授权内容，不得编造资产 ID。',
    finalPass
      ? '这是最终规划轮次。assetRequests 必须为空；必须至少生成一项房间、地形、物体摆放或出生点操作，使用现有资产完成地图，无法使用的内容直接省略。'
      : `若场景需要新的可复用物体，在 assetRequests 中请求生成 ${assetRange.min}-${assetRange.max} 项；请求资产时不要提前编造其 assetId。`,
    'assetRequests.tags 必须使用简短英文语义标签，例如 tree、vegetation、rock、building、prop、landmark、shrub、grass、fence、bridge、door 或 window；不要把 bark、foliage 等模型内部材质标签写进资产标签。',
    '需要真正照亮周围环境的灯具必须在 assetRequests.light 中显式声明光源：point 用于全向灯，spot 用于定向灯；填写 color、intensity(通常 1-8)、range、offset，spot 还要填写 direction、coneAngleDegrees 和 penumbra。重复灯具的 range 应保持局部，避免叠加照亮整个房间。显示器、指示灯、霓虹牌等只发光但不照明的物体不要填写 light。',
    `本地图新资产的默认生成模式是 ${map.assetGenerationMode}；缺失资产由代码使用这个模式生成，但摆放时允许复用资产库中的其他模式资产。`,
    `地图范围：X ${bounds.minX} 到 ${bounds.maxX}，Z ${bounds.minZ} 到 ${bounds.maxZ}，最大高度 ${bounds.maxY}。`,
    `本地图配额：terrain 最多 ${limits.terrainBrushCount} 笔、笔刷半径最多 ${limits.brushRadiusMax}、waters 最多 ${limits.waterCount} 个、最终物体总数最多 ${limits.objectCount} 个。`,
    `terrainGeneration 是整体地形基底；可用能力：${JSON.stringify(terrainCapabilitySummary())}。新地图应优先选择一个基底；坐标由代码根据地图 seed 确定性生成。`,
    'terrain 每项格式：{"mode":"raise|lower|flatten","x":0,"z":0,"size":2,"strength":0.4,"targetHeight":0}，只用于地形基底之后的局部微调。',
    'terrainModifiers 用于可复用的局部地貌能力，每项格式：{"modifier":"mountain|ridge|valley|basin|cliff|terrace|dune|island","region":{"kind":"circle","x":0,"z":0,"radius":18},"amplitude":5,"softness":0.3,"direction":90,"variation":0.45,"layers":4,"layout":"plateau|coast|canyon|wall|terraces","access":"walkable|scenic"}。region 也可为 path（points + width）或 polygon（points）；island 只用 circle/polygon。山脉必须有宽阔连续的山地区域；walkable 使用低矮宽坡或 terraces 跳跃平台，scenic 才能使用更陡的装饰山。只有宽度足够时才生成 ridge，否则自动降级为山丘；cliff 只用于真正的峭壁、断崖和峡谷墙。',
    'terrainRefinement 在所有地形塑形后执行，格式：{"erosion":0.22,"drainage":0.08,"iterations":3,"talus":46}。新地图通常应提供一次，用轻量坡面松弛和汇流雕刻消除规则刀切感；不要对局部区域重做全图 refinement。',
    'terrainSurfaces 用于局部地表语义，每项格式：{"surface":"grass|sand|rock","region":{"kind":"circle","x":0,"z":0,"radius":8},"intensity":1,"zoneId":"stable-zone-id"}。沙漠或沙丘区域应同时选择 sand。',
    `waters 每项格式：{"type":"lake|river","name":"名称","level":0.2,"depth":${DEFAULT_WATER_DEPTH},"width":1.2,"shorelineSmoothness":0.85,"shorelineIrregularity":0.16,"seed":7,"points":[{"x":0,"z":0}],"levels":[1.2,0.8]}。`,
    '湖泊用 5-10 个粗略边界控制点组合出多个圆弧岸湾，shorelineSmoothness 建议 0.7-0.95，shorelineIrregularity 建议 0.08-0.28；代码会用 seed 生成连续噪声并平滑成不规则圆弧，不要手写密集锯齿点。',
    `河流用 4-10 个从上游到下游排列的中心线控制点，width 是完整河宽，shorelineSmoothness 建议 0.65-0.9。可选 levels 必须与 points 等长并从上游到下游逐渐降低；省略时代码会根据源头地形与终点 level 自动生成沿程水位。河床会按 depth（0.1 到 ${MAX_WATER_DEPTH}）自动开槽并生成平滑河岸。`,
    `湖泊的 depth 是水面以下的盆地深度，代码会自动把湖底挖进地形，不要再用 terrain 笔刷压低水区。小水塘用 0.6 左右，深湖用 3 以上。`,
    'objects 只用于少量独立物体，格式：{"assetId":"已有ID","name":"名称","x":0,"y":0,"z":0,"rotationYDeg":0,"scale":1,"roomOpeningId":"可选的门窗预留ID"}。室外贴地物体省略 y；室内墙面、天花板、门窗物体必须提供 y。',
    '大量植被、岩石等重复物体必须优先使用 scatters，让代码生成坐标。scatters 每项格式：{"assetIds":["已有ID"],"region":{"kind":"circle","x":0,"z":0,"r":20},"density":0.04,"avoidWater":1,"maxSlope":30,"minSpacing":2,"scaleRange":[0.8,1.2],"seed":7,"patchSeed":99,"clusterStrength":0.6,"edgeFalloff":0.25,"spacingByAssetId":{"另一已有ID":3},"habitat":{"height":[-2,0,6,10],"slope":[0,0,20,35],"waterDistance":[0,1,5,9]}}。同一植物群落的多个 scatter 使用相同 patchSeed，让物种共享群落而不是各自形成圆团。',
    '若用户写了雾、光照、素描等氛围词，只放入 renderPromptSuggestions，不要用它改变地图。',
    '只返回一个 JSON 对象，不要 Markdown：',
    '{"summary":"简短摘要","assetRequests":[{"name":"资产名","prompt":"独立低多边形物体描述，无地面和背景","tags":["prop"],"light":null}],"room":null,"terrainGeneration":{"preset":"hills","amplitude":5,"roughness":0.55},"terrain":[],"terrainModifiers":[],"terrainRefinement":{"erosion":0.22,"drainage":0.08,"iterations":3,"talus":46},"terrainSurfaces":[],"waters":[],"waterUpdates":[],"waterRemovals":[],"objects":[],"objectUpdates":[],"objectRemovals":[],"scatters":[],"spawn":null,"renderPromptSuggestions":[]}',
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
  if (!Array.isArray(value) || maxCount <= 0) return [];
  const requests: AssetGenerationRequest[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const input = item as Record<string, unknown>;
    const name = cleanText(input.name, '', 42);
    const prompt = cleanText(input.prompt, '', 500);
    const tags = normalizeAssetTags(input.tags) ?? [];
    const light = normalizeMapAssetLight(input.light);
    const mode = normalizeModelGenerationMode(selectedMode);
    const key = `${name}\n${prompt}`;
    if (!name || !prompt || seen.has(key)) continue;
    seen.add(key);
    requests.push({ name, prompt, tags, ...(light ? { light } : {}), mode });
    if (requests.length === maxCount) break;
  }
  return requests;
}

function hasSpatialOperations(suggestion: MapAiSuggestion): boolean {
  return suggestion.operations.some((operation) =>
    (operation.type === 'map.update' && operation.visualSemantics !== undefined)
    || operation.type === 'room.set'
    || operation.type === 'terrain.brush'
    || operation.type === 'terrain.modify'
    || operation.type === 'terrain.refine'
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

function descendingLevels(levels: number[]): number[] {
  let previous = Number.POSITIVE_INFINITY;
  return levels.map((level) => {
    previous = Math.min(previous, level);
    return previous;
  });
}
