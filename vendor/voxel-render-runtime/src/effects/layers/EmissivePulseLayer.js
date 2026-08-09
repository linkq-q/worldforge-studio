/**
 * EmissivePulseLayer.js — 真实 Effect Layer：呼吸发光 / 能量脉冲（任务书 #04）
 *
 * 视觉：随 uTime 正弦呼吸的自发光叠加，强化「稀有度 / 魔法感」。
 * stage = 'emissive'（在 color 之后、stylization 之前拼接）。
 *
 * 硬约束：本文件**不 import three**（继承协议层 EffectLayer，可脱离浏览器 node 自测）。
 *   GLSL 是纯字符串；color 数组 → THREE.Color 由 injector / getThreeUniforms(THREE) 接收注入的 THREE。
 *
 * 注入点：与 FresnelRim 一致 —— variant body 注入到 `#include <tonemapping_fragment>` 之前
 *   （光照后、tonemapping 前），故只能叠加到 `gl_FragColor.rgb`（此处 totalEmissiveRadiance 已消费）。
 *
 * uTime：作为 manifest.requires.uniforms 的系统 uniform，由 runtime 统一 tick（见 EffectPackageRuntime.updateRuntimeUniforms）。
 *   它**不进** getParamUniformMap（非参数），故不影响 variantKey、调参不动它。
 */

import { EffectLayer } from '../EffectLayer.js';
import { EmissivePulse as EMISSIVE_PULSE_MANIFEST } from '../coreLayers.manifest.js';

// manifest param 名 → GLSL uniform 名映射（前缀防撞名）
const UNIFORM_NAMES = {
  color: 'uEmissivePulseColor',
  speed: 'uEmissivePulseSpeed',
  intensity: 'uEmissivePulseIntensity',
};

export class EmissivePulseLayer extends EffectLayer {
  constructor(manifest = EMISSIVE_PULSE_MANIFEST) {
    super(manifest);
  }

  /** GLSL uniform 声明（uTime 为系统 uniform，多 layer 共享时由 builder 去重）。 */
  getUniformDeclarations() {
    return [
      'uniform vec3 uEmissivePulseColor;',
      'uniform float uEmissivePulseSpeed;',
      'uniform float uEmissivePulseIntensity;',
      'uniform vec3 uEffLayerBoundsMin;',
      'uniform vec3 uEffLayerBoundsSize;',
      'uniform float uEffLayerObjectPhase;',
      'uniform float uTime;',
      'float effEmissiveHash21(vec2 p) {',
      '  p = fract(p * vec2(234.34, 435.21));',
      '  p += dot(p, p + 34.23);',
      '  return fract(p.x * p.y);',
      '}',
      'float effEmissiveNoise2D(vec2 p) {',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(effEmissiveHash21(i), effEmissiveHash21(i + vec2(1.0, 0.0)), u.x),',
      '             mix(effEmissiveHash21(i + vec2(0.0, 1.0)), effEmissiveHash21(i + 1.0), u.x), u.y);',
      '}',
    ].join('\n');
  }

  /** 世界空间 varying 由 injector 统一提供，本层 vertex 无需求。 */
  getVertexBody() {
    return '';
  }

  /**
   * 片元 body：稳定的呼吸发光，叠加到 gl_FragColor.rgb。
   * 不改 alpha / normal / baseColor，不 discard，不依赖 texture。
   */
  getFragmentBody() {
    return [
      '// Stable glow with a restrained pulse and a small object-local energy drift.',
      'float emissivePulsePhase = uTime * uEmissivePulseSpeed * 6.2831853 + uEffLayerObjectPhase * 6.2831853;',
      'float emissivePulseWave = 0.93 + 0.07 * sin(emissivePulsePhase);',
      'vec3 emissive01 = clamp((vEffLayerLocalPos - uEffLayerBoundsMin) / max(uEffLayerBoundsSize, vec3(0.0001)), 0.0, 1.0);',
      'vec2 emissiveFlowUv = vec2(emissive01.x + emissive01.z, emissive01.y) * 2.8;',
      'emissiveFlowUv += vec2(uTime * 0.07, -uTime * 0.11) * uEmissivePulseSpeed;',
      'float emissiveFlow = effEmissiveNoise2D(emissiveFlowUv);',
      'float emissiveShimmer = mix(0.95, 1.05, smoothstep(0.25, 0.78, emissiveFlow));',
      'vec3 emissivePulseColor = uEmissivePulseColor * emissivePulseWave * emissiveShimmer * uEmissivePulseIntensity;',
      'gl_FragColor.rgb += emissivePulseColor;',
    ].join('\n');
  }

  /**
   * Runtime helper：用注入的 THREE 把默认值转 three uniform 对象（供 #02 风格单层路径 / 复用）。
   * @param {object} THREE
   * @param {object} [overrides] - { color:[r,g,b], speed, intensity }
   */
  getThreeUniforms(THREE, overrides = {}) {
    const defaults = this.getDefaultUniforms();
    const color = overrides.color ?? defaults.color;
    const speed = overrides.speed ?? defaults.speed;
    const intensity = overrides.intensity ?? defaults.intensity;
    return {
      [UNIFORM_NAMES.color]: { value: new THREE.Color(color[0], color[1], color[2]) },
      [UNIFORM_NAMES.speed]: { value: speed },
      [UNIFORM_NAMES.intensity]: { value: intensity },
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
