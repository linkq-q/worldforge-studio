import { getMapBounds, sampleTerrainHeight, type EditableMap, type MapAsset } from '../shared/map';
import { applyMapOperations, type MapAiSuggestion } from '../shared/mapOperations';
import type { MapLintIssue } from '../shared/mapLint';
import { normalizeMapAiNewAssetRange } from '../shared/mapPlanning';
import type { AgentProgressEvent, ChatProvider } from '../shared/protocol';
import { normalizeAssetTags, normalizeMapAssetLight, type MapAssetLight } from '../shared/mapAssetMetadata';
import type { ModelGenerationMode } from '../shared/modelGenerationMode';
import { sceneZoneWorldRegion, type SceneCompositionPlan } from '../shared/sceneComposition';
import { validateMapSuggestion } from './mapSuggestionValidation';
import { llmChat, type ChatMessage } from './modelApi';
import { runAssetGenerationPool, type AssetTaskReporter } from './assetGenerationPool';
import {
  executeSceneProgram,
  SCENE_PROGRAM_API_REFERENCE,
  type SceneProgramResult
} from './sceneProgram';

export interface SceneDesignAssetRequest {
  name: string;
  prompt: string;
  tags: string[];
  light?: MapAssetLight;
  mode: ModelGenerationMode;
}

export interface SceneDesignAgentOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  minNewAssets?: number;
  maxNewAssets?: number;
  reuseExistingAssets?: boolean;
  reusableAssetIds?: readonly string[];
  onProgress?: (event: AgentProgressEvent) => void;
  onPreview?: (suggestion: MapAiSuggestion) => void;
  /** Optional high-level director intent. Geometry remains owned by the Scene Program. */
  compositionPlan?: SceneCompositionPlan;
  createAsset: (request: SceneDesignAssetRequest, report: AssetTaskReporter) => Promise<MapAsset>;
  /** Test seam; production uses the configured chat backend. */
  chat?: (messages: readonly ChatMessage[]) => Promise<string>;
}

interface AgentAction {
  action: 'request_assets' | 'write_program' | 'finish';
  summary: string;
  assets?: SceneDesignAssetRequest[];
  program?: string;
}

interface SceneOutcome {
  unmet: string[];
  warnings: string[];
  metrics: {
    guides: number;
    objects: number;
    waterBodies: number;
    grassLayers: number;
    semanticSurfaces: number;
    playableLandRatio: number;
  };
}

const MAX_AGENT_ITERATIONS = 10;
const MAX_DIRECTED_CODE_ITERATIONS = 5;

