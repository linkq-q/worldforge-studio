/**
 * ChargeAuraLayer.js — 真实 Effect Layer：蓄力辉光（Phase 2A，护城河 1 可玩化）
 *
 * 视觉：随运行时 uChargeLevel（0→1）增强的辉光蒸腾——
 *   - ramp：pow(chargeLevel, risePower) 把蓄力映射成辉光强度（低蓄力几乎无、满蓄强烈）
 *   - rim 偏置：rimBias 把辉光集中到掠射轮廓（"蒸腾光环"感）或铺满整面
 *   - shimmer：uTime 驱动的轻微闪烁，蓄力时有"能量在涌动"的活感
 *   以 gl_FragColor.rgb += 叠加（纯发光，不染色、不改 alpha）。
 *
 * stage = 'feedback'（与 HitFlash 同大类，在 color/emissive 之后、stylization 之前）。
 *
 * 运行时 uniform：uChargeLevel（战斗状态白名单，stateBindings）+ uTime（系统）。
 *   两者由 GameStateUniformBus / 动画循环每帧 tick，不进 variantKey、不是 param（调参不动它们）。
 *
 * 硬约束：本文件**不 import three**（继承协议层 EffectLayer，可脱离浏览器 node 自测）。
 * 消费 injector 提供的世界空间 varying（vEffLayerWorldPos / vEffLayerWorldNormal）+ three 内置 cameraPosition。
 */

import { EffectLayer } from '../EffectLayer.js';
import { ChargeAura as CHARGE_AURA_MANIFEST } from '../coreLayers.manifest.js';

// manifest param 名 → GLSL uniform 名映射（前缀防撞名）
const UNIFORM_NAMES = {
  color: 'uChargeAuraColor',
  intensity: 'uChargeAuraIntensity',
  pulseSpeed: 'uChargeAuraPulseSpeed',
  risePower: 'uChargeAuraRisePower',
  rimBias: 'uChargeAuraRimBias',
};

export class ChargeAuraLayer extends EffectLayer {
  constructor(manifest = CHARGE_AURA_MANIFEST) {
    super(manifest);
  }

  /** GLSL uniform 声明（uChargeLevel/uTime 为运行时 uniform，多 layer 共享时由 builder 去重）。 */
  getUniformDeclarations() {
    return [
      'uniform vec3 uChargeAuraColor;',
      'uniform float uChargeAuraIntensity;',
      'uniform float uChargeAuraPulseSpeed;',
      'uniform float uChargeAuraRisePower;',
      'uniform float uChargeAuraRimBias;',
      'uniform float uChargeLevel;',
      'uniform float uTime;',
    ].join('\n');
  }

  /** 世界空间 varying 由 injector 统一提供，本层 vertex 无需求。 */
  getVertexBody() {
    return '';
  }

  /**
   * 片元 body：蓄力 ramp × rim 偏置 × shimmer → 叠加辉光。
   * 蓄力为 0 时 chargeRamp=0 → 完全不可见（不蓄力时武器外观不变）。
   */
  getFragmentBody() {
    return [
      'float chargeAuraLevel = clamp(uChargeLevel, 0.0, 1.0);',
      'float chargeAuraRamp = pow(chargeAuraLevel, max(uChargeAuraRisePower, 0.0001));',
      'vec3 chargeAuraN = normalize(vEffLayerWorldNormal);',
      'vec3 chargeAuraV = normalize(cameraPosition - vEffLayerWorldPos);',
      'float chargeAuraRim = pow(1.0 - max(dot(chargeAuraN, chargeAuraV), 0.0), 2.0);',
      '// rimBias: 0=整面辉光，1=只在掠射轮廓蒸腾',
      'float chargeAuraWeight = mix(1.0, chargeAuraRim, clamp(uChargeAuraRimBias, 0.0, 1.0));',
      '// shimmer: 蓄力时能量涌动的轻微闪烁',
      'float chargeAuraShimmer = 0.75 + 0.25 * sin(uTime * uChargeAuraPulseSpeed * 6.2831853);',
      'vec3 chargeAuraGlow = uChargeAuraColor * chargeAuraRamp * chargeAuraWeight * chargeAuraShimmer * uChargeAuraIntensity;',
      'gl_FragColor.rgb += chargeAuraGlow;',
    ].join('\n');
  }

  /**
   * Runtime helper：用注入的 THREE 把默认值转 three uniform 对象。
   * @param {object} THREE
   * @param {object} [overrides] - { color:[r,g,b], intensity, pulseSpeed, risePower, rimBias }
   */
  getThreeUniforms(THREE, overrides = {}) {
    const d = this.getDefaultUniforms();
    const color = overrides.color ?? d.color;
    return {
      [UNIFORM_NAMES.color]: { value: new THREE.Color(color[0], color[1], color[2]) },
      [UNIFORM_NAMES.intensity]: { value: overrides.intensity ?? d.intensity },
      [UNIFORM_NAMES.pulseSpeed]: { value: overrides.pulseSpeed ?? d.pulseSpeed },
      [UNIFORM_NAMES.risePower]: { value: overrides.risePower ?? d.risePower },
      [UNIFORM_NAMES.rimBias]: { value: overrides.rimBias ?? d.rimBias },
    };
  }

  /** param→GLSL uniform 名映射，供 builder 生成 uniformDefaults 及 runtime 调参复用。 */
  getParamUniformMap() {
    return { ...UNIFORM_NAMES };
  }

  static get UNIFORM_NAMES() {
    return { ...UNIFORM_NAMES };
  }
}
