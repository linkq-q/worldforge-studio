/**
 * EffectSchemaValidator.js — Effect Package IR 校验器（Phase 2B，鲁棒性核心 §5.2④）
 *
 * 在 IR 层（编译前）做四类校验，对标 VLMaterial「推理期语法检查器，屏蔽非法 token，
 * 保证生成程序正确性」——差别是我们校验 IR（容易做到 100% 正确）而非 GLSL（难穷举）：
 *   (a) 结构合法：materialLayers 为非空字符串数组
 *   (b) Layer 存在 + 大类规则：未知 id 报错；至多一个 base 层（base 层替换着色，互斥）
 *   (c) 兼容性：incompatibleWith 冲突检测（复用 registry.checkCompatibility）
 *   (d) 预算：cost 估算分不超 maxCostScore（移动端更严，对齐 frame budget）
 * 另含：stateBindings ⊆ 运行时白名单；layerParams 引用与取值范围校验。
 *
 * 返回**结构化错误**（{code, message, layer?}）而非抛错——供 Repair Loop 回灌 LLM 自修复。
 *
 * 硬约束：纯逻辑，禁止 import three。输入是 #01 的 LayerRegistry。
 */

import { STAGE_ORDER, RUNTIME_UNIFORM_WHITELIST } from '../EffectLayer.js';

const WHITELIST_SET = new Set(RUNTIME_UNIFORM_WHITELIST);

// cost.instructions → 估算权重；总分与 maxCostScore 比较（启发式，非精确 ms）
const INSTR_WEIGHT = { low: 1, med: 2, high: 4 };

