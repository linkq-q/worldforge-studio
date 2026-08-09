/**
 * KuwaharaPass.js — Kuwahara 绘画感后处理 Pass
 *
 * Kuwahara filter 是一种保留边缘的平滑滤波器，将 3D 场景变成
 * 油画/水彩质感（平面区域被涂抹成色块，边缘保留甚至增强）。
 *
 * 本实现基于 Maxime Heckel "On Crafting Painterly Shaders" 博客：
 *   https://blog.maximeheckel.com/posts/on-crafting-painterly-shaders/
 *
 * 实现方案：
 *   阶段A（已实现）：基础 4-sector Kuwahara
 *     - 每个像素取 4 个象限（sector），计算每个 sector 的均值和方差
 *     - 输出方差最小的 sector 的均值
 *     - 支持 uKernelSize 控制涂抹程度，uStrength 控制与原图混合比例
 *     - 使用多项式权重（而非高斯）以获得更好的边缘保留效果
 *
 *   阶段B（未实现）：各向异性 Kuwahara
 *     - 需要额外的 TensorPass 先计算结构张量
 *     - 需要第二个 pass 进行各向异性采样
 *     - 留接口供将来扩展
 *
 * 性能：
 *   kernel=4: 每像素采样 4×(5²)=100 次，桌面端流畅
 *   kernel=6: 每像素采样 4×(7²)=196 次，中端可接受
 *   kernel=8: 每像素采样 4×(9²)=324 次，仅推荐高端 GPU
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * Kuwahara 着色器 — 基础 4-sector 实现
 *
 * 每个 sector 计算：
 *   1. 加权均值 Σ(color × weight) / Σ(weight)
 *   2. 加权方差 Σ((color-mean)² × weight) / Σ(weight)
 *   3. 方差转换为亮度用于比较
 *
 * 选择方差最小的 sector 输出其均值，保留边缘。
 */
const KuwaharaShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uKernelSize: { value: 4 },
    uStrength: { value: 1.0 },
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
    uniform vec2 uResolution;
    uniform int uKernelSize;
    uniform float uStrength;

    varying vec2 vUv;

    // ============================================================
    // 多项式权重函数（性能优于高斯 exp()）
    // 基于 Kyprianidis et al. "Anisotropic Kuwahara Filtering
    // with Polynomial Weighting Functions"
    //
    // f(x,y) = [(x + ζ) - η·y²]²
    // 其中 η=0.5, ζ=0.1 为经验值
    // ============================================================
    float polynomialWeight(float x, float y) {
      float eta = 0.5;
      float zeta = 0.1;
      float val = (x + zeta) - eta * (y * y);
      return max(0.0, val * val);
    }

    // ============================================================
    // 计算单个 sector 的加权均值和加权方差
    //
    // 参数:
    //   offsetStart — sector 在 kernel 中的起始偏移（像素）
    //   halfKernel  — 核半径的一半
    //   texelSize   — 单个像素的 UV 步长
    //   avgColor    — 输出：该 sector 的加权平均颜色
    //   variance    — 输出：该 sector 的亮度加权方差
    // ============================================================
    void computeSector(
      vec2 offsetStart,
      int halfKernel,
      vec2 texelSize,
      out vec3 avgColor,
      out float variance
    ) {
      vec3 colorSum = vec3(0.0);
      vec3 squaredSum = vec3(0.0);
      float weightSum = 0.0;

      for (int y = 0; y < 12; y++) {
        if (y > halfKernel) break;
        for (int x = 0; x < 12; x++) {
          if (x > halfKernel) break;

          vec2 sampleOffset = offsetStart + vec2(float(x), float(y));
          vec2 sampleUV = vUv + sampleOffset * texelSize;

          // 边界裁剪
          sampleUV = clamp(sampleUV, vec2(0.0), vec2(1.0));

          vec3 color = texture2D(tDiffuse, sampleUV).rgb;

          // 多项式权重（越靠近 sector 中心的像素权重越大）
          float weight = polynomialWeight(
            float(x) / float(halfKernel + 1),
            float(y) / float(halfKernel + 1)
          );

          colorSum += color * weight;
          squaredSum += color * color * weight;
          weightSum += weight;
        }
      }

      // 防止除以零
      if (weightSum < 0.0001) {
        avgColor = texture2D(tDiffuse, vUv).rgb;
        variance = 1.0;
        return;
      }

      avgColor = colorSum / weightSum;
      vec3 varianceVec = (squaredSum / weightSum) - (avgColor * avgColor);

      // 方差转换为亮度（BT.709 感知加权）用于比较
      variance = dot(varianceVec, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
      // 强度为 0 时直接返回原图
      if (uStrength <= 0.0) {
        gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0);
        return;
      }

      vec3 originalColor = texture2D(tDiffuse, vUv).rgb;
      vec2 texelSize = 1.0 / uResolution;

      // kernel 半径限制（防止性能问题）
      int halfKernel = uKernelSize;
      if (halfKernel < 1) halfKernel = 1;
      if (halfKernel > 10) halfKernel = 10;

      // ============================================
      // 4 个 sector 的起始偏移
      // ============================================
      // Sector 0: 左上 (Top-Left)
      // Sector 1: 右上 (Top-Right)
      // Sector 2: 左下 (Bottom-Left)
      // Sector 3: 右下 (Bottom-Right)
      vec2 offsets[4];
      offsets[0] = vec2(float(-halfKernel), float(-halfKernel)); // TL
      offsets[1] = vec2(0.0, float(-halfKernel));                 // TR
      offsets[2] = vec2(float(-halfKernel), 0.0);                 // BL
      offsets[3] = vec2(0.0, 0.0);                                 // BR

      vec3 sectorColors[4];
      float sectorVariances[4];

      for (int i = 0; i < 4; i++) {
        computeSector(offsets[i], halfKernel, texelSize, sectorColors[i], sectorVariances[i]);
      }

      // 选择方差最小的 sector
      float minVariance = sectorVariances[0];
      vec3 finalColor = sectorColors[0];

      if (sectorVariances[1] < minVariance) {
        minVariance = sectorVariances[1];
        finalColor = sectorColors[1];
      }
      if (sectorVariances[2] < minVariance) {
        minVariance = sectorVariances[2];
        finalColor = sectorColors[2];
      }
      if (sectorVariances[3] < minVariance) {
        minVariance = sectorVariances[3];
        finalColor = sectorColors[3];
      }

      // 与原图混合
      vec3 result = mix(originalColor, finalColor, uStrength);

      gl_FragColor = vec4(result, 1.0);
    }
  `,
};

/**
 * 创建 KuwaharaPass 实例
 *
 * @param {THREE.WebGLRenderer} renderer — Three.js 渲染器，用于获取初始分辨率
 * @returns {ShaderPass} 配置好的 ShaderPass 实例
 */
export function createKuwaharaPass(renderer) {
  const pass = new ShaderPass(KuwaharaShader);
  const size = new THREE.Vector2();
  renderer.getSize(size);
  pass.uniforms.uResolution.value.copy(size);

  // 默认关闭
  pass.enabled = false;

  return pass;
}

/**
 * 设置 Kuwahara filter 的 kernel 大小
 *
 * @param {ShaderPass} pass — KuwaharaPass 实例
 * @param {number} size — 核半径（2-10，超出范围会被 clamp）
 */
export function setKuwaharaKernelSize(pass, size) {
  if (!pass?.uniforms?.uKernelSize) return;
  const clamped = Math.max(1, Math.min(10, Math.round(size)));
  pass.uniforms.uKernelSize.value = clamped;
}

/**
 * 设置 Kuwahara filter 的混合强度
 *
 * @param {ShaderPass} pass — KuwaharaPass 实例
 * @param {number} strength — 0=原图，1=全Kuwahara
 */
export function setKuwaharaStrength(pass, strength) {
  if (!pass?.uniforms?.uStrength) return;
  pass.uniforms.uStrength.value = THREE.MathUtils.clamp(strength, 0, 1);
}

export { KuwaharaShader };
