/**
 * EffectGenerationPipeline.js — 自然语言 → 合法 Effect Package IR 的完整管线（Phase 2B）
 *
 * 串起 §5.2 的 ①②④⑤⑩：
 *   ① IntentParser  →  ② LayerPlanner  →  ④ Validate  →  ⑤ Repair Loop（≤N 次）  →  ⑩ Fallback
 *
 * 契约：**永不抛错、永不返回非法包**。任何环节失败（LLM 超时/乱码/反复校验失败）→ 回退到
 *   关键词最近邻的合法包（never white-screen）。这是 demo 现场稳定性的根。
 *
 * 不负责编译/注入（那是 EffectPackageRuntime 的事）；本管线只产出**已校验**的 IR。
 *
 * 硬约束：纯逻辑，禁止 import three。LLM 经注入 complete()，可 fake 自测。
 */

import { validateEffectPackage, formatErrorsForRepair } from './EffectSchemaValidator.js';
import { buildFallbackPackage } from './effectFallback.js';

export class EffectGenerationPipeline {
  /**
   * @param {object} deps
   * @param {object} deps.parser - IntentParser（有 .parse(text)）
   * @param {object} deps.planner - LayerPlanner（有 .plan(intent, repair?)）
   * @param {object} deps.registry - LayerRegistry
   * @param {object} [opts]
   * @param {number} [opts.maxRepairs=2]
   * @param {number} [opts.maxCostScore=24]
   */
  constructor({ parser, planner, registry }, opts = {}) {
    if (!parser || !planner || !registry) throw new Error('EffectGenerationPipeline requires parser, planner, registry');
    this.parser = parser;
    this.planner = planner;
    this.registry = registry;
    this.maxRepairs = opts.maxRepairs ?? 2;
    this.maxCostScore = opts.maxCostScore ?? 24;
  }

  /**
   * @param {string} text - 用户自然语言
   * @returns {Promise<{package:object, source:'planned'|'repaired'|'fallback', attempts:number, intent:object|null, errors:Array, warnings:string[]}>}
   */
  async generate(text) {
    const validateOpts = { registry: this.registry, maxCostScore: this.maxCostScore };
    let intent = null;
    let attempts = 0;

    try {
      // ① 解析意图（失败 → 用原文做 fallback 的意图）
      const parsed = await this.parser.parse(text);
      intent = parsed.intent;

      // ② 初次规划
      let planned = await this.planner.plan(intent);
      attempts = 1;
      let result = validateEffectPackage(planned.package, validateOpts);
      if (result.valid) {
        return { package: planned.package, source: 'planned', attempts, intent, errors: [], warnings: result.warnings };
      }

      // ⑤ 修复回合：把校验错误回灌 planner，最多 maxRepairs 次
      let lastErrors = result.errors;
      let lastPkg = planned.package;
      for (let i = 0; i < this.maxRepairs; i++) {
        attempts++;
        const repair = { previous: lastPkg, errors: formatErrorsForRepair(lastErrors) };
        const repaired = await this.planner.plan(intent, repair);
        const r = validateEffectPackage(repaired.package, validateOpts);
        if (r.valid) {
          return { package: repaired.package, source: 'repaired', attempts, intent, errors: [], warnings: r.warnings };
        }
        lastErrors = r.errors;
        lastPkg = repaired.package;
      }
      // ⑩ 修复仍失败 → 回退
      return this._fallback(intent ?? text, attempts, intent, lastErrors);
    } catch (err) {
      // 任何异常（LLM 超时/乱码/解析失败）→ 回退，用意图或原文做最近邻
      return this._fallback(intent ?? text, attempts, intent, [{ code: 'PIPELINE_ERROR', message: String(err?.message || err) }]);
    }
  }

  /** 产出兜底合法包（一定通过校验）。 */
  _fallback(intentOrText, attempts, intent, errors) {
    const fb = buildFallbackPackage(intentOrText, { registry: this.registry, maxCostScore: this.maxCostScore });
    return {
      package: fb.package,
      source: 'fallback',
      attempts,
      intent,
      errors: errors || [],
      warnings: [],
      fallbackInfo: { matchedLayers: fb.matchedLayers, usedDefault: fb.usedDefault },
    };
  }
}
