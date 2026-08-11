import type { RenderScheme } from '../shared/renderScheme';
import {
  createDefaultRenderAccessPolicy,
  RENDER_CAPABILITIES,
  type RenderCapability,
  type RenderModuleSelection,
  type RenderParameterAccess
} from '../shared/renderPlan';
import {
  RENDER_INSPECTOR_CATEGORIES,
  renderInspectorCategory,
  type RenderInspectorCategoryId
} from './renderInspectorCatalog';

export type DeveloperRenderView = 'tuning' | 'access';

const PARAMETER_LABELS: Record<string, string> = {
  recipe: '风格配方',
  mode: '模式',
  background: '背景颜色',
  fogColor: '雾颜色',
  density: '雾浓度',
  skyColor: '天空光颜色',
  groundColor: '地面颜色',
  rootColor: '草根颜色',
  tipColor: '草尖颜色',
  visibilityDistance: '可视距离（米）',
  paletteVariation: '调色板变化',
  bladeHeight: '叶片高度',
  bladeWidth: '叶片宽度',
  windStrength: '风力',
  windAngle: '风向',
  normalFlatten: '法线压平',
  rootDarken: '根部压暗',
  gradientBias: '渐变偏移',
  cellSize: '叶片间距',
  fadeStart: '淡出起点',
  fadeEnd: '淡出终点',
  maxInstances: '最大叶片数',
  groundTint: '地表染色',
  groundTintStrength: '地表染色强度',
  masterStrength: '动态特效总强度',
  semanticStrength: '语义自动触发强度',
  pollen: '花粉微粒',
  vapor: '水汽',
  dust: '尘埃',
  sand: '飞沙',
  value: '当前值',
  texture: 'HDRI 贴图',
  opacity: '透明度',
  color: '主颜色',
  shallowColor: '浅水颜色',
  depthColor: '深水颜色',
  foamColor: '泡沫颜色',
  waveStrength: '波纹强度',
  waveSpeed: '波纹速度',
  waveScale: '波纹尺度',
  waveDirection: '波纹方向',
  waveSharpness: '波峰锐度',
  foamStrength: '泡沫强度',
  shoreFoamWidth: '岸边泡沫宽度',
  shoreWaveRange: '岸浪范围',
  shoreWaveFrequency: '岸浪层数',
  shoreWaveWidth: '岸浪线宽',
  shoreWaveBreakup: '岸浪破碎度',
  environmentReflectionStrength: 'HDRI 环境反射',
  environmentReflectionExposure: 'HDRI 反射曝光',
  intensity: '强度',
  strength: '强度',
  exposure: '曝光',
  saturation: '饱和度',
  contrast: '对比度',
  temperature: '冷暖',
  shadowLift: '暗部抬升',
  rotation: '水平旋转',
  tint: '染色',
  tintStrength: '染色强度',
  useAsEnvironment: '用于环境反射',
  bands: '明暗色阶',
  shadowFloor: '暗部亮度',
  highlightFactor: '高光亮度',
  rampStrength: '卡通分段强度',
  transitionSoftness: '明暗过渡',
  threshold: '描边阈值',
  width: '描边宽度',
  depthWeight: '深度边缘',
  normalWeight: '法线边缘',
  objectWeight: '物体边缘',
  materialWeight: '材质边缘',
  noiseStrength: '线条噪声',
  strokeVariation: '笔触变化',
  echoCount: '回声层数',
  echoSpacing: '回声间距',
  echoAngle: '回声角度',
  echoStrength: '回声强度',
  echoColor: '回声颜色',
  coordinateSpace: '线条坐标',
  worldScale: '世界纹理尺度',
  hatchSpacing: '排线间距',
  hatchAngle: '排线角度',
  lineWidth: '线宽',
  jitter: '线条抖动',
  colorMode: '颜色模式',
  toneStrength: '调子强度',
  toneBias: '调子偏移',
  denseSpacing: '密排线间距',
  darkFill: '暗部填充',
  break: '断线程度',
  lineColor: '线条颜色',
  paperColor: '纸张颜色',
  paperStrength: '纸张质感',
  paperScale: '纸张纹理尺度',
  paperTint: '纸张染色',
  halftoneStrength: '网点强度',
  halftoneCellSize: '网点大小',
  printOffset: '套印偏移',
  comicLineBoost: '漫画线增强',
  comicLineWidth: '漫画线宽',
  comicInkColor: '漫画墨色',
  roughness: '粗糙度',
  metalness: '金属度',
  warmth: '光照冷暖',
  shadowSoftness: '阴影柔和度',
  bloom: '辉光',
  bloomStrength: '辉光强度',
  ssao: '环境遮蔽',
  depthOfField: '景深',
  speed: '动画速度',
  fragmentId: '白名单片段',
  code: 'GLSL 代码'
};

