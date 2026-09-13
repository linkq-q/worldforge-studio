/**
 * WaterSurface.js — 风格化卡通风水面
 *
 * 基于 Faraz Shaikh stylized water + Aleksandar Gjoreski lake shader，
 * 改编为 Three.js 原生 ShaderMaterial，核心差异：
 * 1. 岸边泡沫使用 step() 硬切而非 smoothstep() 软渐变
 * 2. 泡沫边缘叠加程序化 noise 扰动轮廓，使白边不规则
 * 3. 两层正弦叠加顶点位移，保持湖面平静感
 * 4. 深度纹理读取复用 InkEdgePass 的 linearizeDepth 公式
 *
 * 依赖：Three.js 0.160.0，需要场景深度纹理（来自 PostProcessPanel 的 normalRenderTarget.depthTexture）
 */

import * as THREE from 'three';
import { RENDER_ORDER } from '../../render/RenderOrders.js';
import {
  DEPTH_UTILS_GLSL as WATER_DEPTH_UTILS_GLSL,
  EQUIRECT_UTILS_GLSL as WATER_EQUIRECT_UTILS_GLSL,
  NOISE_UTILS_GLSL as WATER_NOISE_UTILS_GLSL,
  RING_STRIPE_GLSL as WATER_RING_STRIPE_GLSL,
} from './chunks.js';

// ============================================================
// Vertex Shader
// ============================================================
const WATER_VERTEX_SHADER = /* glsl */ `
  ${WATER_NOISE_UTILS_GLSL}

  varying vec3 vWorldPosition;
  varying vec3 vReflectionWorldPosition;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec4 vScreenPos;
  varying vec2 vUv;
  varying float vDisplacement;

  uniform float uTime;
  uniform float uWaveScale;
  uniform float uWaveSpeed;
  uniform float uWaveHeight;
  uniform float uSurfaceLift;
  uniform float uEdgeDampRange;
  uniform float uWaterPlaneSize;
  uniform float uDragMult;
  uniform int uIterationsVertex;
  uniform float uWaveCenter;
  uniform float uWaveAmplitudeBoost;
  uniform bool uUseDirectionalWaves;
  uniform vec2 uPrimaryWaveDirection;
  uniform vec2 uSecondaryWaveDirection;
  uniform float uDirectionalWaveBlend;
  uniform float uDirectionalAnisotropy;
  uniform float uLargeWaveStrength;
  uniform float uLargeWaveScale;
  uniform float uLargeWaveSpeed;
  uniform float uLargeWaveStretch;
  uniform float uSecondaryWaveStrength;
  uniform float uSecondaryWaveScale;
  uniform float uSecondaryWaveSpeed;
  uniform float uMidWaveStrength;
  uniform float uMidWaveScale;
  uniform float uMidWaveSpeed;
  uniform float uDetailWaveStrength;
  uniform float uDetailWaveScale;
  uniform float uDetailWaveSpeed;
  uniform float uWaveRidgeSharpness;
  uniform float uWaveCrestStretch;
  uniform float uWaveCrossDamping;
  uniform float uWaveSpacingVariation;
  uniform float uWaveSpacingScale;
  uniform sampler2D tShoreDistance;
  uniform bool uUseShoreDistance;
  uniform bool uInvertShoreDistance;
  uniform float uShoreDistanceScale;
  uniform bool uShoreWorldSpace;
  uniform vec2 uShoreWorldCenter;
  uniform float uShoreWorldSize;
  uniform bool uShoreWaveEnabled;
  uniform float uShoreWaveRange;
  uniform float uShoreWaveFrequency;
  uniform float uShoreWaveSpeed;
  uniform float uShoreWaveWidth;
  uniform float uShoreWaveNoiseScale;
  uniform float uShoreWaveNoiseStrength;
  uniform float uShoreWaveBreakup;
  uniform float uShoreWaveCrestHeight;
  uniform float uWaterMode;

  vec2 wavedx(vec2 position, vec2 direction, float frequency, float timeshift) {
    float x = dot(direction, position) * frequency + timeshift;
    float wave = exp(sin(x) - 1.0);
    float dx = wave * cos(x);
    return vec2(wave, -dx);
  }

  float getwavesVertex(vec2 position) {
    float wavePhaseShift = length(position) * 0.1;

    float iter = 0.0;
    float frequency = 1.0;
    float timeMultiplier = 2.0;
    float weight = 1.0;
    float sumOfValues = 0.0;
    float sumOfWeights = 0.0;

    for (int i = 0; i < 8; i++) {
      if (i >= uIterationsVertex) break;

      vec2 direction = normalize(vec2(sin(iter), cos(iter)));
      vec2 res = wavedx(
        position,
        direction,
        frequency,
        uTime * uWaveSpeed * timeMultiplier + wavePhaseShift
      );

      position += direction * res.y * weight * uDragMult;
      sumOfValues += res.x * weight;
      sumOfWeights += weight;

      weight = mix(weight, 0.0, 0.2);
      frequency *= 1.18;
      timeMultiplier *= 1.07;
      iter += 1232.399963;
    }

    return sumOfValues / max(sumOfWeights, 0.0001);
  }

  vec2 normalizeDirection(vec2 direction, vec2 fallback) {
    float lenSq = dot(direction, direction);
    return lenSq > 0.000001 ? normalize(direction) : normalize(fallback);
  }

  float directionalWavePhase(
    vec2 position,
    vec2 direction,
    float scale,
    float speed,
    float stretch
  ) {
    vec2 dir = normalizeDirection(direction, vec2(1.0, 0.25));
    vec2 tangent = vec2(-dir.y, dir.x);
    float ridgeStretch = max(stretch * mix(1.0, uWaveCrestStretch, uDirectionalAnisotropy), 0.001);
    float along = dot(position, dir) * scale;
    float across = dot(position, tangent) * scale / ridgeStretch;
    float seed = dot(dir, vec2(19.17, 47.23)) + scale * 7.31;
    float spacingNoise = noise2D(vec2(along, across) * uWaveSpacingScale + vec2(seed, -seed * 0.37));
    float phaseWarp = (spacingNoise - 0.5) * 2.0 * uWaveSpacingVariation;
    return along + phaseWarp
      + sin((across + phaseWarp * 0.25) * 0.65) * 0.25 * (1.0 - uWaveCrossDamping)
      + uTime * speed;
  }

  float directionalWaveLayer(
    vec2 position,
    vec2 direction,
    float scale,
    float speed,
    float stretch,
    float sharpness
  ) {
    float phase = directionalWavePhase(position, direction, scale, speed, stretch);
    float w = exp(sin(phase) - 1.0);
    w = (w - uWaveCenter) * uWaveAmplitudeBoost;
    w = sign(w) * pow(abs(w), max(sharpness, 0.001));
    return w;
  }

  float computeDirectionalDetailHeight(vec2 worldXZ) {
    vec2 detailDir = normalizeDirection(uPrimaryWaveDirection + uSecondaryWaveDirection, vec2(0.6, 1.0));
    return directionalWaveLayer(
      worldXZ,
      detailDir,
      uDetailWaveScale,
      uDetailWaveSpeed,
      max(uLargeWaveStretch * 0.25, 0.25),
      0.8
    );
  }

  float computeDirectionalWaveHeight(vec2 worldXZ) {
    float randomOctave = getwavesVertex(worldXZ * uWaveScale);

    float largeA = directionalWaveLayer(
      worldXZ,
      uPrimaryWaveDirection,
      uLargeWaveScale,
      uLargeWaveSpeed,
      uLargeWaveStretch,
      uWaveRidgeSharpness
    ) * uLargeWaveStrength;

    float largeB = directionalWaveLayer(
      worldXZ,
      uSecondaryWaveDirection,
      uSecondaryWaveScale,
      uSecondaryWaveSpeed,
      uLargeWaveStretch * 0.75,
      max(uWaveRidgeSharpness * 0.85, 0.5)
    ) * uSecondaryWaveStrength;

    float mid = directionalWaveLayer(
      worldXZ,
      normalizeDirection(uPrimaryWaveDirection + uSecondaryWaveDirection * 0.35, vec2(1.0, 0.0)),
      uMidWaveScale,
      uMidWaveSpeed,
      max(uLargeWaveStretch * 0.55, 0.5),
      1.0
    ) * uMidWaveStrength;

    float detail = computeDirectionalDetailHeight(worldXZ) * uDetailWaveStrength;
    float directional = largeA + largeB + mid + detail * 0.2;
    return mix(randomOctave, directional, clamp(uDirectionalWaveBlend, 0.0, 1.0));
  }

  float computeVertexWaveHeight(vec2 localXZ) {
    float h;
    if (uUseDirectionalWaves) {
      h = computeDirectionalWaveHeight(localXZ);
    } else {
      float waveRaw = getwavesVertex(localXZ * uWaveScale);
      h = (waveRaw - uWaveCenter) * uWaveAmplitudeBoost;
    }
    return h * uWaveHeight;
  }

  float sampleShoreDistanceForVertex(vec3 localPosition) {
    if (!uUseShoreDistance) return 1.0;
    vec2 shoreUv;
    float shoreRegionFade = 1.0;
    if (uShoreWorldSpace) {
      vec3 worldBase = (modelMatrix * vec4(localPosition, 1.0)).xyz;
      vec2 rel = (worldBase.xz - uShoreWorldCenter) / max(uShoreWorldSize, 0.0001);
      shoreUv = vec2(rel.x, -rel.y) + 0.5;
      float edge = max(abs(rel.x), abs(rel.y));
      shoreRegionFade = 1.0 - smoothstep(0.46, 0.5, edge);
    } else {
      shoreUv = vec2(
        localPosition.x / max(uWaterPlaneSize, 0.0001),
        -localPosition.z / max(uWaterPlaneSize, 0.0001)
      ) + 0.5;
    }
    float shoreDist = texture2D(tShoreDistance, shoreUv).r;
    if (uInvertShoreDistance) {
      shoreDist = 1.0 - shoreDist;
    }
    shoreDist = mix(1.0, shoreDist, shoreRegionFade);
    return clamp(shoreDist * uShoreDistanceScale, 0.0, 1.0);
  }

  float computeShoreDamp(vec3 localPosition) {
    float shoreDist = sampleShoreDistanceForVertex(localPosition);
    return smoothstep(0.0, max(uEdgeDampRange, 0.0001), shoreDist);
  }

  float computeShoreWaveCrestHeight(vec3 localPosition) {
    if (!uUseShoreDistance || !uShoreWaveEnabled) return 0.0;
    float shoreDist = sampleShoreDistanceForVertex(localPosition);
    float shoreRangeMask = 1.0 - smoothstep(uShoreWaveRange * 0.5, uShoreWaveRange, shoreDist);
    vec3 worldBase = (modelMatrix * vec4(localPosition, 1.0)).xyz;
    float shoreNoise = fbmNoise(worldBase.xz * uShoreWaveNoiseScale, uTime * 0.08);
    float distortedDist = shoreDist + (shoreNoise - 0.5) * uShoreWaveNoiseStrength;
    float stripe = fract(distortedDist * uShoreWaveFrequency - uTime * uShoreWaveSpeed);
    float waveLine = uWaterMode < 0.5
      ? 1.0 - smoothstep(uShoreWaveWidth * 0.85, uShoreWaveWidth, stripe)
      : 1.0 - smoothstep(0.0, uShoreWaveWidth, stripe);
    float breakup = smoothstep(uShoreWaveBreakup - 0.08, uShoreWaveBreakup + 0.08, shoreNoise);
    return waveLine * shoreRangeMask * breakup * uShoreWaveCrestHeight;
  }

  float computeDisplacedWaveHeight(vec2 localXZ, vec3 localPosition) {
    float waveH = computeVertexWaveHeight(localXZ);
    float damp = computeShoreDamp(localPosition);
    return waveH * damp + uSurfaceLift * damp + computeShoreWaveCrestHeight(localPosition);
  }

  void main() {
    float waveH = computeDisplacedWaveHeight(position.xz, position);
    vec3 displaced = position + vec3(0.0, waveH, 0.0);

    // Neighbor sampling keeps the existing displaced vertex normal chain.
    float eps = 0.1;
    float dx = computeDisplacedWaveHeight(vec2(position.x + eps, position.z), vec3(position.x + eps, position.y, position.z));
    float dz = computeDisplacedWaveHeight(vec2(position.x, position.z + eps), vec3(position.x, position.y, position.z + eps));
    vec3 posX = vec3(position.x + eps, dx, position.z);
    vec3 posZ = vec3(position.x, dz, position.z + eps);
    vec3 toX = normalize(posX - displaced);
    vec3 toZ = normalize(posZ - displaced);
    vec3 perturbedNormal = normalize(cross(toZ, toX));

    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vec4 reflectionWorldPos = modelMatrix * vec4(position, 1.0);

    vWorldPosition = worldPos.xyz;
    vReflectionWorldPosition = reflectionWorldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * perturbedNormal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    vScreenPos = projectionMatrix * viewMatrix * worldPos;
    vUv = uv;
    vDisplacement = waveH;

    gl_Position = vScreenPos;
  }
`;

// ============================================================
// Fragment Shader
// ============================================================
// 雨天 / 默认涟漪贴花：同屏最大点数。shader 数组声明与循环上限用 ${MAX_RIPPLE_DECALS} 注入，
// JS 侧 uRippleDecalPoints 初始化、addRippleDecalPoint 环形覆盖、setRippleDecalParams /
// getRippleDecalParams 的 slice / min 同步引用。原 8 槽满了会整体清空（雨天涟漪因此被「截断」），
// 抬到 24 后可同屏更多、单个涟漪能活满 uRippleDecalLifetime 而不被打断。改这里需同步下列引用点。
const MAX_RIPPLE_DECALS = 24;

