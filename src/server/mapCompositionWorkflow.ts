import { getMapBounds, type EditableMap, type MapAsset } from '../shared/map';
import type { MapAiSuggestion } from '../shared/mapOperations';
import { planLimits } from '../shared/mapPlanning';
import { CHAT_PROVIDER_OPTIONS, type AgentProgressEvent, type ChatProvider } from '../shared/protocol';
import {
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
  resolveSceneFamilies
} from '../shared/sceneCompositionAssets';
import { compileSceneComposition } from '../shared/sceneCompositionCompiler';
import type { ModelGenerationMode } from '../shared/modelGenerationMode';
import { llmChat } from './modelApi';
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
  createAsset: (request: {
    name: string;
    prompt: string;
    tags: string[];
    mode: ModelGenerationMode;
  }) => Promise<MapAsset>;
}

export interface MapCompositionWorkflowResult {
  suggestion: MapAiSuggestion;
  assets: MapAsset[];
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

  options.onProgress?.({ phase: 'composing', label: '场景总导演正在组织区域、主次与资产家族' });
  let plan = await requestStructured(
    'scene composition plan',
    buildSceneDirectorPrompt(map, assets),
    cleanPrompt,
    (value) => normalizeSceneCompositionPlan(value, map),
    options,
    0.45
  );

  const consultationTrace: NonNullable<MapAiSuggestion['composition']>['consultations'] = [];
  const consultations = [...plan.consultations].sort((left, right) => right.priority - left.priority);
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
      plan = applySceneAdvice(plan, advice, map);
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

  const limits = planLimits(getMapBounds(map));
  options.onProgress?.({ phase: 'resolving-assets', label: '按语义标签和地图建模模式匹配可复用资产' });
  const initialResolution = resolveSceneFamilies(plan, map, assets, limits.assetRequestCount);
  const generated: Array<{ familyId: string; asset: MapAsset }> = [];
  for (const [index, gap] of initialResolution.gaps.entries()) {
    options.signal?.throwIfAborted();
    options.onProgress?.({
      phase: 'generating-asset',
      label: `生成必要资产 ${index + 1}/${initialResolution.gaps.length}：${gap.name}`,
      current: index + 1,
      total: initialResolution.gaps.length
    });
    const asset = await options.createAsset({
      name: gap.name,
      prompt: gap.prompt,
      tags: gap.tags,
      mode: map.assetGenerationMode
    });
    if (asset.mode !== map.assetGenerationMode) throw new Error('generated_asset_mode_mismatch');
    generated.push({ familyId: gap.familyId, asset });
  }
  const resolvedFamilies = attachGeneratedSceneAssets(initialResolution.families, generated);
  const expandedAssets = [...assets, ...generated.map((entry) => entry.asset)];

  options.onProgress?.({ phase: 'compiling', label: '将场景意图编译为可编辑地形、水体和资产操作' });
  let compiled = compileSceneComposition(map, plan, resolvedFamilies);

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
    plan = applySceneAdvice(plan, review, map);
    compiled = compileSceneComposition(map, plan, resolvedFamilies);
  }

  return {
    assets: expandedAssets,
    suggestion: {
      summary: plan.summary,
      operations: compiled.operations,
      renderPromptSuggestions: plan.renderPromptSuggestions,
      generatedAssets: generated.map(({ asset }) => ({ id: asset.id, name: asset.name })),
      composition: {
        plan,
        metrics: compiled.metrics,
        consultations: consultationTrace,
        review
      }
    }
  };
}

async function requestStructured<T>(
  kind: string,
  systemPrompt: string,
  userPrompt: string,
  normalize: (value: unknown) => T,
  options: MapCompositionWorkflowOptions,
  temperature: number
): Promise<T> {
  const first = await requestModel(systemPrompt, userPrompt, options, temperature);
  try {
    return normalize(parseJsonObject(first));
  } catch (error) {
    options.signal?.throwIfAborted();
    const repaired = await requestModel(
      systemPrompt,
      buildStructuredRepairPrompt(kind, first, error),
      options,
      Math.min(temperature, 0.15)
    );
    return normalize(parseJsonObject(repaired));
  }
}

function requestModel(
  systemPrompt: string,
  userPrompt: string,
  options: MapCompositionWorkflowOptions,
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

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('invalid_agent_json');
  const parsed = JSON.parse(trimmed.slice(first, last + 1)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_agent_json');
  return parsed as Record<string, unknown>;
}
