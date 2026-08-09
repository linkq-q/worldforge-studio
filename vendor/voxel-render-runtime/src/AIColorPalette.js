/**
 * AIColorPalette.js — DeepSeek API 驱动的色调 LUT 生成器
 *
 * 职责：
 * 1. 调用 DeepSeek API（/chat/completions，OpenAI 兼容格式）生成色板控制点
 * 2. 将色板烘焙为 Three.js DataTexture（1D LUT，宽256高1）
 * 3. 提供默认水墨风格 fallback LUT
 *
 * API 规格（来自 api-docs.deepseek.com，2026-06 确认）：
 *   Endpoint: POST https://api.deepseek.com/chat/completions
 *   Auth:     Bearer <API_KEY>
 *   Model:    deepseek-v4-pro / deepseek-v4-flash
 *   JSON 模式: response_format: { type: 'json_object' }
 */

import * as THREE from 'three';

/** 常量 */
const LUT_WIDTH = 256;
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-pro';

/**
 * 默认水墨风格 LUT 控制点
 * - 暗部（0.0–0.3）：冷灰青
 * - 中间调（0.3–0.7）：暖米色
 * - 亮部（0.7–1.0）：暖白
 */
const DEFAULT_PALETTE_POINTS = [
  { l: 0.0, r: 0.15, g: 0.18, b: 0.22 },
  { l: 0.3, r: 0.15, g: 0.18, b: 0.22 },
  { l: 0.5, r: 0.72, g: 0.68, b: 0.52 },
  { l: 0.7, r: 0.72, g: 0.68, b: 0.52 },
  { l: 1.0, r: 0.95, g: 0.92, b: 0.82 },
];

/**
 * 几个风格预设的 prompt
 */
const STYLE_PRESETS = {
  '水墨风': '中国传统水墨画风格，黑白灰为主色调，墨色浓淡变化丰富，留白有韵味，整体淡雅素净',
  '青绿山水': '北宋青绿山水画风格，石青石绿为主色调，金碧辉煌，色彩浓郁但不艳俗，有古画质感',
  '烟雨江南': '江南水乡烟雨朦胧风格，淡蓝淡灰为主，湿润柔和，有水墨氤氲之感，色调偏冷偏灰',
  '敦煌壁画': '敦煌莫高窟壁画风格，土红、石青、石绿为主，色彩厚重古朴，有历史沉淀感',
  '宋代花鸟': '宋代工笔花鸟画风格，色彩淡雅精致，暖黄底色，矿物颜料质感，细节丰富而不张扬',
};

const SYSTEM_PROMPT = `你是一位中国传统绘画色彩专家。根据用户描述的视觉风格，生成一组亮度→颜色的映射关系（色板控制点）。

你必须只返回一个合法的 JSON 对象，不包含任何 markdown 标记、注释或解释文字。

JSON 格式示例：
{"points":[{"l":0.0,"r":0.15,"g":0.18,"b":0.22},{"l":0.3,"r":0.15,"g":0.18,"b":0.22},{"l":0.5,"r":0.72,"g":0.68,"b":0.52},{"l":0.7,"r":0.72,"g":0.68,"b":0.52},{"l":1.0,"r":0.95,"g":0.92,"b":0.82}]}

规则：
- 必须恰好 5 个控制点，l 值分别为 0.0, 0.3, 0.5, 0.7, 1.0
- r/g/b 值域 0.0–1.0，保留 2-3 位小数
- 暗部（l=0.0, 0.3）偏冷色调，模拟墨色基底
- 中间调（l=0.5）反映风格主色调
- 亮部（l=0.7, 1.0）偏暖白，模拟宣纸底色`;

/**
 * 从控制点数组构建 1D LUT DataTexture
 *
 * @param {Array<{l:number, r:number, g:number, b:number}>} points
 *        按 l（亮度）升序排列的控制点数组，l 在 0-1 之间
 * @returns {THREE.DataTexture} 宽256高1的 RGBA DataTexture，使用 LinearFilter
 */
