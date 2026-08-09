/**
 * ParticleParamSchema.js — 粒子编辑器面板的参数 schema(任务书 particle-editor-panel-v1 Phase 0)
 *
 * 描述 ParticleEngine config 的全部字段:类型/范围/分组/条件显示。
 * 面板(ParticleEditorPanel)按此自动生成控件;新增引擎字段 = 这里加一行。
 * 纯数据 + 两个点路径存取 helper,不依赖 three,node 可测。
 *
 * 漂移防护:tests/particle-engine.test.mjs 断言所有内置预设 config 的每个
 * 叶子路径都在本 schema 中——引擎/预设加了字段而这里没跟上,测试即红。
 *
 * 控件类型:
 *   float / int  数字输入 + 滑杆(min/max/step)
 *   bool         checkbox
 *   color        取色器(config 中为 [r,g,b] 0-1 数组,面板负责 hex 互转)
 *   enum         下拉(options)
 *   vec3         3 个数字输入(config 中为 [x,y,z])
 *   range        2 个数字输入(config 中为 [a,b],labels 标注语义,默认 min/max)
 *
 * 约定:duration ≤ 0 表示"常驻"(面板保存时省略该字段,引擎默认 Infinity)。
 */

import { CURVE_IDS } from './ParticleEngine.js';

export const GROUP_ORDER = ['Basic', 'Shape', 'Velocity', 'Appearance'];

const curveEnum = { type: 'enum', options: CURVE_IDS, default: 'linear' };