export async function runSceneDesignAgent(
  prompt: string,
  map: EditableMap,
  initialAssets: readonly MapAsset[],
  options: SceneDesignAgentOptions
): Promise<MapAiSuggestion> {
  const assetRange = normalizeMapAiNewAssetRange(options.minNewAssets, options.maxNewAssets);
  const bounds = getMapBounds(map);
  const assets = permittedInitialAssets(map, initialAssets, options);
  const generatedAssets: MapAsset[] = [];
  const trace: Array<{ iteration: number; action: string; summary: string }> = [];
  const maxIterations = options.compositionPlan ? MAX_DIRECTED_CODE_ITERATIONS : MAX_AGENT_ITERATIONS;
  if (options.compositionPlan) {
    trace.push({ iteration: 0, action: 'director_brief', summary: options.compositionPlan.summary });
  }
  const messages: ChatMessage[] = [{
    role: 'system',
    content: buildSystemPrompt(map, bounds, assetRange.min, assetRange.max, Boolean(options.compositionPlan))
  }, {
    role: 'user',
    content: buildUserPrompt(prompt, map, assets, options.compositionPlan)
  }];
  const chat = options.chat ?? ((history: readonly ChatMessage[]) => llmChat(history, {
    apiBase: options.apiBase,
    provider: options.provider,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    temperature: 0.15,
    maxTokens: 4_500
  }));
  let latestProgram = '';
  let latestResult: SceneProgramResult | null = null;
  let latestIssues: MapLintIssue[] = [];
  let latestOutcome: SceneOutcome | null = null;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    options.signal?.throwIfAborted();
    options.onProgress?.({
      phase: iteration === 1 ? 'planning' : 'replanning',
      label: iteration === 1 ? 'Scene Agent 正在观察地图与资产' : `Scene Agent 正在进行第 ${iteration} 轮决策`,
      current: iteration,
      total: maxIterations
    });
    const content = await chat(messages);
    messages.push({ role: 'assistant', content });
    let action: AgentAction;
    try {
      action = parseAgentAction(content, map.assetGenerationMode, assetRange.max - generatedAssets.length);
    } catch (error) {
      trace.push({ iteration, action: 'invalid_response', summary: errorMessage(error) });
      messages.push({ role: 'user', content: JSON.stringify({
        tool: 'parse_action',
        ok: false,
        error: errorMessage(error),
        instruction: 'Return one valid JSON action object and continue from the existing tool state.'
      }) });
      continue;
    }
    trace.push({ iteration, action: action.action, summary: action.summary });

    if (action.action === 'request_assets') {
      if (!action.assets?.length) {
        messages.push({ role: 'user', content: JSON.stringify({
          tool: 'request_assets',
          ok: false,
          error: 'No valid asset requests remain within the configured asset budget. Use available assets or write the program.'
        }) });
        continue;
      }
      const created = await runAssetGenerationPool(
        action.assets,
        (request, _index, report) => options.createAsset(request, report),
        { signal: options.signal, onProgress: options.onProgress }
      );
      assets.push(...created);
      generatedAssets.push(...created);
      messages.push({ role: 'user', content: JSON.stringify({
        tool: 'request_assets',
        ok: true,
        assets: created.map(assetManifestItem),
        remainingAssetBudget: assetRange.max - generatedAssets.length
      }) });
      continue;
    }

    if (action.action === 'write_program') {
      if (!action.program) throw new Error('scene_agent_missing_program');
      options.onProgress?.({ phase: 'compiling', label: '解释执行 Scene Program 并检查空间约束' });
      try {
        let result = executeSceneProgram(action.program, map, assets);
        const executionValidation = validateMapSuggestion(map, {
          summary: action.summary,
          operations: result.operations,
          renderPromptSuggestions: result.renderPromptSuggestions,
          generatedAssets: []
        });
        result = { ...result, operations: executionValidation.suggestion.operations };
        latestProgram = action.program;
        latestResult = result;
        latestIssues = executionValidation.issues;
        const candidate = applyMapOperations(map, latestResult.operations);
        const outcome = evaluateSceneOutcome(prompt, map, candidate, assets, generatedAssets, latestResult, latestIssues);
        latestOutcome = outcome;
        messages.push({ role: 'user', content: JSON.stringify({
          tool: 'execute_program',
          ok: true,
          operationCount: latestResult.operations.length,
          guideCount: latestResult.guideCount,
          objectCount: latestResult.objectCount,
          diagnostics: latestResult.diagnostics,
          lintIssues: executionValidation.issues,
          automaticRepairCount: executionValidation.repairCount,
          outcome
        }) });
        options.onPreview?.(finalizeAgentSuggestion(
          map, latestProgram, latestResult, generatedAssets, trace, iteration, action.summary, outcome
        ));
      } catch (error) {
        messages.push({ role: 'user', content: JSON.stringify({
          tool: 'execute_program',
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }) });
      }
      continue;
    }

    if (!latestResult || !latestProgram) {
      messages.push({ role: 'user', content: JSON.stringify({
        tool: 'finish', ok: false, error: 'No successful Scene Program exists. Write or repair one before finishing.'
      }) });
      continue;
    }
    if (generatedAssets.length < assetRange.min) {
      messages.push({ role: 'user', content: JSON.stringify({
        tool: 'finish',
        ok: false,
        error: `The user requires at least ${assetRange.min} new assets; only ${generatedAssets.length} have been created. Request the missing reusable assets before finishing.`
      }) });
      continue;
    }
    const candidate = applyMapOperations(map, latestResult.operations);
    const outcome = evaluateSceneOutcome(prompt, map, candidate, assets, generatedAssets, latestResult, latestIssues);
    if (outcome.unmet.length > 0) {
      messages.push({ role: 'user', content: JSON.stringify({
        tool: 'finish',
        ok: false,
        error: 'Scene outcome requirements are not yet satisfied.',
        outcome
      }) });
      continue;
    }
    return finalizeAgentSuggestion(
      map, latestProgram, latestResult, generatedAssets, trace, iteration, action.summary, outcome
    );
  }

  if (latestProgram && latestResult && latestOutcome) {
    const unmet = [...latestOutcome.unmet];
    if (generatedAssets.length < assetRange.min) {
      unmet.push(`new-assets-minimum:${generatedAssets.length}/${assetRange.min}`);
    }
    const outcome = { ...latestOutcome, unmet: [...new Set(unmet)] };
    return finalizeAgentSuggestion(
      map,
      latestProgram,
      latestResult,
      generatedAssets,
      trace,
      maxIterations,
      outcome.unmet.length > 0
        ? 'Scene Agent 已达到决策上限，保留最后一个可执行候选供审阅'
        : trace.at(-1)?.summary ?? 'Scene Agent 已生成可执行候选',
      outcome
    );
  }
  throw new Error('scene_agent_no_executable_program');
}

