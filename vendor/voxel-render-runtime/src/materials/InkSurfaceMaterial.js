/**
 * InkSurfaceMaterial.js — 全局水墨表面材质
 *
 * 将场景普通 Mesh 替换为统一非写实水墨 ShaderMaterial。
 * 固定方向光 + NdotL 明暗 + 噪声扰动 + 笔触纹理 + 原材质 albedo 参与。
 *
 * 使用方式：
 *   import { createInkSurfaceMaterial } from './materials/InkSurfaceMaterial.js';
 *   const mat = createInkSurfaceMaterial({ ... });
 */

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    // 世界空间法线（仅旋转，不含平移缩放失真）
    vNormalW = normalize(mat3(modelMatrix) * normal);

    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uPaperColor;
  uniform vec3 uInkColor;
  uniform vec3 uLightDir;

  uniform float uToneContrast;
  uniform float uToneLow;
  uniform float uToneHigh;

  uniform sampler2D uNoiseTex;
  uniform bool uHasNoiseTex;
  uniform float uNoiseScale;
  uniform float uNoiseStrength;

  uniform sampler2D uBrushTex;
  uniform bool uHasBrushTex;
  uniform float uBrushScale;
  uniform float uBrushStrength;

  uniform sampler2D uBaseMap;
  uniform bool uHasBaseMap;
  uniform vec3 uBaseColor;
  uniform bool uUseOriginalAlbedo;
  uniform float uAlbedoInfluence;

  uniform bool uUseWorldSpaceNoise;

  // ── Macro Density Field ──
  uniform bool uDensityEnabled;
  uniform vec3 uDensityDir;
  uniform float uDensityScale;
  uniform float uDensityOffset;
  uniform float uDensityContrast;
  uniform float uNoiseScaleSparse;
  uniform float uNoiseScaleDense;
  uniform float uNoiseStrengthLow;
  uniform float uNoiseStrengthHigh;
  uniform float uMacroNoiseScale;
  uniform float uMacroNoiseInfluence;
  uniform bool uDepthDensityEnabled;
  uniform float uDepthNear;
  uniform float uDepthFar;
  uniform float uDepthDensityStrength;
  uniform float uDepthToneStrength;
  uniform float uDensityToneInfluence;

  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorldPos;

  // ── 工具函数 ──

  float luminance(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  float hash(vec2 p) {
    vec2 q = fract(p * vec2(123.34, 456.21));
    q += dot(q, q + 45.32);
    return fract(q.x * q.y);
  }

  // 2D 值噪声（Hermite smoothstep 插值）
  float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // ── Triplanar 采样（世界空间，基于法线自动选择投影面）──

  // 从纹理中取灰度值（感知亮度）
  float sampleTextureGray(sampler2D tex, vec2 uv) {
    vec3 c = texture2D(tex, uv).rgb;
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  // 三向投影采样
  float sampleTriplanar(sampler2D tex, vec3 worldPos, vec3 worldNormal, float scale) {
    vec3 n = abs(normalize(worldNormal));
    n = pow(n, vec3(4.0));
    n /= (n.x + n.y + n.z + 1e-5);

    float xProj = sampleTextureGray(tex, worldPos.zy * scale);
    float yProj = sampleTextureGray(tex, worldPos.xz * scale);
    float zProj = sampleTextureGray(tex, worldPos.xy * scale);

    return xProj * n.x + yProj * n.y + zProj * n.z;
  }

  // ── 宏观密度场（Macro Density Field）──

  // 方向性渐变：沿 uDensityDir 方向线性渐变
  float computeDirectionalDensity(vec3 worldPos) {
    vec3 dir = normalize(uDensityDir);
    float g = dot(worldPos, dir) * uDensityScale + uDensityOffset;
    g = g * 0.5 + 0.5;
    g = clamp(g, 0.0, 1.0);
    g = pow(g, max(uDensityContrast, 0.001));
    return g;
  }

  // 深度因子：近=0，远=1
  float computeDepthFactor(vec3 worldPos) {
    float dist = length(cameraPosition - worldPos);
    return smoothstep(uDepthNear, uDepthFar, dist);
  }

  // 总密度场 = 方向渐变 + 宏观噪声 + 深度调制
  float computeDensityMask(vec3 worldPos, vec3 normalW) {
    float dirGrad = computeDirectionalDensity(worldPos);

    float macroNoise = 0.5;
    if (uHasNoiseTex) {
      macroNoise = sampleTriplanar(uNoiseTex, worldPos, normalW, uMacroNoiseScale);
    } else {
      macroNoise = noise2D(worldPos.xz * uMacroNoiseScale);
    }

    float densityMask = mix(dirGrad, macroNoise, uMacroNoiseInfluence);

    if (uDepthDensityEnabled) {
      float depth01 = computeDepthFactor(worldPos);
      densityMask = clamp(densityMask + depth01 * uDepthDensityStrength, 0.0, 1.0);
    }

    return clamp(densityMask, 0.0, 1.0);
  }

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 L = normalize(uLightDir);
    float ndotl = dot(N, L) * 0.5 + 0.5;
    float tone = ndotl;

    // ── 密度场计算 ──
    float densityMask = 0.0;
    if (uDensityEnabled) {
      densityMask = computeDensityMask(vWorldPos, N);
    }

    // ── 动态 noise scale / strength ──
    float localNoiseScale = uDensityEnabled
      ? mix(uNoiseScaleSparse, uNoiseScaleDense, densityMask)
      : uNoiseScale;
    float localNoiseStrength = uDensityEnabled
      ? mix(uNoiseStrengthLow, uNoiseStrengthHigh, densityMask)
      : uNoiseStrength;

    // ── 噪声采样 ──
    float noiseValue = 0.5;
    if (uHasNoiseTex && uUseWorldSpaceNoise) {
      noiseValue = sampleTriplanar(uNoiseTex, vWorldPos, vNormalW, localNoiseScale);
    } else if (uHasNoiseTex) {
      noiseValue = sampleTextureGray(uNoiseTex, vUv * localNoiseScale);
    } else {
      vec2 texUV = uUseWorldSpaceNoise
        ? vWorldPos.xz * localNoiseScale
        : vUv * localNoiseScale;
      noiseValue = noise2D(texUV);
    }
    tone += (noiseValue - 0.5) * localNoiseStrength;

    // ── 笔触/纸纹（scale + strength 受密度场调制）──
    float localBrushScale = uBrushScale;
    float localBrushStrength = uBrushStrength;
    if (uDensityEnabled) {
      localBrushScale = mix(uBrushScale * 0.6, uBrushScale * 1.8, densityMask);
      localBrushStrength *= mix(0.6, 1.4, densityMask);
    }

    float brushValue = 1.0;
    if (uHasBrushTex && uUseWorldSpaceNoise) {
      brushValue = sampleTriplanar(uBrushTex, vWorldPos, vNormalW, localBrushScale);
    } else if (uHasBrushTex) {
      brushValue = sampleTextureGray(uBrushTex, vUv * localBrushScale);
    }
    tone += (brushValue - 0.5) * localBrushStrength;

    // ── 原材质 albedo 参与 ──
    if (uUseOriginalAlbedo) {
      float baseLum = luminance(uBaseColor);
      if (uHasBaseMap) {
        baseLum = luminance(texture2D(uBaseMap, vUv).rgb);
      }
      tone *= mix(1.0, baseLum, uAlbedoInfluence);
    }

    // ── 宏观墨色偏移 ──
    if (uDensityEnabled) {
      float inkBias = (densityMask - 0.5) * uDensityToneInfluence;
      tone -= inkBias;
    }

    // ── 对比度 + 色阶塑形 ──
    tone = clamp(tone, 0.0, 1.0);
    tone = pow(tone, uToneContrast);
    tone = smoothstep(uToneLow, uToneHigh, tone);

    // ── 深度淡化（远虚近实）──
    if (uDepthDensityEnabled) {
      float depth01 = computeDepthFactor(vWorldPos);
      tone = mix(tone, max(tone, 0.75), depth01 * uDepthToneStrength);
    }

    vec3 finalColor = mix(uInkColor, uPaperColor, tone);
    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

/**
 * 创建 InkSurfaceMaterial 实例
 *
 * @param {object} [options]
 * @param {string} [options.paperColor='#f2ead8']  纸色
 * @param {string} [options.inkColor='#111111']     墨色
 * @param {THREE.Vector3} [options.lightDir]        光照方向
 * @param {number} [options.toneContrast=1.4]       对比度
 * @param {number} [options.toneLow=0.1]            色阶下限
 * @param {number} [options.toneHigh=1.0]           色阶上限
 * @param {THREE.Texture} [options.noiseTex]        噪声贴图
 * @param {number} [options.noiseScale=3.0]         噪声平铺密度
 * @param {number} [options.noiseStrength=0.25]     噪声强度
 * @param {THREE.Texture} [options.brushTex]        笔触/纸纹贴图
 * @param {number} [options.brushScale=2.0]         笔触平铺密度
 * @param {number} [options.brushStrength=0.35]     笔触强度
 * @param {THREE.Texture} [options.baseMap]         原材质贴图
 * @param {THREE.Color} [options.baseColor]         原材质颜色
 * @param {boolean} [options.useOriginalAlbedo=true] 是否保留原材质亮度
 * @param {number} [options.albedoInfluence=0.4]    原材质亮度参与度
 * @param {boolean} [options.useWorldSpaceNoise=true] 是否用世界空间采样
 * @returns {THREE.ShaderMaterial}
 */
export function createInkSurfaceMaterial(options = {}) {
  const uniforms = {
    uPaperColor: { value: new THREE.Color(options.paperColor ?? '#f2ead8') },
    uInkColor: { value: new THREE.Color(options.inkColor ?? '#111111') },
    uLightDir: {
      value: (options.lightDir || new THREE.Vector3(0.4, 0.8, 0.3)).clone().normalize(),
    },
    uToneContrast: { value: options.toneContrast ?? 1.4 },
    uToneLow: { value: options.toneLow ?? 0.1 },
    uToneHigh: { value: options.toneHigh ?? 1.0 },
    uNoiseTex: { value: options.noiseTex ?? null },
    uHasNoiseTex: { value: !!options.noiseTex },
    uNoiseScale: { value: options.noiseScale ?? 3.0 },
    uNoiseStrength: { value: options.noiseStrength ?? 0.25 },
    uBrushTex: { value: options.brushTex ?? null },
    uHasBrushTex: { value: !!options.brushTex },
    uBrushScale: { value: options.brushScale ?? 2.0 },
    uBrushStrength: { value: options.brushStrength ?? 0.35 },
    uBaseMap: { value: options.baseMap ?? null },
    uHasBaseMap: { value: !!options.baseMap },
    uBaseColor: {
      value: options.baseColor
        ? new THREE.Color(options.baseColor)
        : new THREE.Color(1, 1, 1),
    },
    uUseOriginalAlbedo: { value: options.useOriginalAlbedo ?? true },
    uAlbedoInfluence: { value: options.albedoInfluence ?? 0.4 },
    uUseWorldSpaceNoise: { value: options.useWorldSpaceNoise ?? true },

    // ── Macro Density Field ──
    uDensityEnabled: { value: options.densityEnabled ?? true },
    uDensityDir: {
      value: (options.densityDir || new THREE.Vector3(1.0, 0.0, 1.0)).clone().normalize(),
    },
    uDensityScale: { value: options.densityScale ?? 0.035 },
    uDensityOffset: { value: options.densityOffset ?? 0.0 },
    uDensityContrast: { value: options.densityContrast ?? 1.2 },
    uNoiseScaleSparse: { value: options.noiseScaleSparse ?? 1.2 },
    uNoiseScaleDense: { value: options.noiseScaleDense ?? 7.0 },
    uNoiseStrengthLow: { value: options.noiseStrengthLow ?? 0.06 },
    uNoiseStrengthHigh: { value: options.noiseStrengthHigh ?? 0.28 },
    uMacroNoiseScale: { value: options.macroNoiseScale ?? 0.18 },
    uMacroNoiseInfluence: { value: options.macroNoiseInfluence ?? 0.35 },
    uDepthDensityEnabled: { value: options.depthDensityEnabled ?? true },
    uDepthNear: { value: options.depthNear ?? 5.0 },
    uDepthFar: { value: options.depthFar ?? 80.0 },
    uDepthDensityStrength: { value: options.depthDensityStrength ?? 0.25 },
    uDepthToneStrength: { value: options.depthToneStrength ?? 0.18 },
    uDensityToneInfluence: { value: options.densityToneInfluence ?? 0.10 },
  };

  return new THREE.ShaderMaterial({
    name: 'InkSurfaceMaterial',
    uniforms,
    vertexShader,
    fragmentShader,
  });
}

export { vertexShader as inkSurfaceVertexShader, fragmentShader as inkSurfaceFragmentShader };
