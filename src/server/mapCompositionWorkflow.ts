import type { EditableMap, MapAsset } from '../shared/map';
import type { MapAiSuggestion } from '../shared/mapOperations';
import { normalizeMapAiNewAssetRange } from '../shared/mapPlanning';
import { completeIndoorScenePlan } from '../shared/indoorScenePlanning';
import { CHAT_PROVIDER_OPTIONS, type AgentProgressEvent, type ChatProvider } from '../shared/protocol';
import {
  ensureMinimumSceneCoverage,
  enforcePromptSceneIntent,
  isCompositionEmptyMap,
  normalizeSceneCompositionPlan,
  SCENE_COMPOSITION_LIMITS,
  type SceneCompositionPlan
} from '../shared/sceneComposition';
import {
  applySceneAdvice,
  normalizeScenePlanAdvice,
  normalizeSceneReview,
  type SceneReviewResult
} from '../shared/sceneCompositionAdvice';
import {
  attachGeneratedSceneAssets,
  fitSceneAssetVariantBudget,
  resolveSceneFamilies
} from '../shared/sceneCompositionAssets';
import { compileSceneComposition } from '../shared/sceneCompositionCompiler';
import { ensureSceneCompositionOutcome } from '../shared/sceneCompositionOutcome';
import type { ModelGenerationMode } from '../shared/modelGenerationMode';
import type { MapAssetLight } from '../shared/mapAssetMetadata';
import { runAssetGenerationPool, type AssetTaskReporter } from './assetGenerationPool';
import { llmChat } from './modelApi';
import { parseLlmJsonObject } from './llmJson';
import {
  buildSceneDirectorPrompt,
  buildSceneReviewerPrompt,
  buildSceneSpecialistPrompt,
  buildStructuredRepairPrompt
} from './mapCompositionPrompts';

export interface MapCompositionWorkflowOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
  reuseExistingAssets?: boolean;
  reusableAssetIds?: readonly string[];
  minNewAssets?: number;
  maxNewAssets?: number;
  approvedCompositionPlan?: SceneCompositionPlan;
  createAsset: (request: {
    name: string;
    prompt: string;
    tags: string[];
    light?: MapAssetLight;
    mode: ModelGenerationMode;
  }, report: AssetTaskReporter) => Promise<MapAsset>;
}
export type MapCompositionPlanningOptions = Omit<MapCompositionWorkflowOptions, 'createAsset' | 'approvedCompositionPlan'>;
export interface MapCompositionWorkflowResult {
  suggestion: MapAiSuggestion;
  assets: MapAsset[];
}

export async function planMapComposition(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapCompositionPlanningOptions
): Promise<SceneCompositionPlan> {
  if (!isCompositionEmptyMap(map)) throw new Error('map_composition_requires_empty_map');
  const cleanPrompt = prompt.trim().slice(0, 1_200);
  if (!cleanPrompt) throw new Error('missing_prompt');
  const provider = options.provider ?? 'gpt';
  const providerOption = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
  if (!providerOption || providerOption.disabled) throw new Error('provider_unavailable');
  const assetRange = normalizeMapAiNewAssetRange(options.minNewAssets, options.maxNewAssets);
  const reusableIds = options.reusableAssetIds ? new Set(options.reusableAssetIds) : null;
  const reusableAssets = options.reuseExistingAssets
    ? assets.filter((asset) => (
        (!reusableIds || reusableIds.has(asset.id))
        && asset.libraryMetadata?.analysisStatus !== 'pending'
        && asset.libraryMetadata?.enabled !== false
      ))
    : [];
  options.onProgress?.({ phase: 'composing', label: '场景总导演正在生成可确认的俯视空间规划' });
  return requestStructured(
    'scene composition plan',
    buildSceneDirectorPrompt(map, reusableAssets, {
      reuseExistingAssets: options.reuseExistingAssets === true,
      minNewAssets: assetRange.min,
      maxNewAssets: assetRange.max
    }),
    cleanPrompt,
    (value) => normalizeCompositionPlan(value, map, cleanPrompt, assetRange.min, assetRange.max),
    options,
    0.45
  );
}

