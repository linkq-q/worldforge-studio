import {
  CHAT_PROVIDER_OPTIONS,
  type AgentProgressEvent,
  type ChatProvider
} from '../shared/protocol';
import type { RenderScheme, RenderSuggestion } from '../shared/renderScheme';
import type { HdriTexture } from '../shared/hdri';
import { harmonizeHdriAtmosphere } from '../shared/hdriAtmosphere';
import {
  RENDER_CAPABILITIES,
  compileRuntimeOutline,
  compileRuntimePresentation,
  compileRuntimeStyle,
  compileRuntimeWaterStyles,
  compileRenderPlan,
  createDefaultRenderAccessPolicy,
  normalizeRenderPlan,
  renderCapabilitySummary,
  type RenderAccessPolicy,
  type RenderPlan
} from '../shared/renderPlan';
import { llmChat } from './modelApi';
import { parseLlmJsonObject } from './llmJson';
import { stabilizeRenderSemantics } from './renderSemantics';

export interface RenderAiOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  currentPlan?: RenderPlan;
  hdriTextures?: readonly HdriTexture[];
  /** User asked this round to dress the sky with a panorama from the library. */
  requireHdriSky?: boolean;
  onProgress?: (event: AgentProgressEvent) => void;
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

  options.onProgress?.({
    phase: 'planning',
    label: options.currentPlan ? '理解渲染调整要求' : '选择并编排渲染能力'
  });
  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt(schemes, options.currentPlan, options.hdriTextures, options.requireHdriSky)
    },
    { role: 'user', content: cleanPrompt }
  ] as const;
  const requestOptions = {
    apiBase: options.apiBase,
    provider,
    temperature: 0.2,
    // RenderPlan V2 now carries visual direction, HDRI and atmosphere modules.
    // 1000 tokens can truncate an otherwise valid plan before its closing brace.
    maxTokens: 4096,
    fetchImpl: options.fetchImpl,
    signal: options.signal
  };
  const content = await llmChat(messages, requestOptions);
  try {
    options.onProgress?.({ phase: 'validating', label: '校验渲染白名单与参数范围' });
    const suggestion = stabilizeRenderSemantics(
      cleanPrompt,
      normalizeRenderSuggestion(content, schemes, options.hdriTextures),
      schemes,
      options.currentPlan
    );
    assertRefineBase(options.currentPlan, suggestion);
    assertRequestedStyle(cleanPrompt, suggestion);
    assertHdriSky(options.requireHdriSky, suggestion);
    options.onProgress?.({ phase: 'complete', label: '渲染方案已完成' });
    return suggestion;
  } catch (error) {
    options.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : 'invalid_render_plan';
    options.onProgress?.({
      phase: 'repairing',
      label: '首次返回不完整，正在进行最后一次自动修正',
      current: 2,
      total: 2,
      detail: reason
    });
    const repaired = await llmChat([
      ...messages,
      { role: 'assistant', content },
      { role: 'user', content: `上一份 RenderPlan 校验失败：${reason}。只使用能力清单中的模块修正后，重新返回完整 JSON。` }
    ], { ...requestOptions, temperature: 0 });
    const suggestion = stabilizeRenderSemantics(
      cleanPrompt,
      normalizeRenderSuggestion(repaired, schemes, options.hdriTextures),
      schemes,
      options.currentPlan
    );
    assertRefineBase(options.currentPlan, suggestion);
    assertRequestedStyle(cleanPrompt, suggestion);
    assertHdriSky(options.requireHdriSky, suggestion);
    options.onProgress?.({ phase: 'complete', label: '渲染方案已完成' });
    return suggestion;
  }
}

export function refineRenderSuggestion(
  prompt: string,
  currentPlan: RenderPlan,
  schemes: readonly RenderScheme[],
  options: Omit<RenderAiOptions, 'currentPlan'> = {}
): Promise<RenderSuggestion> {
  return generateRenderSuggestion(prompt, schemes, { ...options, currentPlan });
}

