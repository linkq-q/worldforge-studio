/**
 * AsciiPass.js — 字符画 presentation mode（'ascii'）
 *
 * 字符 atlas 运行时用 canvas 2D 生成（换字符集=改一个字符串），格心采原图 →
 * luma → 字符索引 → 格内 UV 换算 atlas UV → glyph mask → 上色。
 *   colored：mix(bg, 格心原图色, mask)（AI 模型彩色字符画）
 *   mono   ：mix(bg, fg, mask)（终端双色）
 *
 * 不做：字符集 UI 可编辑、每格多字符。
 */

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import * as THREE from 'three';

// 墨量升序（左=最亮/最空 → 右=最暗/最满）
const RAMP = ' .:-=+*#%@';

/**
 * 运行时生成字符 atlas（横条 N×1 格，每格 16×16px，白字黑底，等宽字体）。
 * 未注入 canvasFactory 时返回 null，pass 默认 disabled 不会采样。
 * @returns {THREE.CanvasTexture|null}
 */
function buildGlyphAtlas(ramp, canvasFactory) {
  if (typeof canvasFactory !== 'function') return null;
  const cw = 16, ch = 16, n = ramp.length;
  const canvas = canvasFactory();
  if (!canvas) return null;
  canvas.width = cw * n;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px monospace'; // 加粗+撑满格：提高字符占格比例，避免画面大片黑
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    ctx.fillText(ramp[i], i * cw + cw / 2, ch / 2 + 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

const AsciiShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    tGlyph: { value: null },
    uCellSize: { value: 12 },
    uColorMode: { value: 1 },      // 0=mono, 1=colored
    uFgColor: { value: new THREE.Vector3(0.490, 0.949, 0.604) }, // #7df29a
    uBgColor: { value: new THREE.Vector3(0.043, 0.055, 0.071) }, // #0b0e12
    uInvert: { value: 0 },
    uGlyphCount: { value: RAMP.length },
    uGlyphScale: { value: 1.4 },   // 格内 glyph 放大倍率（>1 = 字符占格更大）
    uToneLevels: { value: 4 },     // 透明度分级数（卡通色阶式）
    uToneGrading: { value: 1 },    // 0=关（恒全亮），1=开（字符亮度按亮度档分级）
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
    uniform sampler2D tGlyph;
    uniform float uCellSize;
    uniform float uColorMode;
    uniform vec3 uFgColor;
    uniform vec3 uBgColor;
    uniform float uInvert;
    uniform float uGlyphCount;
    uniform float uGlyphScale;
    uniform float uToneLevels;
    uniform float uToneGrading;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

    void main() {
      float cs = max(uCellSize, 1.0);
      vec2 fragPx = vUv * uResolution;
      vec2 cell = floor(fragPx / cs);
      // 格心 UV：采原图（决定字符 + colored 上色）
      vec2 cuv = ((cell + 0.5) * cs) / uResolution;
      vec3 src = texture2D(tDiffuse, cuv).rgb;
      float l = clamp(luma(src), 0.0, 1.0);
      if (uInvert > 0.5) l = 1.0 - l;

      float idx = floor(l * (uGlyphCount - 0.001)); // 0..count-1
      vec2 local = fract(fragPx / cs);              // 格内 [0,1]
      // glyph 占格缩放：绕格心放大采样（clamp 后越界采到 atlas 黑底，安全）
      local = clamp((local - 0.5) / max(uGlyphScale, 0.1) + 0.5, 0.0, 1.0);
      vec2 auv = vec2((idx + local.x) / uGlyphCount, local.y);
      float mask = texture2D(tGlyph, auv).r;

      // 透明度分级（卡通色阶式）：同一字符按亮度档分亮度，字符集不变信息量翻倍
      // 档 i 的亮度 = (i+1)/L —— 最暗档不为 0，暗部字符仍可见
      if (uToneGrading > 0.5) {
        float L = clamp(uToneLevels, 2.0, 16.0);
        float li = floor(l * (L - 0.001));
        mask *= (li + 1.0) / L;
      }

      vec3 col = (uColorMode > 0.5)
        ? mix(uBgColor, src, mask)     // colored：格心原图色
        : mix(uBgColor, uFgColor, mask); // mono：终端双色
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * 创建 AsciiPass（默认 disabled，运行时生成 glyph atlas）
 * @returns {ShaderPass}
 */
export function createAsciiPass({ canvasFactory } = {}) {
  const pass = new ShaderPass(AsciiShader);
  pass.uniforms.tGlyph.value = buildGlyphAtlas(RAMP, canvasFactory);
  pass.enabled = false;
  return pass;
}

export { AsciiShader, RAMP };
