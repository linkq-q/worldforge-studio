/**
 * effectFallback.js — 回退策略（Phase 2B §5.2⑩）：永远给得出一个合法、能跑、好看的 Effect Package。
 *
 * 用途：LLM 不可用 / 超时 / 反复校验失败 / 描述听不懂时的兜底——**绝不报错给用户、绝不白屏**
 *   （Demo 现场最怕的事）。用关键词最近邻把意图映射到已注册 layer，再保证产出包通过校验器。
 *
 * 关键词表内置在本模块（curated semantic map）；未来可迁移到 manifest.tags。
 *
 * 硬约束：纯逻辑，禁止 import three。输入是 #01 的 LayerRegistry + #2B 的校验器。
 */

import { validateEffectPackage } from './EffectSchemaValidator.js';

// layer id → 关键词（中英），用于最近邻匹配。只列实际可能注册的核心层。
export const LAYER_KEYWORDS = Object.freeze({
  Flame: ['火', '火焰', '燃', '烧', '炎', '火花', 'flame', 'fire', 'burn', 'burning', 'ember'],
  EmissivePulse: ['发光', '脉冲', '呼吸', '能量', '辉', '荧光', 'glow', 'pulse', 'energy', 'emissive', 'neon'],
  HitFlash: ['命中', '击中', '闪白', '打击', 'hit', 'flash', 'strike', 'impact'],
  ChargeAura: ['蓄力', '充能', '蒸腾', '光环', 'charge', 'charging', 'aura', 'buildup'],
  FresnelRim: ['边缘光', '描边', '轮廓', '边缘', 'rim', 'fresnel', 'edge', 'outline', 'silhouette'],
  Glass: ['玻璃', '透明', '水晶', '晶体', 'glass', 'transparent', 'crystal'],
  InkSurface: ['石化', '石头', '岩石', '石质', 'petrify', 'petrified', 'stone', 'rock'],
  Petrify: ['石化', '变成石头', '石像', 'petrify', 'petrified', 'statue', 'stone'],
  WhiteStroke: ['白描', '白色描边', '墨线', '白色轮廓', 'white stroke', 'white outline', 'ink edge'],
  MatcapBase: ['金属', '光泽', '球面', '反射', '镜面', '铬', '金', 'matcap', 'metal', 'metallic', 'chrome', 'gloss', 'gold', 'shiny'],
  CartoonBase: ['卡通', '平涂', '动画风', 'cartoon', 'toon', 'flat', 'cel'],
});

// hue 关键词 → RGB（给匹配到的颜色类 layer 的 color/默认上色）
const HUE_TO_RGB = Object.freeze({
  blue: [0.2, 0.5, 1.0], '蓝': [0.2, 0.5, 1.0],
  red: [1.0, 0.25, 0.15], '红': [1.0, 0.25, 0.15],
  green: [0.3, 1.0, 0.4], '绿': [0.3, 1.0, 0.4],
  purple: [0.7, 0.3, 1.0], '紫': [0.7, 0.3, 1.0],
  gold: [1.0, 0.82, 0.3], '金': [1.0, 0.82, 0.3], yellow: [1.0, 0.85, 0.25], '黄': [1.0, 0.85, 0.25],
  white: [1.0, 1.0, 1.0], '白': [1.0, 1.0, 1.0],
  orange: [1.0, 0.5, 0.1], '橙': [1.0, 0.5, 0.1],
});

// 关键词→颜色类 layer 的 color param 名（用于把 hue 注入 layerParams）
const COLOR_PARAM = Object.freeze({
  Flame: 'color', EmissivePulse: 'color', FresnelRim: 'color', ChargeAura: 'color', HitFlash: 'flashColor',
  Glass: 'color', InkSurface: 'color', Petrify: 'color', WhiteStroke: 'color',
});

// 什么都没匹配上时的安全默认层（便宜、好看、无需 base、不依赖运行时状态）
const SAFE_DEFAULT_LAYER = 'FresnelRim';
const SAFE_DEFAULT_COLOR = [0.45, 0.8, 1.0];

/** 把 intent（字符串或 {attribute,hue,rarity,mood}）压成可扫描的小写字符串。 */
function intentToText(intent) {
  if (typeof intent === 'string') return intent.toLowerCase();
  if (intent && typeof intent === 'object') {
    return Object.values(intent).filter(v => typeof v === 'string' || typeof v === 'number')
      .join(' ').toLowerCase();
  }
  return '';
}

