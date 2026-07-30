import {
  CHAT_PROVIDER_OPTIONS,
  type ChatProvider
} from '../shared/protocol';
import type { RenderScheme, RenderSuggestion } from '../shared/renderScheme';
import {
  RENDER_CAPABILITIES,
  compileRuntimeOutline,
  compileRuntimePresentation,
  compileRuntimeStyle,
  compileRenderPlan,
  normalizeRenderPlan,
  renderCapabilitySummary
} from '../shared/renderPlan';
import { llmChat } from './modelApi';

export interface RenderAiOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function generateRenderSuggestion(
  prompt: string,
  schemes: readonly RenderScheme[],
  options: RenderAiOptions = {}
): Promise<RenderSuggestion> {
  const cleanPrompt = prompt.trim().slice(0, 1000);
  if (!cleanPrompt) throw new Error('missing_prompt');
  const provider = options.provider ?? 'gpt';
  const providerOption = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
  if (!providerOption || providerOption.disabled) throw new Error('provider_unavailable');

  const messages = [
    { role: 'system', content: buildSystemPrompt(schemes) },
    { role: 'user', content: cleanPrompt }
  ] as const;
  const requestOptions = {
    apiBase: options.apiBase,
    provider,
    temperature: 0.2,
    maxTokens: 1000,
    fetchImpl: options.fetchImpl,
    signal: options.signal
  };
  const content = await llmChat(messages, requestOptions);
  try {
    const suggestion = normalizeRenderSuggestion(content, schemes);
    assertRequestedStyle(cleanPrompt, suggestion);
    return suggestion;
  } catch (error) {
    options.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : 'invalid_render_plan';
    const repaired = await llmChat([
      ...messages,
      { role: 'assistant', content },
      { role: 'user', content: `上一份 RenderPlan 校验失败：${reason}。只使用能力清单中的模块修正后，重新返回完整 JSON。` }
    ], requestOptions);
    const suggestion = normalizeRenderSuggestion(repaired, schemes);
    assertRequestedStyle(cleanPrompt, suggestion);
    return suggestion;
  }
}

export function normalizeRenderSuggestion(
  content: string,
  schemes: readonly RenderScheme[]
): RenderSuggestion {
  const input = parseJsonObject(content);
  const planInput = input.plan ?? legacyPlanInput(input);
  const rawPlan = planInput && typeof planInput === 'object'
    ? planInput as Record<string, unknown>
    : {};
  const baseScheme = schemes.find((scheme) => scheme.id === rawPlan.baseSchemeId);
  const plan = normalizeRenderPlan(
    planInput,
    schemes.map((scheme) => scheme.id),
    baseScheme?.accessPolicy,
    'ai'
  );
  const settings = compileRenderPlan(plan);

  const styleTags = Array.isArray(input.styleTags)
    ? [...new Set(input.styleTags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim().slice(0, 24))
      .filter(Boolean))]
      .slice(0, 8)
    : [];

  return {
    baseSchemeId: plan.baseSchemeId,
    settings,
    styleTags,
    explanation: typeof input.explanation === 'string'
      ? input.explanation.trim().slice(0, 200)
      : '',
    plan
  };
}

