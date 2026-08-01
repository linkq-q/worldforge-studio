import type { RenderScheme } from '../shared/renderScheme';
import {
  createDefaultRenderAccessPolicy,
  type RenderCapability,
  type RenderModuleSelection,
  type RenderParameterAccess
} from '../shared/renderPlan';

const PARAMETER_LABELS: Record<string, string> = {
  recipe: '风格配方',
  opacity: '透明度',
  color: '主颜色',
  shallowColor: '浅水颜色',
  depthColor: '深水颜色',
  waveStrength: '波纹强度',
  waveSpeed: '波纹速度',
  foamStrength: '泡沫强度',
  reflectionStrength: '反射强度',
  reflectionDistortion: '反射扰动',
  reflectionFresnel: '反射 Fresnel',
  intensity: '强度',
  strength: '强度',
  exposure: '曝光',
  saturation: '饱和度',
  contrast: '对比度',
  temperature: '冷暖',
  shadowLift: '暗部抬升',
  rotation: '旋转'
};

export function renderDeveloperCapability(
  capability: RenderCapability,
  draft: RenderScheme,
  hdriFiles: string[]
): string {
  const modules = (draft.renderPlan?.modules ?? [])
    .map((module, index) => ({ module, index }))
    .filter((entry) => entry.module.id === capability.id);
  const policy = draft.accessPolicy ?? createDefaultRenderAccessPolicy();
  const availability = capability.availability ?? 'ready';
  return `
    <details class="developer-capability ${modules.length ? 'active' : ''}" ${modules.length ? 'open' : ''}>
      <summary>
        <span><strong>${escapeHtml(capability.label)}</strong><small>${capability.id}</small></span>
        <em class="capability-status ${availability}">${availability === 'ready' ? '可用' : availability === 'limited' ? '部分可用' : '不可用'}</em>
      </summary>
      <div class="developer-capability-body">
        ${capability.availabilityNote ? `<p class="empty">${escapeHtml(capability.availabilityNote)}</p>` : ''}
        <div class="developer-capability-actions">
          ${capability.repeatable
            ? `<button type="button" class="secondary small" data-dev-add-module="${capability.id}">添加作用域</button>`
            : `<label class="developer-toggle"><input type="checkbox" data-dev-module-enable="${capability.id}" ${modules.length ? 'checked' : ''} /> 在此预设中启用</label>`}
        </div>
        <h3>当前效果 · 实时预览</h3>
        ${modules.length
          ? modules.map(({ module, index }) => renderDeveloperModuleInstance(capability, module, index, hdriFiles)).join('')
          : '<p class="empty">此方案尚未启用该能力。</p>'}
        <h3>开放策略</h3>
        <p class="empty">先在上方找到合适的当前值，再设置允许 AI / 开发者调整的范围。</p>
        <div class="developer-policy-table">
          ${Object.entries(capability.params).map(([parameter, rule]) => {
            const entry = policy.parameters.find((item) => (
              item.moduleId === capability.id && item.parameter === parameter
            ));
            return entry ? renderDeveloperPolicyRow(capability, parameter, rule, entry) : '';
          }).join('')}
        </div>
      </div>
    </details>
  `;
}

