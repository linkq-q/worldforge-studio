/**
 * coreLayers.manifest.js — 5 个核心层的 provisional manifest（任务书 #01）
 *
 * 仅数据，无 GLSL。params 为初版（后续实现 brief 可微调）；
 * 结构字段（id/stage/tier/channels/compat/cost/stateBindings）是契约，改动需理由。
 * 注：stage 即执行顺序大类，曾名 category，见 EffectLayer.js 术语提醒。
 *
 * 硬约束：纯数据，禁止 import three / 任何 CartoonShader 文件。
 * 这里的 `CartoonBase` 只是数据 manifest，与现有 CartoonShader GLSL **不接线**。
 */

import { OVERRIDE_LAYER_MANIFESTS } from './overrideLayers.manifest.js';

// 5 个核心层（CartoonBase 除外）共享的 base 兼容声明
const BASE_COMPATIBLE = ['CartoonBase', 'PBRBase'];

export const CartoonBase = {
  id: 'CartoonBase',
  displayName: 'Cartoon Base',
  tier: 'base',
  stage: 'base',
  channels: ['baseColor'],
  requires: { uniforms: [], varyings: [], textures: [] },
  params: {},
  cost: { instructions: 'low', textureReads: 0, drawCalls: 0 },
  compatibleWith: [], // base 层自身不声明 compatibleWith
  incompatibleWith: ['MatcapBase'], // 同为 base 层，二选一
  stateBindings: [],
};

// MatcapBase（Phase 2A）：程序化球形光泽 base 层。
//   视线空间法线 → 球面 UV → 渐变 + 高光 + 边缘光，替换标准着色，为武器/装备塑造球形光泽与体块感。
//   v1 纯程序化（无 matcap 纹理）→ requires.textures / cost.textureReads = 0。与 CartoonBase 互斥（同 base 层）。
export const MatcapBase = {
  id: 'MatcapBase',
  displayName: 'Matcap Base',
  tier: 'standard',
  stage: 'base',
  channels: ['baseColor'],
  requires: { uniforms: [], varyings: [], textures: [] },
  params: {
    // 渐变两端：高光端（朝光）/ 阴影端（背光）
    colorHi: { type: 'color', default: [0.92, 0.95, 1.0] },
    colorLo: { type: 'color', default: [0.08, 0.10, 0.18] },
    // 程序化高光（fake specular）
    specColor: { type: 'color', default: [1.0, 1.0, 1.0] },
    specStrength: { type: 'float', default: 0.7, min: 0, max: 3 },
    shininess: { type: 'float', default: 24, min: 1, max: 128 },
    // 边缘光（rim）
    rimColor: { type: 'color', default: [0.5, 0.7, 1.0] },
    rimStrength: { type: 'float', default: 0.3, min: 0, max: 3 },
    rimPower: { type: 'float', default: 3.0, min: 0.5, max: 8 },
    // 整体替换强度：1=完全替换标准着色，<1=与原着色混合
    strength: { type: 'float', default: 1.0, min: 0, max: 1 },
  },
  cost: { instructions: 'med', textureReads: 0, drawCalls: 0 },
  compatibleWith: [], // base 层自身不声明 compatibleWith
  incompatibleWith: ['CartoonBase'],
  crossSlotIncompatible: ['CartoonBase', 'Glass'],
  stateBindings: [],
};

export const Flame = {
  id: 'Flame',
  displayName: 'Flame',
  tier: 'standard',
  stage: 'color',
  channels: ['baseColor', 'emissive'],
  // v1 为纯程序化火焰（无噪声贴图）→ requires.textures/cost.textureReads 同步为 0（见 #04 FlameLayer 实现）
  requires: { uniforms: ['uTime'], varyings: [], textures: [] },
  params: {
    color: { type: 'color', default: [0.1, 0.4, 1.0], freeLocked: true },
    intensity: { type: 'float', default: 0.9, min: 0, max: 2, freeLocked: true },
    speed: { type: 'float', default: 1.2, min: 0, max: 5 },
    tintStrength: { type: 'float', default: 0.18, min: 0, max: 1 },
    glowStrength: { type: 'float', default: 0.8, min: 0, max: 3 },
    scale: { type: 'float', default: 2.0, min: 0.2, max: 8 },
    threshold: { type: 'float', default: 0.55, min: 0, max: 1 },
  },
  cost: { instructions: 'med', textureReads: 0, drawCalls: 0 },
  compatibleWith: BASE_COMPATIBLE,
  incompatibleWith: ['DissolveLayer'],
  stateBindings: [],
};