function finalizeAgentSuggestion(
  map: EditableMap,
  program: string,
  result: SceneProgramResult,
  generatedAssets: readonly MapAsset[],
  trace: Array<{ iteration: number; action: string; summary: string }>,
  iterations: number,
  summary: string,
  outcome?: SceneOutcome
): MapAiSuggestion {
  const outcomeDiagnostics = outcome?.unmet.map((item) => ({
    severity: 'warning' as const,
    code: 'scene-outcome-unmet',
    message: `尚未完全满足：${item}`
  })) ?? [];
  const suggestion: MapAiSuggestion = {
    summary: summary || `Scene Agent 生成了 ${result.guideCount} 条引导线和 ${result.objectCount} 个物体`,
    operations: result.operations,
    renderPromptSuggestions: result.renderPromptSuggestions,
    generatedAssets: generatedAssets.map((asset) => ({ id: asset.id, name: asset.name })),
    blocked: Boolean(outcome?.unmet.length),
    agent: {
      program,
      iterations,
      guideCount: result.guideCount,
      objectCount: result.objectCount,
      diagnostics: [...result.diagnostics, ...outcomeDiagnostics],
      trace
    }
  };
  return validateMapSuggestion(map, suggestion).suggestion;
}

function buildSystemPrompt(
  map: EditableMap,
  bounds: ReturnType<typeof getMapBounds>,
  minNewAssets: number,
  maxNewAssets: number,
  directedCode: boolean
): string {
  return [
    directedCode
      ? 'You are WorldForge Code Composer. A creative director has already supplied the scene hierarchy; express it as one coherent procedural Scene Program. Local code owns physics and safety.'
      : 'You are WorldForge Scene Agent, a bounded spatial-design agent. You decide the next tool action; local code owns physics and safety.',
    'Return exactly one JSON object, never Markdown.',
    'Actions:',
    '{"action":"request_assets","summary":"...","assets":[{"name":"...","prompt":"standalone low-poly object, no ground/background","tags":["short-english-tag"]}]}',
    '{"action":"write_program","summary":"...","program":"const path = scene.guide(...); ..."}',
    '{"action":"finish","summary":"..."}',
    `You must request ${minNewAssets}-${maxNewAssets} new reusable assets across the run. Reuse listed assets for the remaining roles when suitable. Never invent asset IDs.`,
    ...(directedCode ? [
      'Treat the director brief as creative intent, not literal coordinates or a checklist of isolated zones. Preserve its focal hierarchy, connected structures, circulation, density rhythm and intentional negative space.',
      'Request all missing asset families in one action when possible, then write one complete program. After a successful execution, finish when hard outcome requirements pass; otherwise make one targeted program repair.'
    ] : []),
    'After execute_program, inspect outcome.unmet, outcome.warnings, counts and diagnostics. You may finish only when outcome.unmet is empty.',
    'Build outdoor scenes in layers: macro terrain, local terrain modifiers, drainage/water, semantic surfaces and grass, guides, relationship-aware objects, then spawn and render suggestions.',
    'Use guides for authored environments: parks, campuses, farms, plazas, roads, waterfronts and building groups. Surface important guides and use scatter only for natural populations.',
    'For cities, towns and campuses, prefer scene.streetGrid and iterate both streets and blocks instead of drawing unrelated parallel lines.',
    'Asset manifests include local size=[x,y,z] and longAxis. For modular walls, arcades and grandstands whose longAxis is x, use placeAlong(..., { align:"side", contact:"seam" }); this keeps local X along the guide, allows only this assembly call to meet at seams, and keeps local +Z on the guide-left side. Order ring guides so the intended front is on the left.',
    'For tiered, stacked or multi-level structures, request reusable structural modules and connect them with scene.placeOn or scene.mountOn. Do not fake vertical hierarchy with unrelated ground objects.',
    'Every generated asset must be placed by the successful program. Never leave paid/generated assets unused.',
    `Map sceneMode=${map.sceneMode}; bounds X ${bounds.minX}..${bounds.maxX}, Z ${bounds.minZ}..${bounds.maxZ}; seed=${map.seed}.`,
    SCENE_PROGRAM_API_REFERENCE
  ].join('\n');
}

