/**
 * FlameLayer.js — 真实 Effect Layer：风格化火焰染色 + 流动发光（任务书 #04）
 *
 * 视觉（第一版）：基于世界坐标 + uTime 的流动 mask → 对最终颜色做火焰主题染色 + 自发光。
 *   不做体积火焰 / 透明 / 粒子 / 屏幕空间扭曲 / fbm / raymarch（第一版原则：稳定 > 可调 > 明显 > 好看 > 复杂）。
 * stage = 'color'（最先拼接，先染色，emissive/stylization 再在其上叠加发光）。
 *
 * 硬约束：本文件**不 import three**（继承协议层 EffectLayer，可脱离浏览器 node 自测）。
 *
 * 注入点：variant body 注入到 `#include <tonemapping_fragment>` 之前（光照后、tonemapping 前）。
 *   此处 diffuseColor / totalEmissiveRadiance 已消费，故染色作用于 `gl_FragColor.rgb`：
 *     - 染色：gl_FragColor.rgb = mix(gl_FragColor.rgb, uFlameColor, clamp(flameMask*uFlameTintStrength, 0.0, 1.0))
 *     - 发光：gl_FragColor.rgb += uFlameColor * flameMask * uFlameGlowStrength
 *   这是对 brief §6.4 中 diffuseColor/totalEmissiveRadiance 写法的必要调整（见 recon §3.2）。
 *
 * 坐标来源：使用 injector 统一提供的 vEffLayerWorldPos（世界坐标，恒可用），
 *   而非 vUv（MeshStandardMaterial 仅在有贴图时才有 vUv，不可靠）。保证不崩、不依赖贴图。
 */

import { EffectLayer } from '../EffectLayer.js';
import { Flame as FLAME_MANIFEST } from '../coreLayers.manifest.js';

// manifest param 名 → GLSL uniform 名映射（前缀防撞名）
const UNIFORM_NAMES = {
  color: 'uFlameColor',
  intensity: 'uFlameIntensity',
  speed: 'uFlameSpeed',
  tintStrength: 'uFlameTintStrength',
  glowStrength: 'uFlameGlowStrength',
  scale: 'uFlameScale',
  threshold: 'uFlameThreshold',
};

export class FlameLayer extends EffectLayer {
  constructor(manifest = FLAME_MANIFEST) {
    super(manifest);
  }

  /** GLSL uniform 声明（uTime 为系统 uniform，多 layer 共享时由 builder 去重）。 */
  getUniformDeclarations() {
    return [
      'uniform vec3 uFlameColor;',
      'uniform float uFlameIntensity;',
      'uniform float uFlameSpeed;',
      'uniform float uFlameTintStrength;',
      'uniform float uFlameGlowStrength;',
      'uniform float uFlameScale;',
      'uniform float uFlameThreshold;',
      'uniform vec3 uEffLayerBoundsMin;',
      'uniform vec3 uEffLayerBoundsSize;',
      'uniform float uEffLayerObjectPhase;',
      'uniform float uTime;',
      'float effFlameHash21(vec2 p) {',
      '  p = fract(p * vec2(123.34, 456.21));',
      '  p += dot(p, p + 45.32);',
      '  return fract(p.x * p.y);',
      '}',
      'float effFlameNoise2D(vec2 p) {',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(effFlameHash21(i), effFlameHash21(i + vec2(1.0, 0.0)), u.x),',
      '             mix(effFlameHash21(i + vec2(0.0, 1.0)), effFlameHash21(i + 1.0), u.x), u.y);',
      '}',
      'float effFlameFbm(vec2 p) {',
      '  float value = effFlameNoise2D(p) * 0.58;',
      '  value += effFlameNoise2D(p * 2.03 + 17.7) * 0.29;',
      '  value += effFlameNoise2D(p * 4.01 + 41.3) * 0.13;',
      '  return value;',
      '}',
    ].join('\n');
  }

  /** 世界空间 varying 由 injector 统一提供，本层 vertex 无需求。 */
  getVertexBody() {
    return '';
  }

