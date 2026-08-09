/**
 * EffectLayer.js — Effect Package 协议核心（任务书 #01）
 *
 * 这是 AI 输出的中间表示 (IR) 的契约层：常量 + Manifest 校验 + 大类排序 + 兼容性 + 基类。
 *
 * 硬约束：本文件是**渲染器无关的纯数据/逻辑层**，禁止 import three 或任何渲染模块。
 * 这样 (a) 能脱离浏览器用 node 自测；(b) 未来迁移 TSL/WebGPU 时 IR 层不受影响。
 *
 * 术语提醒：这里的 `stage` 是**效果执行顺序大类**（base→…→stylization）。
 * 它曾叫 `category`，因与 src/ShaderLibrary.js 的 `category`（材质类型 building/glass/default）
 * 在同一代码库撞名、语义不同，验收阶段定案改名为 `stage`。两者正交，切勿混用。
 * 详见 docs/recon_effectlayer_protocol.md。
 */

// ── 大类执行顺序：固定，AI 不可打乱；数组下标即排序权重 ──
// （字段名 stage；曾名 CATEGORY_ORDER/category，见文件头术语提醒）
export const STAGE_ORDER = ['base', 'surface', 'color', 'emissive', 'feedback', 'stylization'];

export const TIER_ENUM = ['base', 'standard', 'premium', 'ai_generated'];

// 合法的材质输出通道
export const CHANNELS = ['baseColor', 'emissive', 'alpha', 'normal', 'position'];

// 运行时游戏状态白名单——Layer 的 stateBindings 只能取这些值（视觉随战斗实时响应的接口契约）
export const RUNTIME_UNIFORM_WHITELIST = [
  'uTime', 'uObjectSeed',
  'uHitFlash', 'uChargeLevel', 'uDamageLevel', 'uFireCooldown',
  'uRarityLevel', 'uTeamColor',
];

const PARAM_TYPES = ['color', 'float', 'int', 'bool', 'string'];
const COST_INSTRUCTIONS = ['low', 'med', 'high'];
const ROUTE_ENUM = ['shaderPatch', 'materialOverride', 'postProcess', 'mask', 'companion', 'event', 'normal'];
const KIND_ENUM = ['patch', 'override', 'companion'];
const BATCH_POLICY_ENUM = ['effectBatchable', 'standaloneOnly', 'standalonePreferred', 'notMaterialRelated'];

const STAGE_SET = new Set(STAGE_ORDER);
const TIER_SET = new Set(TIER_ENUM);
const CHANNEL_SET = new Set(CHANNELS);
const WHITELIST_SET = new Set(RUNTIME_UNIFORM_WHITELIST);

// ── 内部小工具 ──
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * 校验单个 param schema，错误以 `params.<name>: ...` 形式 push 进 errors。
 */
function validateParam(name, param, errors) {
  const prefix = `params.${name}`;
  if (!isPlainObject(param)) {
    errors.push(`${prefix}: must be an object`);
    return;
  }
  if (!PARAM_TYPES.includes(param.type)) {
    errors.push(`${prefix}.type: must be one of ${PARAM_TYPES.join('|')} (got ${JSON.stringify(param.type)})`);
    return; // 类型未知则后续 default 校验无意义
  }
  if (!('default' in param)) {
    errors.push(`${prefix}.default: required`);
    return;
  }

  const { type, default: def, min, max } = param;

  if (type === 'color') {
    if (!Array.isArray(def) || def.length !== 3 || !def.every(n => typeof n === 'number')) {
      errors.push(`${prefix}.default: color default must be a 3-number array [r,g,b]`);
    }
  } else if (type === 'bool') {
    if (typeof def !== 'boolean') errors.push(`${prefix}.default: bool default must be a boolean`);
  } else if (type === 'string') {
    if (typeof def !== 'string' && !(def === null && param.nullable === true)) {
      errors.push(`${prefix}.default: string default must be a string${param.nullable ? ' or null' : ''}`);
    }
    // 可选枚举（particle-system-v1）：声明 options 后 default 必须在内；UI 渲染为下拉，AI 约束导出带枚举值
    if ('options' in param) {
      if (!isStringArray(param.options) || param.options.length === 0) {
        errors.push(`${prefix}.options: must be a non-empty string array`);
      } else if (typeof def === 'string' && !param.options.includes(def)) {
        errors.push(`${prefix}.default: must be one of options [${param.options.join(', ')}]`);
      }
    }
  } else {
    // float | int
    if (typeof def !== 'number') {
      errors.push(`${prefix}.default: ${type} default must be a number`);
    }
    if (type === 'int' && typeof def === 'number' && !Number.isInteger(def)) {
      errors.push(`${prefix}.default: int default must be an integer`);
    }
  }

  const hasMin = min !== undefined;
  const hasMax = max !== undefined;
  if (hasMin && typeof min !== 'number') errors.push(`${prefix}.min: must be a number`);
  if (hasMax && typeof max !== 'number') errors.push(`${prefix}.max: must be a number`);
  if (hasMin && hasMax && typeof min === 'number' && typeof max === 'number') {
    if (min > max) errors.push(`${prefix}: min (${min}) must be <= max (${max})`);
    // default 在 [min,max] 内（仅当 default 是数值）
    if (typeof def === 'number' && (def < min || def > max)) {
      errors.push(`${prefix}.default: ${def} out of range [${min}, ${max}]`);
    }
  }

  if ('freeLocked' in param && typeof param.freeLocked !== 'boolean') {
    errors.push(`${prefix}.freeLocked: must be a boolean`);
  }
  if ('nullable' in param && typeof param.nullable !== 'boolean') {
    errors.push(`${prefix}.nullable: must be a boolean`);
  }
}