const OPTION_LABELS: Record<string, string> = {
  '2': '2 级',
  '3': '3 级',
  on: '开启',
  off: '关闭',
  none: '无',
  pbr: 'PBR',
  cel: '卡通分段',
  clean: '干净描边',
  ink: '墨线',
  echo: '回声线',
  curvature: '曲率线',
  sketch: '素描',
  'comic-clean': '清线漫画',
  'comic-print': '套色漫画',
  color: '保留颜色',
  monochrome: '单色',
  world: '世界空间',
  screen: '屏幕空间',
  neutral: '中性',
  warm: '暖色',
  cool: '冷色',
  misty: '薄雾',
  cinematic: '电影感',
  pastel: '粉彩',
  'calm-lake': '平静湖泊',
  'clear-river': '清澈河流',
  stylized: '风格化',
  stormy: '风暴水面',
  natural: '自然',
  autumn: '秋季',
  winter: '冬季',
  weathered: '风化',
  polished: '抛光',
  'soft-morning': '柔和晨光',
  'hard-day': '硬朗日光',
  backlit: '逆光',
  overcast: '阴天',
  sunset: '黄昏',
  soft: '柔和',
  strong: '强',
  portrait: '人像景深',
  glow: '发光',
  fresnel: 'Fresnel 边缘光',
  flame: '火焰',
  magic: '魔法',
  aura: '光环',
  sway: '摆动',
  'whitelist-fragment': '白名单片段',
  'isolated-glsl': '隔离完整 GLSL',
  'rim-light': '边缘光',
  'color-wash': '颜色洗染',
  'vertex-sway': '顶点摆动'
};

export function renderDeveloperWorkspace(
  draft: RenderScheme,
  hdriFiles: string[],
  categoryId: RenderInspectorCategoryId,
  view: DeveloperRenderView
): string {
  const category = renderInspectorCategory(categoryId);
  const capabilities = category.moduleIds
    .map((id) => RENDER_CAPABILITIES.find((capability) => capability.id === id))
    .filter((capability): capability is RenderCapability => Boolean(capability));
  return `
    <div class="developer-workspace">
      <nav class="developer-category-dock" aria-label="渲染参数分类">
        ${RENDER_INSPECTOR_CATEGORIES.map((entry) => `
          <button type="button" data-dev-category="${entry.id}" class="${entry.id === category.id ? 'active' : ''}" title="${escapeHtml(entry.description)}">
            ${escapeHtml(entry.label)}
          </button>
        `).join('')}
      </nav>
      <div class="developer-category-panel">
        <div class="developer-category-heading">
          <strong>${escapeHtml(category.label)}</strong>
          <small>${escapeHtml(category.description)}</small>
        </div>
        <div class="developer-capability-list">
          ${capabilities.map((capability) => renderDeveloperCapability(capability, draft, hdriFiles, view)).join('')}
        </div>
      </div>
    </div>
  `;
}