export const ERROR_CODES = Object.freeze({
  NOT_OBJECT: 'NOT_OBJECT',
  LAYERS_NOT_ARRAY: 'LAYERS_NOT_ARRAY',
  LAYERS_EMPTY: 'LAYERS_EMPTY',
  LAYER_NOT_STRING: 'LAYER_NOT_STRING',
  DUPLICATE_LAYER: 'DUPLICATE_LAYER',
  UNKNOWN_LAYER: 'UNKNOWN_LAYER',
  MULTIPLE_BASE: 'MULTIPLE_BASE',
  INCOMPATIBLE: 'INCOMPATIBLE',
  BAD_STATE_BINDING: 'BAD_STATE_BINDING',
  PARAM_LAYER_UNKNOWN: 'PARAM_LAYER_UNKNOWN',
  PARAM_UNKNOWN: 'PARAM_UNKNOWN',
  PARAM_OUT_OF_RANGE: 'PARAM_OUT_OF_RANGE',
  PARAM_BAD_TYPE: 'PARAM_BAD_TYPE',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 估算一个已知 layer 集合的 cost 分。 */
export function estimateCostScore(layerIds, registry) {
  let score = 0;
  for (const id of layerIds) {
    if (!registry.has(id)) continue;
    const cost = registry.get(id).manifest.cost || {};
    score += (INSTR_WEIGHT[cost.instructions] || 1)
      + (cost.textureReads || 0)
      + (cost.drawCalls || 0) * 2;
  }
  return score;
}

/**
 * 校验单个 layer 的 layerParams（取值范围 / 类型 / 未知 param）。
 */
function validateLayerParams(layerId, paramValues, manifestParams, errors) {
  for (const [name, value] of Object.entries(paramValues)) {
    const schema = manifestParams[name];
    if (!schema) {
      errors.push({ code: ERROR_CODES.PARAM_UNKNOWN, layer: layerId,
        message: `layerParams.${layerId}.${name}: unknown param (not in manifest)` });
      continue;
    }
    if (schema.type === 'color') {
      if (!Array.isArray(value) || value.length !== 3 || !value.every(n => typeof n === 'number')) {
        errors.push({ code: ERROR_CODES.PARAM_BAD_TYPE, layer: layerId,
          message: `layerParams.${layerId}.${name}: color must be [r,g,b] numbers` });
      }
      continue;
    }
    if (schema.type === 'bool') {
      if (typeof value !== 'boolean') {
        errors.push({ code: ERROR_CODES.PARAM_BAD_TYPE, layer: layerId,
          message: `layerParams.${layerId}.${name}: must be boolean` });
      }
      continue;
    }
    if (schema.type === 'string') {
      if (typeof value !== 'string' && !(value === null && schema.nullable === true)) {
        errors.push({ code: ERROR_CODES.PARAM_BAD_TYPE, layer: layerId,
          message: `layerParams.${layerId}.${name}: must be string${schema.nullable ? ' or null' : ''}` });
      }
      continue;
    }
    // float | int
    if (typeof value !== 'number') {
      errors.push({ code: ERROR_CODES.PARAM_BAD_TYPE, layer: layerId,
        message: `layerParams.${layerId}.${name}: must be a number` });
      continue;
    }
    if (schema.min !== undefined && value < schema.min) {
      errors.push({ code: ERROR_CODES.PARAM_OUT_OF_RANGE, layer: layerId,
        message: `layerParams.${layerId}.${name}: ${value} < min ${schema.min}` });
    }
    if (schema.max !== undefined && value > schema.max) {
      errors.push({ code: ERROR_CODES.PARAM_OUT_OF_RANGE, layer: layerId,
        message: `layerParams.${layerId}.${name}: ${value} > max ${schema.max}` });
    }
  }
}

/**
 * 校验一份 Effect Package IR。收集**所有**错误后一次性返回（非 fail-fast，便于 repair）。
 *
 * @param {object} pkg - { schemaVersion?, materialLayers:[], layerParams?, stateBindings?, ... }
 * @param {object} opts
 * @param {object} opts.registry - LayerRegistry
 * @param {number} [opts.maxCostScore=24] - 预算上限（移动端建议传更小，如 14）
 * @returns {{valid:boolean, errors:Array<{code:string,message:string,layer?:string}>, warnings:string[]}}
 */
export function validateEffectPackage(pkg, { registry, maxCostScore = 24 } = {}) {
  const errors = [];
  const warnings = [];
  if (!registry) throw new Error('validateEffectPackage requires opts.registry');

  if (!isPlainObject(pkg)) {
    return { valid: false, errors: [{ code: ERROR_CODES.NOT_OBJECT, message: 'package must be an object' }], warnings };
  }

  if (!pkg.schemaVersion) warnings.push('schemaVersion missing (recommended)');

  // (a) 结构：materialLayers 非空字符串数组
  const layers = pkg.materialLayers;
  if (!Array.isArray(layers)) {
    return { valid: false, errors: [{ code: ERROR_CODES.LAYERS_NOT_ARRAY, message: 'materialLayers must be an array' }], warnings };
  }
  if (layers.length === 0) {
    errors.push({ code: ERROR_CODES.LAYERS_EMPTY, message: 'materialLayers must not be empty' });
  }

  const seen = new Set();
  const knownIds = [];
  for (const id of layers) {
    if (typeof id !== 'string') {
      errors.push({ code: ERROR_CODES.LAYER_NOT_STRING, message: `materialLayers entry not a string: ${JSON.stringify(id)}` });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ code: ERROR_CODES.DUPLICATE_LAYER, layer: id, message: `duplicate layer: ${id}` });
      continue;
    }
    seen.add(id);
    // (b) Layer 存在
    if (!registry.has(id)) {
      errors.push({ code: ERROR_CODES.UNKNOWN_LAYER, layer: id, message: `unknown layer: ${id}` });
      continue;
    }
    knownIds.push(id);
  }

  // (b) 大类规则：至多一个 base 层
  const baseLayers = knownIds.filter(id => registry.get(id).manifest.stage === 'base');
  if (baseLayers.length > 1) {
    errors.push({ code: ERROR_CODES.MULTIPLE_BASE,
      message: `at most one base-stage layer allowed (got: ${baseLayers.join(', ')})` });
  }

  // (c) 兼容性
  if (knownIds.length > 1) {
    const compat = registry.checkCompatibility(knownIds);
    if (!compat.ok) {
      for (const [a, b] of compat.conflicts) {
        errors.push({ code: ERROR_CODES.INCOMPATIBLE, message: `incompatible layers: ${a} × ${b}` });
      }
    }
  }

  // stateBindings ⊆ 白名单（pkg 级，可选）
  if (pkg.stateBindings !== undefined) {
    if (!Array.isArray(pkg.stateBindings)) {
      errors.push({ code: ERROR_CODES.BAD_STATE_BINDING, message: 'stateBindings must be an array when present' });
    } else {
      for (const b of pkg.stateBindings) {
        if (!WHITELIST_SET.has(b)) {
          errors.push({ code: ERROR_CODES.BAD_STATE_BINDING, message: `stateBinding "${b}" not in runtime whitelist` });
        }
      }
    }
  }

  // layerParams 校验
  if (pkg.layerParams !== undefined) {
    if (!isPlainObject(pkg.layerParams)) {
      errors.push({ code: ERROR_CODES.PARAM_LAYER_UNKNOWN, message: 'layerParams must be an object' });
    } else {
      for (const [layerId, values] of Object.entries(pkg.layerParams)) {
        if (!seen.has(layerId)) {
          warnings.push(`layerParams references "${layerId}" not in materialLayers (ignored)`);
          continue;
        }
        if (!registry.has(layerId)) continue; // 已在 UNKNOWN_LAYER 报过
        if (!isPlainObject(values)) {
          errors.push({ code: ERROR_CODES.PARAM_BAD_TYPE, layer: layerId,
            message: `layerParams.${layerId} must be an object` });
          continue;
        }
        validateLayerParams(layerId, values, registry.get(layerId).manifest.params || {}, errors);
      }
    }
  }

  // (d) 预算
  const score = estimateCostScore(knownIds, registry);
  if (score > maxCostScore) {
    errors.push({ code: ERROR_CODES.BUDGET_EXCEEDED,
      message: `cost score ${score} exceeds budget ${maxCostScore}` });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** 把错误数组格式化成回灌 LLM 的紧凑文本（供 Repair Loop）。 */
export function formatErrorsForRepair(errors) {
  return errors.map(e => `- [${e.code}]${e.layer ? ` (${e.layer})` : ''} ${e.message}`).join('\n');
}