/**
 * 校验一份 Manifest。收集**所有**错误后一次性返回（非 fail-fast）。
 * @param {object} manifest
 * @returns {{valid:boolean, errors:string[]}}
 */
export function validateManifest(manifest) {
  const errors = [];

  if (!isPlainObject(manifest)) {
    return { valid: false, errors: ['manifest: must be an object'] };
  }

  // 1 & 9. id
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    errors.push('id: required non-empty string');
  } else if (/\s/.test(manifest.id)) {
    errors.push('id: must not contain whitespace');
  }

  // displayName
  if (typeof manifest.displayName !== 'string' || manifest.displayName.length === 0) {
    errors.push('displayName: required non-empty string');
  }

  // 2. tier
  if (typeof manifest.tier !== 'string') {
    errors.push('tier: required string');
  } else if (!TIER_SET.has(manifest.tier)) {
    errors.push(`tier: must be one of ${TIER_ENUM.join('|')} (got ${JSON.stringify(manifest.tier)})`);
  }

  // 2. stage（执行顺序大类）
  if (typeof manifest.stage !== 'string') {
    errors.push('stage: required string');
  } else if (!STAGE_SET.has(manifest.stage)) {
    errors.push(`stage: must be one of ${STAGE_ORDER.join('|')} (got ${JSON.stringify(manifest.stage)})`);
  }

  // 3. channels
  if (!Array.isArray(manifest.channels) || manifest.channels.length === 0) {
    errors.push('channels: required non-empty array');
  } else {
    for (const ch of manifest.channels) {
      if (!CHANNEL_SET.has(ch)) {
        errors.push(`channels: invalid channel ${JSON.stringify(ch)} (must be one of ${CHANNELS.join('|')})`);
      }
    }
  }

  // 4. requires
  if (!isPlainObject(manifest.requires)) {
    errors.push('requires: required object { uniforms, varyings, textures }');
  } else {
    for (const key of ['uniforms', 'varyings', 'textures']) {
      if (!isStringArray(manifest.requires[key])) {
        errors.push(`requires.${key}: required string[] (may be empty)`);
      }
    }
  }

  // 5. params
  if (!isPlainObject(manifest.params)) {
    errors.push('params: required object (may be empty)');
  } else {
    for (const [name, param] of Object.entries(manifest.params)) {
      validateParam(name, param, errors);
    }
  }

  // 6. cost
  if (!isPlainObject(manifest.cost)) {
    errors.push('cost: required object { instructions, textureReads, drawCalls }');
  } else {
    if (!COST_INSTRUCTIONS.includes(manifest.cost.instructions)) {
      errors.push(`cost.instructions: must be one of ${COST_INSTRUCTIONS.join('|')}`);
    }
    if (!isNonNegativeInt(manifest.cost.textureReads)) {
      errors.push('cost.textureReads: must be a non-negative integer');
    }
    if (!isNonNegativeInt(manifest.cost.drawCalls)) {
      errors.push('cost.drawCalls: must be a non-negative integer');
    }
  }

  // 7. compatibleWith / incompatibleWith
  const hasCompat = isStringArray(manifest.compatibleWith);
  const hasIncompat = isStringArray(manifest.incompatibleWith);
  if (!hasCompat) errors.push('compatibleWith: required string[] (may be empty)');
  if (!hasIncompat) errors.push('incompatibleWith: required string[] (may be empty)');
  if (hasCompat && hasIncompat) {
    const incompatSet = new Set(manifest.incompatibleWith);
    const intersection = manifest.compatibleWith.filter(id => incompatSet.has(id));
    if (intersection.length > 0) {
      errors.push(`compatibleWith ∩ incompatibleWith must be empty (shared: ${intersection.join(', ')})`);
    }
  }

  // 8. stateBindings（可选，默认 []）
  if (manifest.stateBindings !== undefined) {
    if (!isStringArray(manifest.stateBindings)) {
      errors.push('stateBindings: must be string[] when present');
    } else {
      for (const binding of manifest.stateBindings) {
        if (!WHITELIST_SET.has(binding)) {
          errors.push(`stateBindings: ${JSON.stringify(binding)} not in RUNTIME_UNIFORM_WHITELIST`);
        }
      }
    }
  }

  // 9. runtime projection metadata（可选，旧 shaderPatch manifest 不填时由消费者走默认值）
  if (manifest.route !== undefined && !ROUTE_ENUM.includes(manifest.route)) {
    errors.push(`route: must be one of ${ROUTE_ENUM.join('|')} (got ${JSON.stringify(manifest.route)})`);
  }
  if (manifest.kind !== undefined && !KIND_ENUM.includes(manifest.kind)) {
    errors.push(`kind: must be one of ${KIND_ENUM.join('|')} (got ${JSON.stringify(manifest.kind)})`);
  }
  if (manifest.batchPolicy !== undefined && !BATCH_POLICY_ENUM.includes(manifest.batchPolicy)) {
    errors.push(`batchPolicy: must be one of ${BATCH_POLICY_ENUM.join('|')} (got ${JSON.stringify(manifest.batchPolicy)})`);
  }
  if (manifest.getEffectBatchKey !== undefined && typeof manifest.getEffectBatchKey !== 'function') {
    errors.push('getEffectBatchKey: must be a function when present');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 按 STAGE_ORDER 对一组 manifest（或 {stage} 对象）做**稳定**排序。
 * 同大类内保持传入相对顺序。供 LayerRegistry.sortByStage 复用。
 * @param {Array<{stage:string}>} items
 * @returns {Array}
 */
export function sortByStageOrder(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const wa = STAGE_ORDER.indexOf(a.item.stage);
      const wb = STAGE_ORDER.indexOf(b.item.stage);
      if (wa !== wb) return wa - wb;
      return a.index - b.index; // 稳定：同类保持原顺序
    })
    .map(entry => entry.item);
}