export function renderDeveloperCapability(
  capability: RenderCapability,
  draft: RenderScheme,
  hdriFiles: string[],
  view: DeveloperRenderView | 'both' = 'both'
): string {
  const storedModules = (draft.renderPlan?.modules ?? [])
    .map((module, index) => ({ module, index, virtual: false }))
    .filter((entry) => entry.module.id === capability.id);
  const directWaterControl = capability.id === 'runtime.water-style';
  const modules = storedModules.length > 0 || (capability.repeatable && !directWaterControl)
    ? storedModules
    : [{ module: defaultRenderModule(capability, -1, draft), index: -1, virtual: true }];
  const policy = draft.accessPolicy ?? createDefaultRenderAccessPolicy();
  const availability = capability.availability ?? 'ready';
  const showTuning = view === 'tuning' || view === 'both';
  const showAccess = view === 'access' || view === 'both';
  const summaryNote = capability.availabilityNote
    ?? (view === 'access' ? '权限设置' : '实时预览');
  return `
    <details class="developer-capability ${storedModules.length ? 'active' : ''}" open>
      <summary>
        <span><strong>${escapeHtml(capability.label)}</strong><small>${escapeHtml(summaryNote)}</small></span>
        ${availability === 'ready' ? '' : `<em class="capability-status ${availability}">${availability === 'limited' ? '部分可用' : '不可用'}</em>`}
      </summary>
      <div class="developer-capability-body">
        ${showTuning ? renderTuningSection(capability, modules, hdriFiles, directWaterControl) : ''}
        ${showAccess ? `
          <p class="empty">决定 AI 和开发者能调哪些参数，以及允许的范围；不会改变当前画面。</p>
          <div class="developer-policy-table">
            ${Object.entries(capability.params).map(([parameter, rule]) => {
              const entry = policy.parameters.find((item) => (
                item.moduleId === capability.id && item.parameter === parameter
              ));
              return entry ? renderDeveloperPolicyRow(capability, parameter, rule, entry) : '';
            }).join('')}
          </div>
        ` : ''}
      </div>
    </details>
  `;
}

export function defaultRenderModule(
  capability: RenderCapability,
  index: number,
  scheme?: RenderScheme
): RenderModuleSelection {
  const params: Record<string, string | number> = {};
  for (const [parameter, rule] of Object.entries(capability.params)) {
    params[parameter] = settingValue(capability.id, parameter, scheme)
      ?? rule.default
      ?? fallbackValue(rule);
  }
  const scope = capability.id === 'runtime.water-style'
    ? { target: 'water' as const, tag: 'water' }
    : capability.id === 'runtime.effect-recipe'
      ? { target: 'material-tag' as const, tag: 'emissive' }
      : { target: 'material-tag' as const, tag: 'foliage' };
  return {
    ...(capability.repeatable ? { key: `${capability.id.replaceAll('.', '-')}-${Math.max(0, index)}` } : {}),
    id: capability.id,
    ...(capability.repeatable ? { scope } : {}),
    params
  };
}

function renderTuningSection(
  capability: RenderCapability,
  modules: Array<{ module: RenderModuleSelection; index: number; virtual: boolean }>,
  hdriFiles: string[],
  directWaterControl: boolean
): string {
  const addLabel = capability.id === 'runtime.material-theme' ? '添加材质规则' : '添加特效规则';
  if (capability.repeatable && !directWaterControl && modules.length === 0) {
    return `
      <div class="developer-empty-rule">
        <p class="empty">当前方案还没有这类规则。只有需要按标签批量处理资产时才添加。</p>
        <button type="button" class="secondary small" data-dev-add-module="${capability.id}">${addLabel}</button>
      </div>
    `;
  }
  return `
    ${modules.map(({ module, index, virtual }) => (
      renderDeveloperModuleInstance(capability, module, index, hdriFiles, virtual, directWaterControl)
    )).join('')}
    ${capability.repeatable && !directWaterControl
      ? `<button type="button" class="secondary small developer-add-rule" data-dev-add-module="${capability.id}">${addLabel}</button>`
      : ''}
  `;
}