export function defaultRenderModule(capability: RenderCapability, index: number): RenderModuleSelection {
  const params: Record<string, string | number> = {};
  for (const [parameter, rule] of Object.entries(capability.params)) {
    if (rule.default !== undefined) params[parameter] = rule.default;
  }
  const scope = capability.id === 'runtime.water-style'
    ? { target: 'water' as const, tag: 'water' }
    : capability.id === 'runtime.effect-recipe'
      ? { target: 'material-tag' as const, tag: 'emissive' }
      : { target: 'material-tag' as const, tag: 'foliage' };
  return {
    ...(capability.repeatable ? { key: `${capability.id.replaceAll('.', '-')}-${index}` } : {}),
    id: capability.id,
    ...(capability.repeatable ? { scope } : {}),
    params
  };
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
      <label>形式
        <select data-policy-control data-policy-module="${capability.id}" data-policy-param="${parameter}">
          ${controls.map((control) => `<option value="${control}" ${entry.control === control ? 'selected' : ''}>${control}</option>`).join('')}
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
              <label><input type="checkbox" data-policy-enum-value="${escapeHtml(value)}" data-policy-side="${side}" data-policy-module="${capability.id}" data-policy-param="${parameter}" ${(entry[side].values ?? []).includes(value) ? 'checked' : ''} ${side === 'ai' && capability.developerOnly ? 'disabled' : ''} />${escapeHtml(value)}</label>
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
  hdriFiles: string[]
): string {
  return `
    <div class="developer-module-instance">
      <div class="developer-module-head">
        <strong>${capability.repeatable ? escapeHtml(module.key ?? `作用域 ${index + 1}`) : escapeHtml(capability.label)}</strong>
        ${capability.repeatable ? `<button type="button" class="danger small" data-dev-remove-module="${index}">移除</button>` : ''}
      </div>
      ${capability.repeatable ? `
        <div class="developer-scope">
          <label>目标
            <select data-dev-module-index="${index}" data-dev-scope="target">
              ${['water', 'material-tag', 'asset-tag'].map((target) => `<option value="${target}" ${module.scope?.target === target ? 'selected' : ''}>${target}</option>`).join('')}
            </select>
          </label>
          <label>标签
            <input data-dev-module-index="${index}" data-dev-scope="tag" value="${escapeHtml(module.scope?.tag ?? '')}" placeholder="foliage / stone / tree" />
          </label>
        </div>
      ` : ''}
      <div class="developer-preset-grid">
        ${Object.entries(capability.params).map(([parameter, rule]) => (
          renderDeveloperPresetInput(parameter, rule, module.params[parameter], index, hdriFiles)
        )).join('')}
      </div>
    </div>
  `;
}

function renderDeveloperPresetInput(
  parameter: string,
  rule: RenderCapability['params'][string],
  current: string | number | undefined,
  index: number,
  hdriFiles: string[]
): string {
  const value = current ?? rule.default ?? '';
  if (rule.type === 'code' && rule.control === 'select') {
    const options = ['', ...hdriFiles];
    return `<label><span>${parameterLabel(parameter)}</span><select data-dev-module-index="${index}" data-dev-param="${parameter}">${options.map((option) => `<option value="${escapeHtml(option)}" ${value === option ? 'selected' : ''}>${escapeHtml(option || '（不使用 HDRI）')}</option>`).join('')}</select></label>${hdriFiles.length ? '' : '<p class="empty">把 .hdr/.exr/.jpg 放进 data/map-editor/hdri 目录后重新打开此面板。</p>'}`;
  }
  if (rule.type === 'enum') {
    return `<label><span>${parameterLabel(parameter)}</span><select data-dev-module-index="${index}" data-dev-param="${parameter}">${rule.values.map((option) => `<option value="${escapeHtml(option)}" ${value === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (rule.type === 'color') {
    return `<label><span>${parameterLabel(parameter)}</span><input type="color" data-dev-module-index="${index}" data-dev-param="${parameter}" value="${escapeHtml(String(value || '#ffffff'))}" /></label>`;
  }
  if (rule.type === 'code') {
    return `<label class="developer-code"><span>${parameterLabel(parameter)}</span><textarea rows="7" maxlength="${rule.maxLength}" data-dev-module-index="${index}" data-dev-param="${parameter}" placeholder="隔离 GLSL 扩展">${escapeHtml(String(value))}</textarea></label>`;
  }
  const step = Math.max(0.001, (rule.max - rule.min) / 100);
  return `
    <label class="developer-number-control">
      <span><span>${parameterLabel(parameter)}</span><output data-dev-value-output="${index}:${escapeHtml(parameter)}">${value}</output></span>
      <input class="developer-value-range" type="range" min="${rule.min}" max="${rule.max}" step="${step}" data-dev-module-index="${index}" data-dev-param="${parameter}" value="${value}" />
      <input class="developer-value-number" type="number" min="${rule.min}" max="${rule.max}" step="${step}" data-dev-module-index="${index}" data-dev-param="${parameter}" value="${value}" />
    </label>
  `;
}

function parameterLabel(parameter: string): string {
  return escapeHtml(PARAMETER_LABELS[parameter] ?? parameter);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