/**
 * EffectLayer 基类。
 *
 * 本 brief 只**声明** GLSL 发射接口的签名（后续 brief 填实现），
 * 仅实现 getDefaultUniforms()。构造时强制校验 manifest。
 */
export class EffectLayer {
  constructor(manifest) {
    const { valid, errors } = validateManifest(manifest);
    if (!valid) {
      throw new Error(`Invalid manifest for ${manifest?.id}: ${errors.join('; ')}`);
    }
    this.manifest = manifest;
  }

  get id() { return this.manifest.id; }
  get stage() { return this.manifest.stage; }
  get tier() { return this.manifest.tier; }

  /**
   * 由 manifest.params 的 default 生成 JS 侧默认 uniform 值对象。
   * @returns {Object<string, *>}
   */
  getDefaultUniforms() {
    const uniforms = {};
    const params = this.manifest.params || {};
    for (const [name, param] of Object.entries(params)) {
      // color default 是数组，按值拷贝避免共享引用
      uniforms[name] = Array.isArray(param.default) ? [...param.default] : param.default;
    }
    return uniforms;
  }

  // ── 以下为后续 brief 实现的 GLSL 发射接口，本 brief 仅声明签名 ──
  getUniformDeclarations() { throw new Error('not implemented in protocol brief'); }
  getVertexBody() { throw new Error('not implemented in protocol brief'); }
  getNormalBody() { return ''; }
  getFragmentBody() { throw new Error('not implemented in protocol brief'); }
}
