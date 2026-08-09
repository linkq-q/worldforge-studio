/**
 * LayerPlanner.js — ② 意图 → Effect Package IR（Phase 2B §5.2②，系统智力所在）
 *
 * 意图 → 选哪些 layer、填什么参数、声明哪些 stateBindings，输出 Effect Package JSON(IR)。
 * prompt 注入 manifest 精简视图（封闭可组合空间），让 LLM 在已注册 layer 里规划而非凭空想。
 * 支持 repair：把上一轮的校验错误回灌，要求修正（§5.2⑤）。
 *
 * 我们的 IR 比节点图更轻（layer id 列表 + 参数字典），LLM 命中率天然更高。
 *
 * 硬约束：纯逻辑，禁止 import three。LLM 经注入 complete()，可 fake 自测。
 */

import { summarizeForPrompt } from './manifestSummary.js';
import { parseLLMJson } from './llmClient.js';

function buildSystemPrompt(vocabJson) {
  return [
    'You are an effect-layer PLANNER. Given a structured intent, output an Effect Package as strict JSON.',
    'Return ONLY a JSON object, no prose. Schema:',
    '{',
    '  "schemaVersion": "1.0",',
    '  "materialLayers": string[],          // layer ids chosen from the closed vocabulary below',
    '  "layerParams": { [layerId]: object },// per-layer param overrides (names/types/ranges per schema)',
    '  "stateBindings": string[]            // runtime uniforms this package reacts to (subset of layers\' stateBindings)',
    '}',
    'HARD RULES:',
    '- Choose ONLY layer ids that appear in the vocabulary. Never invent ids.',
    '- At most ONE layer whose stage === "base".',
    '- Never include two layers that list each other in incompatibleWith.',
    '- Keep params within each param\'s [min,max]; colors are [r,g,b] floats 0..1.',
    '- Prefer 2-4 layers. Stage order is enforced downstream; you only pick the set + params.',
    `CLOSED VOCABULARY (stages in fixed order, layers with param schema + incompatibleWith):\n${vocabJson}`,
  ].join('\n');
}

function buildUserPrompt(intent, repair) {
  const parts = [`INTENT:\n${JSON.stringify(intent)}`];
  if (repair && repair.previous) {
    parts.push(`PREVIOUS ATTEMPT (was INVALID):\n${JSON.stringify(repair.previous)}`);
    parts.push(`VALIDATION ERRORS to FIX:\n${repair.errors}`);
    parts.push('Return a corrected Effect Package that fixes ALL the above errors.');
  }
  return parts.join('\n\n');
}

export class LayerPlanner {
  /**
   * @param {object} deps
   * @param {(req:object)=>Promise<string>} deps.complete
   * @param {object} deps.registry
   */
  constructor({ complete, registry }) {
    if (typeof complete !== 'function') throw new Error('LayerPlanner requires complete()');
    if (!registry) throw new Error('LayerPlanner requires registry');
    this.complete = complete;
    this.registry = registry;
    this._vocabJson = summarizeForPrompt(registry);
  }

  /**
   * @param {object} intent
   * @param {object} [repair] - { previous:object, errors:string } 用于修复回合
   * @returns {Promise<{package:object, raw:string}>}
   */
  async plan(intent, repair = null) {
    const raw = await this.complete({
      system: buildSystemPrompt(this._vocabJson),
      user: buildUserPrompt(intent, repair),
      temperature: repair ? 0.0 : 0.2,
      maxTokens: 1024,
    });
    const parsed = parseLLMJson(raw);
    return { package: this._normalize(parsed), raw };
  }

  /** 规整包：补 schemaVersion、确保 materialLayers 数组、layerParams 对象。 */
  _normalize(parsed) {
    const pkg = parsed && typeof parsed === 'object' ? parsed : {};
    return {
      schemaVersion: typeof pkg.schemaVersion === 'string' ? pkg.schemaVersion : '1.0',
      materialLayers: Array.isArray(pkg.materialLayers) ? pkg.materialLayers : [],
      layerParams: pkg.layerParams && typeof pkg.layerParams === 'object' && !Array.isArray(pkg.layerParams)
        ? pkg.layerParams : {},
      ...(Array.isArray(pkg.stateBindings) ? { stateBindings: pkg.stateBindings } : {}),
    };
  }
}
