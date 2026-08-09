/**
 * IntentParser.js — ① 自然语言 → 结构化视觉意图（Phase 2B §5.2①）
 *
 * 把"给这把刀加蓝色火焰、要传说品质"解析成 {attribute, hue, rarity, mood, keywords[]}。
 * 受约束输出（低温 + JSON 模式 + 封闭枚举词表），prompt 给全量 layer 词表做"封闭词汇"，
 * 比自由文本更可靠（对标 ShadAR 的 prompt 工程约束）。
 *
 * AI 职责边界：只产意图 JSON，不写 GLSL、不直接选 GLSL 片段。
 *
 * 硬约束：纯逻辑，禁止 import three。LLM 经注入的 complete() 调用，可用 fake 自测。
 */

import { buildPlannerVocabulary } from './manifestSummary.js';
import { parseLLMJson } from './llmClient.js';

const RARITY_ENUM = ['common', 'rare', 'epic', 'legendary'];

function buildSystemPrompt(vocab) {
  const ids = vocab.layers.map(l => l.id);
  return [
    'You parse a player\'s natural-language weapon-enchant request into a STRUCTURED INTENT as strict JSON.',
    'Return ONLY a JSON object, no prose. Schema:',
    '{',
    '  "attribute": string,        // dominant visual theme, e.g. "flame", "frost", "lightning", "holy"',
    '  "hue": string|null,         // color word if stated: blue/red/green/purple/gold/white/orange, else null',
    `  "rarity": one of ${JSON.stringify(RARITY_ENUM)} (default "common" if unstated),`,
    '  "mood": string|null,        // e.g. "aggressive", "mystical", "calm", else null',
    '  "keywords": string[]        // salient words from the request (for nearest-neighbor fallback)',
    '}',
    'Use ONLY information present in the request. Do not invent shader names.',
    `For reference, available effect-layer ids are: ${JSON.stringify(ids)} (do NOT output these here; that is the planner\'s job).`,
  ].join('\n');
}

export class IntentParser {
  /**
   * @param {object} deps
   * @param {(req:object)=>Promise<string>} deps.complete - LLM 补全
   * @param {object} deps.registry - LayerRegistry（用于封闭词表）
   */
  constructor({ complete, registry }) {
    if (typeof complete !== 'function') throw new Error('IntentParser requires complete()');
    if (!registry) throw new Error('IntentParser requires registry');
    this.complete = complete;
    this.registry = registry;
  }

  /**
   * @param {string} text - 用户自然语言
   * @returns {Promise<{intent:object, raw:string}>}
   */
  async parse(text) {
    const vocab = buildPlannerVocabulary(this.registry);
    const raw = await this.complete({
      system: buildSystemPrompt(vocab),
      user: String(text ?? ''),
      temperature: 0.1,
      maxTokens: 512,
    });
    const parsed = parseLLMJson(raw);
    return { intent: this._normalize(parsed, text), raw };
  }

  /** 规整意图：补默认、收口枚举（鲁棒：LLM 漏字段也不崩）。 */
  _normalize(parsed, originalText) {
    const intent = parsed && typeof parsed === 'object' ? parsed : {};
    return {
      attribute: typeof intent.attribute === 'string' ? intent.attribute : '',
      hue: typeof intent.hue === 'string' ? intent.hue : null,
      rarity: RARITY_ENUM.includes(intent.rarity) ? intent.rarity : 'common',
      mood: typeof intent.mood === 'string' ? intent.mood : null,
      keywords: Array.isArray(intent.keywords) ? intent.keywords.filter(k => typeof k === 'string')
        : (typeof originalText === 'string' ? [originalText] : []),
    };
  }
}