export function normalizeRenderSuggestion(
  content: string,
  schemes: readonly RenderScheme[],
  hdriTextures: readonly HdriTexture[] = []
): RenderSuggestion {
  const input = parseLlmJsonObject(content, 'invalid_render_ai_json');
  const planInput = input.plan ?? legacyPlanInput(input);
  const rawPlan = planInput && typeof planInput === 'object'
    ? planInput as Record<string, unknown>
    : {};
  const baseScheme = schemes.find((scheme) => scheme.id === rawPlan.baseSchemeId);
  const normalizedPlan = normalizeRenderPlan(
    planInput,
    schemes.map((scheme) => scheme.id),
    withHdriTextureChoices(baseScheme?.accessPolicy, hdriTextures),
    'ai'
  );
  const plan = harmonizeHdriAtmosphere(normalizedPlan, hdriTextures);
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

function buildSystemPrompt(
  schemes: readonly RenderScheme[],
  currentPlan?: RenderPlan,
  hdriTextures: readonly HdriTexture[] = [],
  requireHdriSky = false
): string {
  const library = schemes.map((scheme) => ({
    id: scheme.id,
    name: scheme.name,
    description: scheme.description,
    settings: scheme.settings,
    aiAccess: summarizeAiAccess(scheme)
  }));
  const publicCapabilities = [
    ...renderCapabilitySummary().filter((_, index) => !RENDER_CAPABILITIES[index]?.developerOnly),
    {
      id: 'environment.hdri-library',
      instruction: 'Choose texture only from this library. Prefer matching tags; avoid an unclassified file when a tagged choice matches.',
      textures: hdriTextures.map((texture) => ({
        file: texture.file,
        tags: texture.tags,
        skyColor: texture.skyColor,
        groundColor: texture.groundColor
      }))
    }
  ];
  return [
    ...(requireHdriSky ? [
      '本轮用户勾选了「HDRI 天空」：必须输出 environment.hdri 模块，texture 从能力清单的 environment.hdri-library 中挑一个最贴合提示词的文件名，不得留空或自造文件名。',
      '可以按氛围调整 HDRI 的 exposure、saturation、rotation、tint、tintStrength 和 intensity，把日间天空重塑为清晨或黄昏，但不要自造 texture。',
      '不要自己写 environment.palette.fogColor、lighting.hemisphere 或 lighting.sun 的颜色，系统会用经过 tint 后的天空/地面平均色统一设定距离雾、环境光和太阳光。'
    ] : []),
    ...(currentPlan ? [
      '这是一次 Refine。只修改用户明确要求变化的渲染语义，保留其余模块和参数。',
      '必须保持 currentPlan.baseSchemeId 不变，并返回合并后的完整 RenderPlan，而不是只返回差异。',
      `当前 RenderPlan：${JSON.stringify(currentPlan)}`
    ] : []),
    '你是 WorldForge 的渲染风格规划器。用户只描述视觉风格，不得改变地形、物体或资产。',
    '从方案库选择一个基础方案，然后组合该方案 aiAccess 允许的能力与参数。不得输出未列出的模块、参数、Shader 或 GLSL。',
    '模块可以只覆盖需要改变的参数；其余参数继承基础方案。颜色必须是 #RRGGBB。',
    '输出 RenderPlan V2。runtime.material-theme、runtime.water-style、runtime.effect-recipe 可以重复；每项必须提供唯一 key 和 scope。scope.target 只能是 water、material-tag 或 asset-tag，标签使用 foliage、bark、wood、stone、metal、water、emissive、fire、tree、rock、building 等已存在语义。',
    '色彩语义使用 runtime.color-grade；水体语义使用 runtime.water-style；草叶颜色、胖瘦、高度、风和地表染色使用 runtime.grass-style；树叶/树皮/石头/金属批量改材质使用 runtime.material-theme；柔光/硬光/逆光/阴天/黄昏使用 runtime.light-rig；Bloom/SSAO 使用 runtime.post-quality；发光/Fresnel/火焰/魔法光环/植被摇摆使用 runtime.effect-recipe。',
    '水面需要有明显变化时，不要只改颜色：按描述组合 waveStrength、waveSpeed、waveScale、waveDirection、waveSharpness、foamStrength、shoreFoamWidth、shoreWaveRange、shoreWaveFrequency、shoreWaveWidth、shoreWaveBreakup 与反射参数。卡通水面使用 runtime.water-style=stylized，不代表全场景使用 Cel。',
    '水色必须随场景氛围主动变化，不要总用白色或浅蓝色：可以选择青绿、松石、翡翠、深蓝、灰蓝、茶绿或夕照影响下的暖灰蓝。color、shallowColor、depthColor 要有清楚的明度层次，只有 foamColor 可以接近白色；水体 opacity 默认保持在 0.45-0.72，确保能看见水下地形。',
    '同时输出 plan.visualDirection，作为全局视觉导演：contrastMode 只能是 bright-cartoon、colored-shadow、dramatic；timeOfDay 只能是 morning、noon、evening；temperature 只能是 cool、warm；palette 必须提供 sky、keyLight、fillLight、shadow、fog、waterBias、accent 七个 #RRGGBB 色。艳阳/高对比但没有戏剧化要求时默认 bright-cartoon，避免暗部压黑。',
    '“柔和/柔光”默认只表示柔和灯光：选择 runtime.light-rig=soft-morning，保留清晰的中等对比度。只有用户明确说雾、朦胧、低对比、低饱和或粉彩时，才选择晨雾基础方案或 runtime.color-grade=misty/pastel。',
    '“艳阳/烈日/高对比”应通过暖色主光、偏冷环境补光和清晰色彩倾向实现，不得把暗部压成黑块；使用 runtime.light-rig=hard-day，并让 color-grade 保持中等对比和可读暗部。',
    '雾优先使用 atmosphere.fog.visibilityDistance（米），不要猜底层 density：薄雾 240-450，普通雾 120-220，浓雾 40-90；“清晨薄雾”不得低于 260。',
    '明确风格必须选择对应能力：素描/铅笔/手绘排线使用 runtime.presentation-style=sketch（默认 coordinateSpace=world），通常组合 runtime.outline-style=ink；水墨使用 outline=ink；漫画使用 comic-clean 或 comic-print；全场景卡通/赛璐璐使用 surface-style=cel；卡通水面只使用 runtime.water-style=stylized。',
    '只返回一个 JSON 对象，不要 Markdown，不要额外文字：',
    '{"plan":{"version":2,"baseSchemeId":"方案ID","visualDirection":{"version":1,"contrastMode":"bright-cartoon","timeOfDay":"noon","temperature":"warm","palette":{"sky":"#RRGGBB","keyLight":"#RRGGBB","fillLight":"#RRGGBB","shadow":"#RRGGBB","fog":"#RRGGBB","waterBias":"#RRGGBB","accent":"#RRGGBB"},"atmosphereFx":{"masterStrength":0.35,"sunShafts":0,"pollen":0,"vapor":0,"dust":0,"windStreaks":0}},"modules":[{"key":"可选唯一键","id":"能力ID","scope":{"target":"material-tag","tag":"foliage"},"params":{}}]},"styleTags":["tag"],"explanation":"简短说明"}',
    `能力清单：${JSON.stringify(publicCapabilities)}`,
    `方案库：${JSON.stringify(library)}`
  ].join('\n');
}

function withHdriTextureChoices(
  policy: RenderAccessPolicy | undefined,
  textures: readonly HdriTexture[]
): RenderAccessPolicy {
  const files = [...new Set(textures.map((texture) => texture.file).filter(Boolean))];
  const source = policy ?? createDefaultRenderAccessPolicy();
  return {
    ...source,
    parameters: source.parameters.map((entry) => (
      entry.moduleId === 'environment.hdri' && entry.parameter === 'texture'
        ? { ...entry, ai: { ...entry.ai, values: files } }
        : entry
    ))
  };
}

function assertHdriSky(required: boolean | undefined, suggestion: RenderSuggestion): void {
  if (!required) return;
  const hdri = suggestion.plan.modules.find((module) => module.id === 'environment.hdri');
  if (typeof hdri?.params.texture !== 'string' || !hdri.params.texture.trim()) {
    throw new Error('missing_requested_hdri_sky');
  }
}

function assertRefineBase(currentPlan: RenderPlan | undefined, suggestion: RenderSuggestion): void {
  if (currentPlan && suggestion.plan.baseSchemeId !== currentPlan.baseSchemeId) {
    throw new Error('refine_base_scheme_changed');
  }
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
  const cartoonWater = requestsCartoonWater(prompt);
  if (/(素描|铅笔|手绘排线|sketch|pencil|cross[- ]?hatch)/i.test(prompt) && presentation !== 'sketch') {
    throw new Error('missing_requested_style:sketch');
  }
  if (/(漫画|comic)/i.test(prompt) && presentation !== 'comic-clean' && presentation !== 'comic-print') {
    throw new Error('missing_requested_style:comic');
  }
  if (/(水墨|墨线|\bink\b)/i.test(prompt) && outline !== 'ink') {
    throw new Error('missing_requested_style:ink');
  }
  if (cartoonWater && !compileRuntimeWaterStyles(suggestion.plan).some((style) => style.recipe === 'stylized')) {
    throw new Error('missing_requested_style:water-stylized');
  }
  if (requestsGlobalCel(prompt, cartoonWater) && surface !== 'cel') {
    throw new Error('missing_requested_style:cel');
  }
}

function requestsCartoonWater(prompt: string): boolean {
  return /(?:卡通(?:风格)?(?:的)?[^，。！？,;\n]{0,10}(?:水面|水体|海面|湖面|河面|海水)|(?:水面|水体|海面|湖面|河面|海水)[^，。！？,;\n]{0,10}卡通|(?:cartoon|stylized)[ -]?(?:water|ocean|sea|lake|river)|(?:water|ocean|sea|lake|river)[ -]?(?:cartoon|stylized))/i.test(prompt);
}

function requestsGlobalCel(prompt: string, cartoonWater: boolean): boolean {
  if (/(赛璐璐|\btoon\b|cel[- ]?shad|全(?:局|场景)[^，。！？,;\n]{0,10}卡通|整体[^，。！？,;\n]{0,10}卡通|卡通[^，。！？,;\n]{0,8}(?:场景|画面))/i.test(prompt)) return true;
  return /卡通/i.test(prompt) && !cartoonWater;
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
