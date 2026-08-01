# RenderPlan V2

基础版渲染 AI 不直接操作 Three.js 对象，也不生成任意 Shader。它先选择一个已有渲染方案作为基底，再输出版本化、可校验的 `RenderPlan`：

```json
{
  "version": 2,
  "baseSchemeId": "render-morning-mist",
  "modules": [
    { "id": "runtime.color-grade", "params": { "recipe": "misty", "contrast": 0.9 } },
    { "id": "runtime.light-rig", "params": { "recipe": "soft-morning", "strength": 0.8 } },
    {
      "key": "foliage-autumn",
      "id": "runtime.material-theme",
      "scope": { "target": "asset-tag", "tag": "tree" },
      "params": { "recipe": "autumn", "strength": 0.8 }
    }
  ]
}
```

V1 方案仍可读取；一旦在开发者模式中增加新能力，方案会升级为 V2。

## 能力白名单

基础环境与既有 runtime 能力：

- `environment.palette`、`atmosphere.fog`
- `lighting.hemisphere`、`lighting.sun`
- `presentation.exposure`
- `runtime.surface-style`
- `runtime.outline-style`
- `runtime.presentation-style`

新增能力：

- `runtime.color-grade`：冷暖、对比度、饱和度、暗部抬升、Tint 和命名配方
- `runtime.water-style`：湖泊/河流配方、透明度、浅水/深水颜色、波纹、泡沫、环境/平面反射强度、平面反射扰动和 Fresnel
- `runtime.material-theme`：按 `material-tag` 或 `asset-tag` 批量应用材质主题
- `runtime.light-rig`：柔和晨光、硬日光、逆光、阴天和黄昏等灯光配方
- `runtime.post-quality`：Bloom、SSAO 和景深的高层选择
- `runtime.effect-recipe`：按标签组合发光、Fresnel、火焰和魔法特效配方
- `runtime.shader-extension`：仅专业开发者可保存白名单片段或隔离 GLSL

`water-style`、`material-theme` 和 `effect-recipe` 是可重复模块，每个实例都有稳定 `key` 和作用域。材质遍历始终限制在 `modelsRoot`，不会改写编辑器辅助物或整个 Three.js 场景。

当前执行状态：

- 色彩分级、灯光配方、标签材质、Bloom、SSAO 和标签特效已接入真实预览。
- 水体可同时作用于结构化湖泊/河流和带 `water` 标签的模型水面。
- 景深目前只有高层协议，宿主暂不执行。
- 完整 GLSL 可在开发者方案中隔离保存，但当前宿主不编译执行，也不会修改核心源码。

## 每个方案自己的开放策略

渲染方案保存 `accessPolicy`。每个参数分别记录：

- 控件形式：滑条、精确数值、下拉、开关、颜色或代码
- 是否允许基础 AI 调整
- 是否允许开发者调整
- AI 数值范围或枚举白名单
- 开发者数值范围或枚举白名单

开发者模式先显示预设当前值，再显示开放策略。数值参数使用“滑条 + 精确数值框 + 当前值”，修改后立即刷新画面；当前值滑条使用 capability 的完整安全范围，AI/开发者实际可调的子区间仍由方案的 `accessPolicy` 单独限制。这样开发者可以先探索合适效果，再收窄开放范围。保存始终生成新方案，不覆盖内置预设。

AI 输出会按所选基础方案的策略再次校验。未知模块、未知参数、非法作用域、重复的非重复模块、非法颜色或未授权参数会失败；越界数值会裁剪到对应角色的许可范围。首次结果失败时，服务端会把具体原因交给模型修正一次，仍失败则终止生成。Shader 扩展不会进入基础 AI 提示词。

## 执行与版本边界

校验后的计划会编译为环境、表面、描边、presentation、色彩、灯光、后处理和标签作用域能力，并随自定义渲染方案保存。地图只保存 `renderSchemeId`，所以同一方案可被多张地图复用。

World Sketch 默认通过 normal/depth 重建世界位置并做三平面投影；Screen / Print 仅作为明确选择的印刷网纹模式。明确写出“素描、漫画、水墨、卡通”等风格而计划遗漏对应模块时，服务端会使用现有的一次修正机会要求模型补齐。

当前通过 Vite 将包名映射到相邻 `3d-generate/packages/voxel-render-runtime` 的公共入口，并统一使用 runtime peer 支持的 Three.js r160。`RenderPlan` 不依赖 Three.js 版本，多版本差异后续由 host adapter 处理。