function buildUserPrompt(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  compositionPlan?: SceneCompositionPlan
): string {
  const brief = compositionPlan
    ? `\n\nCreative director brief (world-space regions): ${JSON.stringify(compactDirectorBrief(compositionPlan, map))}`
    : '';
  return `${prompt}${brief}\n\nAvailable assets: ${JSON.stringify(assets.slice(0, 120).map(assetManifestItem))}`;
}

function compactDirectorBrief(plan: SceneCompositionPlan, map: EditableMap): unknown {
  return {
    summary: plan.summary,
    global: {
      spatialTheme: plan.globalBrief.spatialTheme,
      visualHierarchy: plan.globalBrief.visualHierarchy,
      assetArtDirection: plan.globalBrief.assetArtDirection,
      focalZoneId: plan.globalBrief.focalZoneId,
      terrainBase: plan.globalBrief.terrainBase
    },
    requirements: plan.intentRequirements.map((requirement) => ({
      description: requirement.description,
      targetZoneId: requirement.targetZoneId,
      familyId: requirement.familyId,
      minCount: requirement.minCount
    })),
    zones: plan.zones.map((zone) => ({
      id: zone.id,
      label: zone.label,
      role: zone.role,
      importance: zone.importance,
      worldRegion: sceneZoneWorldRegion(zone, map),
      brief: zone.brief,
      terrain: zone.terrain,
      water: zone.water,
      familyIds: zone.layers.map((layer) => layer.familyId)
    })),
    transitions: plan.transitions,
    assetFamilies: plan.assetFamilies.map((family) => ({
      id: family.id,
      label: family.label,
      role: family.role,
      tags: family.tags,
      sizeClass: family.sizeClass,
      desiredVariants: family.desiredVariants,
      generationBrief: family.generationBrief
    }))
  };
}

function assetManifestItem(asset: MapAsset): unknown {
  const size = assetColliderSize(asset);
  return {
    id: asset.id,
    name: asset.name,
    tags: asset.tags ?? [],
    footprintRadius: asset.footprintRadius ?? null,
    sizeClass: asset.sizeClass ?? null,
    size,
    longAxis: size[0] > size[2] * 1.15 ? 'x' : size[2] > size[0] * 1.15 ? 'z' : 'square'
  };
}

function assetColliderSize(asset: MapAsset): [number, number, number] {
  const boxes = asset.colliderPlan?.boxes ?? [];
  if (boxes.length === 0) {
    const diameter = Math.max(0.2, (asset.footprintRadius ?? 0.5) * 2);
    return [diameter, asset.sizeClass === 'large' ? 3 : asset.sizeClass === 'medium' ? 1.8 : 1, diameter];
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], box.min[axis]);
      max[axis] = Math.max(max[axis], box.max[axis]);
    }
  }
  return max.map((value, axis) => Number((value - min[axis]).toFixed(3))) as [number, number, number];
}

function permittedInitialAssets(
  map: EditableMap,
  initialAssets: readonly MapAsset[],
  options: Pick<SceneDesignAgentOptions, 'reuseExistingAssets' | 'reusableAssetIds'>
): MapAsset[] {
  const allowed = new Set<string>();
  for (const asset of map.assets ?? []) allowed.add(asset.id);
  for (const object of map.objects) if (object.assetId) allowed.add(object.assetId);
  if (options.reuseExistingAssets) {
    for (const assetId of options.reusableAssetIds ?? []) allowed.add(assetId);
  }
  return initialAssets.filter((asset) => allowed.has(asset.id));
}

