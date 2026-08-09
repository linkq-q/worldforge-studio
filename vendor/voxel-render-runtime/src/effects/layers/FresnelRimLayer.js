/**
 * FresnelRimLayer.js — 第一个真实 Effect Layer（任务书 #02）
 *
 * 把 FresnelRim 从"纯 manifest 协议数据"升级为能发射真实 GLSL 的 Layer。
 * 视觉：基于视角的边缘光（fresnel rim），正对相机处 ≈0（不泛白），掠射处最亮。
 *
 * 硬约束：本文件**不 import three**。
 *   - 它继承 EffectLayer（协议层），仍可脱离浏览器用 node 自测（见 tests/fresnelRimLayer.test.mjs）。
 *   - GLSL 是纯字符串；唯一需要 three 的「把 color 数组转成 THREE.Color」由 getThreeUniforms(THREE) 接收注入的 THREE，
 *     不直接 import，遵守 brief §5.2「协议层不 import three / 转 THREE.Color 发生在 injector 或 runtime helper」。
 *
 * GLSL 命名约定：所有 uniform 加 `uFresnelRim` 前缀，避免与现有 shader（ShaderLibrary 的 uColor 等）撞名。
 */

import { EffectLayer } from '../EffectLayer.js';
import { FresnelRim as FRESNEL_RIM_MANIFEST } from '../coreLayers.manifest.js';

// manifest param 名 → GLSL uniform 名映射（前缀防撞名）
const UNIFORM_NAMES = {
  color: 'uFresnelRimColor',
  power: 'uFresnelRimPower',
  intensity: 'uFresnelRimIntensity',
};

export class FresnelRimLayer extends EffectLayer {
  constructor(manifest = FRESNEL_RIM_MANIFEST) {
    super(manifest);
  }

  /** GLSL uniform 声明（注入到 fragment shader 顶部）。 */
  getUniformDeclarations() {
    return [
      'uniform vec3 uFresnelRimColor;',
      'uniform float uFresnelRimPower;',
      'uniform float uFresnelRimIntensity;',
    ].join('\n');
  }

  /**
   * 顶点着色器 body。
   * 第一版为空：世界坐标/法线 varying 由 EffectLayerInjector 作为通用「世界空间服务」统一注入并计算，
   * FresnelRim 只在 fragment 消费它们（解耦 Layer 与 varying 命名）。
   */
  getVertexBody() {
    return '';
  }

  /**
   * 片元着色器 body（注入到 `#include <tonemapping_fragment>` 之前，即光照后、tonemapping 前）。
   *
   * 消费 injector 提供的世界空间 varying（vEffLayerWorldPos / vEffLayerWorldNormal）+ three 内置 cameraPosition。
   * fresnel = pow(1 - dot(N, V), power)；正对相机 dot≈1 → fresnel≈0 → 正面不泛白。
   * 以 `gl_FragColor.rgb +=` 叠加，保证在 cartoon overlay 覆写 gl_FragColor 之后仍可见（injector 用 order 200）。
   *
   * 注：局部变量 vWorldNormal / 表达式 cameraPosition / pow / uFresnelRimPower / uFresnelRimIntensity
   *     为 brief node 测试断言的关键 token。
   */
  getFragmentBody() {
    return [
      'vec3 vWorldNormal = normalize(vEffLayerWorldNormal);',
      'vec3 effRimViewDir = normalize(cameraPosition - vEffLayerWorldPos);',
      'float fresnelRim = pow(1.0 - max(dot(vWorldNormal, effRimViewDir), 0.0), uFresnelRimPower);',
      'vec3 fresnelRimColor = uFresnelRimColor * fresnelRim * uFresnelRimIntensity;',
      'gl_FragColor.rgb += fresnelRimColor;',
    ].join('\n');
  }

  /**
   * Runtime helper：用注入的 THREE 把 manifest 默认值（color 数组 / float）转成 three uniform 对象。
   * 不 import three —— THREE 由调用方（injector）传入，保持本文件可 node 自测。
   *
   * @param {object} THREE - three 命名空间
   * @param {object} [overrides] - 可选覆盖 { color:[r,g,b], power, intensity }
   * @returns {Object<string, {value:*}>} 形如 { uFresnelRimColor:{value:THREE.Color}, ... }
   */
  getThreeUniforms(THREE, overrides = {}) {
    const defaults = this.getDefaultUniforms(); // { color:[r,g,b], power, intensity }
    const color = overrides.color ?? defaults.color;
    const power = overrides.power ?? defaults.power;
    const intensity = overrides.intensity ?? defaults.intensity;
    return {
      [UNIFORM_NAMES.color]: { value: new THREE.Color(color[0], color[1], color[2]) },
      [UNIFORM_NAMES.power]: { value: power },
      [UNIFORM_NAMES.intensity]: { value: intensity },
    };
  }

  /** 暴露 param→uniform 名映射，供 injector / 调参路径复用。 */
  static get UNIFORM_NAMES() {
    return { ...UNIFORM_NAMES };
  }

  /**
   * 实例级 param→GLSL uniform 名映射，供 EffectVariantBuilder 生成 uniformDefaults
   * 及 runtime 调参（param 名 → uniform 名）复用。
   * @returns {Object<string,string>}
   */
  getParamUniformMap() {
    return { ...UNIFORM_NAMES };
  }
}