function buildSystemPrompt(schemes: readonly RenderScheme[]): string {
  const library = schemes.map((scheme) => ({
    id: scheme.id,
    name: scheme.name,
    description: scheme.description,
    settings: scheme.settings,
    aiAccess: summarizeAiAccess(scheme)
  }));
  const publicCapabilities = renderCapabilitySummary().filter((_, index) => !RENDER_CAPABILITIES[index]?.developerOnly);
  return [
    '你是 WorldForge 的渲染风格规划器。用户只描述视觉风格，不得改变地形、物体或资产。',
    '从方案库选择一个基础方案，然后组合该方案 aiAccess 允许的能力与参数。不得输出未列出的模块、参数、Shader 或 GLSL。',
    '模块可以只覆盖需要改变的参数；其余参数继承基础方案。颜色必须是 #RRGGBB。',
    '输出 RenderPlan V2。runtime.material-theme、runtime.water-style、runtime.effect-recipe 可以重复；每项必须提供唯一 key 和 scope。scope.target 只能是 water、material-tag 或 asset-tag，标签使用 foliage、bark、wood、stone、metal、water、emissive、fire、tree、rock、building 等已存在语义。',
    '色彩语义使用 runtime.color-grade；水体语义使用 runtime.water-style；树叶/树皮/石头/金属批量改材质使用 runtime.material-theme；柔光/硬光/逆光/阴天/黄昏使用 runtime.light-rig；Bloom/SSAO 使用 runtime.post-quality；发光/Fresnel/火焰/魔法使用 runtime.effect-recipe。',
    '明确风格必须选择对应能力：素描/铅笔/手绘排线使用 runtime.presentation-style=sketch（默认 coordinateSpace=world），通常组合 runtime.outline-style=ink；水墨使用 outline=ink；漫画使用 comic-clean 或 comic-print；卡通/赛璐璐使用 surface-style=cel。',
    '只返回一个 JSON 对象，不要 Markdown，不要额外文字：',
    '{"plan":{"version":2,"baseSchemeId":"方案ID","modules":[{"key":"可选唯一键","id":"能力ID","scope":{"target":"material-tag","tag":"foliage"},"params":{}}]},"styleTags":["tag"],"explanation":"简短说明"}',
    `能力清单：${JSON.stringify(publicCapabilities)}`,
    `方案库：${JSON.stringify(library)}`
  ].join('\n');
}

function summarizeAiAccess(scheme: RenderScheme): Record<string, Record<string, unknown>> {
  const summary: Record<string, Record<string, unknown>> = {};
  for (const entry of scheme.accessPolicy.parameters) {
    if (!entry.ai.enabled) continue;
    const module = summary[entry.moduleId] ?? {};
    module[entry.parameter] = {
      ...(entry.ai.min === undefined ? {} : { min: entry.ai.min }),
      ...(entry.ai.max === undefined ? {} : { max: entry.ai.max }),
      ...(entry.ai.values === undefined ? {} : { values: entry.ai.values })
    };
    summary[entry.moduleId] = module;
  }
  return summary;
}

function assertRequestedStyle(prompt: string, suggestion: RenderSuggestion): void {
  const presentation = compileRuntimePresentation(suggestion.plan).mode;
  const outline = compileRuntimeOutline(suggestion.plan).mode;
  const surface = compileRuntimeStyle(suggestion.plan).mode;
  if (/(素描|铅笔|手绘排线|sketch|pencil|cross[- ]?hatch)/i.test(prompt) && presentation !== 'sketch') {
    throw new Error('missing_requested_style:sketch');
  }
  if (/(漫画|comic)/i.test(prompt) && presentation !== 'comic-clean' && presentation !== 'comic-print') {
    throw new Error('missing_requested_style:comic');
  }
  if (/(水墨|墨线|\bink\b)/i.test(prompt) && outline !== 'ink') {
    throw new Error('missing_requested_style:ink');
  }
  if (/(卡通|赛璐璐|\btoon\b|cel[- ]?shad)/i.test(prompt) && surface !== 'cel') {
    throw new Error('missing_requested_style:cel');
  }
}

function parseJsonObject(content: string): Record<string, unknown> {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('invalid_render_ai_json');
  try {
    return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error('invalid_render_ai_json');
  }
}

function legacyPlanInput(input: Record<string, unknown>): unknown {
  const baseSchemeId = typeof input.baseSchemeId === 'string' ? input.baseSchemeId : '';
  const settings = input.settings && typeof input.settings === 'object'
    ? input.settings as Record<string, unknown>
    : {};
  const modules: Array<{ id: string; params: Record<string, unknown> }> = [];
  if ('fogDensity' in settings) modules.push({ id: 'atmosphere.fog', params: { density: settings.fogDensity } });
  if ('sunIntensity' in settings) modules.push({ id: 'lighting.sun', params: { intensity: settings.sunIntensity } });
  if ('exposure' in settings) modules.push({ id: 'presentation.exposure', params: { value: settings.exposure } });
  return { version: 2, baseSchemeId, modules };
}