export const PARTICLE_PARAM_SCHEMA = Object.freeze({
  // ── Basic ──
  renderMode: { group: 'Basic', type: 'enum', label: 'Render Mode', options: ['point', 'mesh', 'streak'], default: 'point' },
  mesh: {
    group: 'Basic', type: 'enum', label: 'Mesh', options: ['box', 'ico'], default: 'box',
    showIf: { field: 'renderMode', equals: 'mesh' },
  },
  rate: { group: 'Basic', type: 'float', label: 'Rate (per sec)', min: 0, max: 200, step: 1, default: 15 },
  burst: { group: 'Basic', type: 'int', label: 'Burst Count', min: 0, max: 200, step: 1, default: 0 },
  duration: { group: 'Basic', type: 'float', label: 'Duration (≤0 = ∞)', min: -1, max: 30, step: 0.1, default: -1 },
  maxCount: { group: 'Basic', type: 'int', label: 'Max Count', min: 8, max: 4096, step: 8, default: 256 },
  lifetime: { group: 'Basic', type: 'range', label: 'Lifetime (s)', labels: ['min', 'max'], min: 0.05, max: 20, step: 0.05, default: [0.5, 1.0] },
  spawnInAnchorSpace: {
    group: 'Basic', type: 'bool', label: 'Rotate At Spawn With Object Anchor', default: false,
  },

  // ── Shape ──
  emitShape: { group: 'Shape', type: 'enum', label: 'Emit Shape', options: ['point', 'ring', 'box'], default: 'point' },
  shapeSize: {
    group: 'Shape', type: 'vec3', label: 'Shape Size (ring: 只用 X=半径)', min: 0, max: 20, step: 0.05, default: [0.5, 0.5, 0.5],
    showIf: { field: 'emitShape', notEquals: 'point' },
  },
  offset: { group: 'Shape', type: 'vec3', label: 'Offset', min: -10, max: 10, step: 0.05, default: [0, 0, 0] },

  // ── Velocity ──
  'velocity.mode': { group: 'Velocity', type: 'enum', label: 'Velocity Mode', options: ['cone', 'radial'], default: 'cone' },
  'velocity.dir': {
    group: 'Velocity', type: 'vec3', label: 'Direction', min: -1, max: 1, step: 0.05, default: [0, 1, 0],
    showIf: { field: 'velocity.mode', equals: 'cone' },
  },
  'velocity.speed': { group: 'Velocity', type: 'range', label: 'Speed (radial 可负=向内)', labels: ['min', 'max'], min: -20, max: 40, step: 0.1, default: [1, 2] },
  'velocity.spread': {
    group: 'Velocity', type: 'float', label: 'Spread', min: 0, max: 2, step: 0.05, default: 0.3,
    showIf: { field: 'velocity.mode', equals: 'cone' },
  },
  acceleration: { group: 'Velocity', type: 'vec3', label: 'Acceleration', min: -20, max: 20, step: 0.1, default: [0, 0, 0] },
  wobble: { group: 'Velocity', type: 'range', label: 'Wobble', labels: ['amp', 'freq'], min: 0, max: 10, step: 0.05, default: [0, 0] },
  groundKill: { group: 'Velocity', type: 'bool', label: 'Ground Kill (y<0)', default: false },

  // ── Appearance ──
  meshSize: { group: 'Appearance', type: 'float', label: 'Size', min: 0.01, max: 20, step: 0.01, default: 0.15 },
  streakLength: {
    group: 'Appearance', type: 'float', label: 'Streak Length', min: 0.01, max: 20, step: 0.01, default: 0.3,
    showIf: { field: 'renderMode', equals: 'streak' },
  },
  streakWidth: {
    group: 'Appearance', type: 'float', label: 'Streak Width (0 = line)', min: 0, max: 2, step: 0.01, default: 0,
    showIf: { field: 'renderMode', equals: 'streak' },
  },
  scaleStart: { group: 'Appearance', type: 'float', label: 'Scale Start', min: 0, max: 4, step: 0.05, default: 1 },
  scaleEnd: { group: 'Appearance', type: 'float', label: 'Scale End', min: 0, max: 4, step: 0.05, default: 0 },
  sizeCurve: { group: 'Appearance', label: 'Size Curve', ...curveEnum },
  colorStart: { group: 'Appearance', type: 'color', label: 'Color Start', default: [1, 0.8, 0.2] },
  colorEnd: { group: 'Appearance', type: 'color', label: 'Color End', default: [1, 0.3, 0.05] },
  colorCurve: { group: 'Appearance', label: 'Color Curve', ...curveEnum },
  alphaStart: { group: 'Appearance', type: 'float', label: 'Alpha Start', min: 0, max: 1, step: 0.05, default: 1 },
  alphaEnd: { group: 'Appearance', type: 'float', label: 'Alpha End', min: 0, max: 1, step: 0.05, default: 0 },
  alphaCurve: { group: 'Appearance', label: 'Alpha Curve', ...curveEnum },
  additive: {
    group: 'Appearance', type: 'bool', label: 'Additive Blend', default: false,
    showIf: { field: 'renderMode', equals: 'point' },
  },
  flicker: {
    group: 'Appearance', type: 'float', label: 'Flicker', min: 0, max: 2, step: 0.05, default: 0,
    showIf: { field: 'renderMode', equals: 'point' },
  },
  // particle-texture-v1 Phase A/B：point 模式贴图 + flipbook。空字符串 = 现状程序化软圆(零回归)。
  map: {
    group: 'Appearance', type: 'texture', label: 'Texture Path (textures/particles/…)', default: '',
    showIf: { field: 'renderMode', equals: 'point' },
  },
  mapFrames: {
    group: 'Appearance', type: 'range', label: 'Sprite Frames', labels: ['cols', 'rows'],
    min: 1, max: 16, step: 1, default: [1, 1],
    showIf: { field: 'renderMode', equals: 'point' },
  },
  mapFps: {
    group: 'Appearance', type: 'float', label: 'Sprite FPS (0 = lifetime)', min: 0, max: 60, step: 1, default: 0,
    showIf: { field: 'renderMode', equals: 'point' },
  },
  mapFrame: {
    group: 'Appearance', type: 'int', label: 'Fixed Sprite Frame (-1 = animate)', min: -1, max: 255, step: 1, default: -1,
    showIf: { field: 'renderMode', equals: 'point' },
  },
  mapFlipY: {
    group: 'Appearance', type: 'bool', label: 'Flip Texture Y (match Three.js flipY)', default: true,
    showIf: { field: 'renderMode', equals: 'point' },
  },
  mapRowInvert: {
    group: 'Appearance', type: 'bool', label: 'Invert Flipbook Rows (bottom-up sheet)', default: false,
    showIf: { field: 'renderMode', equals: 'point' },
  },
  // particle-texture-v1 补充：真实像素 cell 尺寸/网格原点，处理非正方形 cell 与带边距/偏移的 sprite sheet。
  // 0 = 自动（贴图尺寸 / 帧数，等价于网格铺满整张贴图的旧行为）。
  mapCell: {
    group: 'Appearance', type: 'range', label: 'Cell Size (px, 0=auto)', labels: ['w', 'h'],
    min: 0, max: 2048, step: 1, default: [0, 0],
    showIf: { field: 'renderMode', equals: 'point' },
  },
  mapOrigin: {
    group: 'Appearance', type: 'range', label: 'Grid Origin (px)', labels: ['x', 'y'],
    min: 0, max: 2048, step: 1, default: [0, 0],
    showIf: { field: 'renderMode', equals: 'point' },
  },
});

/** config 里的对象字段(velocity)在 schema 中以点路径展开;这两个 helper 供面板/测试统一存取。 */
export function getByPath(config, path) {
  let node = config;
  for (const key of path.split('.')) {
    if (node == null) return undefined;
    node = node[key];
  }
  return node;
}

export function setByPath(config, path, value) {
  const keys = path.split('.');
  let node = config;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

/** 把一份 config 展开成 schema 叶子路径列表(velocity 对象展开,数组是叶子)。漂移测试用。 */
export function listConfigPaths(config, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(config)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...listConfigPaths(value, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

/** 按 schema 默认值构建一份完整 config(面板"New 空白模板"用)。duration≤0 约定省略。 */
export function buildDefaultConfig() {
  const config = {};
  for (const [path, param] of Object.entries(PARTICLE_PARAM_SCHEMA)) {
    if (path === 'duration' && param.default <= 0) continue;
    const value = Array.isArray(param.default) ? [...param.default] : param.default;
    setByPath(config, path, value);
  }
  return config;
}