export async function runMapCompositionWorkflow(
  prompt: string,
  map: EditableMap,
  assets: readonly MapAsset[],
  options: MapCompositionWorkflowOptions
): Promise<MapCompositionWorkflowResult> {
  if (!isCompositionEmptyMap(map)) throw new Error('map_composition_requires_empty_map');
  const cleanPrompt = prompt.trim().slice(0, 1_200);
  if (!cleanPrompt) throw new Error('missing_prompt');
  const provider = options.provider ?? 'gpt';
  const providerOption = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
  if (!providerOption || providerOption.disabled) throw new Error('provider_unavailable');
  const assetRange = normalizeMapAiNewAssetRange(options.minNewAssets, options.maxNewAssets);
  const reusableIds = options.reusableAssetIds ? new Set(options.reusableAssetIds) : null;
  const reusableAssets = options.reuseExistingAssets
    ? assets.filter((asset) => (
        (!reusableIds || reusableIds.has(asset.id))
        && asset.libraryMetadata?.analysisStatus !== 'pending'
        && asset.libraryMetadata?.enabled !== false
      ))
    : [];

  if (!options.approvedCompositionPlan) {
    options.onProgress?.({ phase: 'composing', label: '场景总导演正在组织区域、主次与资产家族' });
  }
  let plan = options.approvedCompositionPlan
    ? normalizeCompositionPlan(options.approvedCompositionPlan, map, cleanPrompt, assetRange.min, assetRange.max)
    : await requestStructured(
    'scene composition plan',
    buildSceneDirectorPrompt(map, reusableAssets, {
      reuseExistingAssets: options.reuseExistingAssets === true,
      minNewAssets: assetRange.min,
      maxNewAssets: assetRange.max
    }),
    cleanPrompt,
    (value) => normalizeCompositionPlan(value, map, cleanPrompt, assetRange.min, assetRange.max),
    options,
    0.45
  );

  const consultationTrace: NonNullable<MapAiSuggestion['composition']>['consultations'] = [];
  const consultations = options.approvedCompositionPlan
    ? []
    : [...plan.consultations].sort((left, right) => right.priority - left.priority);
  for (const [index, consultation] of consultations.entries()) {
    options.signal?.throwIfAborted();
    options.onProgress?.({
      phase: 'consulting',
      label: `专家会诊 ${index + 1}/${consultations.length}：${consultation.discipline}`,
      current: index + 1,
      total: consultations.length,
      detail: consultation.question
    });
    try {
      const advice = await requestStructured(
        `scene specialist advice (${consultation.id})`,
        buildSceneSpecialistPrompt(plan, consultation),
        'Provide focused advice for the requested scene relationship.',
        (value) => normalizeScenePlanAdvice(value, plan, map, SCENE_COMPOSITION_LIMITS.specialistPatchCount),
        options,
        0.3
      );
      plan = enforcePromptSceneIntent(
        ensureMinimumSceneCoverage(applySceneAdvice(plan, advice, map), map),
        cleanPrompt,
        map
      );
      consultationTrace.push({
        id: consultation.id,
        summary: advice.summary,
        findings: advice.findings
      });
    } catch (error) {
      consultationTrace.push({
        id: consultation.id,
        summary: '专家建议未通过结构校验，已跳过，不影响主流程。',
        findings: [{
          code: 'consultation.invalid',
          severity: 'warning',
          message: error instanceof Error ? error.message : String(error)
        }]
      });
    }
  }

  options.onProgress?.({ phase: 'resolving-assets', label: '按语义标签和地图建模模式匹配可复用资产' });
  const initialResolution = resolveSceneFamilies(
    plan,
    map,
    reusableAssets,
    assetRange.max,
    assetRange.min
  );
  const generatedResults = await runAssetGenerationPool(initialResolution.gaps, async (gap, _index, report) => {
    try {
      const asset = await options.createAsset({
        name: gap.name,
        prompt: gap.prompt,
        tags: gap.tags,
        light: gap.light,
        mode: map.assetGenerationMode
      }, report);
      if (asset.mode !== map.assetGenerationMode) throw new Error('generated_asset_mode_mismatch');
      return { familyId: gap.familyId, asset };
    } catch (error) {
      options.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('map_asset_generation_failed:')
        || /failed to fetch|econnrefused|networkerror|socket|connection (?:closed|reset)|terminated|service_unreachable/i.test(message)) {
        throw error;
      }
      report({ status: 'failed', detail: message });
      return null;
    }
  }, { signal: options.signal, onProgress: options.onProgress });
  const generated = generatedResults.filter((entry): entry is { familyId: string; asset: MapAsset } => entry !== null);
  const resolvedFamilies = attachGeneratedSceneAssets(initialResolution.families, generated);
  const expandedAssets = [...assets, ...generated.map((entry) => entry.asset)];
  const assetMinimumShortfall = Math.max(0, assetRange.min - generated.length);
  if (assetMinimumShortfall > 0) {
    options.onProgress?.({
      phase: 'repairing',
      label: `新资产少于下限 ${assetMinimumShortfall} 个，已保留可执行场景并继续`,
      detail: `目标至少 ${assetRange.min} 个，实际生成 ${generated.length} 个`
    });
  }

  options.onProgress?.({ phase: 'compiling', label: '将场景意图编译为可编辑地形、水体和资产操作' });
  let compiled = compileSceneComposition(map, plan, resolvedFamilies);
  let outcome = ensureSceneCompositionOutcome(map, plan, resolvedFamilies, compiled);
  compiled = outcome.compiled;
  const outcomeWarnings = outcome.checks.filter((check) => check.status === 'warning');
  options.onProgress?.({
    phase: outcome.repairCount > 0 || outcomeWarnings.length > 0 ? 'repairing' : 'validating',
    label: outcomeWarnings.length > 0
      ? `实体结果审查已自动降级 ${outcomeWarnings.length} 项，其他内容继续生成`
      : outcome.repairCount > 0
      ? `实体结果审查补齐 ${outcome.repairCount} 项必要内容`
      : '实体结果审查已确认地形、水体与必要资产均已落地',
    current: outcome.checks.length,
    total: outcome.checks.length,
    detail: outcomeWarnings.map((check) => check.message).join('；') || undefined
  });

  options.onProgress?.({ phase: 'reviewing', label: '合成审查正在检查焦点、留白、重复和尺度关系' });
  let review: SceneReviewResult;
  try {
    review = await requestStructured(
      'scene composition review',
      buildSceneReviewerPrompt(plan, compiled.metrics, resolvedFamilies),
      'Review the compiled scene composition and return only necessary differential corrections.',
      (value) => normalizeSceneReview(value, plan, map),
      options,
      0.15
    );
  } catch (error) {
    review = {
      status: 'pass',
      summary: '合成审查未通过结构校验；保留已验证的导演方案。',
      findings: [{
        code: 'review.invalid',
        severity: 'warning',
        message: error instanceof Error ? error.message : String(error)
      }],
      patches: []
    };
  }
  if (review.status === 'revise' && review.patches.length > 0) {
    plan = enforcePromptSceneIntent(
      ensureMinimumSceneCoverage(applySceneAdvice(plan, review, map), map),
      cleanPrompt,
      map
    );
    compiled = compileSceneComposition(map, plan, resolvedFamilies);
    outcome = ensureSceneCompositionOutcome(map, plan, resolvedFamilies, compiled);
    compiled = outcome.compiled;
  }

  return {
    assets: expandedAssets,
    suggestion: {
      summary: plan.summary,
      operations: compiled.operations,
      renderPromptSuggestions: plan.renderPromptSuggestions,
      generatedAssets: generated.map(({ asset }) => ({ id: asset.id, name: asset.name })),
      ...(assetMinimumShortfall > 0 ? {
        diagnostics: [{
          code: 'asset.minimum-degraded',
          severity: 'warning' as const,
          message: `本次实际生成 ${generated.length} 个新资产，低于设置的最少 ${assetRange.min} 个；系统已保留可执行内容并继续，没有中断本次生成。`,
          repaired: false
        }]
      } : {}),
      composition: {
        plan,
        metrics: compiled.metrics,
        consultations: consultationTrace,
        review,
        outcome: { checks: outcome.checks, repairCount: outcome.repairCount }
      }
    }
  };
}