export const EmissivePulse = {
  id: 'EmissivePulse',
  displayName: 'Emissive Pulse',
  tier: 'standard',
  stage: 'emissive',
  channels: ['emissive'],
  requires: { uniforms: ['uTime'], varyings: [], textures: [] },
  params: {
    color: { type: 'color', default: [1, 0.8, 0.2] },
    speed: { type: 'float', default: 1.0, min: 0, max: 5 },
    intensity: { type: 'float', default: 0.8, min: 0, max: 2 },
  },
  cost: { instructions: 'low', textureReads: 0, drawCalls: 0 },
  compatibleWith: BASE_COMPATIBLE,
  incompatibleWith: [],
  stateBindings: [],
};

export const HitFlash = {
  id: 'HitFlash',
  displayName: 'Hit Flash',
  tier: 'standard',
  stage: 'feedback',
  channels: ['baseColor', 'emissive'],
  requires: { uniforms: ['uHitFlash'], varyings: [], textures: [] },
  params: {
    flashColor: { type: 'color', default: [1, 1, 1] },
    falloff: { type: 'float', default: 3.0, min: 0.1, max: 10 },
    intensity: { type: 'float', default: 1, min: 0, max: 3 },
  },
  cost: { instructions: 'low', textureReads: 0, drawCalls: 0 },
  compatibleWith: BASE_COMPATIBLE,
  incompatibleWith: [],
  stateBindings: ['uHitFlash'],
};

// ChargeAura（Phase 2A）：蓄力辉光层——绑运行时 uChargeLevel，蓄力越高辉光越强，满蓄闪烁加剧。
//   护城河 1 的可玩化落点（视觉随战斗状态实时响应）。stage='feedback'（与 HitFlash 同大类）。
//   uChargeLevel/uTime 为运行时 uniform（由 GameStateUniformBus / 动画循环 tick），不进 variantKey。
export const ChargeAura = {
  id: 'ChargeAura',
  displayName: 'Charge Aura',
  tier: 'standard',
  stage: 'feedback',
  channels: ['emissive'],
  requires: { uniforms: ['uChargeLevel', 'uTime'], varyings: [], textures: [] },
  params: {
    color: { type: 'color', default: [0.4, 0.7, 1.0] },
    intensity: { type: 'float', default: 1.0, min: 0, max: 3 },
    pulseSpeed: { type: 'float', default: 2.0, min: 0, max: 10 },
    risePower: { type: 'float', default: 1.5, min: 0.2, max: 4 }, // charge→glow gamma
    rimBias: { type: 'float', default: 0.6, min: 0, max: 1 },     // 0=整体辉光 1=仅轮廓蒸腾
  },
  cost: { instructions: 'med', textureReads: 0, drawCalls: 0 },
  compatibleWith: BASE_COMPATIBLE,
  incompatibleWith: [],
  stateBindings: ['uChargeLevel'],
};