function evaluateSceneOutcome(
  prompt: string,
  original: EditableMap,
  candidate: EditableMap,
  assets: readonly MapAsset[],
  generatedAssets: readonly MapAsset[],
  result: SceneProgramResult,
  lintIssues: readonly MapLintIssue[]
): SceneOutcome {
  const text = prompt.toLowerCase();
  const operationTypes = new Set(result.operations.map((operation) => operation.type));
  const placedAssetIds = new Set(candidate.objects.flatMap((object) => object.assetId ? [object.assetId] : []));
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const placedWords = candidate.objects.flatMap((object) => {
    const asset = object.assetId ? assetById.get(object.assetId) : undefined;
    return [object.name, asset?.name ?? '', ...(asset?.tags ?? [])];
  }).join(' ').toLowerCase();
  const authoredEnvironment = hasAny(text, [
    'park', 'campus', 'farm', 'plaza', 'road', 'street', 'city', 'town', 'village', 'waterfront',
    '公园', '校园', '农场', '农田', '广场', '道路', '街道', '城市', '城镇', '村庄', '滨水'
  ]);
  const needsWater = hasAny(text, ['seaside', 'coast', 'waterfront', 'river', 'lake', 'ocean', 'beach', '海边', '海岸', '滨水', '河', '湖', '海', '沙滩']);
  const needsTerrain = hasAny(text, [
    'mountain', 'hill', 'valley', 'island', 'cliff', 'dune',
    '雪山', '高山', '山地', '山脉', '山峰', '丘陵', '山谷', '峡谷', '岛', '悬崖', '沙丘'
  ]);
  const needsVegetation = hasAny(text, ['park', 'forest', 'garden', 'farm', 'field', 'orchard', 'crop', '公园', '森林', '花园', '农场', '农田', '田野', '果园', '作物']);
  const needsBuildings = hasAny(text, ['campus', 'city', 'town', 'village', 'school', '校园', '城市', '城镇', '村庄', '学校']);
  const needsLayeredStructure = hasAny(text, [
    'multi-level', 'multilevel', 'multi-storey', 'multi-story', 'tiered', 'stacked', 'layered structure',
    'grandstand', 'bleacher', 'stepped seating', 'tiered seating', 'arena seating',
    '多层', '层叠', '叠层', '分层建筑', '上下堆叠', '环形看台', '阶梯看台', '台阶看台'
  ]);
  const semanticSurfaces = result.operations.filter((operation) => operation.type === 'terrain.surface').length;
  const playableLandRatio = sampledPlayableLandRatio(candidate);
  const unmet: string[] = [];
  const firstObjectIndex = result.operations.findIndex((operation) => operation.type === 'object.add');
  if (firstObjectIndex >= 0 && result.operations.slice(firstObjectIndex + 1).some((operation) => (
    operation.type === 'terrain.generate' || operation.type === 'terrain.modify' || operation.type === 'water.add'
  ))) unmet.push('terrain-and-water-must-precede-object-placement');
  if (authoredEnvironment && candidate.guides.length <= original.guides.length) unmet.push('authored-environment-needs-guides');
  if (authoredEnvironment && semanticSurfaces === 0 && candidate.grassLayers.length === original.grassLayers.length
    && candidate.waterBodies.length === original.waterBodies.length) unmet.push('authored-environment-needs-surface-treatment');
  if (authoredEnvironment && candidate.objects.length - original.objects.length < 3) unmet.push('authored-environment-needs-more-spatial-content');
  if (needsWater && candidate.waterBodies.length <= original.waterBodies.length) unmet.push('requested-water-is-missing');
  if (candidate.waterBodies.some((water) => water.type === 'ocean') && playableLandRatio < 0.15) {
    unmet.push('ocean-scene-needs-playable-land');
  }
  if (needsTerrain && !operationTypes.has('terrain.generate') && !operationTypes.has('terrain.modify')) unmet.push('requested-terrain-form-is-missing');
  if (needsVegetation && !hasAny(placedWords, ['tree', 'plant', 'crop', 'flower', 'grass', 'bush', '树', '植物', '作物', '花', '草', '灌木'])
    && candidate.grassLayers.length === original.grassLayers.length) unmet.push('requested-vegetation-is-missing');
  if (needsBuildings && !hasAny(placedWords, ['building', 'house', 'hall', 'school', 'tower', '建筑', '房', '大厅', '教学楼', '塔'])) {
    unmet.push('requested-buildings-are-missing');
  }
  const originalObjectIds = new Set(original.objects.map((object) => object.id));
  if (needsLayeredStructure && !candidate.objects.some((object) => !originalObjectIds.has(object.id) && object.parentId)) {
    unmet.push('requested-layered-structure-is-missing');
  }
  const unplacedGenerated = generatedAssets.filter((asset) => !placedAssetIds.has(asset.id));
  if (unplacedGenerated.length > 0) unmet.push(`generated-assets-unplaced:${unplacedGenerated.map((asset) => asset.id).join(',')}`);
  for (const issue of lintIssues) {
    if (issue.severity === 'error' && !issue.repaired) unmet.push(`lint:${issue.code}`);
  }
  if (result.diagnostics.some((diagnostic) => diagnostic.code === 'asset-not-found')) unmet.push('program-references-missing-assets');
  const warnings: string[] = [];
  if (result.renderPromptSuggestions.length === 0) warnings.push('no-render-suggestion');
  if (!operationTypes.has('reference.set')) warnings.push('no-explicit-safe-spawn');
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.severity === 'warning' && diagnostic.code !== 'asset-not-found') warnings.push(diagnostic.code);
  }
  return {
    unmet: [...new Set(unmet)],
    warnings: [...new Set(warnings)],
    metrics: {
      guides: candidate.guides.length - original.guides.length,
      objects: candidate.objects.length - original.objects.length,
      waterBodies: candidate.waterBodies.length - original.waterBodies.length,
      grassLayers: candidate.grassLayers.length - original.grassLayers.length,
      semanticSurfaces,
      playableLandRatio
    }
  };
}

