/**
 * InkEdgePass.js — 屏幕空间水墨描边后处理 Pass（Sobel 边缘检测 + 渗墨方向性模糊
 *                    + 噪声调制浓淡断续 + 曲率调制描边宽度）
 *
 * 功能：
 * 1. 复用 EdgeMaskPass 的深度/法线边缘（稳定 1px 检测）
 * 2. 检测后独立扩张线宽，不再放大 Sobel 采样步长
 * 3. 共享边缘 → 宽度扩张 + 强度调制
 * 4. 沿深度梯度方向做渗墨模糊（方向性各向异性采样）→ 模拟墨水沿边缘向外晕开
 * 5. 墨色叠加到场景颜色上
 * 6. 【增强A】噪声调制：屏幕空间程序化噪声 × 描边强度 → 浓淡断续感
 * 7. 【增强B】曲率调制：法线 Sobel 近似曲率 → 动态描边宽度（转折处粗，平面处细）
 * 8. 【增强C】飞白效果：屏幕空间噪声阈值化 → 乘法 mask 造成描边真实断裂
 *
 * 依赖：
 *   - tDiffuse（上游 Pass 场景颜色）
 *   - tNormal（法线预渲染目标 — MeshNormalMaterial 输出）
 *   - tDepth（深度纹理 — renderTarget.depthTexture，非线性深度缓冲）
 *
 * 方案选择说明：
 *   - 法线获取：复用现有法线预渲染 Pass（方案A — 额外渲染 pass），不使用 dFdx/dFdy 从深度重建。
 *     理由：项目已有的 SSAO/Curvature 法线预渲染可直接复用，零额外成本；且低多边形场景下
 *     MeshNormalMaterial 输出的视图空间法线精度远优于屏幕空间偏导重建。
 *   - 边缘检测算法：Sobel（3×3 核）。Roberts Cross（2×2）对噪点敏感且无方向信息，
 *     不适合后续渗墨方向计算。Sobel 的 3×3 核更平滑，且同时输出梯度方向（gx, gy）。
 *   - 深度纹理获取：向现有 normalRenderTarget 附加 `depthTexture: new THREE.DepthTexture()`，
 *     一次渲染同时产出法线（color buffer）和深度（depth buffer → depthTexture）。不需要额外渲染。
 *
 * 性能设计：
 *   - 默认渗墨采样数 8，通过 uBleedSamples 控制（映射自 uQuality: 低=4, 中=8, 高=12）
 *   - Sobel 9 次深度采样固定（GPU 友好）
 *   - 法线边缘仅在 uQuality ≥ 1 时启用
 *   - 无几何体区域（深度=1.0）跳过边缘检测
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { EDGE_MASK_EXPANSION_GLSL } from '../shaders/EdgeMaskExpansion.js';

/**
 * InkEdge 着色器定义
 *
 * uniforms 说明：
 *   tDiffuse           — 上游 Pass 输出的场景颜色纹理
 *   tNormal            — 法线纹理（视图空间法线，编码为 RGB = normal * 0.5 + 0.5）
 *   tDepth             — 深度纹理（非线性深度缓冲，值域 [0, 1]）
 *   uCameraNear        — 相机近平面距离
 *   uCameraFar         — 相机远平面距离
 *   uEdgeStrength      — 描边整体强度，0=无描边
 *   uEdgeThreshold     — 边缘检测阈值，低于此值不算边缘（控制线条稀疏程度）
 *   uEdgeWidth         — 描边扩张宽度（像素），不影响边缘检测
 *   uInkColor          — 墨色 RGB
 *   uBlurRadius        — 渗墨模糊半径（像素），控制墨水晕开距离
 *   uBleedFalloff      — 渗墨末端淡出速度（指数衰减系数，越大淡出越快）
 *   uResolution        — 渲染分辨率（用于计算像素步长）
 *   uQuality           — 质量等级：0=低，1=中，2=高
 *   ── 增强A：噪声调制 ──
 *   uNoiseEnabled      — 噪声调制总开关
 *   uNoiseScale        — 噪声空间频率（屏幕空间，越大颗粒越细）
 *   uNoiseStrength     — 噪声调制强度，0=无调制，1=完全由噪声决定浓淡
 *   uNoiseContrast     — 噪声对比度，提高后浓淡差异更明显
 *   uNoiseAnimSpeed    — 噪声时间变化速度，0=静态（推荐）
 *   ── 增强B：曲率调制 ──
 *   uCurvatureEnabled  — 曲率调制总开关
 *   uCurvatureScale    — 曲率影响系数，越高尖角处描边越粗
 *   uCurvatureMin      — 最小宽度系数（平直处下限）
 *   uCurvatureMax      — 最大宽度系数（尖角处上限）
 *   ── 增强C：飞白效果 ──
 *   uFlyWhiteEnabled     — 飞白总开关（true=描边出现断裂）
 *   uFlyWhiteCutoff      — 噪声裁剪阈值，越高断裂越多（推荐 0.4-0.7）
 *   uFlyWhiteFeather     — 断裂边缘羽化宽度（推荐 0.02-0.15）
 *   uFlyWhiteNoiseScale  — 屏幕空间噪声平铺密度（与 uNoiseScale 独立）
 *   uTime              — 时间（秒），驱动噪声动画
 */
const InkEdgeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    tEdgeMask: { value: null },
    uCameraNear: { value: 0.1 },
    uCameraFar: { value: 1000.0 },
    uProjectionMatrixInverse: { value: new THREE.Matrix4() },
    uCameraMatrixWorld: { value: new THREE.Matrix4() },
    uEdgeStrength: { value: 1.0 },
    uEdgeThreshold: { value: 0.1 },
    uEdgeWidth: { value: 1.5 },
    uInkColor: { value: new THREE.Vector3(0.04, 0.04, 0.08) },
    uBlurRadius: { value: 3.0 },
    uBleedFalloff: { value: 2.0 },
    uResolution: { value: new THREE.Vector2(1920, 1080) },
    uQuality: { value: 1.0 },
    // ── 噪声调制（增强A）──
    uNoiseEnabled: { value: true },
    uNoiseScale: { value: 4.0 },
    uNoiseStrength: { value: 0.6 },
    uNoiseContrast: { value: 1.5 },
    uNoiseAnimSpeed: { value: 0.0 },
    uStrokeVariation: { value: 0.0 },
    uStrokeScale: { value: 3.0 },
    uStrokePunch: { value: 0.5 },
    uEchoCount: { value: 0.0 },
    uEchoSpacing: { value: 2.5 },
    uEchoDirection: { value: new THREE.Vector2(1.0, 0.0) },
    uEchoStrength: { value: 0.55 },
    uEchoColor: { value: new THREE.Vector3(0.84, 0.27, 0.38) },
    // ── 曲率调制描边宽度（增强B）──
    uCurvatureEnabled: { value: true },
    uCurvatureScale: { value: 2.0 },
    uCurvatureMin: { value: 0.5 },
    uCurvatureMax: { value: 2.5 },
    // ── 飞白效果（乘法mask断裂）──
    uFlyWhiteEnabled: { value: false },
    uFlyWhiteCutoff: { value: 0.55 },
    uFlyWhiteFeather: { value: 0.08 },
    uFlyWhiteNoiseScale: { value: 5.0 },
    // ── 时间（噪声动画驱动）──
    uTime: { value: 0.0 },
    // ── 远景深度衰减（强度）──
    uDepthFadeEnabled: { value: true },
    uDepthFadeStart: { value: 18.0 },
    uDepthFadeEnd: { value: 45.0 },
    uMinEdgeStrength: { value: 0.0 },
    // ── 远景线宽衰减 ──
    uWidthDepthFadeEnabled: { value: true },
    uMinEdgeWidth: { value: 0.35 },
    uMaxEdgeWidth: { value: 1.5 },
    uWidthFadeStart: { value: 12.0 },
    uWidthFadeEnd: { value: 35.0 },
    // ── 远景 LOD 整体淡出 ──
    uLodFadeEnabled: { value: true },
    uLodFadeStart: { value: 35.0 },
    uLodFadeEnd: { value: 60.0 },
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
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform sampler2D tEdgeMask;
    uniform float uCameraNear;
    uniform float uCameraFar;
    uniform mat4 uProjectionMatrixInverse;
    uniform mat4 uCameraMatrixWorld;
    uniform float uEdgeStrength;
    uniform float uEdgeThreshold;
    uniform float uEdgeWidth;
    uniform vec3 uInkColor;
    uniform float uBlurRadius;
    uniform float uBleedFalloff;
    uniform vec2 uResolution;
    uniform float uQuality;
    uniform bool uNoiseEnabled;
    uniform float uNoiseScale;
    uniform float uNoiseStrength;
    uniform float uNoiseContrast;
    uniform float uNoiseAnimSpeed;
    uniform float uStrokeVariation;
    uniform float uStrokeScale;
    uniform float uStrokePunch;
    uniform float uEchoCount;
    uniform float uEchoSpacing;
    uniform vec2 uEchoDirection;
    uniform float uEchoStrength;
    uniform vec3 uEchoColor;
    uniform bool uCurvatureEnabled;
    uniform float uCurvatureScale;
    uniform float uCurvatureMin;
    uniform float uCurvatureMax;
    uniform bool uFlyWhiteEnabled;
    uniform float uFlyWhiteCutoff;
    uniform float uFlyWhiteFeather;
    uniform float uFlyWhiteNoiseScale;
    uniform float uTime;
    uniform bool uDepthFadeEnabled;
    uniform float uDepthFadeStart;
    uniform float uDepthFadeEnd;
    uniform float uMinEdgeStrength;
    uniform bool uWidthDepthFadeEnabled;
    uniform float uMinEdgeWidth;
    uniform float uMaxEdgeWidth;
    uniform float uWidthFadeStart;
    uniform float uWidthFadeEnd;
    uniform bool uLodFadeEnabled;
    uniform float uLodFadeStart;
    uniform float uLodFadeEnd;

    varying vec2 vUv;

    ${EDGE_MASK_EXPANSION_GLSL}

    // ============================================================
    // 工具函数
    // ============================================================

    // ── 程序化噪声（增强A：复用 ProceduralSky 的 hash+noise 方案）──
    float inkHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    // 2D 值噪声：4 点双线性插值 + Hermite smoothstep
    float inkNoise2D(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);

      float a = inkHash(i);
      float b = inkHash(i + vec2(1.0, 0.0));
      float c = inkHash(i + vec2(0.0, 1.0));
      float d = inkHash(i + vec2(1.0, 1.0));

      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    vec3 reconstructWorldPosition(vec2 uv, float depthSample) {
      vec4 clipPosition = vec4(uv * 2.0 - 1.0, depthSample * 2.0 - 1.0, 1.0);
      vec4 viewPosition = uProjectionMatrixInverse * clipPosition;
      viewPosition /= max(abs(viewPosition.w), 0.00001);
      return (uCameraMatrixWorld * viewPosition).xyz;
    }

    float sampleEchoEdge(vec2 uv, float strokeWidth) {
      vec2 texel = 1.0 / max(uResolution, vec2(1.0));
      float edge = texture2D(tEdgeMask, uv).r;
      float ringWeight = clamp(strokeWidth - 0.5, 0.0, 1.0);
      edge = max(edge, edgeMaskRing(tEdgeMask, uv, texel, 1.0) * ringWeight);
      return edge;
    }

    // Shared edge-mask gradient gives the local stroke tangent. Quantizing only
    // the texture frame (not the geometry) prevents tiny normal/depth changes
    // from making the brush pattern flicker between adjacent pixels.
    vec2 edgeStrokeTangent(vec2 uv, vec2 texel, vec2 fallbackGradient) {
      float left = max(
        texture2D(tEdgeMask, uv - vec2(texel.x, 0.0)).r,
        texture2D(tEdgeMask, uv - vec2(texel.x * 2.0, 0.0)).r
      );
      float right = max(
        texture2D(tEdgeMask, uv + vec2(texel.x, 0.0)).r,
        texture2D(tEdgeMask, uv + vec2(texel.x * 2.0, 0.0)).r
      );
      float bottom = max(
        texture2D(tEdgeMask, uv - vec2(0.0, texel.y)).r,
        texture2D(tEdgeMask, uv - vec2(0.0, texel.y * 2.0)).r
      );
      float top = max(
        texture2D(tEdgeMask, uv + vec2(0.0, texel.y)).r,
        texture2D(tEdgeMask, uv + vec2(0.0, texel.y * 2.0)).r
      );
      vec2 gradient = vec2(right - left, top - bottom);
      if (length(gradient) < 0.001) gradient = fallbackGradient;
      if (length(gradient) < 0.001) return vec2(1.0, 0.0);

      vec2 tangent = normalize(vec2(-gradient.y, gradient.x));
      if (tangent.x < 0.0 || (abs(tangent.x) < 0.0001 && tangent.y < 0.0)) {
        tangent = -tangent;
      }
      float quantum = 3.14159265 / 16.0;
      float angle = floor(atan(tangent.y, tangent.x) / quantum + 0.5) * quantum;
      return vec2(cos(angle), sin(angle));
    }

    vec3 canonicalWorldDirection(vec3 direction) {
      float directionLength = length(direction);
      if (directionLength < 0.00001) return vec3(1.0, 0.0, 0.0);
      direction /= directionLength;
      vec3 axisWeight = abs(direction);
      float dominant = axisWeight.x >= max(axisWeight.y, axisWeight.z)
        ? direction.x
        : (axisWeight.y >= axisWeight.z ? direction.y : direction.z);
      return dominant < 0.0 ? -direction : direction;
    }

    vec2 worldAnchoredStrokeDomain(
      vec3 worldPosition,
      vec3 tangentWorld,
      vec3 acrossWorld,
      float scale
    ) {
      float safeScale = max(scale, 0.01);
      return vec2(
        dot(worldPosition, tangentWorld) * safeScale * 0.42,
        dot(worldPosition, acrossWorld) * safeScale * 0.07
      );
    }

    // Dry-brush fibers are long in the local stroke direction and anchored to
    // reconstructed world position, so the breakup does not slide with camera
    // movement or stay horizontally aligned on every contour.
    float flyWhiteNoiseWorld(
      vec3 worldPosition,
      vec3 tangentWorld,
      vec3 acrossWorld
    ) {
      vec2 domain = worldAnchoredStrokeDomain(
        worldPosition,
        tangentWorld,
        acrossWorld,
        uFlyWhiteNoiseScale
      );
      vec2 fiberDomain = vec2(domain.x * 0.18, domain.y * 1.15);
      float longSegment = inkNoise2D(vec2(domain.x * 0.085, domain.y * 0.025) + 31.7);
      float fiber = inkNoise2D(fiberDomain + vec2(13.7, 59.3));
      return clamp(mix(longSegment, fiber, 0.1), 0.0, 1.0);
    }

    // ── 深度工具函数 ──

    // 非线性深度缓冲 → 视图空间线性深度（世界单位）
    // 标准透视投影逆推公式：
    //   depth = (far + near) / (far - near) + (1 / z_view) * (-2 * far * near) / (far - near)
    //   → z_view = (2 * near * far) / (far + near - depth * (far - near))
    // 返回值范围 [near, far]
    float linearizeDepth(float depthSample) {
      float depth = depthSample;
      // 处理深度纹理可能精度不足的情况
      if (depth >= 0.9999) return uCameraFar;
      return (2.0 * uCameraNear * uCameraFar) /
             (uCameraFar + uCameraNear - depth * (uCameraFar - uCameraNear));
    }

    // 读取并线性化深度
    float readLinearDepth(vec2 uv) {
      return linearizeDepth(texture2D(tDepth, uv).r);
    }

    // 解码法线：MeshNormalMaterial 将视图空间法线编码为 color = normal * 0.5 + 0.5
    vec3 decodeNormal(vec2 uv) {
      vec3 packed = texture2D(tNormal, uv).rgb;
      // 无几何体区域法线为 (0,0,0) → 不做边缘检测
      if (length(packed) < 0.01) return vec3(0.0);
      return normalize(packed * 2.0 - 1.0);
    }

    // 深度 Sobel 只保留梯度方向，供后续渗墨使用；实际线稿来自共享 EdgeMask。

    // 对深度值做 Sobel 3×3 检测，返回 (梯度幅值, 梯度方向 x, 梯度方向 y)
    void sobelDepth(vec2 uv, vec2 texel, out float magnitude, out float gx, out float gy) {
      // 3×3 邻域采样
      float tl = readLinearDepth(uv + vec2(-1.0,  1.0) * texel);
      float t  = readLinearDepth(uv + vec2( 0.0,  1.0) * texel);
      float tr = readLinearDepth(uv + vec2( 1.0,  1.0) * texel);
      float l  = readLinearDepth(uv + vec2(-1.0,  0.0) * texel);
      float r  = readLinearDepth(uv + vec2( 1.0,  0.0) * texel);
      float bl = readLinearDepth(uv + vec2(-1.0, -1.0) * texel);
      float b  = readLinearDepth(uv + vec2( 0.0, -1.0) * texel);
      float br = readLinearDepth(uv + vec2( 1.0, -1.0) * texel);

      // Sobel 核：
      //   Gx = [-1 0 +1; -2 0 +2; -1 0 +1]
      //   Gy = [+1 +2 +1;  0 0  0; -1 -2 -1]
      gx = -tl + tr - 2.0 * l + 2.0 * r - bl + br;
      gy = tl + 2.0 * t + tr - bl - 2.0 * b - br;

      // 梯度幅值（归一化到深度范围）
      magnitude = sqrt(gx * gx + gy * gy) / (uCameraFar - uCameraNear);
    }

    // ── 法线 Sobel 曲率估算（增强B）──
    // 对法线纹理做 3×3 Sobel，法线梯度幅值 ≈ 表面曲率
    // 曲率高（法线变化快）= 尖角/屋脊；曲率低（法线变化慢）= 平面
    // 返回值 [0, 1]，0=平面，1=尖角
    float sobelNormal(vec2 uv, vec2 texel) {
      // 中心像素必须有几何体
      if (length(texture2D(tNormal, uv).rgb) < 0.01) return 0.0;

      // 3×3 邻域采样并解码为视图空间法线
      vec3 n_tl = decodeNormal(uv + vec2(-1.0,  1.0) * texel);
      vec3 n_t  = decodeNormal(uv + vec2( 0.0,  1.0) * texel);
      vec3 n_tr = decodeNormal(uv + vec2( 1.0,  1.0) * texel);
      vec3 n_l  = decodeNormal(uv + vec2(-1.0,  0.0) * texel);
      vec3 n_r  = decodeNormal(uv + vec2( 1.0,  0.0) * texel);
      vec3 n_bl = decodeNormal(uv + vec2(-1.0, -1.0) * texel);
      vec3 n_b  = decodeNormal(uv + vec2( 0.0, -1.0) * texel);
      vec3 n_br = decodeNormal(uv + vec2( 1.0, -1.0) * texel);

      // 对每个法线分量分别做 Sobel，取三个分量的梯度幅值之和
      // Gx = [-1 0 +1; -2 0 +2; -1 0 +1], Gy = [+1 +2 +1; 0 0 0; -1 -2 -1]
      float gx = 0.0, gy = 0.0;

      // X 方向（左右差异累加三个 RGB 分量）
      gx += -n_tl.x + n_tr.x - 2.0 * n_l.x + 2.0 * n_r.x - n_bl.x + n_br.x;
      gx += -n_tl.y + n_tr.y - 2.0 * n_l.y + 2.0 * n_r.y - n_bl.y + n_br.y;
      gx += -n_tl.z + n_tr.z - 2.0 * n_l.z + 2.0 * n_r.z - n_bl.z + n_br.z;

      // Y 方向（上下差异累加三个 RGB 分量）
      gy += n_tl.x + 2.0 * n_t.x + n_tr.x - n_bl.x - 2.0 * n_b.x - n_br.x;
      gy += n_tl.y + 2.0 * n_t.y + n_tr.y - n_bl.y - 2.0 * n_b.y - n_br.y;
      gy += n_tl.z + 2.0 * n_t.z + n_tr.z - n_bl.z - 2.0 * n_b.z - n_br.z;

      // 法线梯度幅值归一化（法线是单位向量，单个分量最大变化为 2）
      // 三通道 Sobel 结果理论最大值为 2 * (1+2+1+1+2+1) = 16
      // 三个通道加起来最大 48，归一化到 [0,1]
      // 注：改为 /8.0 提高曲率响应灵敏度，让转角处更容易变粗
      float mag = sqrt(gx * gx + gy * gy);
      return clamp(mag / 8.0, 0.0, 1.0);
    }

    // ============================================================
    // Step 5: 渗墨方向性模糊（Directional Ink Bleed）
    // ============================================================

    // 沿梯度方向采样深度差，模拟墨水沿边缘向外晕开
    // 核心思路：
    //   梯度的方向指向深度变化最快的方向（即垂直于边缘）
    //   沿梯度方向检查深度不连续性，将边缘"涂抹"到邻近像素
    //   加权衰减模拟墨迹末端淡出
    float computeInkBleed(vec2 uv, vec2 gradientDir, float centerDepth) {
      // 质量映射到采样数
      float maxSamples = 4.0;
      if (uQuality >= 0.5) maxSamples = 8.0;   // 中质量
      if (uQuality >= 1.5) maxSamples = 12.0;  // 高质量

      float stepSize = 1.0 / uResolution.y; // 1 像素对应的 UV 步长
      float totalBleed = 0.0;
      float totalWeight = 0.0;

      // 沿梯度正方向和反方向各采样一半
      for (int i = 1; i <= 12; i++) {
        if (float(i) > maxSamples) break;

        float dist = float(i) / maxSamples * uBlurRadius;
        float falloffWeight = exp(-dist * uBleedFalloff);

        // 正方向
        vec2 offsetPos = gradientDir * stepSize * dist;
        float depthPos = readLinearDepth(uv + offsetPos);
        // 深度差转换为边缘强度
        float edgePos = abs(depthPos - centerDepth) / (uCameraFar - uCameraNear);
        float edgePosAA = max(fwidth(edgePos) * 1.25, 0.002);
        edgePos = smoothstep(uEdgeThreshold - edgePosAA, uEdgeThreshold + edgePosAA, edgePos);
        totalBleed += edgePos * falloffWeight;
        totalWeight += falloffWeight;

        // 反方向
        vec2 offsetNeg = -gradientDir * stepSize * dist;
        float depthNeg = readLinearDepth(uv + offsetNeg);
        float edgeNeg = abs(depthNeg - centerDepth) / (uCameraFar - uCameraNear);
        float edgeNegAA = max(fwidth(edgeNeg) * 1.25, 0.002);
        edgeNeg = smoothstep(uEdgeThreshold - edgeNegAA, uEdgeThreshold + edgeNegAA, edgeNeg);
        totalBleed += edgeNeg * falloffWeight;
        totalWeight += falloffWeight;
      }

      return totalWeight > 0.0 ? totalBleed / totalWeight : 0.0;
    }

    // ============================================================
    // 主函数
    // ============================================================

    void main() {
      vec3 sceneColor = texture2D(tDiffuse, vUv).rgb;

      // 完全关闭描边时直接返回场景颜色
      if (uEdgeStrength <= 0.0) {
        gl_FragColor = vec4(sceneColor, 1.0);
        return;
      }

      // ============================================
      // Step 1: 读取深度
      // ============================================
      float depthSample = texture2D(tDepth, vUv).r;
      // 无几何体区域（天空/背景）跳过边缘检测
      if (depthSample >= 0.9999) {
        gl_FragColor = vec4(sceneColor, 1.0);
        return;
      }
      float centerLinearDepth = linearizeDepth(depthSample);

      // ============================================
      // Step 0: 曲率估算（增强B）→ 宽度系数
      // ============================================
      float widthMultiplier = 1.0;
      if (uCurvatureEnabled) {
        // 用固定偏移做法线 Sobel（不受后续宽度调制影响）
        vec2 normalTexel = vec2(1.0 / uResolution.x, 1.0 / uResolution.y) * uMaxEdgeWidth;
        float curvature = sobelNormal(vUv, normalTexel);
        widthMultiplier = mix(uCurvatureMin, uCurvatureMax,
                              clamp(curvature * uCurvatureScale, 0.0, 1.0));
      }

      // ── 远景线宽衰减：远处描边逐渐变细，避免固定像素宽度占比过大而粘连 ──
      float dynamicEdgeWidth = uMaxEdgeWidth;
      if (uWidthDepthFadeEnabled) {
        float wStart = uWidthFadeStart;
        float wEnd = max(uWidthFadeEnd, wStart + 0.001);
        float widthFade = 1.0 - smoothstep(wStart, wEnd, centerLinearDepth);
        dynamicEdgeWidth = mix(uMinEdgeWidth, uMaxEdgeWidth, widthFade);
      }

      // Detection remains fixed at one texel. Width/cadence/curvature only
      // expand the already detected shared mask.
      vec2 texel = vec2(1.0 / uResolution.x, 1.0 / uResolution.y);

      // Keep the depth Sobel only as a fallback direction for places where the
      // shared mask is locally flat after expansion.
      float depthEdgeMag;
      float gx, gy;
      sobelDepth(vUv, texel, depthEdgeMag, gx, gy);

      vec2 strokeTangent = edgeStrokeTangent(vUv, texel, vec2(gx, gy));
      vec2 strokeAcross = vec2(-strokeTangent.y, strokeTangent.x);
      vec3 worldPosition = reconstructWorldPosition(vUv, depthSample);
      vec3 worldDx = reconstructWorldPosition(vUv + vec2(texel.x, 0.0), depthSample);
      vec3 worldDy = reconstructWorldPosition(vUv + vec2(0.0, texel.y), depthSample);
      vec3 tangentWorld = canonicalWorldDirection(
        (worldDx - worldPosition) * strokeTangent.x
        + (worldDy - worldPosition) * strokeTangent.y
      );
      vec3 acrossWorld = canonicalWorldDirection(
        (worldDx - worldPosition) * strokeAcross.x
        + (worldDy - worldPosition) * strokeAcross.y
      );

      // Low-frequency cadence now advances along the actual edge tangent and
      // is anchored in world space instead of being a fixed screen-space grid.
      vec2 strokeDomain = worldAnchoredStrokeDomain(
        worldPosition,
        tangentWorld,
        acrossWorld,
        uStrokeScale
      );
      float strokeNoise = inkNoise2D(strokeDomain + vec2(17.3, 41.7));
      float punch = clamp(uStrokePunch, 0.0, 1.0);
      float strokeCadence = smoothstep(
        mix(0.1, 0.45, punch),
        mix(0.9, 0.55, punch),
        strokeNoise
      );
      float strokeWidthMultiplier = mix(
        1.0,
        mix(0.55, 1.7, strokeCadence),
        clamp(uStrokeVariation, 0.0, 1.0)
      );
      float edgeForward = texture2D(
        tEdgeMask,
        vUv + strokeTangent * texel * 2.0
      ).r;
      float edgeBackward = texture2D(
        tEdgeMask,
        vUv - strokeTangent * texel * 2.0
      ).r;
      float endpointAccent = abs(edgeForward - edgeBackward)
        * max(edgeForward, edgeBackward);
      strokeWidthMultiplier *= 1.0
        + endpointAccent * punch * clamp(uStrokeVariation, 0.0, 1.0) * 0.45;

      // Shared depth/normal edge source. Expansion is independent of detection.
      float edge = expandEdgeMask(
        tEdgeMask,
        vUv,
        uResolution,
        dynamicEdgeWidth * widthMultiplier * strokeWidthMultiplier
      );

      // ── 远景深度衰减：远处描边强度逐渐淡出，避免与近景同样浓黑而粘连成块 ──
      float depthFade = 1.0;
      if (uDepthFadeEnabled) {
        float dStart = uDepthFadeStart;
        float dEnd = max(uDepthFadeEnd, dStart + 0.001);
        depthFade = 1.0 - smoothstep(dStart, dEnd, centerLinearDepth);
      }
      float finalStrength = mix(uMinEdgeStrength, uEdgeStrength, depthFade);
      edge *= finalStrength;

      // 曲率直接增强描边强度（增强B）
      // 转角/法线突变处积墨变浓，平面处保持正常
      if (uCurvatureEnabled) {
        vec2 normalTexel = vec2(1.0 / uResolution.x, 1.0 / uResolution.y) * uEdgeWidth;
        float curvature = sobelNormal(vUv, normalTexel);
        float curvatureBoost = mix(1.0, 1.0 + curvature * uCurvatureScale * 0.5, 0.5);
        edge *= curvatureBoost;
      }

      // ============================================
      // Step 4.5: 噪声调制描边强度（增强A）
      // 与笔画同方向、世界空间锚定的浓淡变化
      // ============================================
      if (uNoiseEnabled && uNoiseStrength > 0.0 && edge > 0.001) {
        vec2 noiseUV = worldAnchoredStrokeDomain(
          worldPosition,
          tangentWorld,
          acrossWorld,
          uNoiseScale
        );
        noiseUV += vec2(uTime * uNoiseAnimSpeed, 0.0);
        float n = inkNoise2D(noiseUV);
        // 提高对比度：让噪声的浓淡差异更极端
        n = clamp((n - 0.5) * uNoiseContrast + 0.5, 0.0, 1.0);
        
        // 双向调制：噪声既能增浓也能减淡，产生墨色不均匀感
        float signedNoise = (n - 0.5) * 2.0; // -1 ~ 1
        float alphaMod = 1.0 + signedNoise * uNoiseStrength;
        edge *= clamp(alphaMod, 0.25, 1.75);
        
        // 同时轻微调制宽度，让线条粗细也有自然变化
      }

      // ============================================
      // Step 4.6: 飞白 mask（纤维状断裂）
      // ============================================
      if (uFlyWhiteEnabled && edge > 0.001) {
        float fw = flyWhiteNoiseWorld(worldPosition, tangentWorld, acrossWorld);
        float cut = smoothstep(
          uFlyWhiteCutoff - uFlyWhiteFeather,
          uFlyWhiteCutoff + uFlyWhiteFeather,
          fw
        );
        // Low-frequency segment gating keeps deliberate long gaps instead of
        // pepper-noise pinholes, while retaining a short feathered transition.
        edge *= smoothstep(0.04, 0.18, cut) * mix(0.55, 1.0, cut);
      }

      // ============================================
      // Step 5: 渗墨方向性模糊
      // ============================================
      float bleed = 0.0;
      if (uBlurRadius > 0.0 && edge > 0.001) {
        // 梯度方向归一化
        float gradLen = length(vec2(gx, gy));
        vec2 gradientDir = gradLen > 0.0001
          ? normalize(vec2(gx, gy))
          : vec2(1.0, 0.0); // 退化情况使用水平方向

        bleed = computeInkBleed(vUv, gradientDir, centerLinearDepth);
        // ── 测试 2：确认 bleed 是否有值 ──
        // gl_FragColor = vec4(vec3(bleed * 10.0), 1.0);
        // return;
        // 渗墨仅增强边缘周围区域的墨色，不会被阈值削减
      }

      // 最终边缘强度 = 原始边缘 + 渗墨扩散
      float finalEdge = clamp(edge + bleed * 0.7, 0.0, 1.0);

      // ── 远景 LOD 整体淡出：在深度衰减之外再做一层兜底淡出，避免远景密集边缘叠成黑团 ──
      if (uLodFadeEnabled) {
        float lStart = uLodFadeStart;
        float lEnd = max(uLodFadeEnd, lStart + 0.001);
        float lodFade = 1.0 - smoothstep(lStart, lEnd, centerLinearDepth);
        finalEdge *= lodFade;
      }

      float echoEdge = 0.0;
      if (uEchoCount > 0.5 && uEchoStrength > 0.001) {
        vec2 echoStep = uEchoDirection * uEchoSpacing / max(uResolution, vec2(1.0));
        float roundedCount = floor(uEchoCount + 0.5);
        float echoWidth = min(uEdgeWidth, 1.5);
        float echoLayer1 = sampleEchoEdge(vUv - echoStep, echoWidth)
          * step(1.0, roundedCount);
        float echoLayer2 = sampleEchoEdge(vUv - echoStep * 2.0, echoWidth)
          * step(2.0, roundedCount) * 0.78;
        float echoLayer3 = sampleEchoEdge(vUv - echoStep * 3.0, echoWidth)
          * step(3.0, roundedCount) * 0.56;
        echoEdge = max(echoLayer1, max(echoLayer2, echoLayer3));
        float echoAa = max(fwidth(echoEdge) * 1.25, 1.0 / 255.0);
        echoEdge = smoothstep(0.12 - echoAa, 0.12 + echoAa, echoEdge);
        echoEdge *= uEchoStrength * (1.0 - finalEdge);
        echoEdge *= depthFade;
      }

      // ============================================
      // Step 6: 墨色叠加合成
      // ============================================
      vec3 result = mix(sceneColor, uEchoColor, echoEdge);
      result = mix(result, uInkColor, finalEdge);

      // ── 测试 1：确认 InkEdgePass 是否真的在最终画面中 ──
      // gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
      // return;

      gl_FragColor = vec4(result, 1.0);
    }
  `,
};

/**
 * 创建 InkEdgePass 实例
 *
 * 初始化时设置 uResolution，调用方需每帧更新 uCameraNear / uCameraFar
 *
 * @param {THREE.WebGLRenderer} renderer — Three.js 渲染器，用于获取初始分辨率
 * @returns {ShaderPass} 配置好的 ShaderPass 实例
 */
export function createInkEdgePass(renderer) {
  const pass = new ShaderPass(InkEdgeShader);
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const pixelRatio = renderer.getPixelRatio?.() || 1;
  pass.uniforms.uResolution.value.set(size.x * pixelRatio, size.y * pixelRatio);
  return pass;
}

/**
 * 设置 InkEdgePass 的质量等级
 *
 * 低质量 (0): 仅深度 Sobel 边 + 4 渗墨采样 → 移动端/低端 GPU 友好
 * 中质量 (1): 深度 Sobel + 法线边 + 8 渗墨采样 → 推荐默认
 * 高质量 (2): 深度 Sobel + 法线边 + 12 渗墨采样 → 桌面端最佳效果
 *
 * @param {ShaderPass} pass — InkEdgePass 实例
 * @param {number} quality — 0 | 1 | 2
 */
export function setInkEdgeQuality(pass, quality) {
  if (!pass?.uniforms?.uQuality) return;
  pass.uniforms.uQuality.value = quality;
}

export { InkEdgeShader };
