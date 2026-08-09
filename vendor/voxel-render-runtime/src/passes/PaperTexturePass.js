/**
 * PaperTexturePass.js — 宣纸纹理后处理 Pass
 *
 * 将程序化生成的宣纸纤维纹理以 Multiply 混合方式叠加到场景上，
 * 模拟古画/水墨画的纸张质感。
 *
 * 纹理方案：程序化 FBM 噪声（方案A）
 *   - 零外部依赖，无需加载图片文件
 *   - 256×256 RGBA DataTexture，生成时可调参数
 *   - FBM（Fractal Brownian Motion）多层叠加模拟宣纸纤维
 *
 * Multiply 混合原理：
 *   result = src × dst，纯白(1,1,1)不影响场景，暗纹压暗场景
 *   加上 uPaperTint 控制纸张底色，mix() 控制叠加强度
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// ─── 程序化宣纸纹理生成 ────────────────────────────────

const PAPER_SIZE = 256;

/**
 * FBM（分形布朗运动）噪声生成
 * 多层 Perlin-like 噪声叠加，模拟宣纸纤维的自然纹理
 *
 * 注意：这里使用简化的值噪声 + 多层叠加，而非完整的 Perlin 噪声。
 * 理由：宣纸纹理不需要精确的 Perlin 渐变特性，值噪声的多层叠加
 * 已足够产生自然的纤维感。无需引入 glsl-noise 等外部库。
 */

/**
 * 生成一张 256×256 的 FBM 噪声纹理
 * 特点：灰度图（每个通道值相同），明暗变化模拟纸张纤维
 *
 * @param {object} [params]
 * @param {number} [params.octaves=4]   叠加层数
 * @param {number} [params.lacunarity=2.5] 频率倍增因子
 * @param {number} [params.gain=0.45]       振幅衰减因子
 * @param {number} [params.baseFreq=4]      基础频率
 * @param {number} [params.seed=42]         随机种子
 * @returns {THREE.DataTexture}
 */
