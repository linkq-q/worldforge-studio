/**
 * MatcapBaseLayer.js — 真实 Effect Layer：程序化 Matcap 球形光泽 base 层（Phase 2A）
 *
 * 视觉：以**视线空间法线**驱动一个程序化的球面着色——
 *   - 渐变：沿光方向从 colorLo（背光）到 colorHi（朝光），塑造体块感
 *   - 高光：fake specular（pow(N·L, shininess)），给金属/陶瓷般的球形光泽
 *   - 边缘光：rim（基于 viewNormal.z），勾勒轮廓
 *   以 uMatcapStrength 与原着色混合（1=完全替换标准 PBR/Cartoon 着色）。
 *   v1 纯程序化（无 matcap 纹理）：稳定 > 可调 > 明显 > 好看 > 复杂。
 *
 * stage = 'base'（最先拼接），与 CartoonBase 互斥（同为 base 层）。
 *
 * 硬约束：本文件**不 import three**（继承协议层 EffectLayer，可脱离浏览器 node 自测）。
 *
 * 注入点：variant body 注入到 `#include <tonemapping_fragment>` 之前（光照后、tonemapping 前）。
 *   此处标准光照已写入 gl_FragColor，故 matcap 以 mix() 覆写 gl_FragColor.rgb 实现"替换 base 着色"。
 *
 * 视线空间法线：injector 提供世界法线 vEffLayerWorldNormal；本层用 three 内置 viewMatrix 转视线空间：
 *   viewNormal = normalize((viewMatrix * vec4(worldNormal, 0.0)).xyz)。
 *   相机看向 -Z，故正对相机的面 viewNormal.z≈+1，掠射面 ≈0（边缘光据此）。
 */

import { EffectLayer } from '../EffectLayer.js';
import { MatcapBase as MATCAP_BASE_MANIFEST } from '../coreLayers.manifest.js';

// manifest param 名 → GLSL uniform 名映射（前缀防撞名）
const UNIFORM_NAMES = {
  colorHi: 'uMatcapColorHi',
  colorLo: 'uMatcapColorLo',
  specColor: 'uMatcapSpecColor',
  specStrength: 'uMatcapSpecStrength',
  shininess: 'uMatcapShininess',
  rimColor: 'uMatcapRimColor',
  rimStrength: 'uMatcapRimStrength',
  rimPower: 'uMatcapRimPower',
  strength: 'uMatcapStrength',
};

export class MatcapBaseLayer extends EffectLayer {
  constructor(manifest = MATCAP_BASE_MANIFEST) {
    super(manifest);
  }

  /** GLSL uniform 声明（注入到 fragment shader 顶部）。无 uTime（静态着色）。 */
  getUniformDeclarations() {
    return [
      'uniform vec3 uMatcapColorHi;',
      'uniform vec3 uMatcapColorLo;',
      'uniform vec3 uMatcapSpecColor;',
      'uniform float uMatcapSpecStrength;',
      'uniform float uMatcapShininess;',
      'uniform vec3 uMatcapRimColor;',
      'uniform float uMatcapRimStrength;',
      'uniform float uMatcapRimPower;',
      'uniform float uMatcapStrength;',
    ].join('\n');
  }

  /** 世界空间 varying 由 injector 统一提供，本层 vertex 无需求。 */
  getVertexBody() {
    return '';
  }

  /**
   * 片元 body：世界法线 → 视线空间 → 程序化 matcap（渐变 + 高光 + 边缘光），mix 进 gl_FragColor.rgb。
   * 不 discard、不改 alpha、不依赖 texture。固定视线空间光方向（左上前），保证朝向稳定。
   */
  getFragmentBody() {
    return [
      'vec3 matcapWorldN = normalize(vEffLayerWorldNormal);',
      'vec3 matcapViewN = normalize((viewMatrix * vec4(matcapWorldN, 0.0)).xyz);',
      '// 固定视线空间光方向（左上偏前），matcap 朝向不随相机旋转而漂移',
      'vec3 matcapLightDir = normalize(vec3(-0.35, 0.55, 0.75));',
      'float matcapNdotL = dot(matcapViewN, matcapLightDir);',
      '// 渐变底色：背光→朝光',
      'float matcapGrad = clamp(matcapNdotL * 0.5 + 0.5, 0.0, 1.0);',
      'vec3 matcapColor = mix(uMatcapColorLo, uMatcapColorHi, matcapGrad);',
      '// fake specular 高光',
      'float matcapSpec = pow(clamp(matcapNdotL, 0.0, 1.0), uMatcapShininess);',
      'matcapColor += uMatcapSpecColor * matcapSpec * uMatcapSpecStrength;',
      '// 边缘光：掠射面（viewNormal.z 趋 0）',
      'float matcapRim = pow(1.0 - clamp(matcapViewN.z, 0.0, 1.0), uMatcapRimPower);',
      'matcapColor += uMatcapRimColor * matcapRim * uMatcapRimStrength;',
      '// 以 strength 替换/混合标准着色',
      'gl_FragColor.rgb = mix(gl_FragColor.rgb, matcapColor, clamp(uMatcapStrength, 0.0, 1.0));',
    ].join('\n');
  }

  /**
   * Runtime helper：用注入的 THREE 把 manifest 默认值转成 three uniform 对象。
   * @param {object} THREE - three 命名空间
   * @param {object} [overrides] - 可选覆盖（param 名同 manifest）
   * @returns {Object<string,{value:*}>}
   */
  getThreeUniforms(THREE, overrides = {}) {
    const d = this.getDefaultUniforms();
    const colorHi = overrides.colorHi ?? d.colorHi;
    const colorLo = overrides.colorLo ?? d.colorLo;
    const specColor = overrides.specColor ?? d.specColor;
    const rimColor = overrides.rimColor ?? d.rimColor;
    return {
      [UNIFORM_NAMES.colorHi]: { value: new THREE.Color(colorHi[0], colorHi[1], colorHi[2]) },
      [UNIFORM_NAMES.colorLo]: { value: new THREE.Color(colorLo[0], colorLo[1], colorLo[2]) },
      [UNIFORM_NAMES.specColor]: { value: new THREE.Color(specColor[0], specColor[1], specColor[2]) },
      [UNIFORM_NAMES.specStrength]: { value: overrides.specStrength ?? d.specStrength },
      [UNIFORM_NAMES.shininess]: { value: overrides.shininess ?? d.shininess },
      [UNIFORM_NAMES.rimColor]: { value: new THREE.Color(rimColor[0], rimColor[1], rimColor[2]) },
      [UNIFORM_NAMES.rimStrength]: { value: overrides.rimStrength ?? d.rimStrength },
      [UNIFORM_NAMES.rimPower]: { value: overrides.rimPower ?? d.rimPower },
      [UNIFORM_NAMES.strength]: { value: overrides.strength ?? d.strength },
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
