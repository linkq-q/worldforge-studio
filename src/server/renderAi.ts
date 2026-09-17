import {
  CHAT_PROVIDER_OPTIONS,
  type AgentProgressEvent,
  type ChatProvider
} from '../shared/protocol';
import { INDOOR_RENDER_SCHEME_ID, type RenderScheme, type RenderSuggestion } from '../shared/renderScheme';
import type { HdriTexture } from '../shared/hdri';
import { harmonizeHdriAtmosphere } from '../shared/hdriAtmosphere';
import { normalizeRenderSceneProfile, type RenderSceneProfile } from '../shared/renderSceneProfile';
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
import { compileSceneArt } from '../shared/sceneArt';

export interface RenderAiOptions {
  apiBase?: string;
  provider?: ChatProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  currentPlan?: RenderPlan;
  hdriTextures?: readonly HdriTexture[];
  /** User asked this round to dress the sky with a panorama from the library. */
  requireHdriSky?: boolean;
  sceneProfile?: RenderSceneProfile;
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

  const sceneProfile = normalizeRenderSceneProfile(options.sceneProfile);
  options.onProgress?.({
    phase: 'planning',
    label: options.currentPlan ? '理解渲染调整要求' : '选择并编排渲染能力'
  });
  const messages = [
    {
      role: 'system',
      content: buildSystemPrompt(
        schemes,
        options.currentPlan,
        options.hdriTextures,
        options.requireHdriSky,
        sceneProfile
      )
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
    signal: options.signal,
    onProgress: options.onProgress
  };
  const content = await llmChat(messages, requestOptions);
  try {
    options.onProgress?.({ phase: 'validating', label: '校验渲染白名单与参数范围' });
    const suggestion = stabilizeRenderForScene(cleanPrompt, stabilizeRenderSemantics(
      cleanPrompt,
      normalizeRenderSuggestion(content, schemes, options.hdriTextures),
      schemes,
      options.currentPlan
    ), schemes, sceneProfile, options.currentPlan);
    assertRefineBase(options.currentPlan, suggestion);
    assertSceneArtReferences(suggestion.plan, sceneProfile);
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
    const suggestion = stabilizeRenderForScene(cleanPrompt, stabilizeRenderSemantics(
      cleanPrompt,
      normalizeRenderSuggestion(repaired, schemes, options.hdriTextures),
      schemes,
      options.currentPlan
    ), schemes, sceneProfile, options.currentPlan);
    assertRefineBase(options.currentPlan, suggestion);
    assertSceneArtReferences(suggestion.plan, sceneProfile);
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
  const plan = stabilizeDirectionalContrast(harmonizeHdriAtmosphere(normalizedPlan, hdriTextures));
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

const MAX_DIRECTIONAL_CONTRAST_BUDGET = 1.9;

function stabilizeDirectionalContrast(plan: RenderPlan): RenderPlan {
  const hdri = plan.modules.find((module) => module.id === 'environment.hdri');
  const texture = typeof hdri?.params.texture === 'string' ? hdri.params.texture : '';
  const light = plan.modules.find((module) => module.id === 'runtime.light-rig');
  if (!hdri || !texture || light?.params.recipe !== 'hard-day') return plan;

  const grade = plan.modules.find((module) => module.id === 'runtime.color-grade');
  const presentation = plan.modules.find((module) => module.id === 'presentation.exposure');
  const hdriExposure = positiveNumber(hdri.params.exposure, 1);
  const hdriIntensity = positiveNumber(hdri.params.intensity, 1);
  const lightStrength = positiveNumber(light.params.strength, 1);
  const contrast = positiveNumber(grade?.params.contrast, 1);
  const exposure = positiveNumber(presentation?.params.value, 1);
  const budget = hdriExposure * hdriIntensity * lightStrength * contrast * exposure;
  if (budget <= MAX_DIRECTIONAL_CONTRAST_BUDGET) return plan;

  const safeIntensity = Math.floor(
    hdriIntensity * MAX_DIRECTIONAL_CONTRAST_BUDGET / budget * 1000
  ) / 1000;
  return {
    ...plan,
    modules: plan.modules.map((module) => module === hdri
      ? { ...module, params: { ...module.params, intensity: safeIntensity } }
      : module)
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function buildSystemPrompt(
  schemes: readonly RenderScheme[],
  currentPlan?: RenderPlan,
  hdriTextures: readonly HdriTexture[] = [],
  requireHdriSky = false,
  sceneProfile?: RenderSceneProfile
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
    ...(requireHdriSky && sceneProfile?.sceneMode === 'indoor' ? [
      '当前是室内场景，但仍从现有 HDRI 池选择环境贴图。必须输出 environment.hdri，texture 只能使用 environment.hdri-library 中的文件名。',
      '室内 HDRI 必须设置 backgroundVisibility=hidden、useAsEnvironment=on，environmentIntensity 保持在 0.35-0.7；它只提供克制的材质反射和间接环境，不显示室外天空。'
    ] : requireHdriSky ? [
      '本轮用户勾选了「HDRI 天空」：必须输出 environment.hdri 模块，texture 从能力清单的 environment.hdri-library 中挑一个最贴合提示词的文件名，不得留空或自造文件名。',
      '可以按氛围调整 HDRI 的 exposure、saturation、rotation、tint、tintStrength 和 intensity，把日间天空重塑为清晨或黄昏，但不要自造 texture。',
      '不要自己写 environment.palette.fogColor、lighting.hemisphere 或 lighting.sun 的颜色，系统会用经过 tint 后的天空/地面平均色统一设定距离雾、环境光和太阳光。'
    ] : []),
    ...(sceneProfile ? [
      `当前场景摘要：${JSON.stringify(sceneProfile)}`
    ] : []),
    ...(sceneProfile?.sceneArtBrief ? [
      'sceneArtBrief 是已确认地图的构图语义，不是修改地图的指令。用光照、色彩对比、材质层次和氛围强化其主次焦点与游览视点；不要改摆放，不要凭空发明对象或区域 ID。renderHints 仅作候选意图，最终渲染仍遵守当前用户要求和白名单。',
      '先确定观看目的：从 entry 看懂入口与主焦点，从 route 连续看清去向，从 node 看清活动区的工作面和道具；overview 保持整体层次。按这些视点分配局部对比，不要只优化俯视全景。',
      '以可见结果推导调整：需要看清店内时，依次考虑现有玻璃的透射与反射、室内工作面的局部照明、室外亮度对比，以及地面是否接住实际灯光。若货架遮挡或缺少灯具属于几何问题，在 explanation 指出需要地图细化；不得声称渲染已改变几何或凭空制造灯具。',
      'targets.objects 的 position/rotation/scale 是世界坐标，light.offset 是灯具局部坐标；light 描述真实照明能力，材质 emissive 只说明发光外观。优先增强已有灯具，保留工作面暗部细节，控制玻璃与金属高光，谨慎添加 Bloom。缺少截图时只根据结构证据说明方案，不得声称已通过视觉审查。'
    ] : []),
    ...(sceneProfile?.sceneMode === 'indoor' ? [
      '这是室内渲染。默认使用 render-indoor-neutral 基底、PBR 表面、soft SSAO 和室内灯光配方；不要用室外太阳、草地、地形、天气或全局空气粒子填充房间。',
      '室内默认完全关闭全局距离雾。只有用户明确要求烟雾、蒸汽、尘埃、薄雾或朦胧空气时才允许 atmosphere.fog。',
      '灯光优先依赖窗光、实际灯具和间接补光；灯光覆盖不足时不要用高曝光或强环境光掩盖，应在 explanation 中提示补充灯具。',
      '白天自然光使用 interior-daylight，温馨暖光或傍晚使用 interior-warm，夜间使用 interior-night。Bloom 默认关闭，明确要求霓虹、辉光、发光或火焰时才开启。'
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
    '局部美术能力是可重复模块，每个提供唯一 key，省略 scope，params.config 是下述 JSON 对象序列化后的字符串。只使用当前场景 targets 中的真实 objectId、partId、zoneId；只改用户要求的对象和区域，不为填满预算而添加模块。',
    'runtime.color-field 最多4条：{zoneId?:区域ID,target:"ground-and-grass"|"terrain"|"grass",axis:"x"|"z"|"radial",center:[x,z],start:起点,end:终点,feather:边缘过渡米数,strength:0到1,stops:[[0,"#RRGGBB"],[0.4,"#RRGGBB"],[1,"#RRGGBB"]]}。2–4个递增色标，首尾0和1；end必须大于start。草与地面默认共享区域配色，避免无意义彩虹。颜色是受光前基色，不代替照明。',
    'runtime.grass-style 的 rootColor/tipColor 为显式颜色，覆盖预设。colorStops 是2–4个草叶高度色标数组的JSON字符串，首尾0和1；gradientBias和rootDarken可调。启用用户色卡时在该色卡允许的颜色内选色。',
    '新生成渲染方案时，按用户场景与 renderHints 主动协调草、地面、建筑和天空的色相及明度；草的 preset 是形态语义，不要求保留绿色。区域渐变用 runtime.color-field，草叶高度渐变用 runtime.grass-style，避免两层着色互相冲突。Refine 时只有用户要求涉及这些色彩才调整，保留已选方案的其他参数。',
    'runtime.local-light 最多8条，覆盖真实灯具对象而不改地图：{objectId,kind:"point"|"spot",color:"#RRGGBB",intensity:0.5到12,range:1到20,offset:[局部x,y,z],targetId?:照向的对象ID,enabled:true}。共享原有点光与聚光预算；发光材质不会自动照亮地面。',
    'runtime.surface-detail 最多8条：{objectId,partId?:具体材质部件ID,color?:"#RRGGBB",roughness?:0到1,metalness?:0到1,transmission?:0到1,colorExpression?:表达式,emissionExpression?:表达式}。transmission只用于已有物理玻璃部件；表达式只用于普通受支持表面，不用于water或特殊ShaderMaterial。',
    '简单Shader只允许vec3结果表达式：变量color/position/normal/uv/time，运算+ - *，函数vec2 vec3 sin cos abs fract min max clamp mix smoothstep。smoothstep的前两个参数必须是递增的数字常量。例：color * (0.85 + 0.15 * sin(position.x * 2.0 + time))。最长1024字符，禁止语句、循环、除法、采样纹理、宏、自定义函数和完整GLSL；保留原来的光照与阴影模板，禁止用颜色表达式假装实现几何或投影。',
    'runtime.wet-surface 最多1条：{zoneId:平坦铺装区域ID,strength:0到0.65,distortion:0到0.01}。仅平坦区域可用，额外进行一次512像素倒影捕获，不要用于斜坡、全地图或室内非地形地板。',
    '水面需要有明显变化时，不要只改颜色：按描述组合 waveStrength、waveSpeed、waveScale、waveDirection、waveSharpness、foamStrength、shoreFoamWidth、shoreWaveRange、shoreWaveFrequency、shoreWaveWidth、shoreWaveBreakup 与反射参数。卡通水面使用 runtime.water-style=stylized，不代表全场景使用 Cel。',
    '水色必须随场景氛围主动变化，不要总用白色或浅蓝色：可以选择青绿、松石、翡翠、深蓝、灰蓝、茶绿或夕照影响下的暖灰蓝。color、shallowColor、depthColor 要有清楚的明度层次，只有 foamColor 可以接近白色；水体 opacity 默认保持在 0.45-0.72，确保能看见水下地形。',
    '同时输出 plan.visualDirection，作为全局视觉导演：contrastMode 只能是 bright-cartoon、colored-shadow、dramatic；timeOfDay 只能是 morning、noon、evening、night；明确夜晚、夜景、深夜时必须使用 night；temperature 只能是 cool、warm；palette 必须提供 sky、keyLight、fillLight、shadow、fog、waterBias、accent 七个 #RRGGBB 色。艳阳/高对比但没有戏剧化要求时默认 bright-cartoon，避免暗部压黑。',
    '“柔和/柔光”默认只表示柔和灯光：选择 runtime.light-rig=soft-morning，保留清晰的中等对比度。只有用户明确说雾、朦胧、低对比、低饱和或粉彩时，才选择晨雾基础方案或 runtime.color-grade=misty/pastel。',
    '“艳阳/烈日/高对比”应通过暖色主光、偏冷环境补光和清晰色彩倾向实现，不得把暗部压成黑块；使用 runtime.light-rig=hard-day，并让 color-grade 保持中等对比和可读暗部。',
    '雾优先使用 atmosphere.fog.visibilityDistance（米），不要猜底层 density：薄雾 240-450，普通雾 120-220，浓雾 40-90；“清晨薄雾”不得低于 260。',
    '明确风格必须选择对应能力：素描/铅笔/手绘排线使用 runtime.presentation-style=sketch（默认 coordinateSpace=world），通常组合 runtime.outline-style=ink；水墨使用 outline=ink；漫画使用 comic-clean 或 comic-print；全场景卡通/赛璐璐使用 surface-style=cel；卡通水面只使用 runtime.water-style=stylized。',
    '只返回一个 JSON 对象，不要 Markdown，不要额外文字：',
    '{"plan":{"version":2,"baseSchemeId":"方案ID","visualDirection":{"version":1,"contrastMode":"bright-cartoon","timeOfDay":"noon","temperature":"warm","palette":{"sky":"#RRGGBB","keyLight":"#RRGGBB","fillLight":"#RRGGBB","shadow":"#RRGGBB","fog":"#RRGGBB","waterBias":"#RRGGBB","accent":"#RRGGBB"},"atmosphereFx":{"masterStrength":0.35,"pollen":0,"vapor":0,"dust":0}},"modules":[{"key":"可选唯一键","id":"能力ID","scope":{"target":"material-tag","tag":"foliage"},"params":{}}]},"styleTags":["tag"],"explanation":"简短说明"}',
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

function assertSceneArtReferences(plan: RenderPlan, profile?: RenderSceneProfile): void {
  const art = compileSceneArt(plan);
  if (!art.colors.length && !art.lights.length && !art.surfaces.length && !art.wet.length) return;
  if (!profile?.targets) throw new Error('scene_art_requires_target_context');
  const objects = new Map(profile.targets.objects.map(object => [object.id, object]));
  const zones = new Set(profile.targets.zones.map(zone => zone.id));
  for (const rule of [...art.lights, ...art.surfaces]) if (!objects.has(rule.objectId)) throw new Error(`unknown_scene_art_object:${rule.objectId}`);
  for (const rule of art.lights) if (rule.targetId && !objects.has(rule.targetId)) throw new Error(`unknown_scene_art_target:${rule.targetId}`);
  for (const rule of art.surfaces) if (rule.partId && !objects.get(rule.objectId)?.parts.some(part => part.id === rule.partId)) throw new Error(`unknown_scene_art_part:${rule.partId}`);
  for (const rule of [...art.colors, ...art.wet]) if (rule.zoneId && !zones.has(rule.zoneId)) throw new Error(`unknown_scene_art_zone:${rule.zoneId}`);
}

const INDOOR_AIR = /雾|烟|蒸汽|尘埃|粉尘|haze|mist|smoke|steam|dust/i;
const INDOOR_STYLIZATION = /素描|铅笔|手绘排线|漫画|水墨|赛璐璐|全(?:局|场景)[^，。！？,;\n]{0,10}卡通|sketch|pencil|comic|\bink\b|cel[- ]?shad|\btoon\b/i;
const INDOOR_BLOOM = /辉光|光晕|霓虹|发光|火焰|魔法|bloom|glow|neon|flame|magic/i;
const INDOOR_NIGHT = /夜间|夜晚|深夜|夜景|night|midnight/i;
const INDOOR_WARM = /暖光|温馨|黄昏|傍晚|夕阳|餐厅|酒吧|warm|sunset|evening/i;

function stabilizeRenderForScene(
  prompt: string,
  suggestion: RenderSuggestion,
  schemes: readonly RenderScheme[],
  sceneProfile?: RenderSceneProfile,
  currentPlan?: RenderPlan
): RenderSuggestion {
  if (sceneProfile?.sceneMode !== 'indoor') return suggestion;
  const plan: RenderPlan = {
    ...suggestion.plan,
    modules: suggestion.plan.modules.map((module) => ({ ...module, params: { ...module.params } }))
  };

  const hdri = plan.modules.find((module) => module.id === 'environment.hdri');
  if (hdri) {
    hdri.params.backgroundVisibility = 'hidden';
    hdri.params.useAsEnvironment = 'on';
    hdri.params.environmentIntensity = Math.min(0.7, positiveNumber(hdri.params.environmentIntensity, 0.7));
  }

  if (currentPlan) return { ...suggestion, plan, settings: compileRenderPlan(plan) };
  if (schemes.some((scheme) => scheme.id === INDOOR_RENDER_SCHEME_ID)) plan.baseSchemeId = INDOOR_RENDER_SCHEME_ID;

  plan.modules = plan.modules.filter((module) => {
    if (module.id === 'runtime.grass-style') return sceneProfile.content.hasGrass;
    if (module.id === 'runtime.water-style') return sceneProfile.content.hasWater;
    if (module.id === 'runtime.terrain-materials' || module.id === 'runtime.weather') return false;
    if (module.id === 'runtime.atmosphere-fx') return INDOOR_AIR.test(prompt);
    if (!INDOOR_STYLIZATION.test(prompt)
      && (module.id === 'runtime.outline-style' || module.id === 'runtime.presentation-style')) return false;
    return true;
  });

  if (!INDOOR_AIR.test(prompt)) {
    const fog = ensureModule(plan, 'atmosphere.fog');
    delete fog.params.visibilityDistance;
    fog.params.density = 0;
  }
  if (!INDOOR_STYLIZATION.test(prompt)) ensureModule(plan, 'runtime.surface-style').params.mode = 'pbr';

  const rig = ensureModule(plan, 'runtime.light-rig');
  rig.params.recipe = INDOOR_NIGHT.test(prompt)
    ? 'interior-night'
    : INDOOR_WARM.test(prompt) ? 'interior-warm' : 'interior-daylight';
  rig.params.strength = clampNumber(rig.params.strength, 0.75, 1.15, 1);
  rig.params.shadowSoftness = clampNumber(rig.params.shadowSoftness, 0.65, 0.98, 0.88);

  const post = ensureModule(plan, 'runtime.post-quality');
  post.params.ssao = 'soft';
  if (!INDOOR_BLOOM.test(prompt)) {
    post.params.bloom = 'off';
    delete post.params.bloomStrength;
  }

  let explanation = suggestion.explanation;
  if (sceneProfile.lighting.coverageRatio < 0.5) {
    const exposure = plan.modules.find((module) => module.id === 'presentation.exposure');
    if (exposure && typeof exposure.params.value === 'number') exposure.params.value = Math.min(1.1, exposure.params.value);
    const warning = '当前室内实际灯光覆盖不足，已避免用高曝光掩盖；建议在地图阶段补充灯具。';
    explanation = explanation ? `${explanation} ${warning}` : warning;
  }

  return {
    ...suggestion,
    baseSchemeId: plan.baseSchemeId,
    explanation,
    plan,
    settings: compileRenderPlan(plan)
  };
}

function ensureModule(plan: RenderPlan, id: RenderPlan['modules'][number]['id']): RenderPlan['modules'][number] {
  let module = plan.modules.find((candidate) => candidate.id === id);
  if (!module) {
    module = { id, params: {} };
    plan.modules.push(module);
  }
  return module;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
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