function generatePaperTexture(params = {}) {
  const {
    octaves = 4,
    lacunarity = 2.5,
    gain = 0.45,
    baseFreq = 4,
    seed = 42,
  } = params;

  // 使用种子初始化简单的伪随机状态
  let rng = seed;
  function hash(x, y) {
    let h = (x * 374761393 + y * 668265263 + rng) & 0x7fffffff;
    h = ((h >> 13) ^ h) * 1274126177;
    h = (h >> 16) ^ h;
    return (h & 0x7fffffff) / 0x7fffffff;
  }

  // 随机梯度（用于类 Perlin 噪声）
  function gradient(hash, x, y) {
    const angle = hash * Math.PI * 2;
    return Math.cos(angle) * x + Math.sin(angle) * y;
  }

  // 平滑插值（Hermite）
  function smooth(t) {
    return t * t * (3 - 2 * t);
  }

  // 单层 Perlin-like 噪声
  function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;

    const sx = smooth(xf);
    const sy = smooth(yf);

    const n00 = gradient(hash(xi, yi), xf, yf);
    const n10 = gradient(hash(xi + 1, yi), xf - 1, yf);
    const n01 = gradient(hash(xi, yi + 1), xf, yf - 1);
    const n11 = gradient(hash(xi + 1, yi + 1), xf - 1, yf - 1);

    const nx0 = n00 + sx * (n10 - n00);
    const nx1 = n01 + sx * (n11 - n01);

    return nx0 + sy * (nx1 - nx0);
  }

  // FBM: 多层噪声叠加
  function fbm(x, y) {
    let value = 0;
    let amplitude = 1;
    let frequency = baseFreq;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
      value += amplitude * noise(x * frequency, y * frequency);
      maxValue += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }

    return value / maxValue; // 归一化到 [-1, 1]
  }

  // 生成纹理数据
  const data = new Uint8Array(PAPER_SIZE * PAPER_SIZE * 4);

  for (let y = 0; y < PAPER_SIZE; y++) {
    for (let x = 0; x < PAPER_SIZE; x++) {
      // FBM 值映射到 [0, 1]，宣纸偏亮（白色底色）
      const raw = fbm(x / PAPER_SIZE, y / PAPER_SIZE);

      // 将 [-1, 1] 映射到 [0.7, 1.0]（偏白的纸张，暗纹在 0.7 左右）
      const brightness = 0.85 + raw * 0.15;

      // 添加微弱的暖色调（米黄色纸张底色）
      const r = Math.min(255, Math.round(brightness * 255));
      const g = Math.min(255, Math.round(brightness * 253)); // 极微量偏绿
      const b = Math.min(255, Math.round(brightness * 248)); // 极微量偏黄

      const offset = (y * PAPER_SIZE + x) * 4;
      data[offset]     = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(
    data,
    PAPER_SIZE,
    PAPER_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );

  // 使用重复平铺（RepeatWrapping）以支持 uPaperScale > 1
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  return texture;
}

// ─── 着色器定义 ─────────────────────────────────────────

const PaperTextureShader = {
  uniforms: {
    tDiffuse: { value: null },
    tPaper: { value: generatePaperTexture() },
    uPaperStrength: { value: 0.20 },
    uPaperScale: { value: 2.0 },
    uPaperTint: { value: new THREE.Vector3(0.98, 0.94, 0.86) },
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
    uniform sampler2D tPaper;
    uniform float uPaperStrength;
    uniform float uPaperScale;
    uniform vec3 uPaperTint;
    varying vec2 vUv;

    void main() {
      // 场景颜色
      vec3 scene = texture2D(tDiffuse, vUv).rgb;

      // 纸张纹理采样（支持平铺）
      vec2 paperUV = vUv * uPaperScale;
      vec3 paperRaw = texture2D(tPaper, paperUV).rgb;

      // 纸张颜色：uPaperTint（底色）与纹理纤维混合
      // 纸张越暗（纤维越密），越偏向纸本色
      // 纸张越亮（纤维越疏），越接近纯白（不影响场景）
      vec3 paper = mix(uPaperTint, vec3(1.0), paperRaw);

      // Multiply 叠加：scene × paper
      // paper = (1,1,1) 时不影响场景；paper 偏暗时压暗场景
      vec3 multiplied = scene * paper;

      // 用 uPaperStrength 控制叠加强度
      // strength=0 → 原场景；strength=1 → 完全 Multiply
      vec3 result = mix(scene, multiplied, uPaperStrength);

      gl_FragColor = vec4(result, 1.0);
    }
  `,
};

// ─── 工厂函数 ───────────────────────────────────────────

/**
 * 创建 PaperTexturePass 实例
 *
 * @param {object} [params]
 * @param {number} [params.strength=0.20]  纸张叠加强度 (0–1)
 * @param {number} [params.scale=2.0]       纹理平铺密度
 * @param {THREE.Vector3} [params.tint]     纸张色调 (RGB)
 * @param {THREE.DataTexture} [params.texture] 自定义纸张纹理（可选）
 * @returns {ShaderPass}
 */
export function createPaperTexturePass(params = {}) {
  const {
    strength = 0.20,
    scale = 2.0,
    tint,
    texture,
  } = params;

  // 创建 pass 实例（shader 的 uniforms 已包含默认纹理）
  const pass = new ShaderPass(PaperTextureShader);

  // 设置参数
  pass.uniforms.uPaperStrength.value = strength;
  pass.uniforms.uPaperScale.value = scale;

  if (tint) {
    pass.uniforms.uPaperTint.value.copy(tint);
  }

  if (texture) {
    pass.uniforms.tPaper.value = texture;
  }

  return pass;
}

/**
 * 更新纸张纹理（运行时替换）
 *
 * @param {ShaderPass} pass  PaperTexturePass 实例
 * @param {THREE.DataTexture|THREE.Texture} texture 新纹理
 */
export function setPaperTexture(pass, texture) {
  if (!pass || !texture) return;
  pass.uniforms.tPaper.value = texture;
}

export { generatePaperTexture, PaperTextureShader };