function buildLUTTexture(points) {
  // 按 l 值排序
  const sorted = [...points].sort((a, b) => a.l - b.l);

  // 确保首尾覆盖 [0, 1]
  if (sorted.length === 0) {
    // fallback to default
    return generateDefaultLUT();
  }

  // 创建 RGBA 数据（每像素 4 字节，alpha=255）
  const data = new Uint8Array(LUT_WIDTH * 4);

  for (let i = 0; i < LUT_WIDTH; i++) {
    const luminance = i / (LUT_WIDTH - 1); // 0.0 到 1.0

    // 在控制点之间线性插值
    let r = sorted[0].r;
    let g = sorted[0].g;
    let b = sorted[0].b;

    if (luminance <= sorted[0].l) {
      r = sorted[0].r;
      g = sorted[0].g;
      b = sorted[0].b;
    } else if (luminance >= sorted[sorted.length - 1].l) {
      const last = sorted[sorted.length - 1];
      r = last.r;
      g = last.g;
      b = last.b;
    } else {
      for (let j = 0; j < sorted.length - 1; j++) {
        const a = sorted[j];
        const c = sorted[j + 1];
        if (luminance >= a.l && luminance <= c.l) {
          const t = (luminance - a.l) / (c.l - a.l);
          r = a.r + t * (c.r - a.r);
          g = a.g + t * (c.g - a.g);
          b = a.b + t * (c.b - a.b);
          break;
        }
      }
    }

    // 写入 RGBA
    const offset = i * 4;
    data[offset]     = Math.round(Math.max(0, Math.min(1, r)) * 255);
    data[offset + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
    data[offset + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    data[offset + 3] = 255; // alpha
  }

  const texture = new THREE.DataTexture(
    data,
    LUT_WIDTH,
    1,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );

  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return texture;
}

/**
 * 生成默认水墨风格 LUT（同步，无需 API）
 * @returns {THREE.DataTexture}
 */
export function generateDefaultLUT() {
  return buildLUTTexture(DEFAULT_PALETTE_POINTS);
}

/**
 * AIColorPalette 类 — 封装 DeepSeek API 调用
 */
export class AIColorPalette {
  /**
   * @param {string} [apiKey] DeepSeek API Key（可选，不提供则无法调用 API）
   * @param {string} [model='deepseek-v4-pro'] 模型名称
   */
  constructor(apiKey = null, model = DEFAULT_MODEL) {
    this.apiKey = apiKey;
    this.model = model;
    this._lastLUT = null;
  }

  /**
   * 是否有可用的 API key
   */
  get hasAPIKey() {
    return Boolean(this.apiKey);
  }

  /**
   * 调用 DeepSeek API 生成色板 LUT
   *
   * @param {string} stylePrompt 风格描述（中文）
   * @returns {Promise<THREE.DataTexture>}
   */
  async generateLUT(stylePrompt) {
    if (!this.apiKey) {
      console.warn('[AIColorPalette] 未设置 DeepSeek API Key，使用默认水墨 LUT');
      return generateDefaultLUT();
    }

    try {
      const response = await fetch(DEEPSEEK_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: stylePrompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 1024,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`DeepSeek API HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      const content = result.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('DeepSeek API 返回空内容（JSON 模式已知问题，可重试）');
      }

      // 解析 JSON
      let paletteData;
      try {
        paletteData = JSON.parse(content);
      } catch (parseErr) {
        console.warn('[AIColorPalette] JSON 解析失败，原始内容:', content.slice(0, 200));
        throw new Error('API 返回内容不是合法 JSON');
      }

      // 验证数据格式
      if (!paletteData.points || !Array.isArray(paletteData.points) || paletteData.points.length < 2) {
        console.warn('[AIColorPalette] 色板数据格式不正确:', paletteData);
        throw new Error('色板数据格式不正确：缺少 points 数组或点数不足');
      }

      // 构建纹理
      const texture = buildLUTTexture(paletteData.points);
      this._lastLUT = texture;
      console.log('[AIColorPalette] 色板生成成功，', paletteData.points.length, '个控制点');
      return texture;

    } catch (error) {
      console.warn('[AIColorPalette] API 调用失败，fallback 到默认水墨 LUT:', error.message);
      return generateDefaultLUT();
    }
  }

  /**
   * 获取上次生成的 LUT
   */
  get lastLUT() {
    return this._lastLUT;
  }
}

export { buildLUTTexture, STYLE_PRESETS, DEFAULT_PALETTE_POINTS };