/** 从 intent 文本里找一个 hue → RGB（找不到返回 null）。 */
export function detectHue(intent) {
  const text = intentToText(intent);
  for (const [word, rgb] of Object.entries(HUE_TO_RGB)) {
    if (text.includes(word.toLowerCase())) return [...rgb];
  }
  return null;
}

/**
 * 关键词最近邻：返回 intent 命中的、且**已注册**的 layer id（按出现的关键词数排序，去重）。
 * @param {string|object} intent
 * @param {object} registry
 * @returns {string[]}
 */
export function nearestLayers(intent, registry) {
  const text = intentToText(intent);
  if (!text) return [];
  const scored = [];
  for (const [id, words] of Object.entries(LAYER_KEYWORDS)) {
    if (!registry.has(id)) continue;
    let hits = 0;
    for (const w of words) if (text.includes(w.toLowerCase())) hits++;
    if (hits > 0) scored.push({ id, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id));
  return scored.map(s => s.id);
}

/**
 * 构建一个**保证合法**的回退 Effect Package。
 * 流程：关键词匹配 → 去重 → 去掉多余 base（只留一个）→ 剔除互斥冲突 → 注入 hue → 校验；
 *   若仍不合法（极端情况）→ 退到单个安全默认层。
 *
 * @param {string|object} intent - 原始描述或解析后的意图
 * @param {object} opts
 * @param {object} opts.registry
 * @param {number} [opts.maxLayers=4] - 回退包最多层数（保守，控成本）
 * @param {number} [opts.maxCostScore=24]
 * @returns {{package:object, matchedLayers:string[], usedDefault:boolean}}
 */
export function buildFallbackPackage(intent, { registry, maxLayers = 4, maxCostScore = 24 } = {}) {
  if (!registry) throw new Error('buildFallbackPackage requires opts.registry');

  let matched = nearestLayers(intent, registry);

  // 只保留一个 base 层（base 互斥）
  let seenBase = false;
  matched = matched.filter(id => {
    if (registry.get(id).manifest.stage === 'base') {
      if (seenBase) return false;
      seenBase = true;
    }
    return true;
  });

  // 贪心剔除互斥冲突：逐个加入，若与已选集合冲突则跳过
  const chosen = [];
  for (const id of matched) {
    const trial = [...chosen, id];
    if (registry.checkCompatibility(trial).ok && estimateUnderBudget(trial, registry, maxCostScore)) {
      chosen.push(id);
    }
    if (chosen.length >= maxLayers) break;
  }

  let usedDefault = false;
  if (chosen.length === 0) {
    usedDefault = true;
    chosen.push(registry.has(SAFE_DEFAULT_LAYER) ? SAFE_DEFAULT_LAYER : registry.list()[0]);
  }

  // 注入 hue 到颜色类层
  const hue = detectHue(intent);
  const layerParams = {};
  if (hue) {
    for (const id of chosen) {
      const param = COLOR_PARAM[id];
      if (param && registry.get(id).manifest.params?.[param]?.type === 'color') {
        layerParams[id] = { [param]: hue };
      }
    }
  } else if (usedDefault && COLOR_PARAM[chosen[0]]) {
    layerParams[chosen[0]] = { [COLOR_PARAM[chosen[0]]]: SAFE_DEFAULT_COLOR };
  }

  const pkg = {
    schemaVersion: '1.0',
    materialLayers: chosen,
    layerParams,
    _fallback: true,
  };

  // 最终保险：若仍不合法，退到单个安全默认层
  const { valid } = validateEffectPackage(pkg, { registry, maxCostScore });
  if (!valid) {
    const safe = registry.has(SAFE_DEFAULT_LAYER) ? SAFE_DEFAULT_LAYER : registry.list()[0];
    return {
      package: { schemaVersion: '1.0', materialLayers: [safe],
        layerParams: COLOR_PARAM[safe] ? { [safe]: { [COLOR_PARAM[safe]]: SAFE_DEFAULT_COLOR } } : {},
        _fallback: true },
      matchedLayers: matched,
      usedDefault: true,
    };
  }

  return { package: pkg, matchedLayers: matched, usedDefault };
}

// 局部预算检查（贪心加层时用），避免 import 循环开销
function estimateUnderBudget(ids, registry, maxCostScore) {
  const INSTR = { low: 1, med: 2, high: 4 };
  let score = 0;
  for (const id of ids) {
    const c = registry.get(id).manifest.cost || {};
    score += (INSTR[c.instructions] || 1) + (c.textureReads || 0) + (c.drawCalls || 0) * 2;
  }
  return score <= maxCostScore;
}
