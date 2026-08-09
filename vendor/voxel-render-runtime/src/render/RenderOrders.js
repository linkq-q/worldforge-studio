// 透明排序层带唯一真值。层级关系只在这里定义，禁止在业务代码写数字或跨模块注释。
// 详见 docs/tasks/transparency-sort-rules.md
export const RENDER_ORDER = {
  SKY: -1,          // 背景穹顶（AtmosphereSky / HDRISkyDome），永远最先画
  CLOUDS: 0,        // 体积云层（transparent，需显式设置以垫在水/玻璃带之下）
  // OPAQUE = 0 是 three.js 默认值：不透明物体一律不设 renderOrder
  WATER_GLASS: 1,   // 水面 + 玻璃（含 effect Glass override）。带内靠 back-to-front 距离排序
  EFFECTS: 2,        // 火/电/粒子/瀑布水体。additive 为主，带内顺序无关紧要
  EFFECTS_TOP: 3,    // 必须压 EFFECTS 的（现只有瀑布泡沫）
};