// Triplanar（wood/stone base 用）：世界空间三投影程序化材质，无需 UV/贴图。
//   wood/stone 复用同一个 layer，靠 colorLo/colorHi/scale/stretch 区分观感（见 TriplanarLayer.js 头注）。
export const Triplanar = {
  id: 'Triplanar',
  displayName: 'Triplanar Material',
  tier: 'standard',
  stage: 'base',
  channels: ['baseColor', 'alpha'], // alpha：仅 pattern=6(wool) 在 frayAmount>0 时 discard，其余 pattern 不写 alpha
  requires: { uniforms: [], varyings: [], textures: [] },
  // v2 手绘感：pattern 分木/石；结构参数（grain/plank/edge/cell）+ macro/fine。默认档=wood。
  params: {
    colorLo: { type: 'color', default: [0.55, 0.48, 0.40] },
    colorHi: { type: 'color', default: [1.22, 1.00, 0.85] },
    scale: { type: 'float', default: 5.1, min: 0.1, max: 20 },
    stretch: { type: 'float', default: 9.0, min: 1, max: 12 },
    strength: { type: 'float', default: 0.9, min: 0, max: 1 },
    pattern: { type: 'float', default: 0.0, min: 0, max: 9 },      // 0..6=wood/stone/fur, 7=vertical stripe, 8=horizontal stripe, 9=checker fabric
    grainContrast: { type: 'float', default: 0.22, min: 0, max: 0.6 },
    plankScale: { type: 'float', default: 0.55, min: 0.05, max: 4 },
    edge: { type: 'float', default: 0.32, min: 0.02, max: 0.6 },
    cellVariance: { type: 'float', default: 0.10, min: 0, max: 0.35 },
    macroStrength: { type: 'float', default: 0.14, min: 0, max: 0.5 },
    fineNoise: { type: 'float', default: 0.05, min: 0, max: 0.3 },
    // v2.2 木纹扩种：warpAmount/warpScale 把原本硬编码的 grain warp 振幅/采样频率参数化
    // （default/birch 不覆盖，取此处默认值 = 原硬编码值，观感零变化）；knotStrength 是松木节疤开关。
    warpAmount: { type: 'float', default: 1.8, min: 0, max: 4 },
    warpScale: { type: 'float', default: 0.5, min: 0.05, max: 2 },
    knotStrength: { type: 'float', default: 0.0, min: 0, max: 1 },
    // stone/brick/cobblestone 共用一个强度参数，但各自从结构场生成不同形状的微法线。
    stoneNormalStrength: { type: 'float', default: 0.035, min: 0, max: 0.15 },
    barkNormalStrength: { type: 'float', default: 0.035, min: 0, max: 0.15 },
    // marble-only 微表面：分别控制石纹驱动的粗糙度变化与微法线起伏。
    // 其它 pattern 不读取这两个 uniform，默认值保持 D14 的抛光大理石观感。
    marbleRoughnessVariation: { type: 'float', default: 0.14, min: 0, max: 0.3 },
    marbleNormalStrength: { type: 'float', default: 0.065, min: 0, max: 0.15 },
    // fur/wool 轮廓打碎（D9，2026-07-24）：frayAmount=0=关闭（wood/stone/… 零成本零行为变化），仅
    // pattern=6(wool) 分支读取。frayAmount 是总闸（>0.001 才生效）+ frayDensity 的整体倍率；实际的
    // "打碎多远/多密/壳长多厚"由下面三个独立参数控制（D10 拆分，修复"壳=打碎距离导致外扩的壳永远
    // 处在高丢弃概率区、看起来永远镂空"的 bug——原先两者共用同一个数值，壳的根部还没退到"安全区"
    // 就已经是壳的尽头了。frayReach 必须明显大于 frayShellWidth，壳根部才能落在渐变过半、趋向实心
    // 的区域，而不是从头到尾都在高丢弃区）。
    frayAmount: { type: 'float', default: 0.0, min: 0, max: 1 },
    frayReach: { type: 'float', default: 0.16, min: 0.01, max: 0.5 },       // 世界单位：discard 渐变从边缘算起的可达距离（越大→安全区离边缘越远，壳根部越容易落进去）
    frayShellWidth: { type: 'float', default: 0.05, min: 0, max: 0.3 },    // 世界单位：顶点沿包围盒中心方向外扩的物理距离（壳厚度）
    frayDensity: { type: 'float', default: 0.85, min: 0, max: 1 },         // 贴边处（edgeZone=1）的最大丢弃概率，乘以 frayAmount 做整体倍率
    // D13：撕碎噪声的颗粒大小（原硬编码 16.0 频率系数）。数值越大→每颗碎屑越大越块状，越小→越细碎；
    // 默认 1.0 换算回原硬编码频率（16.0），观感零变化。
    frayGrainSize: { type: 'float', default: 1.0, min: 0.2, max: 5.0 },
  },
  cost: { instructions: 'med', textureReads: 0, drawCalls: 0 },
  compatibleWith: [], // base 层自身不声明 compatibleWith
  incompatibleWith: ['CartoonBase', 'MatcapBase'],
  crossSlotIncompatible: ['CartoonBase', 'MatcapBase', 'Glass'],
  stateBindings: [],
};

export const FresnelRim = {
  id: 'FresnelRim',
  displayName: 'Fresnel Rim',
  tier: 'standard',
  stage: 'stylization',
  channels: ['emissive'],
  requires: { uniforms: [], varyings: [], textures: [] },
  params: {
    color: { type: 'color', default: [0.6, 0.8, 1.0], designerRange: { h: [180, 280], s: [0.2, 1], v: [0.4, 1] }, aiRange: { h: [190, 250], s: [0.3, 0.9], v: [0.5, 1] } },
    power: { type: 'float', default: 3.0, min: 0.5, max: 8, hardRange: [0.5, 10], designerRange: [0.8, 8], aiRange: [1.2, 4] },
    intensity: { type: 'float', default: 1.0, min: 0, max: 3, hardRange: [0, 5], designerRange: [0, 3], aiRange: [0.5, 2.5] },
  },
  cost: { instructions: 'low', textureReads: 0, drawCalls: 0 },
  compatibleWith: BASE_COMPATIBLE,
  incompatibleWith: [],
  stateBindings: [],
  forbidden: ['intensity > 4', 'power < 0.8'],
  notes: [
    'Fresnel rim should highlight edges without overpowering the base material.',
    'Do not generate parameters outside the allowed ranges.',
  ],
};