function sampledPlayableLandRatio(map: EditableMap): number {
  const oceans = map.waterBodies.filter((water) => water.type === 'ocean');
  if (oceans.length === 0) return 1;
  const bounds = getMapBounds(map);
  const seaLevel = Math.max(...oceans.map((water) => water.level));
  let land = 0;
  let total = 0;
  for (let zIndex = 0; zIndex < 9; zIndex += 1) {
    for (let xIndex = 0; xIndex < 9; xIndex += 1) {
      const x = bounds.minX + (xIndex + 0.5) / 9 * (bounds.maxX - bounds.minX);
      const z = bounds.minZ + (zIndex + 0.5) / 9 * (bounds.maxZ - bounds.minZ);
      if (sampleTerrainHeight(map, x, z) > seaLevel + 0.02) land += 1;
      total += 1;
    }
  }
  return total > 0 ? land / total : 0;
}

function hasAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseAgentAction(content: string, mode: ModelGenerationMode, remainingAssetBudget: number): AgentAction {
  const object = parseJsonObject(content);
  const action = object.action;
  const summary = typeof object.summary === 'string' ? object.summary.trim().slice(0, 240) : '';
  if (action === 'finish') return { action, summary };
  if (action === 'write_program') {
    if (typeof object.program !== 'string' || !object.program.trim()) throw new Error('scene_agent_missing_program');
    return { action, summary, program: object.program };
  }
  if (action === 'request_assets') {
    const requests = Array.isArray(object.assets) ? object.assets : [];
    const seen = new Set<string>();
    const assets: SceneDesignAssetRequest[] = [];
    for (const raw of requests) {
      if (!raw || typeof raw !== 'object' || assets.length >= Math.max(0, remainingAssetBudget)) continue;
      const item = raw as Record<string, unknown>;
      const name = typeof item.name === 'string' ? item.name.trim().slice(0, 42) : '';
      const prompt = typeof item.prompt === 'string' ? item.prompt.trim().slice(0, 500) : '';
      if (!name || !prompt || seen.has(`${name}\n${prompt}`)) continue;
      seen.add(`${name}\n${prompt}`);
      const light = normalizeMapAssetLight(item.light);
      assets.push({
        name,
        prompt,
        tags: normalizeAssetTags(item.tags) ?? [],
        ...(light ? { light } : {}),
        mode
      });
    }
    return { action, summary, assets };
  }
  throw new Error('invalid_scene_agent_action');
}

function parseJsonObject(content: string): Record<string, unknown> {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('invalid_scene_agent_json');
  try {
    return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('invalid_scene_agent_json');
  }
}