  /**
   * 片元 body：世界坐标 + uTime 驱动的流动 mask → 染色 + 发光，全部作用于 gl_FragColor.rgb。
   * 不 discard、不改 alpha、不依赖 texture。
   */
  getFragmentBody() {
    return [
      '// Stylized surface fire normalized to the target bounds so scale stays consistent across props.',
      'vec3 flame01 = clamp((vEffLayerLocalPos - uEffLayerBoundsMin) / max(uEffLayerBoundsSize, vec3(0.0001)), 0.0, 1.0);',
      'vec3 flamePos = vec3((flame01.x - 0.5) * 2.0, flame01.y, (flame01.z - 0.5) * 2.0) * uFlameScale;',
      'float flameTime = uTime * uFlameSpeed + uEffLayerObjectPhase * 0.37;',
      'float flameWarp = effFlameNoise2D(vec2(flamePos.x + flamePos.z, flamePos.y * 0.72 - flameTime * 0.45));',
      'float flameSway = (flameWarp - 0.5) * 0.85;',
      'float flameColumnWarp = (effFlameNoise2D(vec2(flamePos.x * 1.35 + flamePos.z * 0.65, flameTime * 0.18 + flamePos.z)) - 0.5) * 0.9;',
      'vec2 flameUvXY = vec2(flamePos.x + flameSway, flamePos.y - flameTime + flameColumnWarp);',
      'vec2 flameUvZY = vec2(flamePos.z - flameSway * 0.73 + 13.7, flamePos.y - flameTime * 1.08 - flameColumnWarp * 0.72);',
      'float flameNoiseXY = effFlameFbm(flameUvXY);',
      'float flameNoiseZY = effFlameFbm(flameUvZY);',
      'float flameBreakup = effFlameNoise2D(vec2((flamePos.x - flamePos.z) * 1.7, flamePos.y * 2.2 - flameTime * 1.55));',
      'float flameHeightEnergy = mix(1.08, 0.76, flame01.y);',
      'float flameSignal = (max(flameNoiseXY, flameNoiseZY) * 0.76 + flameBreakup * 0.24) * flameHeightEnergy;',
      'float flameOuter = smoothstep(uFlameThreshold - 0.12, uFlameThreshold + 0.08, flameSignal) * uFlameIntensity;',
      'float flameBody = smoothstep(uFlameThreshold + 0.01, uFlameThreshold + 0.17, flameSignal);',
      'float flameCore = smoothstep(uFlameThreshold + 0.14, uFlameThreshold + 0.30, flameSignal);',
      'vec3 flameOuterColor = uFlameColor * 0.46;',
      'vec3 flameCoreColor = mix(uFlameColor, vec3(0.88, 0.96, 1.0), 0.58);',
      'vec3 flameSurfaceColor = mix(flameOuterColor, uFlameColor, flameBody);',
      'flameSurfaceColor = mix(flameSurfaceColor, flameCoreColor, flameCore);',
      'float flameGlow = min((flameOuter * 0.55 + flameBody * 0.24 + flameCore * 0.16) * uFlameGlowStrength, 0.68);',
      'gl_FragColor.rgb = mix(gl_FragColor.rgb, flameSurfaceColor, clamp(flameOuter * uFlameTintStrength, 0.0, 1.0));',
      'gl_FragColor.rgb += flameSurfaceColor * flameGlow;',
    ].join('\n');
  }

  /**
   * Runtime helper：默认值 → three uniform 对象（供单层路径 / 复用）。
   * @param {object} THREE
   * @param {object} [overrides] - { color:[r,g,b], intensity, speed, tintStrength, glowStrength, scale, threshold }
   */
  getThreeUniforms(THREE, overrides = {}) {
    const defaults = this.getDefaultUniforms();
    const color = overrides.color ?? defaults.color;
    const intensity = overrides.intensity ?? defaults.intensity;
    const speed = overrides.speed ?? defaults.speed;
    const tintStrength = overrides.tintStrength ?? defaults.tintStrength;
    const glowStrength = overrides.glowStrength ?? defaults.glowStrength;
    const scale = overrides.scale ?? defaults.scale;
    const threshold = overrides.threshold ?? defaults.threshold;
    return {
      [UNIFORM_NAMES.color]: { value: new THREE.Color(color[0], color[1], color[2]) },
      [UNIFORM_NAMES.intensity]: { value: intensity },
      [UNIFORM_NAMES.speed]: { value: speed },
      [UNIFORM_NAMES.tintStrength]: { value: tintStrength },
      [UNIFORM_NAMES.glowStrength]: { value: glowStrength },
      [UNIFORM_NAMES.scale]: { value: scale },
      [UNIFORM_NAMES.threshold]: { value: threshold },
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
