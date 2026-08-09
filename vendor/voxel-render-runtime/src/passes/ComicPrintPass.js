/**
 * ComicPrintPass.js — 漫画印刷风 presentation 输出 Pass
 *
 * Presentation 层（RenderPipeline slot='presentation'）单 shader 实现四段效果，
 * 各自 uniform 开关（合并成一个 pass 省 3 次全屏 blit）：
 *   1. Print Offset — RGB 通道微偏移，模拟套印不准（克制，不是镜头色差）
 *   2. Posterize   — 有限色阶，印刷感色彩压缩
 *   3. Halftone    — 亮度驱动的旋转网点（45°），暗部墨点大、亮部消失
 *   4. Line Boost  — 亮度梯度边缘压暗，强化线稿
 *
 * 纸张纹理不在此 pass 内：复用 mainComposer 里现有的 PaperTexturePass
 * （POST PROCESS 面板 Paper Texture 组），避免同一能力两份实现。
 *
 * 网点锚定屏幕空间（gl_FragCoord 栅格），相机移动时网点不游动——
 * 这正是纸媒印刷的观感：内容在网点下流动。
 */

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import * as THREE from 'three';
import { EDGE_MASK_EXPANSION_GLSL } from '../shaders/EdgeMaskExpansion.js';

const ComicPrintShader = {
  uniforms: {
    tDiffuse: { value: null },
    tEdgeMask: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uHalftoneEnabled: { value: 1 },
    uHalftoneStrength: { value: 0.5 },
    uHalftoneCellSize: { value: 6 },
    uHalftoneInkColor: { value: new THREE.Vector3(0, 0, 0) },
    uHalftoneOpacity: { value: 0.85 },
    uHalftoneAngle: { value: Math.PI / 4 },          // 弧度，默认 45°
    uPrintOffsetEnabled: { value: 1 },
    uPrintOffsetAmount: { value: 0.75 },
    uPrintOffsetAngle: { value: Math.PI / 4 },        // 弧度，默认 45°
    uPrintOffsetColorA: { value: new THREE.Vector3(1, 0, 0) }, // 残影 A（默认红=+off 取 R）
    uPrintOffsetColorB: { value: new THREE.Vector3(0, 0, 1) }, // 残影 B（默认蓝=-off 取 B）
    uPosterizeEnabled: { value: 1 },
    uColorLevels: { value: 6 },
    uLineBoost: { value: 0.15 },
    uLineColor: { value: new THREE.Vector3(0, 0, 0) },
    uLineWidth: { value: 1.0 },      // 描边粗细（采样步长，像素）
    uLineThreshold: { value: 0.04 }, // 边缘阈值：低于此的弱梯度不出线（去纹理噪点）
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
    uniform sampler2D tEdgeMask;
    uniform vec2 uResolution;
    uniform float uHalftoneEnabled;
    uniform float uHalftoneStrength;
    uniform float uHalftoneCellSize;
    uniform vec3 uHalftoneInkColor;
    uniform float uHalftoneOpacity;
    uniform float uHalftoneAngle;
    uniform float uPrintOffsetEnabled;
    uniform float uPrintOffsetAmount;
    uniform float uPrintOffsetAngle;
    uniform vec3 uPrintOffsetColorA;
    uniform vec3 uPrintOffsetColorB;
    uniform float uPosterizeEnabled;
    uniform float uColorLevels;
    uniform float uLineBoost;
    uniform vec3 uLineColor;
    uniform float uLineWidth;
    uniform float uLineThreshold;
    varying vec2 vUv;

    ${EDGE_MASK_EXPANSION_GLSL}

    float luma(vec3 c) {
      return dot(c, vec3(0.299, 0.587, 0.114));
    }

    void main() {
      vec2 texel = 1.0 / uResolution;

      // ── 1. Print Offset：双色套印偏移（默认 A=红/+off、B=蓝/-off，逐通道等价旧实现）──
      vec3 color;
      if (uPrintOffsetEnabled > 0.5) {
        vec2 off = texel * uPrintOffsetAmount * vec2(cos(uPrintOffsetAngle), sin(uPrintOffsetAngle));
        vec3 base = texture2D(tDiffuse, vUv).rgb;
        vec3 keep = max(vec3(1.0) - uPrintOffsetColorA - uPrintOffsetColorB, 0.0);
        color = base * keep
              + texture2D(tDiffuse, vUv + off).rgb * uPrintOffsetColorA
              + texture2D(tDiffuse, vUv - off).rgb * uPrintOffsetColorB;
      } else {
        color = texture2D(tDiffuse, vUv).rgb;
      }

      // ── 2. Posterize：有限色阶 ──
      if (uPosterizeEnabled > 0.5) {
        float levels = max(uColorLevels, 2.0);
        color = floor(color * levels + 0.5) / levels;
      }

      // ── 3. Halftone：可调角度旋转网点，暗部墨点大 ──
      if (uHalftoneEnabled > 0.5) {
        float lum = luma(color);
        // 屏幕坐标按 uHalftoneAngle 旋转（默认 45°=经典印刷网线角度）
        vec2 sc = vUv * uResolution;
        vec2 dir = vec2(cos(uHalftoneAngle), sin(uHalftoneAngle));
        vec2 rot = vec2(dot(sc, dir), dot(sc, vec2(-dir.y, dir.x)));
        vec2 cellUv = fract(rot / max(uHalftoneCellSize, 2.0)) - 0.5;
        float dist = length(cellUv) * 2.0;         // 0=格心 1=格角方向
        float inkTarget = 1.0 - lum;               // 越暗墨点越大
        float aa = fwidth(dist) + 0.06;
        float ink = 1.0 - smoothstep(inkTarget - aa, inkTarget + aa, dist);
        // 墨点染色（默认黑+0.85 与旧压暗观感一致），亮部 inkTarget→0 网点自然消失
        vec3 dotted = mix(color, uHalftoneInkColor, ink * uHalftoneOpacity);
        color = mix(color, dotted, uHalftoneStrength);
      }

      // ── 4. Line Boost：复用共享深度/法线边缘，避免纹理噪点和重复检测 ──
      if (uLineBoost > 0.001) {
        float edge = expandEdgeMask(tEdgeMask, vUv, uResolution, uLineWidth);
        color = mix(color, uLineColor, edge * uLineBoost);
      }

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * 创建 ComicPrintPass
 * @returns {ShaderPass}
 */
export function createComicPrintPass() {
  return new ShaderPass(ComicPrintShader);
}

export { ComicPrintShader };
