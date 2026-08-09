/**
 * EffectEditPlanner.js — 自然语言局部微调 → 参数 patch（Phase 2C §5.3B）
 *
 * "火焰再蓝一点 / 边缘光弱一点 / 快一点" → 只改对应 layer 的 uniform（走 runtime.updateParams，
 * **不重编译、不重生成整包**）。这是 IR 路线相对裸代码的决定性优势（对标 Proc3D O(1) 局部编辑）。
 *
 * 两层策略：
 *   1. 规则层（默认、无需 key、即时）：识别常见意图（变色/变亮暗/快慢/范围）→ 对包内相关 param 做增量。
 *   2. LLM 层（可选，规则没命中时）：把当前包 + 调整语 + param schema 给模型，让它出 patch。
 * 产出的 patch 一律按 manifest 的 [min,max] / 颜色形状校验并夹紧后才返回。
 *
 * 硬约束：纯逻辑，禁止 import three。LLM 经注入 complete()，可 fake 自测。
 */

import { parseLLMJson } from './llmClient.js';

// 颜色词 → 目标 RGB（与 effectFallback 的 HUE 表保持一致语义）
const HUE_TO_RGB = Object.freeze({
  blue: [0.2, 0.5, 1.0], '蓝': [0.2, 0.5, 1.0],
  red: [1.0, 0.25, 0.15], '红': [1.0, 0.25, 0.15],
  green: [0.3, 1.0, 0.4], '绿': [0.3, 1.0, 0.4],
  purple: [0.7, 0.3, 1.0], '紫': [0.7, 0.3, 1.0],
  gold: [1.0, 0.82, 0.3], '金': [1.0, 0.82, 0.3], yellow: [1.0, 0.85, 0.25], '黄': [1.0, 0.85, 0.25],
  white: [1.0, 1.0, 1.0], '白': [1.0, 1.0, 1.0],
  orange: [1.0, 0.5, 0.1], '橙': [1.0, 0.5, 0.1],
  cyan: [0.2, 0.9, 1.0], '青': [0.2, 0.9, 1.0],
});

// 强度/速度类调整词 → 乘子
const STRONGER = ['亮一点', '强一点', '更亮', '更强', 'brighter', 'stronger', 'more intense', '浓一点'];
const WEAKER = ['暗一点', '弱一点', '更暗', '更弱', 'dimmer', 'weaker', 'softer', '淡一点'];
const FASTER = ['快一点', '更快', 'faster', '急一点'];
const SLOWER = ['慢一点', '更慢', 'slower', '缓一点'];

const INTENSITY_PARAMS = ['intensity', 'glowStrength', 'specStrength', 'rimStrength'];
const SPEED_PARAMS = ['speed', 'pulseSpeed'];
const COLOR_STEP = 0.4;     // 颜色朝目标 hue 的 lerp 步长
const SCALE_STEP = 1.3;     // 变强/快的乘子（变弱/慢用其倒数）

function clamp(v, min, max) {
  if (min !== undefined && v < min) return min;
  if (max !== undefined && v > max) return max;
  return v;
}

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 取一个 layer 当前 param 的有效值（package 覆盖优先，否则 manifest 默认）。 */
function effectiveValue(pkg, layerId, paramName, manifest) {
  const override = pkg.layerParams?.[layerId]?.[paramName];
  if (override !== undefined) return override;
  return manifest.params?.[paramName]?.default;
}

function detectHue(text) {
  for (const [word, rgb] of Object.entries(HUE_TO_RGB)) {
    if (text.includes(word)) return [...rgb];
  }
  return null;
}

function includesAny(text, list) {
  return list.some(w => text.includes(w));
}

export class EffectEditPlanner {
  /**
   * @param {object} deps
   * @param {object} deps.registry - LayerRegistry
   * @param {(req:object)=>Promise<string>} [deps.complete] - 可选 LLM（规则没命中时用）
   */
  constructor({ registry, complete = null } = {}) {
    if (!registry) throw new Error('EffectEditPlanner requires registry');
    this.registry = registry;
    this.complete = complete;
  }

  /**
   * @param {object} pkg - 当前已应用的 Effect Package
   * @param {string} tweakText - 自然语言调整语
   * @returns {Promise<{patch:object, source:'rule'|'llm'|'none', note?:string}>}
   */
  async planEdit(pkg, tweakText) {
    const text = String(tweakText ?? '').toLowerCase();
    const layers = (pkg?.materialLayers || []).filter(id => this.registry.has(id));
    if (layers.length === 0 || !text) return { patch: {}, source: 'none' };

    const rulePatch = this._rulePatch(pkg, layers, text);
    if (Object.keys(rulePatch).length > 0) return { patch: rulePatch, source: 'rule' };

    if (this.complete) {
      try {
        const llmPatch = await this._llmPatch(pkg, layers, tweakText);
        if (Object.keys(llmPatch).length > 0) return { patch: llmPatch, source: 'llm' };
      } catch {
        /* LLM 失败 → 回到 none，调用方可提示"没听懂" */
      }
    }
    return { patch: {}, source: 'none' };
  }

