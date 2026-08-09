/**
 * ToneMapPass.js — 色调映射 + AI 色板 LUT 后处理 Pass
 *
 * 合并两个功能在同一个 ShaderPass 中：
 * 1. 手动色调调整：饱和度、对比度、亮度、整体色调偏移
 * 2. AI 色板 LUT 映射：用场景亮度采样 1D LUT 做颜色重映射
 *
 * 处理顺序（经验证的最优顺序）：
 *   对比度/亮度 → 饱和度 → 色调偏移 → LUT 映射
 *   理由是：对比度先拉宽动态范围，再做色彩的饱和度/偏移调整，
 *   最后 LUT 统一映射到目标色域。如果 LUT 在饱和度之前会
 *   被后续的饱和度调整冲淡，效果不可控。
 *
 * LUT 纹理：
 *   - 1D LUT，宽256高1，RGBAFormat + UnsignedByteType
 *   - 用 LinearFilter 获得平滑插值
 *   - ClampToEdgeWrapping 防止边缘溢出
 *   - 选择 256 宽度而非 512：1D LUT 256 级已足够覆盖 8-bit 精度，
 *     同时保持 GPU 纹理内存最小
 *   - 选择 RGBAFormat 而非 RGBFormat：Three.js 0.160 对 RGBFormat
 *     支持不如 RGBA 稳定，且额外 1 字节开销可忽略
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { generateDefaultLUT } from '../AIColorPalette.js';

/**
 * ToneMap 着色器定义
 *
 * uniforms:
 *   tDiffuse     — 上游 Pass 输出
 *   uLUT         — AI 生成的 1D 色板 LUT（256x1 RGBA DataTexture）
 *   uLUTStrength — LUT 映射强度，0=原色，1=全LUT
 *   uSaturation  — 饱和度，1=不变，0=灰度，可>1
 *   uTint        — 整体色调偏移（RGB 乘数）
 *   uContrast    — 对比度，1=不变
 *   uBrightness  — 亮度偏移
 */
const ToneMapShader = {
  uniforms: {
    tDiffuse: { value: null },
    uLUT: { value: generateDefaultLUT() },
    uLUTStrength: { value: 0.8 },
    uSaturation: { value: 0.7 },
    uTint: { value: new THREE.Vector3(1.0, 0.97, 0.92) },
    uContrast: { value: 1.1 },
    uBrightness: { value: 0.0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D uLUT;
    uniform float uLUTStrength;
    uniform float uSaturation;
    uniform vec3 uTint;
    uniform float uContrast;
    uniform float uBrightness;
    varying vec2 vUv;

    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;

      // ============================================
      // 1. 对比度 + 亮度
      //   S-curve: (color - 0.5) * contrast + 0.5
      //   对比度=1 时不变；>1 拉开中间调；<1 压缩
      // ============================================
      color = (color - 0.5) * uContrast + 0.5 + uBrightness;

      // ============================================
      // 2. 饱和度
      //   使用 BT.709 luminance 权重（与 sRGB/HDTV 标准一致）
      //   比 BT.601 (0.299,0.587,0.114) 更准确
      //   mix(gray, color, saturation)：saturation=1 原色，0=灰度
      // ============================================
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(lum), color, uSaturation);

      // ============================================
      // 3. 整体色调偏移（Tint）
      //   直接乘以 uTint 分量，模拟暖色/冷色滤镜
      //   例如 (1.0, 0.97, 0.92) 轻微压制蓝绿通道 → 暖黄
      // ============================================
      color *= uTint;

      // ============================================
      // 4. AI 色板 LUT 映射
      //   - 计算当前像素亮度（感知亮度 BT.709）
      //   - 用亮度在 1D LUT 中采样对应的目标颜色
      //   - mix() 控制 LUT 影响强度
      //   1D LUT 采样：uv.x = luminance（0-1 映射到纹理宽度）
      //   使用 LinearFilter 时自动在邻近 texel 间插值
      // ============================================
      float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
      luminance = clamp(luminance, 0.0, 1.0);
      vec3 lutColor = texture2D(uLUT, vec2(luminance, 0.5)).rgb;
      color = mix(color, lutColor, uLUTStrength);

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * 创建 ToneMapPass 实例
 *
 * @returns {ShaderPass} ShaderPass 实例，已设置默认 LUT 纹理
 */
export function createToneMapPass() {
  const pass = new ShaderPass(ToneMapShader);
  return pass;
}

/**
 * 更新 ToneMapPass 的 LUT 纹理
 * 用于 AI 生成色板后实时替换
 *
 * @param {ShaderPass} pass ToneMapPass 实例
 * @param {THREE.DataTexture|THREE.Texture} texture 新的 LUT 纹理
 */
export function setToneMapLUT(pass, texture) {
  if (!pass || !texture) return;
  // 释放旧纹理
  if (pass.uniforms.uLUT.value) {
    pass.uniforms.uLUT.value.dispose?.();
  }
  pass.uniforms.uLUT.value = texture;
}

export { ToneMapShader };