const WATER_FRAGMENT_SHADER = /* glsl */ `
  ${WATER_DEPTH_UTILS_GLSL}
  ${WATER_NOISE_UTILS_GLSL}
  ${WATER_EQUIRECT_UTILS_GLSL}
  ${WATER_RING_STRIPE_GLSL}

  varying vec3 vWorldPosition;
  varying vec3 vReflectionWorldPosition;
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec4 vScreenPos;
  varying vec2 vUv;
  varying float vDisplacement;

  uniform sampler2D tDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uTime;

  uniform vec3 uWaterColor;
  uniform vec3 uShallowColor;
  uniform vec3 uFoamColor;
  uniform vec3 uDepthColor;

  uniform float uFoamThreshold;
  uniform float uFoamWidth;
  uniform float uFoamNoiseStrength;

  uniform float uFresnelPower;
  uniform float uFresnelStrength;

  uniform float uDepthStrength;
  uniform float uModelWaterDepth;

  uniform float uWaveScale;
  uniform float uWaveSpeed;
  uniform float uWaveHeight;
  uniform float uDragMult;
  uniform int uIterationsNormal;
  uniform float uWaveCenter;
  uniform float uWaveAmplitudeBoost;
  uniform float uWaveNormalDistanceFade;
  uniform float uWaveNormalBlend;
  uniform bool uUseDirectionalWaves;
  uniform vec2 uPrimaryWaveDirection;
  uniform vec2 uSecondaryWaveDirection;
  uniform float uDirectionalWaveBlend;
  uniform float uDirectionalAnisotropy;
  uniform float uLargeWaveStrength;
  uniform float uLargeWaveScale;
  uniform float uLargeWaveSpeed;
  uniform float uLargeWaveStretch;
  uniform float uSecondaryWaveStrength;
  uniform float uSecondaryWaveScale;
  uniform float uSecondaryWaveSpeed;
  uniform float uMidWaveStrength;
  uniform float uMidWaveScale;
  uniform float uMidWaveSpeed;
  uniform float uDetailWaveStrength;
  uniform float uDetailWaveScale;
  uniform float uDetailWaveSpeed;
  uniform float uWaveRidgeSharpness;
  uniform float uWaveCrestStretch;
  uniform float uWaveCrossDamping;
  uniform float uWaveSpacingVariation;
  uniform float uWaveSpacingScale;
  uniform float uFoamStrength;
  uniform float uOpacity;
  // v2 model-water: near-shore transparency so the (now-visible) pool floor shows
  // through the water edge. uShoreTransparency=0 → legacy uniform-opacity behaviour.
  uniform float uShoreTransparency;
  uniform float uShoreEdgeAlpha;
  uniform float uFoamOpacity;
  uniform float uFoamSpeed;
  uniform float uFoamPulse;
  uniform bool uWhitecapEnabled;
  uniform float uWhitecapStrength;
  uniform float uWhitecapThreshold;
  uniform float uWhitecapSoftness;
  uniform float uWhitecapNoiseScale;
  uniform float uWhitecapBreakup;
  uniform vec3 uFoamShadowColor;
  uniform float uFoamShadowStrength;
  uniform float uFoamShadowWidth;

  uniform sampler2D tFoamNoise;
  uniform bool uUseFoamNoise;
  uniform bool uFlowEnabled;
  uniform vec2 uFlowDirection;
  uniform float uFlowSpeed;

  uniform bool uHasDepthTexture;

  uniform bool uUseCartoonBands;
  uniform float uBandHardness;

  uniform bool uContactFoamEnabled;
  uniform float uContactFoamStrength;
  uniform float uContactFoamStart;
  uniform float uContactFoamEnd;
  uniform float uContactFoamWidth;
  uniform float uContactFoamNoiseScale;
  uniform float uContactFoamBreakup;
  uniform float uContactFoamPulse;

  // v4 Phase 6c: static ripple decal (rain-drop style local rings, up to MAX_RIPPLE_DECALS fixed world points)
  uniform bool uRippleDecalEnabled;
  uniform float uRippleDecalCount;
  uniform vec2 uRippleDecalPoints[${MAX_RIPPLE_DECALS}];
  uniform float uRippleDecalRadius;
  uniform float uRippleDecalFrequency;
  uniform float uRippleDecalSpeed;
  uniform float uRippleDecalWidth;
  uniform float uRippleDecalStrength;
  uniform float uRippleDecalLifetime;       // grow→decay 包络周期（秒）
  uniform float uRippleDecalNormalStrength;  // 法线扰动强度（需按场景标定）
  uniform float uRippleDecalNoiseScale;      // 半径噪声频率（破圆用）
  uniform float uRippleDecalNoiseStrength;   // 半径噪声强度（0=完美圆环）
  uniform float uRippleDecalFrontWidth;      // 波前带宽（半径比例，越大同屏环越多）
  uniform float uRippleDecalAttenuation;     // 振幅距离衰减指数（0=不衰减）
  uniform float uRippleDecalFadeStart;       // 生命周期开始淡出的相位点（越晚涟漪活到越靠外缘）

  uniform float uWaterDebugMode;

  // === v2: ShoreDistance / Local Water Body 稳定岸线 ===
  uniform sampler2D tShoreDistance;
  uniform bool uUseShoreDistance;
  uniform bool uInvertShoreDistance;
  uniform float uShoreDistanceScale;
  uniform float uShoreFoamStrength;
  uniform float uShoreFoamWidth;
  uniform bool uShoreWaveEnabled;
  uniform float uShoreWaveStrength;
  uniform float uShoreWaveRange;
  uniform float uShoreWaveFrequency;
  uniform float uShoreWaveSpeed;
  uniform float uShoreWaveWidth;
  uniform float uShoreWaveNoiseScale;
  uniform float uShoreWaveNoiseStrength;
  uniform float uShoreWaveBreakup;
  uniform float uShoreWaveCrestHeight;
  // v4 Phase 1: clip the square plane's corners to the shoreDistance footprint
  // so a rect plane over an ellipse pool doesn't spill past the rim.
  uniform float uShoreClipThreshold;
  // v4 scene-shore: sample shoreDistance in WORLD XZ over a sub-region instead of vUv.
  // Lets a full-size ocean plane carry a scene-fitted shore field (snapshot of scene silhouette),
  // so shore waves hug objects without shrinking the plane or losing shore-band resolution.
  uniform bool uShoreWorldSpace;
  uniform vec2 uShoreWorldCenter;  // region center in world XZ
  uniform float uShoreWorldSize;   // region side length (world units)

  // === v3: Water Mode (0=cartoon, 1=realistic, 2=hybrid) ===
  uniform float uWaterMode;

  // === v3: Realistic Water params (lightweight placeholder) ===
  uniform float uRealisticRoughness;
  uniform float uRealisticFresnelStrength;
  uniform float uRealisticFresnelPower;
  uniform float uRealisticAbsorptionStrength;
  uniform float uRealisticDepthTintStrength;

  // === v3 Step 6: Absorption / Depth Tint ===
  uniform bool uUseWaterAbsorption;
  uniform float uAbsorptionStrength;
  uniform float uAbsorptionDepthScale;
  uniform float uAbsorptionDistanceScale;
  uniform vec3 uShallowTint;
  uniform vec3 uDeepTint;
  uniform float uAbsorptionTintStrength;
  uniform float uAbsorptionReflectionDamping;
  uniform float uAbsorptionMin;
  uniform float uAbsorptionMax;

  // === v3 Step 7: Artist-friendly Water Highlight ===
  uniform sampler2D tHighlightNoise;
  uniform bool uHighlightEnabled;
  uniform float uHighlightIntensity;
  uniform vec3 uHighlightColor;
  uniform float uHighlightMax;
  uniform float uHighlightThreshold;
  uniform float uHighlightSoftness;
  uniform float uHighlightFocusPower;
  uniform float uHighlightCoverage;
  uniform float uHighlightSpecularInfluence;
  uniform float uHighlightFresnelInfluence;
  uniform float uHighlightViewInfluence;
  uniform float uHighlightSlopeInfluence;
  uniform float uHighlightViewMin;
  uniform float uHighlightViewMax;
  uniform float uHighlightGrazingBoost;
  uniform bool uUseHighlightNoise;
  uniform float uHighlightNoiseScale;
  uniform float uHighlightNoiseSpeed;
  uniform float uHighlightNoiseStrength;
  uniform float uHighlightNoisePower;
  uniform float uHighlightNoiseContrast;
  uniform float uHighlightNoiseOffset;
  uniform float uHighlightDistanceFade;
  uniform float uHighlightFadeStart;
  uniform float uHighlightFadeRange;
  uniform float uHighlightRidgeBias;
  uniform float uHighlightSlopeMask;
  uniform float uHighlightBlobReduction;
  uniform float uHighlightTopDownSoftening;

  // === v4 Phase 2/3: Cartoon (mode 0) toon enhancements ===
  uniform bool uToonSparkleEnabled;        // Wind Waker 式白色流线高光（程序噪声，无纹理依赖）
  uniform float uToonSparkleThreshold;
  uniform float uToonSparkleIntensity;
  uniform vec3 uToonSparkleColor;
  uniform float uToonSparkleScale;         // 世界空间噪声密度
  uniform float uToonSparkleStretch;       // 沿波向拉伸 → 流线/短划感
  uniform bool uToonPatternEnabled;        // 全水面手绘感 foam 等高线（Wind Waker 表面纹样）
  uniform float uToonPatternScale;
  uniform float uToonPatternWidth;         // 等高线带宽（iso-band 半宽）
  uniform float uToonPatternIntensity;
  uniform sampler2D tToonPattern;
  uniform bool uUseToonPatternTexture;
  uniform float uToonPatternTextureScale;
  uniform float uToonPatternTextureSpeed;
  uniform float uToonPatternTextureMix;
  uniform float uToonNormalSteps;          // 0 = 关闭；>0 = 波光法线量化档数
  uniform bool uToonFoamHardCut;           // mode 0 foam 硬切
  uniform float uToonReflectionSteps;      // Phase 3: planar 倒影色阶量化（0 = 关闭）
  uniform float uToonReflectionFresnelStep;// Phase 3: fresnel 硬边阈值

  // === v3 Step 3: Dual Normal Maps（Realistic/Hybrid 表面细节法线）===
  uniform sampler2D tWaterNormalA;
  uniform sampler2D tWaterNormalB;
  uniform bool uUseWaterNormalMaps;
  uniform float uWaterNormalStrength;
  uniform float uWaterNormalScaleA;
  uniform float uWaterNormalScaleB;
  uniform float uWaterNormalSpeedA;
  uniform float uWaterNormalSpeedB;
  uniform vec2 uWaterNormalDirectionA;
  uniform vec2 uWaterNormalDirectionB;
  uniform float uWaterNormalMix;
  uniform bool uNormalMapIsDirectX;

  vec2 normalizeDirection(vec2 direction, vec2 fallback) {
    float lenSq = dot(direction, direction);
    return lenSq > 0.000001 ? normalize(direction) : normalize(fallback);
  }

  vec2 computeWaterFlowOffset() {
    if (!uFlowEnabled) return vec2(0.0);
    vec2 flowDir = normalizeDirection(uFlowDirection, uPrimaryWaveDirection);
    return flowDir * uTime * uFlowSpeed;
  }

  float directionalWavePhase(
    vec2 position,
    vec2 direction,
    float scale,
    float speed,
    float stretch
  ) {
    vec2 dir = normalizeDirection(direction, vec2(1.0, 0.25));
    vec2 tangent = vec2(-dir.y, dir.x);
    float ridgeStretch = max(stretch * mix(1.0, uWaveCrestStretch, uDirectionalAnisotropy), 0.001);
    float along = dot(position, dir) * scale;
    float across = dot(position, tangent) * scale / ridgeStretch;
    float seed = dot(dir, vec2(19.17, 47.23)) + scale * 7.31;
    float spacingNoise = noise2D(vec2(along, across) * uWaveSpacingScale + vec2(seed, -seed * 0.37));
    float phaseWarp = (spacingNoise - 0.5) * 2.0 * uWaveSpacingVariation;
    return along + phaseWarp
      + sin((across + phaseWarp * 0.25) * 0.65) * 0.25 * (1.0 - uWaveCrossDamping)
      + uTime * speed;
  }

  float computePrimaryCrestProfile(vec2 worldXZ, out float phase) {
    phase = directionalWavePhase(
      worldXZ,
      uPrimaryWaveDirection,
      uLargeWaveScale,
      uLargeWaveSpeed,
      uLargeWaveStretch
    );
    return smoothstep(0.45, 0.95, exp(sin(phase) - 1.0));
  }

  float computeWaveRidgeMask(vec3 N, vec2 worldXZ) {
    float slope = clamp(1.0 - N.y, 0.0, 1.0);
    float phase;
    float ridge = computePrimaryCrestProfile(worldXZ, phase);
    return clamp(mix(slope, ridge, uHighlightRidgeBias), 0.0, 1.0);
  }

  vec3 unpackNormalMap(vec3 c) {
    vec3 n = c * 2.0 - 1.0;
    if (uNormalMapIsDirectX) {
      n.g = -n.g;
    }
    return normalize(n);
  }

  // === v3 Step 4: Realistic Fresnel / Specular highlight（无 envMap 骨架）===
  uniform float uRealisticFresnelBias;
  uniform vec3 uRealisticFresnelColor;
  uniform float uRealisticFresnelOpacity;
  uniform float uRealisticSpecularStrength;
  uniform float uRealisticSpecularPower;
  uniform vec3 uRealisticSpecularColor;
  uniform float uRealisticSpecularNormalInfluence;

  // === v3 Step 5: Environment Reflection（Realistic/Hybrid，采样 scene.environment）===
  uniform sampler2D tWaterEnvMap;
  uniform bool uHasWaterEnvMap;
  uniform bool uUseWaterEnvReflection;
  uniform float uWaterReflectionStrength;
  uniform float uWaterReflectionFresnelInfluence;
  uniform vec3 uWaterReflectionTint;
  uniform float uWaterReflectionRoughness;
  uniform float uWaterReflectionNormalInfluence;
  uniform float uWaterReflectionExposure;
  // v2 model-water: 1 = let cartoon mode (uWaterMode 0) also sample env reflection,
  // with posterize + fresnel weighting so it reads stylised, not photoreal.
  uniform float uToonEnvReflection;

  // === v3 Step 8: Planar Reflection（建筑/物体水面倒影）===
  uniform sampler2D tPlanarReflection;
  uniform mat4 uPlanarReflectionMatrix;
  uniform bool uHasPlanarReflection;
  uniform float uPlanarReflectionStrength;
  uniform float uPlanarReflectionDistortion;
  uniform float uPlanarReflectionDistortionScale;
  uniform float uPlanarReflectionFresnelBoost;
  uniform float uPlanarReflectionDebugMode;

  // Fresnel：基于传入法线与 vViewDir（指向摄像机），uRealisticFresnelBias 避免菲涅尔恰好为 0
  float computeWaterFresnel(vec3 normal, vec3 viewDir) {
    float ndotv = clamp(dot(normalize(normal), normalize(viewDir)), 0.0, 1.0);
    float fresnel = uRealisticFresnelBias
      + pow(1.0 - ndotv, uRealisticFresnelPower) * uRealisticFresnelStrength;
    return clamp(fresnel, 0.0, 1.0);
  }

  // Specular：Blinn-Phong 半程向量轻量近似，非完整 PBR 水体 BRDF
  float computeWaterSpecular(vec3 normal, vec3 viewDir, vec3 lightDir) {
    vec3 halfDir = normalize(viewDir + lightDir);
    float spec = pow(max(dot(normalize(normal), halfDir), 0.0), uRealisticSpecularPower);
    return spec * uRealisticSpecularStrength;
  }

  float computeWaterAbsorptionFactor(vec3 worldPos, float viewDistance, float depthDiff, float shoreDist) {
    float factor = 0.0;

    factor += viewDistance * uAbsorptionDistanceScale;
    factor += depthDiff * uAbsorptionDepthScale * (uHasDepthTexture ? 1.0 : 0.0);

    if (uUseShoreDistance) {
      factor += (1.0 - shoreDist) * uAbsorptionDepthScale;
    }

    factor *= uAbsorptionStrength;
    float absorptionMin = min(uAbsorptionMin, uAbsorptionMax);
    float absorptionMax = max(uAbsorptionMin, uAbsorptionMax);
    return clamp(factor, absorptionMin, absorptionMax);
  }

  void main() {
    // ============================================
    // Step 0: 计算屏幕 UV（用于深度纹理采样）
    // ============================================
    vec2 screenUV = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;

    // ============================================
    // 方案B：深度纹理驱动 foam + 颜色渐变
    // ============================================

    // 深度纹理读取
    float depthSample = texture2D(tDepth, screenUV).r;
    float sceneLinearDepth = linearizeDepth(depthSample, uCameraNear, uCameraFar);

    vec4 waterViewPos = viewMatrix * vec4(vWorldPosition, 1.0);
    float waterDepth = abs(waterViewPos.z);
    float depthDiff = max(sceneLinearDepth - waterDepth, 0.0);

    float hasDepth = uHasDepthTexture ? 1.0 : 0.0;

    // === ShoreDistance 采样（v2 局部水域稳定岸线，camera-independent） ===
    float shoreDist = 1.0;
    if (uUseShoreDistance) {
      // 默认按平面 UV 采样（部件水/上传 mask）；scene-shore 模式改为世界 XZ 子区域采样。
      // 世界→UV 映射与 PlaneGeometry(rotateX -90°) 的 vUv 一致：u=+X, v=-Z，故两种模式可无缝互换。
      vec2 shoreUv = vUv;
      float shoreRegionFade = 1.0;
      if (uShoreWorldSpace) {
        vec2 rel = (vWorldPosition.xz - uShoreWorldCenter) / max(uShoreWorldSize, 0.0001);
        shoreUv = vec2(rel.x, -rel.y) + 0.5;
        // 区域外淡出到开阔水面（shoreDist=1）：ClampToEdge 会把边缘 texel 无限延展成
        // 直线条带（水平/垂直交叉 = 十字/直角伪影），出区域必须归 1 而不是采边缘值。
        float edge = max(abs(rel.x), abs(rel.y));
        shoreRegionFade = 1.0 - smoothstep(0.46, 0.5, edge);
      }
      shoreDist = texture2D(tShoreDistance, shoreUv).r;
      if (uInvertShoreDistance) {
        shoreDist = 1.0 - shoreDist;
      }
      shoreDist = mix(1.0, shoreDist, shoreRegionFade);
      shoreDist = clamp(shoreDist * uShoreDistanceScale, 0.0, 1.0);
      // Corner clip: pixels outside the water footprint (shoreDist≈0) are cut.
      // Default 1×1 white placeholder (shoreDist=1) is never affected.
      // scene-shore（世界空间）模式不裁剪——整块海面在区域外仍是开阔水。
      if (!uShoreWorldSpace && shoreDist < uShoreClipThreshold) discard;
    }

    // === 1. foam 噪声扰动（多层叠加，更有机） ===
    float noiseVal;
    if (uUseFoamNoise) {
      vec2 foamUV = vWorldPosition.xz * 0.08 + vec2(uTime * 0.02, -uTime * 0.015) + computeWaterFlowOffset() * 0.08;
      noiseVal = texture2D(tFoamNoise, foamUV).r;
    } else {
      float noise1 = sin(vWorldPosition.x * 3.0 + uTime * 0.5) *
                     cos(vWorldPosition.z * 2.7 + uTime * 0.3);
      float noise2 = sin(vWorldPosition.x * 7.3 - uTime * 0.8) *
                     cos(vWorldPosition.z * 5.1 + uTime * 0.6);
      float noise3 = sin((vWorldPosition.x + vWorldPosition.z) * 4.5 + uTime * 0.4);
      noiseVal = (noise1 * 0.5 + noise2 * 0.3 + noise3 * 0.2) * 0.5 + 0.5;
    }

    float perturbedThreshold = uFoamThreshold * uFoamWidth * (0.6 + noiseVal * 0.8);

    // 拍打：多层不同频率的脉动叠加，模拟层层浪
    float pulse1 = sin(uTime * uFoamSpeed) * 0.5 + 0.5;
    float pulse2 = sin(uTime * uFoamSpeed * 0.6 + 1.5) * 0.5 + 0.5;
    float pulse3 = sin(uTime * uFoamSpeed * 1.4 + 3.0) * 0.5 + 0.5;
    float pulse = pulse1 * 0.5 + pulse2 * 0.3 + pulse3 * 0.2;
    perturbedThreshold *= (1.0 + pulse * uFoamPulse);
    // uFoamNoiseStrength：基于 noiseVal 的额外阈值扰动
    perturbedThreshold *= (1.0 + (noiseVal - 0.5) * uFoamNoiseStrength);

    // 多层 foam，不同阈值形成内外两圈
    float foam1 = smoothstep(perturbedThreshold * 1.05, perturbedThreshold * 0.85, depthDiff);
    float foam2 = smoothstep(perturbedThreshold * 0.6,  perturbedThreshold * 0.4,  depthDiff) * 0.4;

    // === 1b. Contact Foam（接触泡沫：水陆交界处的泡沫带，noise 扰动外缘） ===
    float contactFoam = 0.0;
    if (uContactFoamEnabled) {
      float foamNoise = fbmNoise(vWorldPosition.xz * uContactFoamNoiseScale, uTime * uContactFoamPulse);
      float contactFoamEdge = uContactFoamEnd + foamNoise * uContactFoamWidth;
      float band = smoothstep(contactFoamEdge, uContactFoamStart, depthDiff);
      contactFoam = band * smoothstep(uContactFoamBreakup, 1.0, foamNoise) * uContactFoamStrength;
    }
    contactFoam *= hasDepth;

    // === 1d. Shore Noise（共用于 Shore Foam / Shore Wave 的 breakup 噪声） ===
    float shoreNoise = 0.0;
    if (uUseShoreDistance) {
      shoreNoise = fbmNoise(vWorldPosition.xz * uShoreWaveNoiseScale, uTime * 0.08);
    }

    // === 1e. Shore Foam（基于 shoreDistance 的稳定岸边泡沫，不随相机晃动） ===
    // v4: breakup 从「全程调光器」改为窄带 smoothstep——fbmNoise 均值约 0.44，
    // 旧写法 smoothstep(breakup, 1.0) 把强度压到 ~10% 导致岸浪几乎不可见。
    // 窄带写法：噪声高于阈值的段落完整显示，低于则断开 → 有缺口的浪圈而非整体变暗。
    float shoreBreakup = smoothstep(uShoreWaveBreakup - 0.08, uShoreWaveBreakup + 0.08, shoreNoise);
    // 高频 froth 噪声（世界空间固定尺度 → 池子/海岛泡沫颗粒一致）
    float shoreFroth = 0.0;
    if (uUseShoreDistance) {
      shoreFroth = fbmNoise(vWorldPosition.xz * uShoreWaveNoiseScale * 3.0 + 7.3, uTime * 0.12);
    }
    float shoreFoam = 0.0;
    if (uUseShoreDistance) {
      // domain-warp：用 froth 噪声扰动到岸距离，泡沫边缘起沫破碎，而不是一条干净等值线
      float foamDist = shoreDist + (shoreFroth - 0.5) * uShoreFoamWidth * 1.8;
      float shoreMask = 1.0 - smoothstep(0.0, max(uShoreFoamWidth, 0.0001), foamDist);
      shoreFoam = shoreMask * shoreBreakup * uShoreFoamStrength;
    }

    // === 1f. Shore Wave（沿 shoreDistance 等值线滚动的层叠浪线条纹） ===
    float shoreWaveShadow = 0.0;
    float shoreWave = 0.0;
    if (uUseShoreDistance && uShoreWaveEnabled) {
      float shoreRangeMask = 1.0 - smoothstep(uShoreWaveRange * 0.5, uShoreWaveRange, shoreDist);
      float distortedDist = shoreDist + (shoreNoise - 0.5) * uShoreWaveNoiseStrength;
      float waveCoord = distortedDist * uShoreWaveFrequency - uTime * uShoreWaveSpeed;
      float stripe = fract(waveCoord);
      float waveLine;
      if (uWaterMode < 0.5) {
        // cartoon：硬边浪线（Wind Waker 式白圈），前缘微软化抗锯齿
        waveLine = 1.0 - smoothstep(uShoreWaveWidth * 0.85, uShoreWaveWidth, stripe);
      } else {
        waveLine = 1.0 - smoothstep(0.0, uShoreWaveWidth, stripe);
      }
      shoreWave = waveLine * shoreRangeMask * shoreBreakup * uShoreWaveStrength;
      float shoreShadowStart = uShoreWaveWidth;
      float shoreShadowEnd = min(shoreShadowStart + uFoamShadowWidth, 0.98);
      float shoreShadowBand = smoothstep(shoreShadowStart * 0.85, shoreShadowStart, stripe)
        * (1.0 - smoothstep(shoreShadowStart, max(shoreShadowEnd, shoreShadowStart + 0.0001), stripe));
      shoreWaveShadow = shoreShadowBand * shoreRangeMask * shoreBreakup
        * min(uShoreWaveStrength, 1.0);
    }

    // === 1g. Ripple Decal（v4 Phase 6c：雨滴式静态涟漪，世界空间固定点，最多 8 个） ===
    // 与 shoreWave 同一套 ringStripe() 数学，但圆心是固定世界坐标而非轮廓等值线；
    // 不依赖 depthTexture / shoreDistance，模型水与全局水面都能用。
    float rippleDecal = 0.0;
    vec2 rippleSlope = vec2(0.0);   // 6c+：累加各点的径向斜率 → 下方注入 finalWaterNormal
    if (uRippleDecalEnabled) {
      // 噪声扰动：把 fbm 掺进半径破掉完美圆环（0 强度 = 纯圆）。
      // perf：噪声只依赖世界坐标，与涟漪点无关，提到循环外算一次（原先逐点 8× fbm）。
      float radiusNoise = (fbmNoise(vWorldPosition.xz * uRippleDecalNoiseScale, uTime * 0.15) - 0.5) * uRippleDecalNoiseStrength;
      for (int i = 0; i < ${MAX_RIPPLE_DECALS}; i++) {
        if (float(i) >= uRippleDecalCount) break;
        vec2 center = uRippleDecalPoints[i];
        float dRaw = length(vWorldPosition.xz - center);
        float rangeMask = 1.0 - smoothstep(uRippleDecalRadius * 0.5, uRippleDecalRadius, dRaw);
        float d = dRaw + radiusNoise;
        // item 1：每点独立的 grow→decay 生消包络，相位按位置 hash 错开，避免同步脉动
        float phase = fract(uTime / uRippleDecalLifetime + hash2D(center));
        float env = smoothstep(0.0, 0.15, phase) * (1.0 - smoothstep(uRippleDecalFadeStart, 1.0, phase));
        // 扩散波前：环只存在于向外扩张的前沿带内，波前过去后内部自动平复
        // （Lagarde clamp 思路的连续版；phase 复用生消包络 → lifetime 同时控制扩散速度）
        float frontDist = phase * uRippleDecalRadius;
        float frontMask = 1.0 - smoothstep(0.0, uRippleDecalRadius * uRippleDecalFrontWidth, abs(dRaw - frontDist));
        // 振幅随扩散衰减：能量摊到更大周长，指数越大近圆心越强
        float atten = exp(-uRippleDecalAttenuation * dRaw / max(uRippleDecalRadius, 0.001));
        float ring = ringStripe(d, uRippleDecalFrequency, uRippleDecalSpeed, uRippleDecalWidth, uTime) * rangeMask * env * frontMask;
        // item 3：重叠取最强环而非能量相加，避免糊成一片死平/死白
        rippleDecal = max(rippleDecal, ring);
        // 法线扰动：阻尼正弦波做径向斜率（Lagarde《Water drop 2b》/ 主流雨滴涟漪做法）。
        // 关键：不能对上面的平顶泡沫环 ringStripe 做差分——它内部导数恒为 0，只有一条窄边有梯度，
        // 拉满也几乎看不出凹凸。正弦波处处平滑非零，才有连续起伏的法线。周期与泡沫环对齐（×2π）。
        float wave = sin((d * uRippleDecalFrequency - uTime * uRippleDecalSpeed) * 6.2831853);
        float slopeMag = wave * rangeMask * env * frontMask * atten;
        vec2 radialDir = dRaw > 1e-4 ? (vWorldPosition.xz - center) / dRaw : vec2(0.0);
        rippleSlope += radialDir * slopeMag;
      }
      rippleDecal = clamp(rippleDecal, 0.0, 1.0) * uRippleDecalStrength;
      rippleSlope *= uRippleDecalNormalStrength;
    }

    // The displaced surface normal is already evaluated per vertex above.
    // Re-evaluating the complete wave field three times per fragment made
    // large water bodies fill-rate bound and let two normal paths disagree
    // while the camera moved.
    vec3 waveNormal = normalize(vWorldNormal);
    float waveWhitecap = 0.0;
    float waveWhitecapShadow = 0.0;
    if (uWaterMode < 0.5 && uWhitecapEnabled && uUseDirectionalWaves) {
      float crestPhase;
      float crestProfile = computePrimaryCrestProfile(vWorldPosition.xz, crestPhase);
      float ridgeBand = smoothstep(
        uWhitecapThreshold - max(uWhitecapSoftness, 0.0001),
        uWhitecapThreshold + max(uWhitecapSoftness, 0.0001),
        crestProfile
      );
      vec2 whitecapUv = (vWorldPosition.xz + computeWaterFlowOffset()) * uWhitecapNoiseScale;
      float whitecapNoise = fbmNoise(whitecapUv, uTime * 0.12);
      float whitecapBreakup = smoothstep(uWhitecapBreakup - 0.08, uWhitecapBreakup + 0.08, whitecapNoise);
      waveWhitecap = ridgeBand * whitecapBreakup * uWhitecapStrength;
      float shadowOuter = smoothstep(
        uWhitecapThreshold - max(uWhitecapSoftness, 0.0001) - uFoamShadowWidth,
        uWhitecapThreshold - max(uWhitecapSoftness, 0.0001),
        crestProfile
      );
      float leeSide = 1.0 - smoothstep(-0.15, 0.15, cos(crestPhase));
      waveWhitecapShadow = max(shadowOuter - ridgeBand, 0.0)
        * mix(0.2, 1.0, leeSide) * whitecapBreakup * min(uWhitecapStrength, 1.0);
    }

    // All dynamic foam sources share one coverage field; Toon Pattern remains a separate hand-drawn detail layer.
    float baseFoam = clamp(foam1 + foam2, 0.0, 1.0) * uFoamOpacity * uFoamStrength * hasDepth;
    float foamCoverage = clamp(baseFoam + contactFoam + shoreFoam + shoreWave + rippleDecal + waveWhitecap, 0.0, 1.0);
    float foamShadow = clamp(waveWhitecapShadow + shoreWaveShadow, 0.0, 1.0) * uFoamShadowStrength;
    float foam = foamCoverage;
    // v4 Phase 2.3: cartoon foam 硬切（噪声/岸线已提供不规则轮廓，step 出手绘白边）
    if (uWaterMode < 0.5 && uToonFoamHardCut) {
      foam = smoothstep(0.34, 0.46, foam);
    }

    // === 2. 颜色深度渐变（含卡通色阶 + 深水颜色 + ShoreDistance 驱动） ===
    float depthFactor = clamp(depthDiff * uDepthStrength, 0.0, 1.0);
    float colorFactor = depthFactor;
    if (uUseShoreDistance) {
      colorFactor = shoreDist;
    }
    if (uUseCartoonBands) {
      if (uWaterMode < 0.5) {
        // Cartoon：完整色阶量化
        colorFactor = floor(colorFactor * uBandHardness + 0.5) / uBandHardness;
      } else if (uWaterMode > 1.5) {
        // Hybrid placeholder：保留减弱的色阶，叠加下方 Realistic 吸收/反射
        float hybridHardness = max(uBandHardness * 0.5, 1.0);
        colorFactor = floor(colorFactor * hybridHardness + 0.5) / hybridHardness;
      }
      // Realistic（uWaterMode == 1）：保持连续渐变，不量化
    }
    vec3 shallowMid = mix(uShallowColor, uWaterColor, clamp(colorFactor * 2.0, 0.0, 1.0));
    vec3 waterColor = mix(shallowMid, uDepthColor, clamp(colorFactor * 2.0 - 1.0, 0.0, 1.0));

    // === v3: Realistic/Hybrid — Beer-Lambert 吸收近似，景深越大越偏深水色 ===
    float absorb = 0.0;
    if (uWaterMode > 0.5) {
      absorb = uHasDepthTexture
        ? 1.0 - exp(-depthDiff * uRealisticAbsorptionStrength)
        : (uUseShoreDistance ? shoreDist : 0.0);
      waterColor = mix(waterColor, uDepthColor, absorb * uRealisticDepthTintStrength);
    }

    float viewDistance = length(cameraPosition - vWorldPosition);
    float absorption = 0.0;
    if (uWaterMode > 0.5 && uUseWaterAbsorption) {
      absorption = computeWaterAbsorptionFactor(vWorldPosition, viewDistance, depthDiff, shoreDist);
      vec3 absorptionTint = mix(uShallowTint, uDeepTint, absorption);
      waterColor = mix(waterColor, absorptionTint, absorption * uAbsorptionTintStrength);
    }

    // === v3 Step 3: Dual Normal Maps（Realistic/Hybrid 表面细节扰动法线）===
    vec3 baseNormal = normalize(vWorldNormal);
    // v4 Phase 2.2: cartoon 波光法线量化 → 波面片化（仅 mode 0，喂给 sparkle + planar 扰动）
    if (uWaterMode < 0.5 && uToonNormalSteps > 0.5) {
      waveNormal = normalize(floor(waveNormal * uToonNormalSteps + 0.5) / uToonNormalSteps);
    }
    vec3 finalWaterNormal = waveNormal;
    if (uUseWaterNormalMaps) {
      vec2 waterUv = vWorldPosition.xz;
      vec2 flowOffset = computeWaterFlowOffset();
      vec2 dirA = length(uWaterNormalDirectionA) > 0.0001 ? normalize(uWaterNormalDirectionA) : vec2(1.0, 0.0);
      vec2 dirB = length(uWaterNormalDirectionB) > 0.0001 ? normalize(uWaterNormalDirectionB) : vec2(1.0, 0.0);

      vec2 uvA = (waterUv + flowOffset) * uWaterNormalScaleA + dirA * uTime * uWaterNormalSpeedA;
      vec2 uvB = (waterUv + flowOffset) * uWaterNormalScaleB + dirB * uTime * uWaterNormalSpeedB;

      vec3 nA = unpackNormalMap(texture2D(tWaterNormalA, uvA).rgb);
      vec3 nB = unpackNormalMap(texture2D(tWaterNormalB, uvB).rgb);
      vec3 detailNormal = normalize(mix(nA, nB, uWaterNormalMix));

      // Y-up water plane: normal-map XY contributes detail slope on world XZ.
      vec3 detailNormalWorld = normalize(baseNormal + vec3(detailNormal.x, 0.0, detailNormal.y) * uWaveNormalBlend);
      finalWaterNormal = normalize(mix(baseNormal, detailNormalWorld, uWaterNormalStrength));
    }
    vec3 normalForHighlight = (uWaterMode > 0.5 && uUseWaterNormalMaps) ? finalWaterNormal : baseNormal;
    // 6c+：ripple decal 法线扰动，同时喂给主法线与高光法线——卡通/写实两种模式都要反光
    // （rippleSlope 已在上方 foam 段算好；未启用时为 0，法线不变）
    if (uRippleDecalEnabled) {
      vec3 rippleN = vec3(rippleSlope.x, 0.0, rippleSlope.y);
      finalWaterNormal = normalize(finalWaterNormal + rippleN);
      normalForHighlight = normalize(normalForHighlight + rippleN);
    }

    // v3 Step 4: 简化平行光方向（与下方 Specular 及 Step 3 高光 lightMask 共用，避免出现两套光照方向）
    vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));

    // === 3. 菲涅尔反射 ===
    float NdotV = max(dot(baseNormal, normalize(vViewDir)), 0.0);
    float fresnel;
    vec3 reflectColor;
    if (uWaterMode < 0.5) {
      // Cartoon：原有菲涅尔，不受 normal map 影响
      fresnel = pow(1.0 - NdotV, uFresnelPower) * uFresnelStrength;
      reflectColor = mix(uWaterColor * 1.4, vec3(1.0), 0.3);
    } else {
      // Realistic/Hybrid placeholder：更强菲涅尔 + 法线扰动（normal map 或 fbm 兜底）+ 粗糙度控制反射色
      vec3 normalForRealistic = uUseWaterNormalMaps ? finalWaterNormal : baseNormal;
      float normalPerturb = 0.0;
      float realNdotV = clamp(dot(normalForRealistic, normalize(vViewDir)) + normalPerturb, 0.0, 1.0);
      fresnel = pow(1.0 - realNdotV, uRealisticFresnelPower) * uRealisticFresnelStrength;
      reflectColor = mix(vec3(1.0), uWaterColor * 1.4, uRealisticRoughness);
    }
    waterColor = mix(waterColor, reflectColor, fresnel);

    // === v3 Step 4: Realistic Fresnel / Specular highlight（基于 finalWaterNormal，无 envMap 骨架）===
    float waterFresnel = 0.0;
    float waterSpecular = 0.0;
    if (uWaterMode > 0.5) {
      // Specular Normal Influence：在 baseNormal 与 finalWaterNormal 之间插值/外插，
      // 控制法线贴图细节对高光的扰动程度（0=不受影响，>1=放大扰动）
      vec3 specNormal = normalize(mix(baseNormal, finalWaterNormal, uRealisticSpecularNormalInfluence));

      waterFresnel = computeWaterFresnel(finalWaterNormal, vViewDir);
      waterSpecular = computeWaterSpecular(specNormal, vViewDir, lightDir);

      vec3 fresnelTint = uRealisticFresnelColor * waterFresnel;
      vec3 specularTint = uRealisticSpecularColor * waterSpecular;

      waterColor = mix(waterColor, fresnelTint, waterFresnel * uRealisticFresnelOpacity);
      waterColor += specularTint;
    }

    // === v3 Step 5: Environment Reflection（Realistic/Hybrid，基于 finalWaterNormal 采样 scene.environment）===
    vec3 reflectionColor = vec3(0.0);
    float reflectionWeight = 0.0;
    // v2 model-water: cartoon mode (uWaterMode 0) now also runs this block when
    // uToonEnvReflection is on, so tag/scene cartoon water reflects the sky instead
    // of leaving the fed tWaterEnvMap unsampled (the old 'uWaterMode > 0.5' gate).
    if ((uWaterMode > 0.5 || uToonEnvReflection > 0.5) && uUseWaterEnvReflection) {
      // Cartoon water keeps the sky projection stable and lets only explicit
      // interaction ripples perturb it. Broad animated wave normals otherwise make
      // a static panorama twist across the whole surface while the camera is still.
      vec3 cartoonReflectionNormal = normalize(
        baseNormal + vec3(rippleSlope.x, 0.0, rippleSlope.y) * uWaterReflectionNormalInfluence
      );
      vec3 reflectionNormal = uWaterMode < 0.5
        ? cartoonReflectionNormal
        : normalize(mix(baseNormal, finalWaterNormal, uWaterReflectionNormalInfluence));
      vec3 V = normalize(vViewDir);
      vec3 R = reflect(-V, reflectionNormal);
      vec3 envColor = uHasWaterEnvMap
        ? texture2D(tWaterEnvMap, equirectUv(R)).rgb
        : vec3(0.5, 0.65, 0.85);

      float reflFresnel = computeWaterFresnel(reflectionNormal, V);
      reflectionWeight = uWaterReflectionStrength
        * mix(1.0, reflFresnel, uWaterReflectionFresnelInfluence)
        * (1.0 - uWaterReflectionRoughness * 0.5);
      float reflectionDamping = 1.0 - absorption * uAbsorptionReflectionDamping;
      reflectionWeight *= clamp(reflectionDamping, 0.0, 1.0);
      reflectionWeight = clamp(reflectionWeight, 0.0, 1.0);

      vec3 tintedEnv = envColor * uWaterReflectionTint * uWaterReflectionExposure;
      float envLuma = dot(tintedEnv, vec3(0.299, 0.587, 0.114));
      reflectionColor = mix(tintedEnv, vec3(envLuma), uWaterReflectionRoughness * 0.35);

      // Cartoon: flatten the reflection into a few bands and bias its weight toward
      // grazing angles — top-down keeps water colour, glancing angles catch the sky
      // (RiME/Wind-Waker read), rather than a mirror-accurate reflection.
      if (uWaterMode < 0.5) {
        float steps = max(uToonReflectionSteps, 2.0);
        vec3 qEnv = floor(reflectionColor * steps + 0.5) / steps;
        reflectionColor = mix(reflectionColor, qEnv, 0.85);
        reflectionWeight *= mix(0.2, 1.0, reflFresnel);
      }
    }

    // === v3 Step 8: Planar Reflection（建筑/物体水面倒影，基于 uPlanarReflectionMatrix 投影采样）===
    vec3 planarColor = vec3(0.0);
    float planarWeight = 0.0;
    if (uHasPlanarReflection) {  // v4 Phase 3: 卡通模式(mode 0)也可采样倒影
      // 用 uPlanarReflectionMatrix 将世界坐标投影到反射纹理 UV 空间
      // Project the undisplaced plane position. Vertex waves animate height and
      // shading, but must not move the reflection camera projection on a still view.
      vec4 clipPos = uPlanarReflectionMatrix * vec4(vReflectionWorldPosition, 1.0);
      vec2 planarUv = clipPos.xy / max(clipPos.w, 0.0001);
      planarUv = planarUv * 0.5 + 0.5;  // NDC → [0,1]

      // Normal 扰动 UV（模拟水面波动对倒影的扭曲）
      float planarDistortion = uPlanarReflectionDistortion * uPlanarReflectionDistortionScale * uWaterNormalStrength;
      vec2 planarSlope = uWaterMode < 0.5 ? rippleSlope : finalWaterNormal.xz;
      planarUv += planarSlope * planarDistortion;

      // 透视裁剪：UV 超出 [0,1] 范围外不采样（倒影纹理不重复）
      float inBounds = step(0.0, planarUv.x) * step(planarUv.x, 1.0) *
                       step(0.0, planarUv.y) * step(planarUv.y, 1.0);

      vec3 rawPlanar = texture2D(tPlanarReflection, planarUv).rgb;

      // Debug 模式
      if (uPlanarReflectionDebugMode > 1.5) {
        // Mode 2: show UV grid
        rawPlanar = vec3(fract(planarUv.x * 4.0), fract(planarUv.y * 4.0), 0.0);
      } else if (uPlanarReflectionDebugMode > 0.5) {
        // Mode 1: show planar only（未经 fresnel/tint 处理的原始倒影）
        planarColor = rawPlanar;
        planarWeight = 1.0;
      }

      if (uPlanarReflectionDebugMode < 0.5) {
        // 默认混合模式：fresnel-boosted 混合到 reflectionColor
        float planarFresnel = computeWaterFresnel(finalWaterNormal, vViewDir);
        // v4 Phase 3: 卡通倒影处理（仅 mode 0）——色阶量化 + fresnel 硬边。
        // 扰动已用量化后的 finalWaterNormal（Phase 2.2），倒影边缘天然块状。
        if (uWaterMode < 0.5) {
          if (uToonReflectionSteps > 0.5) {
            float luma = dot(rawPlanar, vec3(0.299, 0.587, 0.114));
            float qLuma = floor(luma * uToonReflectionSteps + 0.5) / uToonReflectionSteps;
            rawPlanar *= qLuma / max(luma, 0.001);
          }
          planarFresnel = step(uToonReflectionFresnelStep, planarFresnel);
        }
        planarWeight = uPlanarReflectionStrength
          * mix(0.5, 1.0, planarFresnel * uPlanarReflectionFresnelBoost)
          * inBounds;
        planarWeight = clamp(planarWeight, 0.0, 1.0);
        planarColor = rawPlanar;
      }
    }

    // === v3 Step 7: Artist-friendly Water Highlight ===
    float highlight = 0.0;
    if (uWaterMode > 0.5 && uHighlightEnabled) {
      vec3 N = normalize(finalWaterNormal);
      vec3 V = normalize(vViewDir);
      vec3 L = normalize(lightDir);
      vec3 H = normalize(V + L);
      float ndotv = clamp(dot(N, V), 0.0, 1.0);
      float ndoth = max(dot(N, H), 0.0);

      // 1. 计算物理/视角相关的 highlight mask
      float specMask = pow(ndoth, max(uRealisticSpecularPower * 0.35, 1.0));
      float fresnelMask = computeWaterFresnel(N, V);
      float viewMin = min(uHighlightViewMin, uHighlightViewMax);
      float viewMax = max(uHighlightViewMin, uHighlightViewMax);
      float viewWindow = smoothstep(viewMin, viewMax, ndotv);
      float grazing = pow(1.0 - ndotv, 2.0) * uHighlightGrazingBoost;
      float viewGlint = mix(uHighlightCoverage, 1.0, clamp(grazing, 0.0, 1.0));
      viewGlint *= viewWindow;
      float slope = clamp(1.0 - N.y, 0.0, 1.0);
      float slopeMask = pow(slope, 0.75);

      // 2. 高光区域聚焦
      float highlightBase =
        specMask * uHighlightSpecularInfluence +
        fresnelMask * uHighlightFresnelInfluence +
        viewGlint * uHighlightViewInfluence +
        slopeMask * uHighlightSlopeInfluence;
      highlightBase = pow(clamp(highlightBase, 0.0, 1.0), max(uHighlightFocusPower, 0.001));

      float highlightMask = smoothstep(
        uHighlightThreshold,
        uHighlightThreshold + max(uHighlightSoftness, 0.001),
        highlightBase
      );
      float ridgeMask = computeWaveRidgeMask(N, vWorldPosition.xz);
      highlightMask *= mix(
        1.0,
        ridgeMask,
        uHighlightSlopeMask
      );
      highlightMask = mix(
        highlightMask,
        highlightMask * ridgeMask,
        uHighlightBlobReduction
      );

      // 视角范围：俯视（highlightNdotV → 1）时收紧高光，避免全屏闪
      float fadeEnd = uHighlightFadeStart + max(uHighlightFadeRange, 1.0);
      float distanceFade = 1.0 - smoothstep(uHighlightFadeStart, fadeEnd, viewDistance) * uHighlightDistanceFade;
      highlightMask *= clamp(distanceFade, 0.0, 1.0);
      float topDown = smoothstep(0.75, 1.0, ndotv);
      highlightMask = mix(
        highlightMask,
        highlightMask * 0.65,
        topDown * uHighlightTopDownSoftening
      );

      // 距离衰减：避免远处密密麻麻白点
      // 3. 用噪声打碎高光区域（不决定整片水面是否发亮）
      vec2 noiseUv = vWorldPosition.xz * uHighlightNoiseScale;
      noiseUv += normalize(vec2(0.7, 0.3)) * uTime * uHighlightNoiseSpeed;
      float highlightNoise = 1.0;
      if (uUseHighlightNoise) {
        float n = texture2D(tHighlightNoise, noiseUv).r;
        n = (n - 0.5) * uHighlightNoiseContrast + 0.5;
        n = clamp(n + uHighlightNoiseOffset, 0.0, 1.0);
        n = pow(n, max(uHighlightNoisePower, 0.001));
        highlightNoise = mix(1.0, n, uHighlightNoiseStrength);
      } else {
        highlightNoise = 1.0;
      }

      highlight = highlightMask * highlightNoise * uHighlightIntensity;
      highlight = min(highlight, uHighlightMax);

      waterColor += uHighlightColor * highlight;
    }

    // === v4 Phase 2.1: Cartoon sparkle（Wind Waker 式白色流线高光，仅 mode 0）===
    // 纯程序噪声（不依赖 tHighlightNoise——其默认 1×1 白纹理会让 step 退化成大色块）。
    // 沿主波向拉伸噪声 UV → 短划/流线状亮片；两层不同速度相乘 → 随时间闪动流动。
    float toonSparkle = 0.0;
    if (uWaterMode < 0.5 && uToonSparkleEnabled) {
      vec3 Ns = normalize(normalForHighlight);
      float ridgeMask = computeWaveRidgeMask(Ns, vWorldPosition.xz);
      vec2 sDir = normalizeDirection(uPrimaryWaveDirection, vec2(1.0, 0.25));
      vec2 sTan = vec2(-sDir.y, sDir.x);
      // 波向坐标系：沿波向压缩（拉长亮片）、垂直方向保持密度
      vec2 sUv = vec2(
        dot(vWorldPosition.xz, sDir) / max(uToonSparkleStretch, 0.5),
        dot(vWorldPosition.xz, sTan)
      ) * uToonSparkleScale;
      vec2 flowOffset = computeWaterFlowOffset();
      vec2 sFlowUv = vec2(
        dot(flowOffset, sDir) / max(uToonSparkleStretch, 0.5),
        dot(flowOffset, sTan)
      ) * uToonSparkleScale;
      float n1 = noise2D(sUv + sFlowUv + sDir * uTime * 0.35);
      float n2 = noise2D((sUv + sFlowUv) * 1.9 - sDir * uTime * 0.55 + vec2(17.0));
      float glint = n1 * n2 * mix(0.6, 1.0, ridgeMask);
      float sparkleAa = max(fwidth(glint), 0.002);
      float sparkleDetail = 1.0 - smoothstep(0.08, 0.22, sparkleAa);
      toonSparkle = smoothstep(
        uToonSparkleThreshold - sparkleAa,
        uToonSparkleThreshold + sparkleAa,
        glint
      ) * uToonSparkleIntensity * sparkleDetail;
      waterColor += uToonSparkleColor * toonSparkle;
    }

    // === v4: Cartoon surface pattern（全水面手绘 foam 等高线，仅 mode 0）===
    // fbm 噪声的窄 iso-band → 蜿蜒的白色细线纹样（Wind Waker 水面标志性图案），
    // 双向缓慢滚动，硬边裁切。与 foam 相加后统一走 uFoamColor 合成。
    if (uWaterMode < 0.5 && uToonPatternEnabled) {
      vec2 patternBase = vWorldPosition.xz + computeWaterFlowOffset();
      float pn = fbmNoise((vWorldPosition.xz + computeWaterFlowOffset()) * uToonPatternScale + vec2(uTime * 0.03, -uTime * 0.022), uTime * 0.12);
      if (uUseToonPatternTexture) {
        vec2 patternUv = patternBase * uToonPatternTextureScale
          + vec2(uTime * 0.03, -uTime * 0.022) * uToonPatternTextureSpeed;
        float texturePattern = texture2D(tToonPattern, patternUv).r;
        pn = mix(pn, texturePattern, clamp(uToonPatternTextureMix, 0.0, 1.0));
      }
      float isoBand = step(0.5 - uToonPatternWidth, pn) * step(pn, 0.5 + uToonPatternWidth);
      foam = clamp(foam + isoBand * uToonPatternIntensity, 0.0, 1.0);
    }

    // === Debug 可视化模式：DepthDiff / ContactFoam / FinalFoam ===
    if (uWaterDebugMode > 0.5) {
      if (uWaterDebugMode < 1.5) {
        gl_FragColor = vec4(vec3(clamp(depthDiff, 0.0, 2.0) * 0.5), 1.0);
        return;
      } else if (uWaterDebugMode < 2.5) {
        gl_FragColor = vec4(vec3(contactFoam), 1.0);
        return;
      } else if (uWaterDebugMode < 4.5) {
        gl_FragColor = vec4(vec3(foam), 1.0);
        return;
      }
    }

    // === Debug 可视化模式：ShoreDistance / ShoreFoam / ShoreWave ===
    if (uWaterDebugMode > 9.5 && uWaterDebugMode < 10.5) {
      gl_FragColor = vec4(vec3(shoreDist), 1.0);
      return;
    }
    if (uWaterDebugMode > 10.5 && uWaterDebugMode < 11.5) {
      gl_FragColor = vec4(vec3(shoreFoam), 1.0);
      return;
    }
    if (uWaterDebugMode > 11.5 && uWaterDebugMode < 12.5) {
      gl_FragColor = vec4(vec3(shoreWave), 1.0);
      return;
    }

    // === v3 Step 4: Debug 可视化模式：Fresnel / Specular ===
    if (uWaterDebugMode > 12.5 && uWaterDebugMode < 13.5) {
      gl_FragColor = vec4(vec3(waterFresnel), 1.0);
      return;
    }
    if (uWaterDebugMode > 13.5 && uWaterDebugMode < 14.5) {
      gl_FragColor = vec4(vec3(waterSpecular), 1.0);
      return;
    }

    // === v3 Step 5: Debug 可视化模式：EnvReflection / ReflectionWeight ===
    if (uWaterDebugMode > 14.5 && uWaterDebugMode < 15.5) {
      gl_FragColor = vec4(reflectionColor, 1.0);
      return;
    }
    if (uWaterDebugMode > 15.5 && uWaterDebugMode < 16.5) {
      gl_FragColor = vec4(vec3(reflectionWeight), 1.0);
      return;
    }

    // === v3 Step 7: Debug 可视化模式：Highlight ===
    if (uWaterDebugMode > 16.5 && uWaterDebugMode < 17.5) {
      gl_FragColor = vec4(vec3(highlight), 1.0);
      return;
    }
    if (uWaterDebugMode > 17.5 && uWaterDebugMode < 18.5) {
      gl_FragColor = vec4(vec3(waveWhitecap), 1.0);
      return;
    }
    if (uWaterDebugMode > 18.5 && uWaterDebugMode < 19.5) {
      gl_FragColor = vec4(vec3(foamShadow), 1.0);
      return;
    }

    // === 5. 合成 ===
    // v3 Step 5: Environment Reflection 合成（clamp 防止反射完全遮盖水色/泡沫）
    float safeReflectionWeight = clamp(reflectionWeight, 0.0, 0.85);
    waterColor = mix(waterColor, reflectionColor, safeReflectionWeight);

    // v3 Step 8: Planar Reflection 合成（建筑倒影叠加在环境反射之上）
    float safePlanarWeight = clamp(planarWeight, 0.0, 0.9);
    waterColor = mix(waterColor, planarColor, safePlanarWeight);

    // Model water knows its authored column depth even when the scene depth texture
    // cannot see a transparent glass floor. Apply this after reflections so deep
    // containers remain deep-colored from above; global/shallow water keeps zero.
    float modelVolumeFactor = smoothstep(0.15, 1.5, uModelWaterDepth);
    waterColor = mix(waterColor, uDepthColor * 0.32, modelVolumeFactor * 0.9);

    waterColor = mix(waterColor, uFoamShadowColor, foamShadow);
    vec3 finalColor = mix(waterColor, uFoamColor, foam);

    float baseOpacity = uOpacity;
    if (uWaterMode > 0.5) {
      // Realistic/Hybrid placeholder：基础更透明，吸收越强越接近原始 opacity
      baseOpacity = mix(uOpacity * 0.6, uOpacity, absorb);
    }
    // v2 model-water: fade the water edge toward transparent so the pool floor that
    // used to be hidden by the placeholder shows through near the shore; deep centre
    // (shoreDist→1) stays at base opacity. uShoreTransparency=0 → unchanged.
    float shoreOpacity = mix(baseOpacity, baseOpacity * uShoreEdgeAlpha, clamp((1.0 - shoreDist) * uShoreTransparency, 0.0, 1.0));
    float alpha = shoreOpacity + foam * 0.08;
    gl_FragColor = vec4(finalColor, alpha);
  }
`;

