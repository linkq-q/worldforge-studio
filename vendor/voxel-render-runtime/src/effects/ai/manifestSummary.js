/**
 * manifestSummary.js — Layer 清单的「精简封闭词表」视图（Phase 2B）
 *
 * 用途：注入到 Intent Parser / Layer Planner 的 prompt，让 LLM 在**封闭可组合空间**里规划，
 *   而不是凭空想 shader（对标 VLMaterial「紧凑 DSL + 受控生成」、Proc3D「语言原生紧凑图」）。
 *
 * 只暴露规划所需字段：id / displayName / stage / tier / channels / params(schema) /
 *   incompatibleWith / stateBindings / cost。不泄露 GLSL、不泄露实现细节。
 *
 * 硬约束：纯逻辑，禁止 import three。输入是 #01 的 LayerRegistry（提供 list/get）。
 */

import { STAGE_ORDER } from '../EffectLayer.js';

/**
 * 把单个 manifest 压成 prompt 友好的精简 param schema（去掉 UI/权限无关字段）。
 */
function summarizeParams(params = {}) {
  const out = {};
  for (const [name, p] of Object.entries(params)) {
    const entry = { type: p.type, default: p.default };
    if (p.aiRange !== undefined) entry.aiRange = p.aiRange;
    else {
      if (p.min !== undefined) entry.min = p.min;
      if (p.max !== undefined) entry.max = p.max;
    }
    if (p.designerRange !== undefined) entry.designerRange = p.designerRange;
    if (p.hardRange !== undefined) entry.hardRange = p.hardRange;
    if (p.freeLocked) entry.freeLocked = true;
    out[name] = entry;
  }
  return out;
}

/**
 * 单层精简摘要。
 * @param {object} manifest
 * @returns {object}
 */
export function summarizeLayer(manifest) {
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    stage: manifest.stage,
    kind: manifest.kind || 'patch',
    tier: manifest.tier,
    channels: [...(manifest.channels || [])],
    params: summarizeParams(manifest.params),
    incompatibleWith: [...(manifest.incompatibleWith || [])],
    stateBindings: [...(manifest.stateBindings || [])],
    cost: { ...manifest.cost },
  };
}

/**
 * 全量 Layer 摘要数组（按 STAGE_ORDER 稳定排序，便于 LLM 理解大类顺序）。
 * @param {{list:()=>string[], get:(id:string)=>{manifest:object}}} registry
 * @returns {object[]}
 */
export function buildManifestSummary(registry) {
  const summaries = registry.list().map(id => summarizeLayer(registry.get(id).manifest));
  return summaries.sort((a, b) => {
    const wa = STAGE_ORDER.indexOf(a.stage);
    const wb = STAGE_ORDER.indexOf(b.stage);
    if (wa !== wb) return wa - wb;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Planner 用的封闭词表：大类顺序 + 各大类下可选 layer id + 全量摘要。
 * @param {object} registry
 * @returns {{stages:string[], layersByStage:Object<string,string[]>, layers:object[]}}
 */
export function buildPlannerVocabulary(registry) {
  const layers = buildManifestSummary(registry);
  const layersByStage = {};
  for (const stage of STAGE_ORDER) layersByStage[stage] = [];
  for (const l of layers) {
    if (!layersByStage[l.stage]) layersByStage[l.stage] = [];
    layersByStage[l.stage].push(l.id);
  }
  return { stages: [...STAGE_ORDER], layersByStage, layers };
}

/**
 * 注入 prompt 的紧凑 JSON 字符串（封闭词表 + 大类顺序约束说明）。
 * @param {object} registry
 * @returns {string}
 */
export function summarizeForPrompt(registry) {
  const vocab = buildPlannerVocabulary(registry);
  return JSON.stringify(vocab);
}