  /** 规则增量：变色 / 变亮暗 / 快慢，作用于包内所有相关 param，夹紧到范围。 */
  _rulePatch(pkg, layers, text) {
    const patch = {};
    const hue = detectHue(text);
    const stronger = includesAny(text, STRONGER);
    const weaker = includesAny(text, WEAKER);
    const faster = includesAny(text, FASTER);
    const slower = includesAny(text, SLOWER);

    for (const id of layers) {
      const manifest = this.registry.get(id).manifest;
      const params = manifest.params || {};
      const layerPatch = {};

      // 颜色：朝目标 hue lerp（作用于该层所有 color 类型 param）
      if (hue) {
        for (const [name, schema] of Object.entries(params)) {
          if (schema.type !== 'color') continue;
          const cur = effectiveValue(pkg, id, name, manifest);
          if (Array.isArray(cur) && cur.length === 3) {
            layerPatch[name] = lerp3(cur, hue, COLOR_STEP).map(v => clamp(v, 0, 1));
          }
        }
      }

      // 强度
      if (stronger || weaker) {
        const factor = stronger ? SCALE_STEP : 1 / SCALE_STEP;
        for (const name of INTENSITY_PARAMS) {
          const schema = params[name];
          if (!schema || schema.type === 'color') continue;
          const cur = effectiveValue(pkg, id, name, manifest);
          if (typeof cur === 'number') layerPatch[name] = clamp(cur * factor, schema.min, schema.max);
        }
      }

      // 速度
      if (faster || slower) {
        const factor = faster ? SCALE_STEP : 1 / SCALE_STEP;
        for (const name of SPEED_PARAMS) {
          const schema = params[name];
          if (!schema || schema.type === 'color') continue;
          const cur = effectiveValue(pkg, id, name, manifest);
          if (typeof cur === 'number') layerPatch[name] = clamp(cur * factor, schema.min, schema.max);
        }
      }

      if (Object.keys(layerPatch).length > 0) patch[id] = layerPatch;
    }
    return patch;
  }

  /** LLM 兜底：要求只输出 { layerId: { param: value } }，校验后夹紧。 */
  async _llmPatch(pkg, layers, tweakText) {
    const schema = {};
    for (const id of layers) {
      const params = this.registry.get(id).manifest.params || {};
      schema[id] = Object.fromEntries(Object.entries(params).map(([n, p]) => [n,
        { type: p.type, ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}) }]));
    }
    const system = [
      'You adjust an EXISTING effect package by emitting ONLY a JSON param patch, no prose.',
      'Output shape: { "<layerId>": { "<param>": <value> } }. Only include params you change.',
      'Colors are [r,g,b] floats 0..1. Numbers must stay within each param min/max.',
      `Editable layers + param schema:\n${JSON.stringify(schema)}`,
    ].join('\n');
    const user = `CURRENT package layerParams:\n${JSON.stringify(pkg.layerParams || {})}\n\nADJUSTMENT:\n${tweakText}`;
    const raw = await this.complete({ system, user, temperature: 0.0, maxTokens: 512 });
    return this._sanitizePatch(parseLLMJson(raw), layers);
  }

  /** 校验+夹紧 LLM patch：丢掉未知 layer/param、类型不符项，数值夹到范围。 */
  _sanitizePatch(raw, layers) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    const layerSet = new Set(layers);
    for (const [id, values] of Object.entries(raw)) {
      if (!layerSet.has(id) || !values || typeof values !== 'object') continue;
      const params = this.registry.get(id).manifest.params || {};
      const clean = {};
      for (const [name, value] of Object.entries(values)) {
        const schema = params[name];
        if (!schema) continue;
        if (schema.type === 'color') {
          if (Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number')) {
            clean[name] = value.map(v => clamp(v, 0, 1));
          }
        } else if (typeof value === 'number') {
          clean[name] = clamp(value, schema.min, schema.max);
        }
      }
      if (Object.keys(clean).length > 0) out[id] = clean;
    }
    return out;
  }
}

/** 把 edit patch 合并进 package.layerParams（返回新包，不改原对象）——供调用方更新"当前包"。 */
export function mergeEditIntoPackage(pkg, patch) {
  const merged = { ...pkg, layerParams: { ...(pkg.layerParams || {}) } };
  for (const [id, values] of Object.entries(patch)) {
    merged.layerParams[id] = { ...(merged.layerParams[id] || {}), ...values };
  }
  return merged;
}