function normalizeCompositionPlan(
  value: unknown,
  map: EditableMap,
  prompt: string,
  minimumAssets: number,
  maximumAssets: number
): SceneCompositionPlan {
  const normalized = normalizeSceneCompositionPlan(value, map);
  const covered = ensureMinimumSceneCoverage({
    ...normalized,
    assetFamilies: normalized.assetFamilies.map((family) => ({ ...family, desiredVariants: 1 }))
  }, map);
  const contracted = enforcePromptSceneIntent(covered, prompt, map);
  const completed = completeIndoorScenePlan(contracted, map, prompt, minimumAssets, maximumAssets);
  const budgeted = fitSceneAssetVariantBudget(completed, minimumAssets, maximumAssets);
  return enforcePromptSceneIntent(budgeted, prompt, map);
}

async function requestStructured<T>(
  kind: string,
  systemPrompt: string,
  userPrompt: string,
  normalize: (value: unknown) => T,
  options: MapCompositionPlanningOptions,
  temperature: number
): Promise<T> {
  let content = await requestModel(systemPrompt, userPrompt, options, temperature);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return normalize(parseLlmJsonObject(content, 'invalid_agent_json'));
    } catch (error) {
      options.signal?.throwIfAborted();
      if (attempt === 3) throw error;
      content = await requestModel(
        systemPrompt,
        buildStructuredRepairPrompt(kind, content, error),
        options,
        Math.min(temperature, 0.15)
      );
    }
  }
  throw new Error('invalid_agent_json');
}

function requestModel(
  systemPrompt: string,
  userPrompt: string,
  options: MapCompositionPlanningOptions,
  temperature: number
): Promise<string> {
  return llmChat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], {
    apiBase: options.apiBase,
    provider: options.provider ?? 'gpt',
    temperature,
    maxTokens: 8_192,
    fetchImpl: options.fetchImpl,
    signal: options.signal
  });
}