// ============================================================
// v3: Water Mode — cartoon / realistic / hybrid
// ============================================================
const WATER_MODE_NAMES = ['cartoon', 'realistic', 'hybrid'];

// ============================================================
// 默认参数
// ============================================================
const DEFAULT_OPTIONS = {
  size: 200,
  segments: 128,
  waterLevel: -0.5,
  waterMode: 'cartoon',
  waterColor: new THREE.Color(0.18, 0.32, 0.38),
  shallowColor: new THREE.Color(0.35, 0.55, 0.58),
  foamColor: new THREE.Color(1.0, 1.0, 1.0),
  depthColor: new THREE.Color(0.08, 0.15, 0.20),
  foamThreshold: 0.08,
  foamWidth: 1.0,
  foamNoiseStrength: 0.15,
  waveSpeed: 0.5,
  waveScale: 1.5,
  waveHeight: 0.08,
  fresnelPower: 3.0,
  fresnelStrength: 0.6,
  depthStrength: 0.8,
};

export class WaterSurface {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Group} [environmentRoot] — 环境对象根节点（可选，默认 scene）
   * @param {object} [options]
   */
  constructor(scene, renderer, environmentRoot = null, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    this.scene = scene;
    this.environmentRoot = environmentRoot || scene;
    this.renderer = renderer;
    this._clock = new THREE.Clock();
    this._visible = true;

    const geometry = new THREE.PlaneGeometry(opts.size, opts.size, opts.segments, opts.segments);
    geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      vertexShader: WATER_VERTEX_SHADER,
      fragmentShader: WATER_FRAGMENT_SHADER,
      extensions: { derivatives: true },
      uniforms: {
        tDepth: { value: null },
        uTime: { value: 0 },
        uCameraNear: { value: 0.1 },
        uCameraFar: { value: 1000 },
        uWaterColor: { value: opts.waterColor.clone() },
        uShallowColor: { value: opts.shallowColor.clone() },
        uFoamColor: { value: opts.foamColor.clone() },
        uDepthColor: { value: opts.depthColor.clone() },
        uFoamThreshold: { value: opts.foamThreshold },
        uFoamWidth: { value: opts.foamWidth },
        uFoamNoiseStrength: { value: opts.foamNoiseStrength },
        uWaveSpeed: { value: opts.waveSpeed },
        uWaveScale: { value: opts.waveScale },
        uWaveHeight: { value: opts.waveHeight },
        uSurfaceLift: { value: 0 },
        uEdgeDampRange: { value: 0.12 },
        uWaterPlaneSize: { value: opts.size },
        uDragMult: { value: 0.38 },
        uIterationsVertex: { value: 5 },
        uWaveCenter: { value: 0.46 },
        uWaveAmplitudeBoost: { value: 2.2 },
        uIterationsNormal: { value: 6 },
        uWaveNormalDistanceFade: { value: 0.5 },
        uWaveNormalBlend: { value: 1.0 },
        uUseDirectionalWaves: { value: true },
        uPrimaryWaveDirection: { value: new THREE.Vector2(1.0, 0.25) },
        uSecondaryWaveDirection: { value: new THREE.Vector2(-0.35, 1.0) },
        uDirectionalWaveBlend: { value: 0.75 },
        uDirectionalAnisotropy: { value: 0.8 },
        uLargeWaveStrength: { value: 1.0 },
        uLargeWaveScale: { value: 0.85 },
        uLargeWaveSpeed: { value: 0.85 },
        uLargeWaveStretch: { value: 2.2 },
        uSecondaryWaveStrength: { value: 0.35 },
        uSecondaryWaveScale: { value: 1.4 },
        uSecondaryWaveSpeed: { value: 1.15 },
        uMidWaveStrength: { value: 0.35 },
        uMidWaveScale: { value: 2.1 },
        uMidWaveSpeed: { value: 1.2 },
        uDetailWaveStrength: { value: 0.12 },
        uDetailWaveScale: { value: 5.0 },
        uDetailWaveSpeed: { value: 1.6 },
        uWaveRidgeSharpness: { value: 1.35 },
        uWaveCrestStretch: { value: 1.8 },
        uWaveCrossDamping: { value: 0.45 },
        uWaveSpacingVariation: { value: 0.75 },
        uWaveSpacingScale: { value: 0.12 },

        // Worktree-only A/B/C comparison; intentionally not persisted.

        uFresnelPower: { value: opts.fresnelPower },
        uFresnelStrength: { value: opts.fresnelStrength },
        uDepthStrength: { value: opts.depthStrength },
        uModelWaterDepth: { value: 0.0 },
        uFoamStrength: { value: 1.0 },
        uOpacity: { value: 0.92 },
        uShoreTransparency: { value: 0.0 },
        uShoreEdgeAlpha: { value: 0.35 },
        uFoamOpacity: { value: 0.8 },
        uFoamSpeed: { value: 1.5 },
        uFoamPulse: { value: 0.3 },
        uWhitecapEnabled: { value: true },
        uWhitecapStrength: { value: 0.65 },
        uWhitecapThreshold: { value: 0.28 },
        uWhitecapSoftness: { value: 0.10 },
        uWhitecapNoiseScale: { value: 0.65 },
        uWhitecapBreakup: { value: 0.46 },
        uFoamShadowColor: { value: new THREE.Color(0x0b4f68) },
        uFoamShadowStrength: { value: 0.55 },
        uFoamShadowWidth: { value: 0.14 },
        // 噪声贴图槽
        tHighlightNoise: { value: null },
        tFoamNoise:    { value: null },
        uUseFoamNoise:    { value: false },
        uFlowEnabled: { value: false },
        uFlowDirection: { value: new THREE.Vector2(1.0, 0.0) },
        uFlowSpeed: { value: 0.35 },

        // === v1: 深度纹理状态 / 卡通色阶 / 接触泡沫 / 接触波纹 / Debug 可视化 ===
        uHasDepthTexture: { value: false },

        // v4: cartoon 默认开色阶（shader 内 mode 1 realistic 不量化，安全）
        uUseCartoonBands: { value: true },
        uBandHardness: { value: 3.0 },

        uContactFoamEnabled: { value: true },
        uContactFoamStrength: { value: 1.0 },
        uContactFoamStart: { value: 0.0 },
        uContactFoamEnd: { value: 0.6 },
        uContactFoamWidth: { value: 0.4 },
        uContactFoamNoiseScale: { value: 0.6 },
        uContactFoamBreakup: { value: 0.45 },
        uContactFoamPulse: { value: 1.2 },

        // v4 Phase 6c: static ripple decal (off by default, zero regression)
        uRippleDecalEnabled: { value: false },
        uRippleDecalCount: { value: 0 },
        uRippleDecalPoints: { value: Array.from({ length: MAX_RIPPLE_DECALS }, () => new THREE.Vector2(0, 0)) },
        uRippleDecalRadius: { value: 1.2 },
        uRippleDecalFrequency: { value: 8.0 },
        uRippleDecalSpeed: { value: 1.0 },
        uRippleDecalWidth: { value: 0.25 },
        uRippleDecalStrength: { value: 0.7 },
        uRippleDecalLifetime: { value: 1.4 },
        uRippleDecalNormalStrength: { value: 0.35 },
        uRippleDecalNoiseScale: { value: 0.6 },
        uRippleDecalNoiseStrength: { value: 0.15 },
        uRippleDecalFrontWidth: { value: 0.35 },
        uRippleDecalAttenuation: { value: 1.5 },
        uRippleDecalFadeStart: { value: 0.55 },

        uWaterDebugMode: { value: 0 },

        // === v2: ShoreDistance / Local Water Body 稳定岸线 ===
        tShoreDistance: { value: null },
        uUseShoreDistance: { value: false },
        uInvertShoreDistance: { value: false },
        uShoreDistanceScale: { value: 1.0 },
        uShoreFoamStrength: { value: 0.8 },
        uShoreFoamWidth: { value: 0.08 },
        uShoreWaveEnabled: { value: true },
        uShoreWaveStrength: { value: 0.9 },
        uShoreWaveRange: { value: 0.45 },
        // v4 retune: 旧默认 (freq 12 / width 0.06) 的浪线不足 1px，肉眼不可见
        uShoreWaveFrequency: { value: 6.0 },
        uShoreWaveSpeed: { value: 0.25 },
        uShoreWaveWidth: { value: 0.25 },
        uShoreWaveNoiseScale: { value: 1.8 },
        uShoreWaveNoiseStrength: { value: 0.06 },
        uShoreWaveBreakup: { value: 0.38 },
        uShoreWaveCrestHeight: { value: 0.035 },
        uShoreClipThreshold: { value: 0.002 },
        // v4 scene-shore: world-space shore region (off by default → part water uses vUv)
        uShoreWorldSpace: { value: false },
        uShoreWorldCenter: { value: new THREE.Vector2(0, 0) },
        uShoreWorldSize: { value: 1.0 },

        // === v3: Water Mode (0=cartoon, 1=realistic, 2=hybrid) ===
        uWaterMode: { value: Math.max(0, WATER_MODE_NAMES.indexOf(opts.waterMode)) },

        // === v3: Realistic Water params (lightweight placeholder) ===
        uRealisticRoughness: { value: 0.35 },
        uRealisticFresnelStrength: { value: 0.6 },
        uRealisticFresnelPower: { value: 3.0 },
        uRealisticAbsorptionStrength: { value: 0.15 },
        uRealisticDepthTintStrength: { value: 0.5 },

        // === v3 Step 6: Absorption / Depth Tint ===
        uUseWaterAbsorption: { value: true },
        uAbsorptionStrength: { value: 0.45 },
        uAbsorptionDepthScale: { value: 0.08 },
        uAbsorptionDistanceScale: { value: 0.002 },
        uShallowTint: { value: new THREE.Color(0x6fbfd0) },
        uDeepTint: { value: new THREE.Color(0x123445) },
        uAbsorptionTintStrength: { value: 0.65 },
        uAbsorptionReflectionDamping: { value: 0.35 },
        uAbsorptionMin: { value: 0.0 },
        uAbsorptionMax: { value: 1.0 },

        // === v3 Step 7: Artist-friendly Water Highlight ===
        uHighlightEnabled: { value: true },
        uHighlightIntensity: { value: 0.45 },
        uHighlightColor: { value: new THREE.Color(0xd8f2ff) },
        uHighlightMax: { value: 0.8 },
        uHighlightThreshold: { value: 0.35 },
        uHighlightSoftness: { value: 0.25 },
        uHighlightFocusPower: { value: 2.0 },
        uHighlightCoverage: { value: 0.55 },
        uHighlightSpecularInfluence: { value: 0.55 },
        uHighlightFresnelInfluence: { value: 0.35 },
        uHighlightViewInfluence: { value: 0.45 },
        uHighlightSlopeInfluence: { value: 0.35 },
        uHighlightViewMin: { value: 0.15 },
        uHighlightViewMax: { value: 1.0 },
        uHighlightGrazingBoost: { value: 0.6 },
        uUseHighlightNoise: { value: true },
        uHighlightNoiseScale: { value: 18.0 },
        uHighlightNoiseSpeed: { value: 0.06 },
        uHighlightNoiseStrength: { value: 0.65 },
        uHighlightNoisePower: { value: 3.0 },
        uHighlightNoiseContrast: { value: 1.0 },
        uHighlightNoiseOffset: { value: 0.0 },
        uHighlightDistanceFade: { value: 0.35 },
        uHighlightFadeStart: { value: 120.0 },
        uHighlightFadeRange: { value: 260.0 },
        uHighlightRidgeBias: { value: 0.55 },
        uHighlightSlopeMask: { value: 0.45 },
        uHighlightBlobReduction: { value: 0.65 },
        uHighlightTopDownSoftening: { value: 0.35 },

        // === v4 Phase 2/3: Cartoon (mode 0) toon enhancements ===
        uToonSparkleEnabled: { value: true },
        uToonSparkleThreshold: { value: 0.55 },
        uToonSparkleIntensity: { value: 0.6 },
        uToonSparkleColor: { value: new THREE.Color(0xffffff) },
        uToonSparkleScale: { value: 1.6 },
        uToonSparkleStretch: { value: 3.0 },
        uToonPatternEnabled: { value: true },
        uToonPatternScale: { value: 0.35 },
        uToonPatternWidth: { value: 0.015 },
        uToonPatternIntensity: { value: 0.55 },
        tToonPattern: { value: null },
        uUseToonPatternTexture: { value: false },
        uToonPatternTextureScale: { value: 0.35 },
        uToonPatternTextureSpeed: { value: 1.0 },
        uToonPatternTextureMix: { value: 1.0 },
        uToonNormalSteps: { value: 0.0 },
        uToonFoamHardCut: { value: true },
        uToonReflectionSteps: { value: 4.0 },
        uToonReflectionFresnelStep: { value: 0.35 },

        // === v3 Step 4: Realistic Fresnel / Specular highlight（无 envMap 骨架）===
        uRealisticFresnelBias: { value: 0.02 },
        uRealisticFresnelColor: { value: new THREE.Color(0xbfdfff) },
        uRealisticFresnelOpacity: { value: 0.65 },
        uRealisticSpecularStrength: { value: 0.35 },
        uRealisticSpecularPower: { value: 64.0 },
        uRealisticSpecularColor: { value: new THREE.Color(0xffffff) },
        uRealisticSpecularNormalInfluence: { value: 1.0 },

        // === v3 Step 3: Dual Normal Maps（Realistic/Hybrid 表面细节法线）===
        tWaterNormalA: { value: null },
        tWaterNormalB: { value: null },
        uUseWaterNormalMaps: { value: false },
        uWaterNormalStrength: { value: 0.45 },
        uWaterNormalScaleA: { value: 1.2 },
        uWaterNormalScaleB: { value: 3.5 },
        uWaterNormalSpeedA: { value: 0.035 },
        uWaterNormalSpeedB: { value: 0.075 },
        uWaterNormalDirectionA: { value: new THREE.Vector2(1.0, 0.25) },
        uWaterNormalDirectionB: { value: new THREE.Vector2(-0.35, 1.0) },
        uWaterNormalMix: { value: 0.5 },
        uNormalMapIsDirectX: { value: false },

        // === v3 Step 5: Environment Reflection（Realistic/Hybrid，采样 scene.environment）===
        tWaterEnvMap: { value: null },
        uHasWaterEnvMap: { value: false },
        uUseWaterEnvReflection: { value: false },
        uWaterReflectionStrength: { value: 0.55 },
        uWaterReflectionFresnelInfluence: { value: 1.0 },
        uWaterReflectionTint: { value: new THREE.Color(0xffffff) },
        uWaterReflectionRoughness: { value: 0.25 },
        uWaterReflectionNormalInfluence: { value: 1.0 },
        uWaterReflectionExposure: { value: 1.0 },
        uToonEnvReflection: { value: 0.0 },

        // === v3 Step 8: Planar Reflection（建筑/物体水面倒影）===
        tPlanarReflection: { value: null },
        uPlanarReflectionMatrix: { value: new THREE.Matrix4() },
        uHasPlanarReflection: { value: false },
        uPlanarReflectionStrength: { value: 0.6 },
        uPlanarReflectionDistortion: { value: 0.02 },
        uPlanarReflectionDistortionScale: { value: 1.0 },
        uPlanarReflectionFresnelBoost: { value: 1.5 },
        uPlanarReflectionDebugMode: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.y = opts.waterLevel;
    this.mesh.renderOrder = RENDER_ORDER.WATER_GLASS;
    this.mesh.name = 'WaterSurface';

    // 打保护标记：防止 ShaderLibrary / InkMaterialManager 替换水面材质
    this.mesh.userData.skipShaderApply = true;
    this.mesh.userData.isEnvironmentObject = true;
    this.mesh.userData.isWater = true;

    // 创建1×1默认深度纹理（中灰=0.5，保守估计中间深度）
    // RGBA 格式，R 通道 128/255≈0.5，避免 white(1.0) → far plane 导致深度逻辑全黑
    this._defaultDepthTex = new THREE.DataTexture(
      new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this._defaultDepthTex.needsUpdate = true;
    this.material.uniforms.tDepth.value = this._defaultDepthTex;

    // 创建1×1默认 shoreDistance 纹理（白=1.0，代表"无 mask 时整面都是湖心，无岸线效果"）
    this._defaultShoreDistanceTex = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this._defaultShoreDistanceTex.wrapS = this._defaultShoreDistanceTex.wrapT = THREE.ClampToEdgeWrapping;
    this._defaultShoreDistanceTex.minFilter = THREE.LinearFilter;
    this._defaultShoreDistanceTex.magFilter = THREE.LinearFilter;
    this._defaultShoreDistanceTex.generateMipmaps = false;
    this._defaultShoreDistanceTex.needsUpdate = true;
    this.material.uniforms.tShoreDistance.value = this._defaultShoreDistanceTex;

    // v3 Step 3: 创建1×1默认法线纹理（RGB=128,128,255 → unpackNormalMap 后为 (0,0,1)，即"朝上"中性法线）
    // 用 RepeatWrapping（而非 ClampToEdge），保证用户上传贴图前 scale/speed 变化时 sampler 行为一致、不报错
    this._defaultNormalTex = new THREE.DataTexture(
      new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this._defaultNormalTex.wrapS = this._defaultNormalTex.wrapT = THREE.RepeatWrapping;
    this._defaultNormalTex.minFilter = THREE.LinearFilter;
    this._defaultNormalTex.magFilter = THREE.LinearFilter;
    this._defaultNormalTex.generateMipmaps = false;
    this._defaultNormalTex.needsUpdate = true;
    this.material.uniforms.tWaterNormalA.value = this._defaultNormalTex;
    this.material.uniforms.tWaterNormalB.value = this._defaultNormalTex;

    // v3 Step 5: 创建1×1默认环境贴图纹理（天蓝色，无 scene.environment 时的兜底反射色）
    this._defaultEnvMapTex = new THREE.DataTexture(
      new Uint8Array([140, 180, 220, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this._defaultEnvMapTex.wrapS = this._defaultEnvMapTex.wrapT = THREE.ClampToEdgeWrapping;
    this._defaultEnvMapTex.minFilter = THREE.LinearFilter;
    this._defaultEnvMapTex.magFilter = THREE.LinearFilter;
    this._defaultEnvMapTex.generateMipmaps = false;
    this._defaultEnvMapTex.needsUpdate = true;
    this.material.uniforms.tWaterEnvMap.value = this._defaultEnvMapTex;
    this._useSceneEnvironment = false;

    const highlightNoiseData = new Uint8Array([
      48, 48, 48, 255, 190, 190, 190, 255, 96, 96, 96, 255, 238, 238, 238, 255,
      216, 216, 216, 255, 76, 76, 76, 255, 172, 172, 172, 255, 116, 116, 116, 255,
      128, 128, 128, 255, 232, 232, 232, 255, 60, 60, 60, 255, 184, 184, 184, 255,
      244, 244, 244, 255, 104, 104, 104, 255, 204, 204, 204, 255, 84, 84, 84, 255,
    ]);
    this._defaultHighlightNoiseTex = new THREE.DataTexture(
      highlightNoiseData, 4, 4, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this._defaultHighlightNoiseTex.wrapS = this._defaultHighlightNoiseTex.wrapT = THREE.RepeatWrapping;
    this._defaultHighlightNoiseTex.minFilter = THREE.LinearFilter;
    this._defaultHighlightNoiseTex.magFilter = THREE.LinearFilter;
    this._defaultHighlightNoiseTex.generateMipmaps = false;
    this._defaultHighlightNoiseTex.colorSpace = THREE.NoColorSpace;
    this._defaultHighlightNoiseTex.needsUpdate = true;
    this.material.uniforms.tHighlightNoise.value = this._defaultHighlightNoiseTex;

    this.environmentRoot.add(this.mesh);
  }

  /**
   * 每帧调用
   * @param {number} deltaTime
   * @param {THREE.Camera} camera
   * @param {THREE.DepthTexture|null} depthTexture
   */
  update(deltaTime, camera, depthTexture) {
    if (!this._visible || !this.material) return;

    const uniforms = this.material.uniforms;

    uniforms.uTime.value += deltaTime;
    uniforms.uCameraNear.value = camera.near;
    uniforms.uCameraFar.value = camera.far;

    // 深度纹理：区分真实深度纹理与默认占位纹理
    if (depthTexture) {
      uniforms.tDepth.value = depthTexture;
      uniforms.uHasDepthTexture.value = true;
    } else {
      uniforms.tDepth.value = this._defaultDepthTex;
      uniforms.uHasDepthTexture.value = false;
    }
  }

  /**
   * 设置噪声贴图
   * @param {'foam'|'pattern'} slot - 槽位名
   * @param {THREE.Texture|null} texture - 贴图，传 null 清除并回退到数学路径
   */
  setNoiseTexture(slot, texture) {
    const map = {
      foam:    ['tFoamNoise',    'uUseFoamNoise'],
      pattern: ['tToonPattern',  'uUseToonPatternTexture'],
    };
    const entry = map[slot];
    if (!entry) return;
    const [texUniform, flagUniform] = entry;
    if (!texUniform || !flagUniform) return;

    if (texture) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      this.material.uniforms[texUniform].value = texture;
      this.material.uniforms[flagUniform].value = true;
    } else {
      this.material.uniforms[texUniform].value = null;
      this.material.uniforms[flagUniform].value = false;
    }
  }

  setHighlightNoiseTexture(texture) {
    const u = this.material.uniforms;
    if (texture) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      u.tHighlightNoise.value = texture;
      u.uUseHighlightNoise.value = true;
    } else {
      u.tHighlightNoise.value = this._defaultHighlightNoiseTex;
    }
  }

  setHighlightParams(partial = {}) {
    if (!partial || typeof partial !== 'object') return;
    const u = this.material.uniforms;
    const setClamped = (uniformName, value, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      u[uniformName].value = Math.min(max, Math.max(min, n));
    };
    const setColor = (uniformName, value) => {
      if (value === undefined || value === null) return;
      const target = u[uniformName].value;
      if (value instanceof THREE.Color) {
        target.copy(value);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        target.setHex(value);
      } else if (typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
        target.set(value);
      }
    };

    if (partial.enabled !== undefined) u.uHighlightEnabled.value = Boolean(partial.enabled);
    if (partial.useNoise !== undefined) u.uUseHighlightNoise.value = Boolean(partial.useNoise);
    if (partial.intensity !== undefined) setClamped('uHighlightIntensity', partial.intensity, 0.0, 3.0);
    if (partial.max !== undefined) setClamped('uHighlightMax', partial.max, 0.0, 2.0);
    if (partial.threshold !== undefined) setClamped('uHighlightThreshold', partial.threshold, 0.0, 1.0);
    if (partial.softness !== undefined) setClamped('uHighlightSoftness', partial.softness, 0.001, 0.6);
    if (partial.focusPower !== undefined) setClamped('uHighlightFocusPower', partial.focusPower, 0.5, 12.0);
    if (partial.coverage !== undefined) setClamped('uHighlightCoverage', partial.coverage, 0.0, 1.0);
    if (partial.specularInfluence !== undefined) setClamped('uHighlightSpecularInfluence', partial.specularInfluence, 0.0, 2.0);
    if (partial.fresnelInfluence !== undefined) setClamped('uHighlightFresnelInfluence', partial.fresnelInfluence, 0.0, 2.0);
    if (partial.viewInfluence !== undefined) setClamped('uHighlightViewInfluence', partial.viewInfluence, 0.0, 2.0);
    if (partial.slopeInfluence !== undefined) setClamped('uHighlightSlopeInfluence', partial.slopeInfluence, 0.0, 2.0);
    if (partial.viewMin !== undefined) setClamped('uHighlightViewMin', partial.viewMin, 0.0, 1.0);
    if (partial.viewMax !== undefined) setClamped('uHighlightViewMax', partial.viewMax, 0.0, 1.0);
    if (partial.grazingBoost !== undefined) setClamped('uHighlightGrazingBoost', partial.grazingBoost, 0.0, 3.0);
    if (partial.noiseScale !== undefined) setClamped('uHighlightNoiseScale', partial.noiseScale, 0.1, 100.0);
    if (partial.noiseSpeed !== undefined) setClamped('uHighlightNoiseSpeed', partial.noiseSpeed, -2.0, 2.0);
    if (partial.noiseStrength !== undefined) setClamped('uHighlightNoiseStrength', partial.noiseStrength, 0.0, 1.0);
    if (partial.noisePower !== undefined) setClamped('uHighlightNoisePower', partial.noisePower, 0.5, 16.0);
    if (partial.noiseContrast !== undefined) setClamped('uHighlightNoiseContrast', partial.noiseContrast, 0.0, 4.0);
    if (partial.noiseOffset !== undefined) setClamped('uHighlightNoiseOffset', partial.noiseOffset, -1.0, 1.0);
    if (partial.distanceFade !== undefined) setClamped('uHighlightDistanceFade', partial.distanceFade, 0.0, 1.0);
    if (partial.fadeStart !== undefined) setClamped('uHighlightFadeStart', partial.fadeStart, 0.0, 500.0);
    if (partial.fadeRange !== undefined) setClamped('uHighlightFadeRange', partial.fadeRange, 1.0, 1000.0);
    if (partial.ridgeBias !== undefined) setClamped('uHighlightRidgeBias', partial.ridgeBias, 0.0, 1.0);
    if (partial.slopeMask !== undefined) setClamped('uHighlightSlopeMask', partial.slopeMask, 0.0, 1.0);
    if (partial.blobReduction !== undefined) setClamped('uHighlightBlobReduction', partial.blobReduction, 0.0, 1.0);
    if (partial.topDownSoftening !== undefined) setClamped('uHighlightTopDownSoftening', partial.topDownSoftening, 0.0, 1.0);
    setColor('uHighlightColor', partial.color);

    if (u.uHighlightViewMin.value > u.uHighlightViewMax.value) {
      const oldMin = u.uHighlightViewMin.value;
      u.uHighlightViewMin.value = u.uHighlightViewMax.value;
      u.uHighlightViewMax.value = oldMin;
    }
  }

  getHighlightParams() {
    const u = this.material.uniforms;
    return {
      enabled: u.uHighlightEnabled.value,
      intensity: u.uHighlightIntensity.value,
      color: '#' + u.uHighlightColor.value.getHexString(),
      max: u.uHighlightMax.value,
      threshold: u.uHighlightThreshold.value,
      softness: u.uHighlightSoftness.value,
      focusPower: u.uHighlightFocusPower.value,
      coverage: u.uHighlightCoverage.value,
      specularInfluence: u.uHighlightSpecularInfluence.value,
      fresnelInfluence: u.uHighlightFresnelInfluence.value,
      viewInfluence: u.uHighlightViewInfluence.value,
      slopeInfluence: u.uHighlightSlopeInfluence.value,
      viewMin: u.uHighlightViewMin.value,
      viewMax: u.uHighlightViewMax.value,
      grazingBoost: u.uHighlightGrazingBoost.value,
      useNoise: u.uUseHighlightNoise.value,
      noiseScale: u.uHighlightNoiseScale.value,
      noiseSpeed: u.uHighlightNoiseSpeed.value,
      noiseStrength: u.uHighlightNoiseStrength.value,
      noisePower: u.uHighlightNoisePower.value,
      noiseContrast: u.uHighlightNoiseContrast.value,
      noiseOffset: u.uHighlightNoiseOffset.value,
      distanceFade: u.uHighlightDistanceFade.value,
      fadeStart: u.uHighlightFadeStart.value,
      fadeRange: u.uHighlightFadeRange.value,
      ridgeBias: u.uHighlightRidgeBias.value,
      slopeMask: u.uHighlightSlopeMask.value,
      blobReduction: u.uHighlightBlobReduction.value,
      topDownSoftening: u.uHighlightTopDownSoftening.value,
      hasNoiseTexture: !!u.tHighlightNoise.value && u.tHighlightNoise.value !== this._defaultHighlightNoiseTex,
    };
  }

  setDirectionalWaveParams(partial = {}) {
    if (!partial || typeof partial !== 'object') return;
    const u = this.material.uniforms;
    const setClamped = (uniformName, value, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      u[uniformName].value = Math.min(max, Math.max(min, n));
    };
    const normalizeDirection = (value, fallback) => {
      let x;
      let y;
      if (Array.isArray(value)) {
        [x, y] = value;
      } else if (value && typeof value === 'object') {
        x = value.x;
        y = value.y;
      } else {
        return null;
      }
      x = Number(x);
      y = Number(y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const len = Math.hypot(x, y);
      if (len <= 0.000001) return fallback.clone().normalize();
      return new THREE.Vector2(x / len, y / len);
    };

    if (partial.enabled !== undefined) u.uUseDirectionalWaves.value = Boolean(partial.enabled);
    const primary = normalizeDirection(partial.primaryDirection, new THREE.Vector2(1.0, 0.25));
    if (primary) u.uPrimaryWaveDirection.value.copy(primary);
    const secondary = normalizeDirection(partial.secondaryDirection, new THREE.Vector2(-0.35, 1.0));
    if (secondary) u.uSecondaryWaveDirection.value.copy(secondary);

    if (partial.directionalBlend !== undefined) setClamped('uDirectionalWaveBlend', partial.directionalBlend, 0.0, 1.0);
    if (partial.anisotropy !== undefined) setClamped('uDirectionalAnisotropy', partial.anisotropy, 0.0, 1.0);
    if (partial.largeStrength !== undefined) setClamped('uLargeWaveStrength', partial.largeStrength, 0.0, 3.0);
    if (partial.largeScale !== undefined) setClamped('uLargeWaveScale', partial.largeScale, 0.05, 5.0);
    if (partial.largeSpeed !== undefined) setClamped('uLargeWaveSpeed', partial.largeSpeed, -3.0, 3.0);
    if (partial.largeStretch !== undefined) setClamped('uLargeWaveStretch', partial.largeStretch, 0.1, 8.0);
    if (partial.secondaryStrength !== undefined) setClamped('uSecondaryWaveStrength', partial.secondaryStrength, 0.0, 2.0);
    if (partial.secondaryScale !== undefined) setClamped('uSecondaryWaveScale', partial.secondaryScale, 0.05, 8.0);
    if (partial.secondarySpeed !== undefined) setClamped('uSecondaryWaveSpeed', partial.secondarySpeed, -3.0, 3.0);
    if (partial.midStrength !== undefined) setClamped('uMidWaveStrength', partial.midStrength, 0.0, 2.0);
    if (partial.midScale !== undefined) setClamped('uMidWaveScale', partial.midScale, 0.05, 12.0);
    if (partial.midSpeed !== undefined) setClamped('uMidWaveSpeed', partial.midSpeed, -3.0, 3.0);
    if (partial.detailStrength !== undefined) setClamped('uDetailWaveStrength', partial.detailStrength, 0.0, 1.0);
    if (partial.detailScale !== undefined) setClamped('uDetailWaveScale', partial.detailScale, 0.1, 30.0);
    if (partial.detailSpeed !== undefined) setClamped('uDetailWaveSpeed', partial.detailSpeed, -5.0, 5.0);
    if (partial.ridgeSharpness !== undefined) setClamped('uWaveRidgeSharpness', partial.ridgeSharpness, 0.5, 4.0);
    if (partial.crestStretch !== undefined) setClamped('uWaveCrestStretch', partial.crestStretch, 0.1, 8.0);
    if (partial.crossDamping !== undefined) setClamped('uWaveCrossDamping', partial.crossDamping, 0.0, 1.0);
    if (partial.spacingVariation !== undefined) setClamped('uWaveSpacingVariation', partial.spacingVariation, 0.0, 2.5);
    if (partial.spacingScale !== undefined) setClamped('uWaveSpacingScale', partial.spacingScale, 0.01, 0.5);
  }

  getDirectionalWaveParams() {
    const u = this.material.uniforms;
    return {
      enabled: u.uUseDirectionalWaves.value,
      primaryDirection: [u.uPrimaryWaveDirection.value.x, u.uPrimaryWaveDirection.value.y],
      secondaryDirection: [u.uSecondaryWaveDirection.value.x, u.uSecondaryWaveDirection.value.y],
      directionalBlend: u.uDirectionalWaveBlend.value,
      anisotropy: u.uDirectionalAnisotropy.value,
      largeStrength: u.uLargeWaveStrength.value,
      largeScale: u.uLargeWaveScale.value,
      largeSpeed: u.uLargeWaveSpeed.value,
      largeStretch: u.uLargeWaveStretch.value,
      secondaryStrength: u.uSecondaryWaveStrength.value,
      secondaryScale: u.uSecondaryWaveScale.value,
      secondarySpeed: u.uSecondaryWaveSpeed.value,
      midStrength: u.uMidWaveStrength.value,
      midScale: u.uMidWaveScale.value,
      midSpeed: u.uMidWaveSpeed.value,
      detailStrength: u.uDetailWaveStrength.value,
      detailScale: u.uDetailWaveScale.value,
      detailSpeed: u.uDetailWaveSpeed.value,
      ridgeSharpness: u.uWaveRidgeSharpness.value,
      crestStretch: u.uWaveCrestStretch.value,
      crossDamping: u.uWaveCrossDamping.value,
      spacingVariation: u.uWaveSpacingVariation.value,
      spacingScale: u.uWaveSpacingScale.value,
    };
  }

  setFlowParams(partial = {}) {
    if (!partial || typeof partial !== 'object') return;
    const u = this.material.uniforms;

    if (partial.enabled !== undefined) {
      u.uFlowEnabled.value = Boolean(partial.enabled);
    }

    const setClamped = (uniformName, value, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      u[uniformName].value = Math.min(max, Math.max(min, n));
    };

    const direction = Array.isArray(partial.direction)
      ? partial.direction
      : (Array.isArray(partial.uFlowDirection) ? partial.uFlowDirection : null);
    let x = direction ? direction[0] : partial.directionX;
    let y = direction ? direction[1] : partial.directionY;
    if (x === undefined && partial.uFlowDirectionX !== undefined) x = partial.uFlowDirectionX;
    if (y === undefined && partial.uFlowDirectionY !== undefined) y = partial.uFlowDirectionY;
    x = Number(x);
    y = Number(y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const len = Math.hypot(x, y);
      if (len > 0.000001) {
        u.uFlowDirection.value.set(x / len, y / len);
      }
    }

    if (partial.speed !== undefined) setClamped('uFlowSpeed', partial.speed, -3.0, 3.0);
    if (partial.uFlowSpeed !== undefined) setClamped('uFlowSpeed', partial.uFlowSpeed, -3.0, 3.0);
  }

  getFlowParams() {
    const u = this.material.uniforms;
    return {
      enabled: u.uFlowEnabled.value,
      direction: [u.uFlowDirection.value.x, u.uFlowDirection.value.y],
      speed: u.uFlowSpeed.value,
    };
  }

  /**
   * v4 Phase 6c: 静态涟漪贴花（雨滴式局部圆环）。points 为世界空间 XZ 坐标数组，
   * 上限 8 个，超出部分忽略；不传 points 时只更新标量参数。
   */
  setRippleDecalParams(partial = {}) {
    if (!partial || typeof partial !== 'object') return;
    const u = this.material.uniforms;

    if (partial.enabled !== undefined) {
      u.uRippleDecalEnabled.value = Boolean(partial.enabled);
    }

    const setClamped = (uniformName, value, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      u[uniformName].value = Math.min(max, Math.max(min, n));
    };
    if (partial.radius !== undefined) setClamped('uRippleDecalRadius', partial.radius, 0.01, 50);
    if (partial.frequency !== undefined) setClamped('uRippleDecalFrequency', partial.frequency, 0.1, 50);
    if (partial.speed !== undefined) setClamped('uRippleDecalSpeed', partial.speed, -10, 10);
    if (partial.width !== undefined) setClamped('uRippleDecalWidth', partial.width, 0.01, 1);
    if (partial.strength !== undefined) setClamped('uRippleDecalStrength', partial.strength, 0, 3);
    if (partial.lifetime !== undefined) setClamped('uRippleDecalLifetime', partial.lifetime, 0.1, 10);
    if (partial.normalStrength !== undefined) setClamped('uRippleDecalNormalStrength', partial.normalStrength, 0, 2);
    if (partial.noiseScale !== undefined) setClamped('uRippleDecalNoiseScale', partial.noiseScale, 0.05, 5);
    if (partial.noiseStrength !== undefined) setClamped('uRippleDecalNoiseStrength', partial.noiseStrength, 0, 2);
    if (partial.frontWidth !== undefined) setClamped('uRippleDecalFrontWidth', partial.frontWidth, 0.05, 1);
    if (partial.attenuation !== undefined) setClamped('uRippleDecalAttenuation', partial.attenuation, 0, 6);
    if (partial.fadeStart !== undefined) setClamped('uRippleDecalFadeStart', partial.fadeStart, 0.1, 0.95);

    if (Array.isArray(partial.points)) {
      // 导入的点写在 pinned 前段之后，不得覆盖瀑布脚等常驻 pinned 槽位（A.6 所有权协议）。
      const pinnedN = Math.min(this._pinnedRipples?.size || 0, MAX_RIPPLE_DECALS);
      const points = partial.points.slice(0, MAX_RIPPLE_DECALS - pinnedN);
      points.forEach(([x, z], i) => {
        if (Number.isFinite(Number(x)) && Number.isFinite(Number(z))) {
          u.uRippleDecalPoints.value[pinnedN + i].set(Number(x), Number(z));
        }
      });
      u.uRippleDecalCount.value = pinnedN + points.length;
    }
  }

  getRippleDecalParams() {
    const u = this.material.uniforms;
    const count = Math.max(0, Math.min(MAX_RIPPLE_DECALS, Math.round(u.uRippleDecalCount.value)));
    // 只导出 transient 点：pinned 点（瀑布脚）由 owner 实例在重建时重新 pin，进存档会变重复点。
    const pinnedN = Math.min(this._pinnedRipples?.size || 0, count);
    return {
      enabled: u.uRippleDecalEnabled.value,
      radius: u.uRippleDecalRadius.value,
      frequency: u.uRippleDecalFrequency.value,
      speed: u.uRippleDecalSpeed.value,
      width: u.uRippleDecalWidth.value,
      strength: u.uRippleDecalStrength.value,
      lifetime: u.uRippleDecalLifetime.value,
      normalStrength: u.uRippleDecalNormalStrength.value,
      noiseScale: u.uRippleDecalNoiseScale.value,
      noiseStrength: u.uRippleDecalNoiseStrength.value,
      frontWidth: u.uRippleDecalFrontWidth.value,
      attenuation: u.uRippleDecalAttenuation.value,
      fadeStart: u.uRippleDecalFadeStart.value,
      points: u.uRippleDecalPoints.value.slice(pinnedN, count).map((v) => [v.x, v.y]),
    };
  }

  /**
   * 追加一个 transient 涟漪点（世界空间 XZ）——雨滴 / 手动 decal 用。
   * 槽位所有权协议（water-dynamic-v1 A.6）：数组前段属于 pinned 点（瀑布脚等常驻涟漪，
   * 见 pinRippleDecalPoint），transient 环形覆盖只在 pinned 之后的剩余槽位内轮转，
   * 两个写入方互不清点。返回当前已激活的点数量（封顶 MAX_RIPPLE_DECALS）。
   */
  addRippleDecalPoint(x, z) {
    const u = this.material.uniforms;
    const pts = u.uRippleDecalPoints.value;
    const pinned = Math.min(this._pinnedRipples?.size || 0, pts.length);
    const cap = pts.length - pinned;
    if (cap <= 0) return u.uRippleDecalCount.value; // 全部被 pinned 占用，丢弃 transient
    if (this._rippleWriteIdx === undefined) this._rippleWriteIdx = 0;
    const idx = pinned + (this._rippleWriteIdx % cap);
    pts[idx].set(Number(x) || 0, Number(z) || 0);
    this._rippleWriteIdx = (this._rippleWriteIdx + 1) % cap;
    u.uRippleDecalCount.value = Math.min(pts.length, Math.max(u.uRippleDecalCount.value, idx + 1));
    return u.uRippleDecalCount.value;
  }

  /** 清空 transient 涟漪点；pinned 点（瀑布脚）保留——它们由各自 owner 负责 unpin。 */
  clearRippleDecalPoints() {
    const pts = this.material.uniforms.uRippleDecalPoints.value;
    this.material.uniforms.uRippleDecalCount.value = Math.min(this._pinnedRipples?.size || 0, pts.length);
    this._rippleWriteIdx = 0;
  }

  /**
   * Pin 一个常驻涟漪点（瀑布脚撞击环）。pinned 点占数组前段槽位，addRippleDecalPoint
   * 的环形覆盖永远不会碰它们；shader 的 grow→decay 包络按 lifetime 周期自动循环，
   * 所以 pinned 点无需重写即持续起环。返回 pin id，供 unpinRippleDecalPoint 释放。
   * ponytail: rebuild 会丢弃当前 transient 点（雨滴一秒内自动补满），pin/unpin 是低频操作。
   */
  pinRippleDecalPoint(x, z) {
    if (!this._pinnedRipples) { this._pinnedRipples = new Map(); this._pinnedRippleSeq = 0; }
    const id = ++this._pinnedRippleSeq;
    this._pinnedRipples.set(id, [Number(x) || 0, Number(z) || 0]);
    this._rebuildPinnedRippleSlots();
    const u = this.material.uniforms;
    if (!u.uRippleDecalEnabled.value) u.uRippleDecalEnabled.value = true;
    return id;
  }

  /**
   * Cheap per-frame reposition of an already-pinned point (waterfall follows
   * transform-control drag / model movement) — writes the uniform slot directly,
   * no full rebuild. No-op if id isn't pinned (e.g. already unpinned this frame).
   */
  updatePinnedRipplePoint(id, x, z) {
    if (!this._pinnedRipples?.has(id)) return false;
    this._pinnedRipples.set(id, [Number(x) || 0, Number(z) || 0]);
    const index = [...this._pinnedRipples.keys()].indexOf(id);
    if (index < 0) return false;
    this.material.uniforms.uRippleDecalPoints.value[index].set(Number(x) || 0, Number(z) || 0);
    return true;
  }

  unpinRippleDecalPoint(id) {
    if (!this._pinnedRipples?.delete(id)) return false;
    this._rebuildPinnedRippleSlots();
    return true;
  }

  _rebuildPinnedRippleSlots() {
    const u = this.material.uniforms;
    const pts = u.uRippleDecalPoints.value;
    const pinned = [...(this._pinnedRipples?.values() || [])].slice(0, pts.length);
    pinned.forEach(([x, z], i) => pts[i].set(x, z));
    u.uRippleDecalCount.value = pinned.length;
    this._rippleWriteIdx = 0;
  }

  /**
   * 设置/清除 shoreDistance 纹理（Local Water Body 稳定岸线）
   * @param {THREE.DataTexture|THREE.Texture|null} texture - shoreDistance 纹理，传 null 清除并禁用
   */
  setShoreDistanceTexture(texture) {
    const u = this.material.uniforms;
    u.tShoreDistance.value = texture || this._defaultShoreDistanceTex;
    u.uUseShoreDistance.value = !!texture;
    if (texture) {
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
    } else {
      // clearing shore also drops world-space region mode (back to plane-UV default)
      u.uShoreWorldSpace.value = false;
    }
  }

  /**
   * v4 模型水防穿模：按当前波浪参数估算波谷下探深度，作为内部 clearance。
   * 顶点 shader 会用 shoreDist 阻尼，岸边 clearance=0，水体内部逐渐抬高。
   * @param {number} [safety=1.15] - 安全系数（估算偏保守，留一点余量避免临界穿模）
   * @returns {number} 实际设置的 uSurfaceLift（shore-damped clearance）
   */
  applyWaveClearanceLift(safety = 1.15) {
    const u = this.material.uniforms;
    if (this.mesh?.userData?.isModelWater) {
      u.uSurfaceLift.value = 0;
      return 0;
    }
    const waveHeight = u.uWaveHeight.value;
    let amp;
    if (u.uUseDirectionalWaves?.value) {
      // 方向波：各层强度之和 × 波高 ≈ 顶点最大下探量（层函数幅度约 ±1）
      amp = (u.uLargeWaveStrength.value + u.uSecondaryWaveStrength.value
        + u.uMidWaveStrength.value + u.uDetailWaveStrength.value * 0.2) * waveHeight;
    } else {
      amp = u.uWaveAmplitudeBoost.value * waveHeight;
    }
    const crest = u.uShoreWaveEnabled?.value ? (u.uShoreWaveCrestHeight?.value || 0) : 0;
    const lift = Math.max(0, amp * safety + crest);
    u.uSurfaceLift.value = lift;
    return lift;
  }

  /**
   * v4 scene-shore: bind the shoreDistance texture to a world-space XZ sub-region so a
   * full-size ocean plane can carry a scene-fitted shore field. Pass null to revert to vUv mode.
   * @param {{x:number,y:number}|null} centerXZ - region center in world XZ (y = world Z)
   * @param {number} [size] - region side length in world units
   */
  setShoreWorldRegion(centerXZ, size) {
    const u = this.material.uniforms;
    if (!centerXZ || !(size > 0)) {
      u.uShoreWorldSpace.value = false;
      return;
    }
    u.uShoreWorldCenter.value.set(centerXZ.x, centerXZ.y);
    u.uShoreWorldSize.value = size;
    u.uShoreWorldSpace.value = true;
  }

  /**
   * v3 Step 3: 设置/清除水面法线贴图（Normal A/B，用于 Realistic/Hybrid 表面细节扰动法线）
   * @param {'A'|'B'} slot - 槽位
   * @param {THREE.Texture|null} texture - 法线贴图，传 null 或非法 slot 时回退到中性法线，不抛错
   */
  setWaterNormalTexture(slot, texture) {
    const map = { A: 'tWaterNormalA', B: 'tWaterNormalB' };
    const uniformName = map[slot];
    if (!uniformName) {
      console.warn(`[WaterSurface] Unknown water normal slot "${slot}", expected "A" or "B".`);
      return;
    }
    const u = this.material.uniforms;
    if (texture) {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      u[uniformName].value = texture;
    } else {
      u[uniformName].value = this._defaultNormalTex;
    }
  }

  /**
   * v3 Step 3: 设置水面法线贴图参数（仅更新传入字段，自动 clamp 到合法范围并拒绝 NaN）
   * @param {object} partial - {enabled, strength, scaleA, scaleB, speedA, speedB,
   *   directionAX, directionAY, directionBX, directionBY, mix}
   */
  setWaterNormalParams(partial) {
    if (!partial) return;
    const u = this.material.uniforms;

    if (partial.enabled !== undefined) {
      u.uUseWaterNormalMaps.value = Boolean(partial.enabled);
    }

    const setClamped = (uniformName, value, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      u[uniformName].value = Math.min(max, Math.max(min, n));
    };

    if (partial.strength !== undefined) setClamped('uWaterNormalStrength', partial.strength, 0.0, 2.0);
    if (partial.scaleA !== undefined) setClamped('uWaterNormalScaleA', partial.scaleA, 0.05, 20.0);
    if (partial.scaleB !== undefined) setClamped('uWaterNormalScaleB', partial.scaleB, 0.05, 20.0);
    if (partial.speedA !== undefined) setClamped('uWaterNormalSpeedA', partial.speedA, -1.0, 1.0);
    if (partial.speedB !== undefined) setClamped('uWaterNormalSpeedB', partial.speedB, -1.0, 1.0);
    if (partial.mix !== undefined) setClamped('uWaterNormalMix', partial.mix, 0.0, 1.0);

    const setClampedComponent = (vec2, key, value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      vec2[key] = Math.min(1.0, Math.max(-1.0, n));
    };
    if (partial.directionAX !== undefined) setClampedComponent(u.uWaterNormalDirectionA.value, 'x', partial.directionAX);
    if (partial.directionAY !== undefined) setClampedComponent(u.uWaterNormalDirectionA.value, 'y', partial.directionAY);
    if (partial.directionBX !== undefined) setClampedComponent(u.uWaterNormalDirectionB.value, 'x', partial.directionBX);
    if (partial.directionBY !== undefined) setClampedComponent(u.uWaterNormalDirectionB.value, 'y', partial.directionBY);
  }

  /**
   * v3 Step 3: 获取水面法线贴图参数
   * @returns {object}
   */
  getWaterNormalParams() {
    const u = this.material.uniforms;
    return {
      enabled: u.uUseWaterNormalMaps.value,
      strength: u.uWaterNormalStrength.value,
      scaleA: u.uWaterNormalScaleA.value,
      scaleB: u.uWaterNormalScaleB.value,
      speedA: u.uWaterNormalSpeedA.value,
      speedB: u.uWaterNormalSpeedB.value,
      directionA: [u.uWaterNormalDirectionA.value.x, u.uWaterNormalDirectionA.value.y],
      directionB: [u.uWaterNormalDirectionB.value.x, u.uWaterNormalDirectionB.value.y],
      mix: u.uWaterNormalMix.value,
      hasNormalA: !!u.tWaterNormalA.value && u.tWaterNormalA.value !== this._defaultNormalTex,
      hasNormalB: !!u.tWaterNormalB.value && u.tWaterNormalB.value !== this._defaultNormalTex,
    };
  }

  /**
   * v3 Step 2/4: 设置 Realistic Water 参数（仅更新传入字段，自动 clamp 到合法范围并拒绝 NaN/非法颜色）
   * @param {object} partial - {roughness, fresnelStrength, fresnelPower, normalStrength,
   *   absorptionStrength, depthTintStrength, fresnelBias, fresnelColor, fresnelOpacity,
   *   specularStrength, specularPower, specularColor, specularNormalInfluence}
   *   颜色字段支持 THREE.Color / hex number / "#rrggbb" 字符串；非法值跳过并保留当前值，
   *   不会产生 "THREE.Color: Unknown color" 警告。
   */
  setRealisticParams(partial) {
    if (!partial) return;
    const u = this.material.uniforms;

    const setClamped = (uniformName, value, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      u[uniformName].value = Math.min(max, Math.max(min, n));
    };
    const setColor = (uniformName, value) => {
      if (value === undefined || value === null) return;
      const target = u[uniformName].value;
      if (value instanceof THREE.Color) {
        target.copy(value);
        return;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        target.setHex(value);
        return;
      }
      if (typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
        target.set(value);
      }
      // 其余非法值（非法字符串/其它类型）直接跳过，保留当前值
    };

    // v3 Step 2: Realistic Water (lightweight placeholder)
    if (partial.roughness !== undefined) setClamped('uRealisticRoughness', partial.roughness, 0.0, 1.0);
    if (partial.fresnelStrength !== undefined) setClamped('uRealisticFresnelStrength', partial.fresnelStrength, 0.0, 3.0);
    if (partial.fresnelPower !== undefined) setClamped('uRealisticFresnelPower', partial.fresnelPower, 0.5, 10.0);
    if (partial.absorptionStrength !== undefined) setClamped('uRealisticAbsorptionStrength', partial.absorptionStrength, 0.0, 2.0);
    if (partial.depthTintStrength !== undefined) setClamped('uRealisticDepthTintStrength', partial.depthTintStrength, 0.0, 1.0);

    // v3 Step 4: Fresnel / Specular highlight
    if (partial.fresnelBias !== undefined) setClamped('uRealisticFresnelBias', partial.fresnelBias, 0.0, 1.0);
    if (partial.fresnelOpacity !== undefined) setClamped('uRealisticFresnelOpacity', partial.fresnelOpacity, 0.0, 1.0);
    if (partial.specularStrength !== undefined) setClamped('uRealisticSpecularStrength', partial.specularStrength, 0.0, 3.0);
    if (partial.specularPower !== undefined) setClamped('uRealisticSpecularPower', partial.specularPower, 1.0, 256.0);
    if (partial.specularNormalInfluence !== undefined) setClamped('uRealisticSpecularNormalInfluence', partial.specularNormalInfluence, 0.0, 2.0);
    setColor('uRealisticFresnelColor', partial.fresnelColor);
    setColor('uRealisticSpecularColor', partial.specularColor);
  }

  /**
   * v3 Step 2/4: 获取 Realistic Water 参数
   * @returns {object}
   */
  getRealisticParams() {
    const u = this.material.uniforms;
    return {
      roughness: u.uRealisticRoughness.value,
      fresnelStrength: u.uRealisticFresnelStrength.value,
      fresnelPower: u.uRealisticFresnelPower.value,
      absorptionStrength: u.uRealisticAbsorptionStrength.value,
      depthTintStrength: u.uRealisticDepthTintStrength.value,
      fresnelBias: u.uRealisticFresnelBias.value,
      fresnelColor: '#' + u.uRealisticFresnelColor.value.getHexString(),
      fresnelOpacity: u.uRealisticFresnelOpacity.value,
      specularStrength: u.uRealisticSpecularStrength.value,
      specularPower: u.uRealisticSpecularPower.value,
      specularColor: '#' + u.uRealisticSpecularColor.value.getHexString(),
      specularNormalInfluence: u.uRealisticSpecularNormalInfluence.value,
    };
  }

  /**
   * v3 Step 5: 设置/清除水面环境反射贴图（equirectangular，通常来自 scene.environment）
   * @param {THREE.Texture|null} texture - 传 null 或不传时回退到中性兜底贴图，不抛错
   */
  /**
   * v3 Step 6: 设置轻量 absorption / depth tint 参数。
   * @param {object} partial - {enabled, strength, depthScale, distanceScale,
   *   shallowTint, deepTint, tintStrength, reflectionDamping, min, max}
   */
  setWaterAbsorptionParams(partial = {}) {
    if (!partial || typeof partial !== 'object') return;
    const u = this.material.uniforms;

    if (partial.enabled !== undefined) {
      u.uUseWaterAbsorption.value = Boolean(partial.enabled);
    }

    const setClamped = (uniformName, value, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      u[uniformName].value = Math.min(max, Math.max(min, n));
    };
    const setColor = (uniformName, value) => {
      if (value === undefined || value === null) return;
      const target = u[uniformName].value;
      if (value instanceof THREE.Color) {
        target.copy(value);
        return;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        target.setHex(value);
        return;
      }
      if (typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
        target.set(value);
      }
    };

    if (partial.strength !== undefined) setClamped('uAbsorptionStrength', partial.strength, 0.0, 3.0);
    if (partial.depthScale !== undefined) setClamped('uAbsorptionDepthScale', partial.depthScale, 0.0, 1.0);
    if (partial.distanceScale !== undefined) setClamped('uAbsorptionDistanceScale', partial.distanceScale, 0.0, 0.02);
    if (partial.tintStrength !== undefined) setClamped('uAbsorptionTintStrength', partial.tintStrength, 0.0, 1.0);
    if (partial.reflectionDamping !== undefined) setClamped('uAbsorptionReflectionDamping', partial.reflectionDamping, 0.0, 1.0);
    if (partial.min !== undefined) setClamped('uAbsorptionMin', partial.min, 0.0, 1.0);
    if (partial.max !== undefined) setClamped('uAbsorptionMax', partial.max, 0.0, 1.0);
    setColor('uShallowTint', partial.shallowTint);
    setColor('uDeepTint', partial.deepTint);

    if (u.uAbsorptionMin.value > u.uAbsorptionMax.value) {
      const oldMin = u.uAbsorptionMin.value;
      u.uAbsorptionMin.value = u.uAbsorptionMax.value;
      u.uAbsorptionMax.value = oldMin;
    }
  }

  /**
   * v3 Step 6: 获取轻量 absorption / depth tint 参数。
   * @returns {object}
   */
  getWaterAbsorptionParams() {
    const u = this.material.uniforms;
    return {
      enabled: u.uUseWaterAbsorption.value,
      strength: u.uAbsorptionStrength.value,
      depthScale: u.uAbsorptionDepthScale.value,
      distanceScale: u.uAbsorptionDistanceScale.value,
      shallowTint: '#' + u.uShallowTint.value.getHexString(),
      deepTint: '#' + u.uDeepTint.value.getHexString(),
      tintStrength: u.uAbsorptionTintStrength.value,
      reflectionDamping: u.uAbsorptionReflectionDamping.value,
      min: u.uAbsorptionMin.value,
      max: u.uAbsorptionMax.value,
    };
  }

  setWaterEnvMap(texture) {
    const u = this.material.uniforms;
    if (texture) {
      u.tWaterEnvMap.value = texture;
      u.uHasWaterEnvMap.value = true;
    } else {
      u.tWaterEnvMap.value = this._defaultEnvMapTex;
      u.uHasWaterEnvMap.value = false;
    }
  }

  /**
   * v3 Step 5: 获取当前水面环境反射贴图
   * @returns {THREE.Texture|null} 未设置真实贴图（仍是兜底纹理）时返回 null
   */
  getWaterEnvMap() {
    const u = this.material.uniforms;
    return u.uHasWaterEnvMap.value ? u.tWaterEnvMap.value : null;
  }

  /**
   * v3 Step 5: 设置环境反射参数（仅更新传入字段，自动 clamp 到合法范围并拒绝 NaN/非法颜色）
   * @param {object} partial - {enabled, strength, fresnelInfluence, tint, roughness,
   *   normalInfluence, exposure, useSceneEnvironment}
   *   tint 支持 THREE.Color / hex number / "#rrggbb" 字符串；非法值跳过并保留当前值。
   */
  setWaterReflectionParams(partial) {
    if (!partial) return;
    const u = this.material.uniforms;

    if (partial.enabled !== undefined) {
      u.uUseWaterEnvReflection.value = Boolean(partial.enabled);
    }
    if (partial.useSceneEnvironment !== undefined) {
      this._useSceneEnvironment = Boolean(partial.useSceneEnvironment);
    }

    const setClamped = (uniformName, value, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      u[uniformName].value = Math.min(max, Math.max(min, n));
    };
    const setColor = (uniformName, value) => {
      if (value === undefined || value === null) return;
      const target = u[uniformName].value;
      if (value instanceof THREE.Color) {
        target.copy(value);
        return;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        target.setHex(value);
        return;
      }
      if (typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)) {
        target.set(value);
      }
      // 其余非法值（非法字符串/其它类型）直接跳过，保留当前值
    };

    if (partial.strength !== undefined) setClamped('uWaterReflectionStrength', partial.strength, 0.0, 1.5);
    if (partial.fresnelInfluence !== undefined) setClamped('uWaterReflectionFresnelInfluence', partial.fresnelInfluence, 0.0, 2.0);
    if (partial.roughness !== undefined) setClamped('uWaterReflectionRoughness', partial.roughness, 0.0, 1.0);
    if (partial.normalInfluence !== undefined) setClamped('uWaterReflectionNormalInfluence', partial.normalInfluence, 0.0, 2.0);
    if (partial.exposure !== undefined) setClamped('uWaterReflectionExposure', partial.exposure, 0.0, 3.0);
    setColor('uWaterReflectionTint', partial.tint);
  }

  /**
   * v3 Step 5: 获取环境反射参数
   * @returns {object}
   */
  getWaterReflectionParams() {
    const u = this.material.uniforms;
    return {
      enabled: u.uUseWaterEnvReflection.value,
      strength: u.uWaterReflectionStrength.value,
      fresnelInfluence: u.uWaterReflectionFresnelInfluence.value,
      tint: '#' + u.uWaterReflectionTint.value.getHexString(),
      roughness: u.uWaterReflectionRoughness.value,
      normalInfluence: u.uWaterReflectionNormalInfluence.value,
      exposure: u.uWaterReflectionExposure.value,
      useSceneEnvironment: !!this._useSceneEnvironment,
      hasEnvMap: u.uHasWaterEnvMap.value,
    };
  }

  // ════════════════════════════════════════════════════════════
  // v3 Step 8: Planar Reflection（建筑/物体水面倒影）
  // ════════════════════════════════════════════════════════════

  /**
   * 设置 planar reflection 纹理（由 PlanarReflectionPass 每帧调用）。
   * @param {THREE.Texture|null} texture
   */
  setPlanarReflectionTexture(texture) {
    const u = this.material.uniforms;
    u.tPlanarReflection.value = texture;
    u.uHasPlanarReflection.value = !!texture;
  }

  /**
   * 设置 planar reflection 投影矩阵（由 PlanarReflectionPass 每帧调用）。
   * @param {THREE.Matrix4} matrix
   */
  setPlanarReflectionMatrix(matrix) {
    const u = this.material.uniforms;
    if (matrix) u.uPlanarReflectionMatrix.value.copy(matrix);
  }

  /**
   * 设置 planar reflection 参数。
   * @param {object} partial - { strength, distortion, fresnelBoost }
   */
  setPlanarReflectionParams(partial) {
    if (!partial) return;
    const u = this.material.uniforms;
    const setClamped = (name, val, min, max) => {
      const n = Number(val);
      if (!Number.isFinite(n)) return;
      u[name].value = Math.min(max, Math.max(min, n));
    };
    if (partial.strength !== undefined) setClamped('uPlanarReflectionStrength', partial.strength, 0.0, 1.5);
    if (partial.distortion !== undefined) setClamped('uPlanarReflectionDistortion', partial.distortion, 0.0, 0.2);
    if (partial.fresnelBoost !== undefined) setClamped('uPlanarReflectionFresnelBoost', partial.fresnelBoost, 0.0, 3.0);
    if (partial.distortionScale !== undefined) setClamped('uPlanarReflectionDistortionScale', partial.distortionScale, 0.0, 2.0);
  }

  /**
   * 平面倒影法线扰动强度缩放（presentation 策略：低分辨率倒影降扰动避免被撕碎）
   * @param {number} v — 0..2，smooth≈1.0 / pixelated≈0.75
   */
  setPlanarReflectionDistortionScale(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    this.material.uniforms.uPlanarReflectionDistortionScale.value = Math.min(2.0, Math.max(0.0, n));
  }

  /**
   * @returns {object} 当前 planar reflection 参数
   */
  getPlanarReflectionParams() {
    const u = this.material.uniforms;
    return {
      enabled: u.uHasPlanarReflection.value,
      strength: u.uPlanarReflectionStrength.value,
      distortion: u.uPlanarReflectionDistortion.value,
      fresnelBoost: u.uPlanarReflectionFresnelBoost.value,
      debugMode: u.uPlanarReflectionDebugMode.value,
    };
  }

  /**
   * 设置 planar reflection debug 模式。
   * @param {number|string} mode — 0='off', 1='planar only', 2='UV grid'
   * @returns {number} 实际设置的值
   */
  setPlanarReflectionDebugMode(mode) {
    const u = this.material.uniforms;
    const num = Number(mode);
    if (Number.isFinite(num)) {
      u.uPlanarReflectionDebugMode.value = Math.min(2, Math.max(0, Math.round(num)));
    }
    return u.uPlanarReflectionDebugMode.value;
  }

  setWaterLevel(y) {
    if (this.mesh) this.mesh.position.y = y;
  }

  setVisible(visible) {
    this._visible = visible;
    if (this.mesh) this.mesh.visible = visible;
  }

  get visible() {
    return this._visible;
  }

  getUniforms() {
    return this.material.uniforms;
  }

  setProceduralWaveParams(partial = {}) {
    if (!partial || typeof partial !== 'object') return;

    const u = this.material.uniforms;
    if (Number.isFinite(partial.dragMult)) {
      u.uDragMult.value = Math.min(2.0, Math.max(0.0, partial.dragMult));
    }
    if (Number.isFinite(partial.iterationsVertex)) {
      u.uIterationsVertex.value = Math.min(8, Math.max(1, Math.round(partial.iterationsVertex)));
    }
    if (Number.isFinite(partial.waveCenter)) {
      u.uWaveCenter.value = Math.min(1.0, Math.max(0.0, partial.waveCenter));
    }
    if (Number.isFinite(partial.waveAmplitudeBoost)) {
      u.uWaveAmplitudeBoost.value = Math.min(8.0, Math.max(0.1, partial.waveAmplitudeBoost));
    }
    if (Number.isFinite(partial.iterationsNormal)) {
      u.uIterationsNormal.value = Math.min(12, Math.max(1, Math.round(partial.iterationsNormal)));
    }
    if (Number.isFinite(partial.waveNormalDistanceFade)) {
      u.uWaveNormalDistanceFade.value = Math.min(1.0, Math.max(0.0, partial.waveNormalDistanceFade));
    }
    if (Number.isFinite(partial.waveNormalBlend)) {
      u.uWaveNormalBlend.value = Math.min(2.0, Math.max(0.0, partial.waveNormalBlend));
    }
  }

  /**
   * 设置水体渲染模式（v3：mode 切换只改 uWaterMode，不重建 mesh/material，
   * 不影响其他参数与可见性）
   * @param {'cartoon'|'realistic'|'hybrid'} mode
   */
  setWaterMode(mode) {
    const index = WATER_MODE_NAMES.indexOf(mode);
    if (index === -1) {
      console.warn(`[WaterSurface] Unknown water mode "${mode}", falling back to "cartoon".`);
      this.material.uniforms.uWaterMode.value = 0;
      return;
    }
    this.material.uniforms.uWaterMode.value = index;
  }

  /**
   * @returns {'cartoon'|'realistic'|'hybrid'}
   */
  getWaterMode() {
    return WATER_MODE_NAMES[this.material.uniforms.uWaterMode.value] || 'cartoon';
  }

  getFoamWidth() {
    return this.material.uniforms.uFoamWidth.value;
  }

  setFoamWidth(value) {
    this.material.uniforms.uFoamWidth.value = value;
  }

  getWaterColor() {
    return this.material.uniforms.uWaterColor.value;
  }

  setWaterColor(color) {
    this.material.uniforms.uWaterColor.value.set(color);
  }

  dispose() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.material.dispose();
      this.mesh = null;
      this.material = null;
    }
    if (this._defaultDepthTex) {
      this._defaultDepthTex.dispose();
      this._defaultDepthTex = null;
    }
    if (this._defaultShoreDistanceTex) {
      this._defaultShoreDistanceTex.dispose();
      this._defaultShoreDistanceTex = null;
    }
    if (this._defaultNormalTex) {
      this._defaultNormalTex.dispose();
      this._defaultNormalTex = null;
    }
    if (this._defaultEnvMapTex) {
      this._defaultEnvMapTex.dispose();
      this._defaultEnvMapTex = null;
    }
    if (this._defaultHighlightNoiseTex) {
      this._defaultHighlightNoiseTex.dispose();
      this._defaultHighlightNoiseTex = null;
    }
  }

  /**
   * 导出水体所有可调参数，用于场景 JSON 保存
   * @returns {object}
   */
  /**
   * 完全不透明模式：关闭 alpha 混合并写深度，让水面变成实心遮挡体，
   * 彻底盖住水面下的物体（不再依赖 uOpacity 达到视觉不透明）。
   * @param {boolean} opaque
   */
  setOpaque(opaque) {
    this._opaque = !!opaque;
    this.material.transparent = !this._opaque;
    this.material.depthWrite = this._opaque; // 不透明时写深度，正确遮挡
    this.material.needsUpdate = true;
  }

  isOpaque() {
    return !!this._opaque;
  }

  exportState() {
    const u = this.material.uniforms;
    return {
      waterLevel: this.mesh.position.y,
      waterVisible: this._visible,
      opaque: !!this._opaque,

      // === v3: Water Mode ===
      waterMode: this.getWaterMode(),
      uWaterMode: u.uWaterMode.value,

      // === v3: Realistic Water params (lightweight placeholder) ===
      uRealisticRoughness: u.uRealisticRoughness.value,
      uRealisticFresnelStrength: u.uRealisticFresnelStrength.value,
      uRealisticFresnelPower: u.uRealisticFresnelPower.value,
      uRealisticAbsorptionStrength: u.uRealisticAbsorptionStrength.value,
      uRealisticDepthTintStrength: u.uRealisticDepthTintStrength.value,

      // === v3 Step 6: Absorption / Depth Tint ===
      absorption: {
        enabled: u.uUseWaterAbsorption.value,
        strength: u.uAbsorptionStrength.value,
        depthScale: u.uAbsorptionDepthScale.value,
        distanceScale: u.uAbsorptionDistanceScale.value,
        shallowTint: '#' + u.uShallowTint.value.getHexString(),
        deepTint: '#' + u.uDeepTint.value.getHexString(),
        tintStrength: u.uAbsorptionTintStrength.value,
        reflectionDamping: u.uAbsorptionReflectionDamping.value,
        min: u.uAbsorptionMin.value,
        max: u.uAbsorptionMax.value,
      },
      uUseWaterAbsorption: u.uUseWaterAbsorption.value,
      uAbsorptionStrength: u.uAbsorptionStrength.value,
      uAbsorptionDepthScale: u.uAbsorptionDepthScale.value,
      uAbsorptionDistanceScale: u.uAbsorptionDistanceScale.value,
      uShallowTint: '#' + u.uShallowTint.value.getHexString(),
      uDeepTint: '#' + u.uDeepTint.value.getHexString(),
      uAbsorptionTintStrength: u.uAbsorptionTintStrength.value,
      uAbsorptionReflectionDamping: u.uAbsorptionReflectionDamping.value,
      uAbsorptionMin: u.uAbsorptionMin.value,
      uAbsorptionMax: u.uAbsorptionMax.value,

      // === v3 Step 4: Realistic Fresnel / Specular highlight ===
      uRealisticFresnelBias: u.uRealisticFresnelBias.value,
      uRealisticFresnelColor: '#' + u.uRealisticFresnelColor.value.getHexString(),
      uRealisticFresnelOpacity: u.uRealisticFresnelOpacity.value,
      uRealisticSpecularStrength: u.uRealisticSpecularStrength.value,
      uRealisticSpecularPower: u.uRealisticSpecularPower.value,
      uRealisticSpecularColor: '#' + u.uRealisticSpecularColor.value.getHexString(),
      uRealisticSpecularNormalInfluence: u.uRealisticSpecularNormalInfluence.value,

      // === v3 Step 7: Artist-friendly Water Highlight ===
      highlight: this.getHighlightParams(),
      uHighlightEnabled: u.uHighlightEnabled.value,
      uHighlightIntensity: u.uHighlightIntensity.value,
      uHighlightColor: '#' + u.uHighlightColor.value.getHexString(),
      uHighlightMax: u.uHighlightMax.value,
      uHighlightThreshold: u.uHighlightThreshold.value,
      uHighlightSoftness: u.uHighlightSoftness.value,
      uHighlightFocusPower: u.uHighlightFocusPower.value,
      uHighlightCoverage: u.uHighlightCoverage.value,
      uHighlightSpecularInfluence: u.uHighlightSpecularInfluence.value,
      uHighlightFresnelInfluence: u.uHighlightFresnelInfluence.value,
      uHighlightViewInfluence: u.uHighlightViewInfluence.value,
      uHighlightSlopeInfluence: u.uHighlightSlopeInfluence.value,
      uHighlightViewMin: u.uHighlightViewMin.value,
      uHighlightViewMax: u.uHighlightViewMax.value,
      uHighlightGrazingBoost: u.uHighlightGrazingBoost.value,
      uUseHighlightNoise: u.uUseHighlightNoise.value,
      uHighlightNoiseScale: u.uHighlightNoiseScale.value,
      uHighlightNoiseSpeed: u.uHighlightNoiseSpeed.value,
      uHighlightNoiseStrength: u.uHighlightNoiseStrength.value,
      uHighlightNoisePower: u.uHighlightNoisePower.value,
      uHighlightNoiseContrast: u.uHighlightNoiseContrast.value,
      uHighlightNoiseOffset: u.uHighlightNoiseOffset.value,
      uHighlightDistanceFade: u.uHighlightDistanceFade.value,
      uHighlightFadeStart: u.uHighlightFadeStart.value,
      uHighlightFadeRange: u.uHighlightFadeRange.value,
      uHighlightRidgeBias: u.uHighlightRidgeBias.value,
      uHighlightSlopeMask: u.uHighlightSlopeMask.value,
      uHighlightBlobReduction: u.uHighlightBlobReduction.value,
      uHighlightTopDownSoftening: u.uHighlightTopDownSoftening.value,
      ridgeBias: u.uHighlightRidgeBias.value,
      slopeMask: u.uHighlightSlopeMask.value,
      blobReduction: u.uHighlightBlobReduction.value,
      topDownSoftening: u.uHighlightTopDownSoftening.value,

      // === v4 Phase 2/3: Cartoon toon enhancements ===
      uToonSparkleEnabled: u.uToonSparkleEnabled.value,
      uToonSparkleThreshold: u.uToonSparkleThreshold.value,
      uToonSparkleIntensity: u.uToonSparkleIntensity.value,
      uToonSparkleColor: '#' + u.uToonSparkleColor.value.getHexString(),
      uToonSparkleScale: u.uToonSparkleScale.value,
      uToonSparkleStretch: u.uToonSparkleStretch.value,
      uToonPatternEnabled: u.uToonPatternEnabled.value,
      uToonPatternScale: u.uToonPatternScale.value,
      uToonPatternWidth: u.uToonPatternWidth.value,
      uToonPatternIntensity: u.uToonPatternIntensity.value,
      uToonPatternTextureScale: u.uToonPatternTextureScale.value,
      uToonPatternTextureSpeed: u.uToonPatternTextureSpeed.value,
      uToonPatternTextureMix: u.uToonPatternTextureMix.value,
      uToonNormalSteps: u.uToonNormalSteps.value,
      uToonFoamHardCut: u.uToonFoamHardCut.value,
      uToonReflectionSteps: u.uToonReflectionSteps.value,
      uToonReflectionFresnelStep: u.uToonReflectionFresnelStep.value,
      uShoreTransparency: u.uShoreTransparency.value,
      uShoreEdgeAlpha: u.uShoreEdgeAlpha.value,
      uToonEnvReflection: u.uToonEnvReflection.value,

      uWaterColor: '#' + u.uWaterColor.value.getHexString(),
      uShallowColor: '#' + u.uShallowColor.value.getHexString(),
      uFoamColor: '#' + u.uFoamColor.value.getHexString(),
      uDepthColor: '#' + u.uDepthColor.value.getHexString(),
      uFoamWidth: u.uFoamWidth.value,
      uFoamThreshold: u.uFoamThreshold.value,
      uFoamOpacity: u.uFoamOpacity.value,
      uFoamSpeed: u.uFoamSpeed.value,
      uFoamPulse: u.uFoamPulse.value,
      uFoamStrength: u.uFoamStrength.value,
      uFoamNoiseStrength: u.uFoamNoiseStrength?.value ?? 0,
      uWhitecapEnabled: u.uWhitecapEnabled.value,
      uWhitecapStrength: u.uWhitecapStrength.value,
      uWhitecapThreshold: u.uWhitecapThreshold.value,
      uWhitecapSoftness: u.uWhitecapSoftness.value,
      uWhitecapNoiseScale: u.uWhitecapNoiseScale.value,
      uWhitecapBreakup: u.uWhitecapBreakup.value,
      uFoamShadowColor: '#' + u.uFoamShadowColor.value.getHexString(),
      uFoamShadowStrength: u.uFoamShadowStrength.value,
      uFoamShadowWidth: u.uFoamShadowWidth.value,
      uWaveHeight: u.uWaveHeight.value,
      uSurfaceLift: u.uSurfaceLift.value,
      uEdgeDampRange: u.uEdgeDampRange.value,
      uWaveSpeed: u.uWaveSpeed.value,
      uWaveScale: u.uWaveScale.value,
      proceduralWave: {
        dragMult: u.uDragMult.value,
        iterationsVertex: u.uIterationsVertex.value,
        waveCenter: u.uWaveCenter.value,
        waveAmplitudeBoost: u.uWaveAmplitudeBoost.value,
        iterationsNormal: u.uIterationsNormal.value,
        waveNormalBlend: u.uWaveNormalBlend.value,
        waveNormalDistanceFade: u.uWaveNormalDistanceFade.value,
      },
      directionalWaves: this.getDirectionalWaveParams(),
      flow: this.getFlowParams(),
      uUseDirectionalWaves: u.uUseDirectionalWaves.value,
      uPrimaryWaveDirection: [u.uPrimaryWaveDirection.value.x, u.uPrimaryWaveDirection.value.y],
      uSecondaryWaveDirection: [u.uSecondaryWaveDirection.value.x, u.uSecondaryWaveDirection.value.y],
      uDirectionalWaveBlend: u.uDirectionalWaveBlend.value,
      uDirectionalAnisotropy: u.uDirectionalAnisotropy.value,
      uLargeWaveStrength: u.uLargeWaveStrength.value,
      uLargeWaveScale: u.uLargeWaveScale.value,
      uLargeWaveSpeed: u.uLargeWaveSpeed.value,
      uLargeWaveStretch: u.uLargeWaveStretch.value,
      uSecondaryWaveStrength: u.uSecondaryWaveStrength.value,
      uSecondaryWaveScale: u.uSecondaryWaveScale.value,
      uSecondaryWaveSpeed: u.uSecondaryWaveSpeed.value,
      uMidWaveStrength: u.uMidWaveStrength.value,
      uMidWaveScale: u.uMidWaveScale.value,
      uMidWaveSpeed: u.uMidWaveSpeed.value,
      uDetailWaveStrength: u.uDetailWaveStrength.value,
      uDetailWaveScale: u.uDetailWaveScale.value,
      uDetailWaveSpeed: u.uDetailWaveSpeed.value,
      uWaveRidgeSharpness: u.uWaveRidgeSharpness.value,
      uWaveCrestStretch: u.uWaveCrestStretch.value,
      uWaveCrossDamping: u.uWaveCrossDamping.value,
      uWaveSpacingVariation: u.uWaveSpacingVariation.value,
      uWaveSpacingScale: u.uWaveSpacingScale.value,
      uFlowEnabled: u.uFlowEnabled.value,
      uFlowDirection: [u.uFlowDirection.value.x, u.uFlowDirection.value.y],
      uFlowDirectionX: u.uFlowDirection.value.x,
      uFlowDirectionY: u.uFlowDirection.value.y,
      uFlowSpeed: u.uFlowSpeed.value,
      uDragMult: u.uDragMult.value,
      uIterationsVertex: u.uIterationsVertex.value,
      uWaveCenter: u.uWaveCenter.value,
      uWaveAmplitudeBoost: u.uWaveAmplitudeBoost.value,
      uIterationsNormal: u.uIterationsNormal.value,
      uWaveNormalBlend: u.uWaveNormalBlend.value,
      uWaveNormalDistanceFade: u.uWaveNormalDistanceFade.value,
      uFresnelPower: u.uFresnelPower.value,
      uFresnelStrength: u.uFresnelStrength.value,
      uDepthStrength: u.uDepthStrength.value,
      uOpacity: u.uOpacity.value,
      uUseCartoonBands: u.uUseCartoonBands.value,
      uBandHardness: u.uBandHardness.value,
      uContactFoamEnabled: u.uContactFoamEnabled.value,
      uContactFoamStrength: u.uContactFoamStrength.value,
      uContactFoamStart: u.uContactFoamStart.value,
      uContactFoamEnd: u.uContactFoamEnd.value,
      uContactFoamWidth: u.uContactFoamWidth.value,
      uContactFoamNoiseScale: u.uContactFoamNoiseScale.value,
      uContactFoamBreakup: u.uContactFoamBreakup.value,
      uContactFoamPulse: u.uContactFoamPulse.value,
      rippleDecal: this.getRippleDecalParams(),

      // v2: ShoreDistance / Local Water Body（仅导出参数，不导出 mask/纹理本身）
      uUseShoreDistance: u.uUseShoreDistance.value,
      uInvertShoreDistance: u.uInvertShoreDistance.value,
      uShoreDistanceScale: u.uShoreDistanceScale.value,
      uShoreFoamStrength: u.uShoreFoamStrength.value,
      uShoreFoamWidth: u.uShoreFoamWidth.value,
      uShoreWaveEnabled: u.uShoreWaveEnabled.value,
      uShoreWaveStrength: u.uShoreWaveStrength.value,
      uShoreWaveRange: u.uShoreWaveRange.value,
      uShoreWaveFrequency: u.uShoreWaveFrequency.value,
      uShoreWaveSpeed: u.uShoreWaveSpeed.value,
      uShoreWaveWidth: u.uShoreWaveWidth.value,
      uShoreWaveNoiseScale: u.uShoreWaveNoiseScale.value,
      uShoreWaveNoiseStrength: u.uShoreWaveNoiseStrength.value,
      uShoreWaveBreakup: u.uShoreWaveBreakup.value,
      uShoreWaveCrestHeight: u.uShoreWaveCrestHeight.value,
      uShoreClipThreshold: u.uShoreClipThreshold.value,
      // v4 scene-shore: world-space region (mask texture itself is not persisted, same as upload path)
      uShoreWorldSpace: u.uShoreWorldSpace.value,
      uShoreWorldCenter: [u.uShoreWorldCenter.value.x, u.uShoreWorldCenter.value.y],
      uShoreWorldSize: u.uShoreWorldSize.value,

      // === v3 Step 3: Dual Normal Maps（Realistic/Hybrid 表面细节法线，不含贴图本身）===
      waterNormals: {
        enabled: u.uUseWaterNormalMaps.value,
        strength: u.uWaterNormalStrength.value,
        scaleA: u.uWaterNormalScaleA.value,
        scaleB: u.uWaterNormalScaleB.value,
        speedA: u.uWaterNormalSpeedA.value,
        speedB: u.uWaterNormalSpeedB.value,
        directionA: [u.uWaterNormalDirectionA.value.x, u.uWaterNormalDirectionA.value.y],
        directionB: [u.uWaterNormalDirectionB.value.x, u.uWaterNormalDirectionB.value.y],
        mix: u.uWaterNormalMix.value,
      },
      // 以下扁平字段供 Water Normals UI 控件的 data-water-param 同步机制使用
      uUseWaterNormalMaps: u.uUseWaterNormalMaps.value,
      uWaterNormalStrength: u.uWaterNormalStrength.value,
      uWaterNormalScaleA: u.uWaterNormalScaleA.value,
      uWaterNormalScaleB: u.uWaterNormalScaleB.value,
      uWaterNormalSpeedA: u.uWaterNormalSpeedA.value,
      uWaterNormalSpeedB: u.uWaterNormalSpeedB.value,
      uWaterNormalMix: u.uWaterNormalMix.value,
      uWaterNormalDirectionAX: u.uWaterNormalDirectionA.value.x,
      uWaterNormalDirectionAY: u.uWaterNormalDirectionA.value.y,
      uWaterNormalDirectionBX: u.uWaterNormalDirectionB.value.x,
      uWaterNormalDirectionBY: u.uWaterNormalDirectionB.value.y,

      // === v3 Step 5: Environment Reflection（Realistic/Hybrid 环境反射，不含贴图本身）===
      reflection: {
        enabled: u.uUseWaterEnvReflection.value,
        strength: u.uWaterReflectionStrength.value,
        fresnelInfluence: u.uWaterReflectionFresnelInfluence.value,
        tint: '#' + u.uWaterReflectionTint.value.getHexString(),
        roughness: u.uWaterReflectionRoughness.value,
        normalInfluence: u.uWaterReflectionNormalInfluence.value,
        exposure: u.uWaterReflectionExposure.value,
        useSceneEnvironment: !!this._useSceneEnvironment,
      },
      // 以下扁平字段供 Environment Reflection UI 控件的 data-water-param 同步机制使用
      uUseWaterEnvReflection: u.uUseWaterEnvReflection.value,
      uWaterReflectionStrength: u.uWaterReflectionStrength.value,
      uWaterReflectionFresnelInfluence: u.uWaterReflectionFresnelInfluence.value,
      uWaterReflectionTint: '#' + u.uWaterReflectionTint.value.getHexString(),
      uWaterReflectionRoughness: u.uWaterReflectionRoughness.value,
      uWaterReflectionNormalInfluence: u.uWaterReflectionNormalInfluence.value,
      uWaterReflectionExposure: u.uWaterReflectionExposure.value,
      useSceneEnvironment: !!this._useSceneEnvironment,

      // === v3 Step 8: Planar Reflection（建筑/物体水面倒影）===
      planarReflection: {
        enabled: u.uHasPlanarReflection.value,
        strength: u.uPlanarReflectionStrength.value,
        distortion: u.uPlanarReflectionDistortion.value,
        distortionScale: u.uPlanarReflectionDistortionScale.value,
        fresnelBoost: u.uPlanarReflectionFresnelBoost.value,
        debugMode: u.uPlanarReflectionDebugMode.value,
      },
      // 扁平字段供 Planar Reflection UI 的 data-water-param 同步机制使用
      uPlanarReflectionStrength: u.uPlanarReflectionStrength.value,
      uPlanarReflectionDistortion: u.uPlanarReflectionDistortion.value,
      uPlanarReflectionFresnelBoost: u.uPlanarReflectionFresnelBoost.value,
      uPlanarReflectionDebugMode: u.uPlanarReflectionDebugMode.value,
    };
  }

  /**
   * 从场景 JSON 恢复水体参数
   * @param {object} state
   */
  importState(state) {
    if (!state) return;
    const u = this.material.uniforms;

    if (state.waterLevel !== undefined) {
      this.mesh.position.y = state.waterLevel;
    } else if (state.uWaterLevel !== undefined && state.uWaterLevel !== null) {
      // 兼容旧数据：早期版本只导出了 uWaterLevel，作为 mesh.position.y 的回退来源
      this.mesh.position.y = Number(state.uWaterLevel);
    }
    if (state.waterVisible !== undefined) this.setVisible(state.waterVisible);
    if (state.opaque !== undefined) this.setOpaque(state.opaque);

    // === v3: Water Mode ===
    if (state.waterMode !== undefined && state.waterMode !== null) {
      this.setWaterMode(String(state.waterMode));
    } else if (state.uWaterMode !== undefined && state.uWaterMode !== null) {
      u.uWaterMode.value = Number(state.uWaterMode);
    }

    // 颜色字段：仅接受合法 #rrggbb/#rgb 字符串，避免 THREE.Color "Unknown color" 控制台警告
    const hexColorRe = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    for (const f of ['uWaterColor', 'uShallowColor', 'uFoamColor', 'uDepthColor', 'uRealisticFresnelColor', 'uRealisticSpecularColor', 'uHighlightColor', 'uToonSparkleColor', 'uFoamShadowColor']) {
      if (typeof state[f] === 'string' && hexColorRe.test(state[f])) {
        u[f].value.set(state[f]);
      }
    }

    // float 字段：类型检查，避免 undefined/null 覆盖默认值
    const floatFields = [
      'uFoamWidth', 'uFoamThreshold', 'uFoamOpacity', 'uFoamSpeed', 'uFoamPulse',
      'uFoamStrength', 'uFoamNoiseStrength', 'uWhitecapStrength', 'uWhitecapThreshold',
      'uWhitecapSoftness', 'uWhitecapNoiseScale', 'uWhitecapBreakup',
      'uFoamShadowStrength', 'uFoamShadowWidth', 'uWaveHeight',
      'uSurfaceLift',
      'uEdgeDampRange',
      'uWaveSpeed', 'uWaveScale', 'uFresnelPower', 'uFresnelStrength',
      'uDepthStrength', 'uOpacity',
      'uBandHardness',
      // v3: Realistic Water (lightweight placeholder)
      'uRealisticRoughness', 'uRealisticFresnelStrength', 'uRealisticFresnelPower',
      'uRealisticAbsorptionStrength', 'uRealisticDepthTintStrength',
      // v3 Step 4: Realistic Fresnel / Specular highlight
      'uRealisticFresnelBias', 'uRealisticFresnelOpacity',
      'uRealisticSpecularStrength', 'uRealisticSpecularPower', 'uRealisticSpecularNormalInfluence',
      // v3 Step 7: Artist-friendly Water Highlight
      'uContactFoamStrength', 'uContactFoamStart', 'uContactFoamEnd', 'uContactFoamWidth',
      'uContactFoamNoiseScale', 'uContactFoamBreakup', 'uContactFoamPulse',
      // v2: ShoreDistance / Local Water Body
      'uShoreDistanceScale', 'uShoreFoamStrength', 'uShoreFoamWidth',
      'uShoreWaveStrength', 'uShoreWaveRange', 'uShoreWaveFrequency', 'uShoreWaveSpeed',
      'uShoreWaveWidth', 'uShoreWaveNoiseScale', 'uShoreWaveNoiseStrength', 'uShoreWaveBreakup',
      'uShoreWaveCrestHeight',
      'uShoreClipThreshold', 'uShoreWorldSize',
      // v4 Phase 2/3: Cartoon toon enhancements
      'uToonSparkleThreshold', 'uToonSparkleIntensity', 'uToonSparkleScale', 'uToonSparkleStretch',
      'uToonPatternScale', 'uToonPatternWidth', 'uToonPatternIntensity',
      'uToonPatternTextureScale', 'uToonPatternTextureSpeed', 'uToonPatternTextureMix', 'uToonNormalSteps',
      'uToonReflectionSteps', 'uToonReflectionFresnelStep',
      // v2 model-water: shore transparency + cartoon env reflection
      'uShoreTransparency', 'uShoreEdgeAlpha', 'uToonEnvReflection',
      // v4 Phase 6: Dynamic water flow
      'uFlowSpeed',
    ];
    for (const f of floatFields) {
      if (state[f] !== undefined && state[f] !== null && u[f]) {
        const n = Number(state[f]);
        if (Number.isFinite(n)) u[f].value = n;
      }
    }

    if (state.proceduralWave && typeof state.proceduralWave === 'object') {
      this.setProceduralWaveParams(state.proceduralWave);
    } else {
      this.setProceduralWaveParams({
        dragMult: state.uDragMult,
        iterationsVertex: state.uIterationsVertex,
        waveCenter: state.uWaveCenter,
        waveAmplitudeBoost: state.uWaveAmplitudeBoost,
        iterationsNormal: state.uIterationsNormal,
        waveNormalBlend: state.uWaveNormalBlend,
        waveNormalDistanceFade: state.uWaveNormalDistanceFade,
      });
    }

    if (state.directionalWaves && typeof state.directionalWaves === 'object') {
      this.setDirectionalWaveParams(state.directionalWaves);
    } else {
      this.setDirectionalWaveParams({
        enabled: state.uUseDirectionalWaves,
        primaryDirection: state.uPrimaryWaveDirection,
        secondaryDirection: state.uSecondaryWaveDirection,
        directionalBlend: state.uDirectionalWaveBlend,
        anisotropy: state.uDirectionalAnisotropy,
        largeStrength: state.uLargeWaveStrength,
        largeScale: state.uLargeWaveScale,
        largeSpeed: state.uLargeWaveSpeed,
        largeStretch: state.uLargeWaveStretch,
        secondaryStrength: state.uSecondaryWaveStrength,
        secondaryScale: state.uSecondaryWaveScale,
        secondarySpeed: state.uSecondaryWaveSpeed,
        midStrength: state.uMidWaveStrength,
        midScale: state.uMidWaveScale,
        midSpeed: state.uMidWaveSpeed,
        detailStrength: state.uDetailWaveStrength,
        detailScale: state.uDetailWaveScale,
        detailSpeed: state.uDetailWaveSpeed,
        ridgeSharpness: state.uWaveRidgeSharpness,
        crestStretch: state.uWaveCrestStretch,
        crossDamping: state.uWaveCrossDamping,
        spacingVariation: state.uWaveSpacingVariation,
        spacingScale: state.uWaveSpacingScale,
      });
    }

    // bool 字段
    if (state.flow && typeof state.flow === 'object') {
      this.setFlowParams(state.flow);
    } else {
      this.setFlowParams({
        enabled: state.uFlowEnabled,
        direction: state.uFlowDirection,
        directionX: state.uFlowDirectionX,
        directionY: state.uFlowDirectionY,
        speed: state.uFlowSpeed,
      });
    }

    if (state.rippleDecal && typeof state.rippleDecal === 'object') {
      this.setRippleDecalParams(state.rippleDecal);
    }

    if (state.absorption && typeof state.absorption === 'object') {
      this.setWaterAbsorptionParams(state.absorption);
    } else {
      this.setWaterAbsorptionParams({
        enabled: state.uUseWaterAbsorption,
        strength: state.uAbsorptionStrength,
        depthScale: state.uAbsorptionDepthScale,
        distanceScale: state.uAbsorptionDistanceScale,
        shallowTint: state.uShallowTint,
        deepTint: state.uDeepTint,
        tintStrength: state.uAbsorptionTintStrength,
        reflectionDamping: state.uAbsorptionReflectionDamping,
        min: state.uAbsorptionMin,
        max: state.uAbsorptionMax,
      });
    }

    if (state.highlight && typeof state.highlight === 'object') {
      this.setHighlightParams(state.highlight);
    } else {
      this.setHighlightParams({
        enabled: state.uHighlightEnabled,
        intensity: state.uHighlightIntensity,
        color: state.uHighlightColor,
        max: state.uHighlightMax,
        threshold: state.uHighlightThreshold,
        softness: state.uHighlightSoftness,
        focusPower: state.uHighlightFocusPower,
        coverage: state.uHighlightCoverage,
        specularInfluence: state.uHighlightSpecularInfluence,
        fresnelInfluence: state.uHighlightFresnelInfluence,
        viewInfluence: state.uHighlightViewInfluence,
        slopeInfluence: state.uHighlightSlopeInfluence,
        viewMin: state.uHighlightViewMin,
        viewMax: state.uHighlightViewMax,
        grazingBoost: state.uHighlightGrazingBoost,
        useNoise: state.uUseHighlightNoise,
        noiseScale: state.uHighlightNoiseScale,
        noiseSpeed: state.uHighlightNoiseSpeed,
        noiseStrength: state.uHighlightNoiseStrength,
        noisePower: state.uHighlightNoisePower,
        noiseContrast: state.uHighlightNoiseContrast,
        noiseOffset: state.uHighlightNoiseOffset,
        distanceFade: state.uHighlightDistanceFade,
        fadeStart: state.uHighlightFadeStart,
        fadeRange: state.uHighlightFadeRange,
        ridgeBias: state.uHighlightRidgeBias,
        slopeMask: state.uHighlightSlopeMask,
        blobReduction: state.uHighlightBlobReduction,
        topDownSoftening: state.uHighlightTopDownSoftening,
      });
    }

    const boolFields = [
      'uUseCartoonBands', 'uContactFoamEnabled', 'uWhitecapEnabled',
      'uInvertShoreDistance', 'uShoreWaveEnabled', 'uHighlightEnabled', 'uUseDirectionalWaves',
      'uFlowEnabled',
      // v4 Phase 2/3: Cartoon toon enhancements
      'uToonSparkleEnabled', 'uToonFoamHardCut', 'uToonPatternEnabled',
      // v4 scene-shore
      'uShoreWorldSpace',
    ];
    for (const f of boolFields) {
      if (state[f] !== undefined && state[f] !== null && u[f]) {
        u[f].value = Boolean(state[f]);
      }
    }
    // v4 scene-shore: world region center (vec2). Mask texture isn't persisted, so this only
    // takes effect if a shore texture is (re)generated after load; harmless otherwise.
    if (Array.isArray(state.uShoreWorldCenter) && state.uShoreWorldCenter.length === 2) {
      const cx = Number(state.uShoreWorldCenter[0]);
      const cz = Number(state.uShoreWorldCenter[1]);
      if (Number.isFinite(cx) && Number.isFinite(cz)) u.uShoreWorldCenter.value.set(cx, cz);
    }

    // uUseShoreDistance：单独处理 —— 旧场景没有 mask 纹理时不能让 shader 误以为有真实数据，
    // 若 state 要求开启但当前没有真实 shoreDistance 纹理，自动降级为 false 并提示一次。
    if (state.uUseShoreDistance !== undefined && state.uUseShoreDistance !== null) {
      const wantShoreDistance = Boolean(state.uUseShoreDistance);
      const hasTexture = !!u.tShoreDistance.value && u.tShoreDistance.value !== this._defaultShoreDistanceTex;
      if (wantShoreDistance && !hasTexture) {
        console.warn('[WaterSurface] uUseShoreDistance=true but no shoreDistance texture is loaded; falling back to false.');
        u.uUseShoreDistance.value = false;
      } else {
        u.uUseShoreDistance.value = wantShoreDistance;
      }
    }

    // === v3 Step 3: Dual Normal Maps ===
    // 旧场景没有 waterNormals 字段时不做任何处理，保持默认值；
    // 数值非法（非 number/NaN）或方向数组不完整时，setWaterNormalParams 内部会跳过该字段，
    // 自动回退到当前默认值（构造时已设为 §4.1 默认值）。
    if (state.waterNormals && typeof state.waterNormals === 'object') {
      const wn = state.waterNormals;
      const dirA = Array.isArray(wn.directionA) ? wn.directionA : [];
      const dirB = Array.isArray(wn.directionB) ? wn.directionB : [];
      this.setWaterNormalParams({
        enabled: wn.enabled,
        strength: wn.strength,
        scaleA: wn.scaleA,
        scaleB: wn.scaleB,
        speedA: wn.speedA,
        speedB: wn.speedB,
        mix: wn.mix,
        directionAX: dirA[0],
        directionAY: dirA[1],
        directionBX: dirB[0],
        directionBY: dirB[1],
      });
    }

    // === v3 Step 5: Environment Reflection ===
    // 旧场景没有 reflection 字段时不做任何处理，保持默认值（构造时已设为默认值）。
    // useSceneEnvironment=true 且当前 scene.environment 存在时，自动将其同步为 envMap；
    // scene.environment 尚未加载（如 HDRI 异步加载中）时跳过，保留兜底贴图，不报错。
    if (state.reflection && typeof state.reflection === 'object') {
      const refl = state.reflection;
      this.setWaterReflectionParams({
        enabled: refl.enabled,
        strength: refl.strength,
        fresnelInfluence: refl.fresnelInfluence,
        tint: refl.tint,
        roughness: refl.roughness,
        normalInfluence: refl.normalInfluence,
        exposure: refl.exposure,
        useSceneEnvironment: refl.useSceneEnvironment,
      });
      if (refl.useSceneEnvironment && this.scene && this.scene.environment) {
        this.setWaterEnvMap(this.scene.environment);
      }
    }

    // === v3 Step 8: Planar Reflection ===
    if (state.planarReflection && typeof state.planarReflection === 'object') {
      this.setPlanarReflectionParams(state.planarReflection);
      if (state.planarReflection.debugMode !== undefined) {
        this.setPlanarReflectionDebugMode(state.planarReflection.debugMode);
      }
    }
  }
}

export {
  WATER_VERTEX_SHADER,
  WATER_FRAGMENT_SHADER,
  WATER_DEPTH_UTILS_GLSL as DEPTH_UTILS_GLSL,
};