function renderDeveloperPolicyRow(
  capability: RenderCapability,
  parameter: string,
  rule: RenderCapability['params'][string],
  entry: RenderParameterAccess
): string {
  const controls: RenderParameterAccess['control'][] = rule.type === 'number'
    ? ['range', 'number']
    : rule.type === 'enum'
      ? ['select', 'toggle']
      : rule.type === 'color'
        ? ['color']
        : ['code'];
  return `
    <div class="developer-policy-row">
      <strong>${parameterLabel(parameter)}</strong>
      <label>控件
        <select data-policy-control data-policy-module="${capability.id}" data-policy-param="${parameter}">
          ${controls.map((control) => `<option value="${control}" ${entry.control === control ? 'selected' : ''}>${control === 'range' ? '滑条' : control === 'number' ? '数字' : control === 'select' ? '选项' : control === 'toggle' ? '开关' : control === 'color' ? '颜色' : '代码'}</option>`).join('')}
        </select>
      </label>
      <label class="developer-toggle"><input type="checkbox" data-policy-enabled="ai" data-policy-module="${capability.id}" data-policy-param="${parameter}" ${entry.ai.enabled ? 'checked' : ''} ${capability.developerOnly ? 'disabled' : ''} /> AI</label>
      <label class="developer-toggle"><input type="checkbox" data-policy-enabled="developer" data-policy-module="${capability.id}" data-policy-param="${parameter}" ${entry.developer.enabled ? 'checked' : ''} /> 开发者</label>
      ${rule.type === 'number' ? `
        <div class="developer-ranges">
          ${renderPolicyRange(capability.id, parameter, 'ai', entry.ai, rule.min, rule.max)}
          ${renderPolicyRange(capability.id, parameter, 'developer', entry.developer, rule.min, rule.max)}
        </div>
      ` : ''}
      ${rule.type === 'enum' ? `
        <div class="developer-enum-access">
          ${(['ai', 'developer'] as const).map((side) => `
            <span><b>${side === 'ai' ? 'AI' : '开发者'}</b>${rule.values.map((value) => `
              <label><input type="checkbox" data-policy-enum-value="${escapeHtml(value)}" data-policy-side="${side}" data-policy-module="${capability.id}" data-policy-param="${parameter}" ${(entry[side].values ?? []).includes(value) ? 'checked' : ''} ${side === 'ai' && capability.developerOnly ? 'disabled' : ''} />${optionLabel(value)}</label>
            `).join('')}</span>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderPolicyRange(
  moduleId: string,
  parameter: string,
  side: 'ai' | 'developer',
  access: RenderParameterAccess['ai'],
  hardMin: number,
  hardMax: number
): string {
  return `
    <span><b>${side === 'ai' ? 'AI' : '开发者'}</b>
      <input type="number" data-policy-range="min" data-policy-side="${side}" data-policy-module="${moduleId}" data-policy-param="${parameter}" min="${hardMin}" max="${hardMax}" value="${access.min ?? hardMin}" />
      <i>—</i>
      <input type="number" data-policy-range="max" data-policy-side="${side}" data-policy-module="${moduleId}" data-policy-param="${parameter}" min="${hardMin}" max="${hardMax}" value="${access.max ?? hardMax}" />
    </span>
  `;
}

function renderDeveloperModuleInstance(
  capability: RenderCapability,
  module: RenderModuleSelection,
  index: number,
  hdriFiles: string[],
  virtual: boolean,
  directWaterControl: boolean
): string {
  const title = directWaterControl
    ? '全局结构化水体'
    : capability.repeatable
      ? module.scope?.tag || `规则 ${index + 1}`
      : capability.label;
  return `
    <div class="developer-module-instance ${virtual ? 'virtual' : ''}">
      ${capability.repeatable ? `
        <div class="developer-module-head">
          <strong>${escapeHtml(title)}</strong>
          ${!directWaterControl && !virtual ? `<button type="button" class="danger small" data-dev-remove-module="${index}">删除规则</button>` : ''}
        </div>
      ` : ''}
      ${capability.repeatable && !directWaterControl ? renderRuleTarget(capability, module, index) : ''}
      <div class="developer-preset-grid">
        ${Object.entries(capability.params).map(([parameter, rule]) => (
          renderDeveloperPresetInput(parameter, rule, module.params[parameter], index, capability.id, hdriFiles)
        )).join('')}
      </div>
    </div>
  `;
}

function renderRuleTarget(capability: RenderCapability, module: RenderModuleSelection, index: number): string {
  const materialRule = capability.id === 'runtime.material-theme';
  return `
    <div class="developer-scope">
      <label>匹配方式
        <select data-dev-module-index="${index}" data-dev-module-id="${capability.id}" data-dev-scope="target">
          <option value="material-tag" ${module.scope?.target === 'material-tag' ? 'selected' : ''}>材质标签</option>
          <option value="asset-tag" ${module.scope?.target === 'asset-tag' ? 'selected' : ''}>资产标签</option>
        </select>
      </label>
      <label>${materialRule ? '要替换的标签' : '要添加特效的标签'}
        <input data-dev-module-index="${index}" data-dev-module-id="${capability.id}" data-dev-scope="tag" value="${escapeHtml(module.scope?.tag ?? '')}" placeholder="foliage / stone / emissive" />
      </label>
    </div>
  `;
}

function renderDeveloperPresetInput(
  parameter: string,
  rule: RenderCapability['params'][string],
  current: string | number | undefined,
  index: number,
  moduleId: string,
  hdriFiles: string[]
): string {
  const value = current ?? rule.default ?? fallbackValue(rule);
  const identity = `data-dev-module-index="${index}" data-dev-module-id="${moduleId}" data-dev-param="${parameter}"`;
  if (rule.type === 'code' && rule.control === 'select') {
    const options = ['', ...hdriFiles];
    return `<label><span>${parameterLabel(parameter)}</span><select ${identity}>${options.map((option) => `<option value="${escapeHtml(option)}" ${value === option ? 'selected' : ''}>${escapeHtml(option || '不使用 HDRI')}</option>`).join('')}</select></label>${hdriFiles.length ? '' : '<p class="empty">把 .exr 放进 data/map-editor/hdri 后重新打开面板。</p>'}`;
  }
  if (rule.type === 'enum') {
    return `<label><span>${parameterLabel(parameter)}</span><select ${identity}>${rule.values.map((option) => `<option value="${escapeHtml(option)}" ${value === option ? 'selected' : ''}>${optionLabel(option)}</option>`).join('')}</select></label>`;
  }
  if (rule.type === 'color') {
    return `<label><span>${parameterLabel(parameter)}</span><input type="color" ${identity} value="${escapeHtml(String(value || '#ffffff'))}" /></label>`;
  }
  if (rule.type === 'code') {
    return `<label class="developer-code"><span>${parameterLabel(parameter)}</span><textarea rows="7" maxlength="${rule.maxLength}" ${identity} placeholder="隔离 GLSL 扩展">${escapeHtml(String(value))}</textarea></label>`;
  }
  const step = numericStep(rule.min, rule.max);
  return `
    <label class="developer-number-control">
      <span><span>${parameterLabel(parameter)}</span><output data-dev-value-output="${index}:${escapeHtml(parameter)}">${value}</output></span>
      <input class="developer-value-range" type="range" min="${rule.min}" max="${rule.max}" step="${step}" ${identity} value="${value}" />
      <input class="developer-value-number" type="number" min="${rule.min}" max="${rule.max}" step="${step}" ${identity} value="${value}" />
    </label>
  `;
}

function settingValue(moduleId: string, parameter: string, scheme?: RenderScheme): string | number | undefined {
  if (!scheme) return undefined;
  const settings = scheme.settings;
  const key = `${moduleId}:${parameter}`;
  const values: Record<string, string | number> = {
    'environment.palette:background': settings.background,
    'environment.palette:fogColor': settings.fogColor,
    'atmosphere.fog:density': settings.fogDensity,
    'lighting.hemisphere:skyColor': settings.hemisphereSkyColor,
    'lighting.hemisphere:groundColor': settings.hemisphereGroundColor,
    'lighting.hemisphere:intensity': settings.hemisphereIntensity,
    'lighting.sun:color': settings.sunColor,
    'lighting.sun:intensity': settings.sunIntensity,
    'presentation.exposure:value': settings.exposure
  };
  return values[key];
}

function fallbackValue(rule: RenderCapability['params'][string]): string | number {
  if (rule.type === 'color') return '#ffffff';
  if (rule.type === 'enum') return rule.values[0] ?? '';
  if (rule.type === 'code') return '';
  if (rule.min <= 0 && rule.max >= 0) return 0;
  return rule.min;
}

function numericStep(min: number, max: number): number {
  const span = Math.max(0, max - min);
  if (span === 0) return 0.001;
  const magnitude = 10 ** Math.floor(Math.log10(span));
  return Math.max(0.001, magnitude / 100);
}

function parameterLabel(parameter: string): string {
  return escapeHtml(PARAMETER_LABELS[parameter] ?? parameter);
}

function optionLabel(option: string): string {
  return escapeHtml(OPTION_LABELS[option] ?? option);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
