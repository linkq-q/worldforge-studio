/**
 * TriplanarStylePresets.js — 生成风格 → Triplanar 参数预设（纯数据，无 import）。
 *
 * 契约：模型生成时选的风格（voxel / curve / …，见 js/ai/api.config.js PROVIDERS 的 mode）决定木/石
 * 纹理的结构参数。这里只提供「能力档位」，不认识业务；MaterialTagCompiler 在词表 preset.params 之上
 * merge 本表返回的 override，且必须在 baseRecipe.key（batch key）计算之前 merge，保证不同风格分批。
 *
 * 只覆盖结构参数（pattern/grain/plank/edge/cell/macro/fine + scale/stretch/strength），颜色沿用词表
 * preset（不同建筑各自涂色，风格不该改色相）。未知风格 / 旧模型无 style → 'default'。
 */

// 木/石各自的「默认档」结构参数（颜色不在此，来自词表 preset）。
const WOOD_BASE = {
  pattern: 0, scale: 5.1, stretch: 9.0, strength: 0.9,
  grainContrast: 0.22, plankScale: 0.55, edge: 0.32, cellVariance: 0.10,
  macroStrength: 0.14, fineNoise: 0.05,
};
const STONE_BASE = {
  pattern: 1, scale: 3.5, stretch: 1.0, strength: 0.55,
  grainContrast: 0.0, plankScale: 0.55, edge: 0.10, cellVariance: 0.09,
  macroStrength: 0.16, fineNoise: 0.04,
};

export const TRIPLANAR_STYLE_PRESETS = {
  // 默认档（standard/lite/wire/未知风格）。
  default: { wood: { ...WOOD_BASE }, stone: { ...STONE_BASE } },

  // 体块（voxel/voxel-pro）：面轴对齐、木板更宽贴合体素栅格、平坦区更大、缝更利落；石块更大更方。
  voxel: {
    wood: { ...WOOD_BASE, stretch: 6.0, plankScale: 0.85, grainContrast: 0.18, edge: 0.22, fineNoise: 0.04 },
    stone: { ...STONE_BASE, scale: 2.4, edge: 0.12, cellVariance: 0.11, macroStrength: 0.18 },
  },

  // 曲面（curve）：木纹沿 stretch 方向流动、过渡更柔、板缝弱化；石纹裂缝更软。
  curve: {
    wood: { ...WOOD_BASE, stretch: 11.0, plankScale: 0.5, grainContrast: 0.16, edge: 0.42, macroStrength: 0.16 },
    stone: { ...STONE_BASE, scale: 4.2, edge: 0.15, cellVariance: 0.08 },
  },
};

/** 生成 mode → 风格档位。voxel/voxel-pro→voxel；curve→curve；其余→default。 */
export function normalizeTriplanarStyle(rawStyle) {
  const s = typeof rawStyle === 'string' ? rawStyle.toLowerCase() : '';
  if (s === 'voxel' || s === 'voxel-pro') return 'voxel';
  if (s === 'curve') return 'curve';
  return 'default';
}

/**
 * @param {string} baseValue - 'wood' | 'stone'
 * @param {string} rawStyle - 模型 style 字段（生成 mode），可空
 * @returns {object} 该风格该材质的结构参数 override（可直接 merge 到词表 preset.params 之上）
 */
export function triplanarStyleParams(baseValue, rawStyle) {
  const style = normalizeTriplanarStyle(rawStyle);
  const bucket = TRIPLANAR_STYLE_PRESETS[style] || TRIPLANAR_STYLE_PRESETS.default;
  const params = bucket[baseValue];
  return params ? { ...params } : {};
}

export default triplanarStyleParams;
