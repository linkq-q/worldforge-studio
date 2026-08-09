/**
 * PixelPresentationPass.js — 像素风 presentation 输出 Pass
 *
 * Presentation 层（RenderPipeline slot='presentation'）：把 mainComposer 的
 * 最终颜色纹理按 pixelScale 做低分辨率栅格采样（UV 量化 = nearest 采样低分网格），
 * 输出统一像素块画面。可选 posterize（有限色阶）+ Bayer 4×4 dither。
 *
 * 不改主渲染链分辨率——SSAO/Bloom/InkEdge 等照常全分辨率运行，
 * 像素化只发生在最终呈现这一步。
 */

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import * as THREE from 'three';

const PixelPresentationShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uPixelScale: { value: 4 },
    uPosterizeEnabled: { value: 0 },
    uColorLevels: { value: 8 },
    uDitherEnabled: { value: 0 },
    uDitherStrength: { value: 0.12 },
    // ── Phase 6：描边保持 ──
    tEdgeMask: { value: null },
    uEdgePreserveEnabled: { value: 0 },
    uEdgeInkColor: { value: new THREE.Vector3(0.102, 0.102, 0.133) }, // #1a1a22
    uSampleBox: { value: 0 },
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
    uniform float uPixelScale;
    uniform float uPosterizeEnabled;
    uniform float uColorLevels;
    uniform float uDitherEnabled;
    uniform float uDitherStrength;
    uniform sampler2D tEdgeMask;
    uniform float uEdgePreserveEnabled;
    uniform vec3 uEdgeInkColor;
    uniform float uSampleBox;
    varying vec2 vUv;

    // Bayer 2×2 基元：[0 2; 3 1]
    float bayer2(vec2 p) {
      return p.x * 2.0 + p.y * 3.0 - 4.0 * p.x * p.y;
    }

    // Bayer 4×4 有序抖动（2×2 递归展开），返回 [-0.5, 0.5)
    float bayer4(vec2 cell) {
      vec2 p = floor(cell);
      float b = bayer2(mod(p, 2.0)) * 4.0 + bayer2(mod(floor(p / 2.0), 2.0));
      return b / 16.0 - 0.5;
    }

    void main() {
      // 像素栅格：把 UV 量化到 pixelScale 大小的格子中心（= nearest 低分采样）
      vec2 grid = uResolution / max(uPixelScale, 1.0);
      vec2 cell = floor(vUv * grid);
      vec2 uv = (cell + 0.5) / grid;

      vec3 color;
      if (uSampleBox > 0.5) {
        // box 采样：格内 2×2 平均，细特征覆盖率化（缓解非描边细节闪烁）
        vec2 q = 0.25 / grid; // 格内 ±1/4 偏移
        color = (texture2D(tDiffuse, uv + vec2(-q.x, -q.y)).rgb
               + texture2D(tDiffuse, uv + vec2( q.x, -q.y)).rgb
               + texture2D(tDiffuse, uv + vec2(-q.x,  q.y)).rgb
               + texture2D(tDiffuse, uv + vec2( q.x,  q.y)).rgb) * 0.25;
      } else {
        color = texture2D(tDiffuse, uv).rgb; // nearest 单点（原行为）
      }

      if (uPosterizeEnabled > 0.5) {
        float levels = max(uColorLevels, 2.0);
        float dither = uDitherEnabled > 0.5 ? bayer4(cell) * uDitherStrength : 0.0;
        color = floor(color * levels + 0.5 + dither) / levels;
      }

      // 描边保持：格内 3×3 taps 取边缘 max，描边恒对齐格子、不随相机抖动
      if (uEdgePreserveEnabled > 0.5) {
        vec2 step3 = 1.0 / grid / 3.0; // ≤ 半格，基本命中格内边缘像素
        float edge = 0.0;
        for (int dx = -1; dx <= 1; dx++) {
          for (int dy = -1; dy <= 1; dy++) {
            vec2 s = uv + vec2(float(dx), float(dy)) * step3;
            edge = max(edge, texture2D(tEdgeMask, s).r);
          }
        }
        color = mix(color, uEdgeInkColor, edge);
      }

      gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * 创建 PixelPresentationPass
 * @param {object} [params]
 * @param {number} [params.pixelScale=4] 像素块边长（相对 composer RT 像素）
 * @returns {ShaderPass}
 */
export function createPixelPresentationPass(params = {}) {
  const pass = new ShaderPass(PixelPresentationShader);
  if (Number.isFinite(params.pixelScale)) {
    pass.uniforms.uPixelScale.value = params.pixelScale;
  }
  return pass;
}

export { PixelPresentationShader };