// 通用植物摆动：纯顶点位移，不改颜色、裁切、法线或透光；供所有已建出轮廓的植物复用。
export const VegetationSway = {
  id: 'VegetationSway',
  displayName: 'Vegetation Sway',
  tier: 'standard',
  stage: 'base',
  // `stage` keeps its vertex code before later material work.  The slot is deliberately
  // surfaceDetail rather than baseShading: a block canopy composes Foliage + this layer,
  // while baseShading is an exclusive material-selection slot in MaterialLayerResolver.
  slot: 'surfaceDetail',
  channels: ['position'],
  requires: { uniforms: ['uTime'], varyings: [], textures: [] },
  params: {
    amplitude: { type: 'float', default: 0.1, min: 0, max: 0.3 },
    frequency: { type: 'float', default: 0.7, min: 0.1, max: 5 },
    phaseScale: { type: 'float', default: 1.2, min: 0, max: 5 },
  },
  cost: { instructions: 'low', textureReads: 0, drawCalls: 0 },
  compatibleWith: [],
  incompatibleWith: [],
  stateBindings: [],
};

// 块状冠层材质：结构化叶片印章 + 蓬松法线 + 风格化逆光透叶。
// `foliage:leaf` 在词表层与 VegetationSway 组合；本层不再拥有风摆参数。
export const Foliage = {
  id: 'Foliage',
  displayName: 'Foliage (Leaf Clusters + Puff Lighting)',
  tier: 'standard',
  stage: 'base',
  channels: ['alpha', 'baseColor', 'normal'],
  requires: { uniforms: [], varyings: [], textures: [] },
  params: {
    cutoutScale: { type: 'float', default: 3.0, min: 1, max: 30 },       // 每个 bbox 面上的叶片密度，越大叶片越多越小
    cutoutThreshold: { type: 'float', default: 0, min: 0, max: 1 },      // 叶形覆盖阈值，越大边缘负空间越多
    clusterScale: { type: 'float', default: 0.5, min: 0.5, max: 12 },    // 兼容旧名：叶片细长程度，越大越细长
    clusterVariance: { type: 'float', default: 0.16, min: 0, max: 0.6 }, // 逐叶明度/冷暖抖动幅度
    aoStrength: { type: 'float', default: 0.17, min: 0, max: 0.8 },      // 冠层伪 AO 梯度强度
    rimStrength: { type: 'float', default: 0.24, min: 0, max: 1 },       // 兼容旧参数名：叶面高光强度
    rimWidth: { type: 'float', default: 0.13, min: 0.01, max: 0.3 },     // 兼容旧参数名：叶面高光柔度
    quantSteps: { type: 'float', default: 4.0, min: 0, max: 8 },         // 色阶数：0=平滑，≥1=硬色带(卡通)
    puffiness: { type: 'float', default: 0.8, min: 0, max: 1 },          // 侧面法线向冠层顶部弯曲，弱化方块感
    transmission: { type: 'float', default: 0.45, min: 0, max: 1 },      // 主方向光下的背光与掠射透叶强度
  },
  cost: { instructions: 'med', textureReads: 0, drawCalls: 0 },
  compatibleWith: [],
  incompatibleWith: [],
  stateBindings: [],
};

export const CORE_LAYER_MANIFESTS = [
  CartoonBase,
  MatcapBase,
  Triplanar,
  Flame,
  EmissivePulse,
  HitFlash,
  ChargeAura,
  FresnelRim,
  VegetationSway,
  Foliage,
  ...OVERRIDE_LAYER_MANIFESTS,
];

/**
 * 把 5 个核心层注册进给定 registry。
 * @param {{register: (manifest:object)=>any}} registry
 * @returns {string[]} 已注册的 id 列表
 */
export function registerCoreLayers(registry) {
  for (const manifest of CORE_LAYER_MANIFESTS) {
    registry.register(manifest);
  }
  return CORE_LAYER_MANIFESTS.map(m => m.id);
}
