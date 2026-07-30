# 新版渲染能力接入：中断恢复记录

> 状态：已于 2026-07-30 恢复并完成。未提交、未 push。

## 本轮目标

把 Codex 任务 `019fadb6-024a-7701-99d5-3b3be9ab26b6` 中已验收并合并到
`3d-generate/private/my-dev` 的新版渲染能力接入 WorldForge，并扩大基础版 AI 的安全白名单。

已确认目标能力不是旧的全屏网格滤镜，而是统一风格链：

- 表面：PBR / Cel
- 统一描边：Clean / Ink / Echo / Curvature
- 呈现：World Sketch / Comic Clean / Comic Print
- World Sketch 默认使用 normal/depth 预通道重建世界位置，以三平面投影让排线跟随模型表面；旧 Screen / Print 网纹只作为可选模式
- 完整素描应能组合世界空间排线、共享 Ink/EdgeMask 轮廓和纸张质感

上游代码已确认位于 `3d-generate/private/my-dev`，当前提交为 `02fa8d7`；
Stylized Outline 合并提交为 `5ca6b29`，公共入口包括：

- `@voxel-studio/render-runtime/outline`
- `@voxel-studio/render-runtime/postprocess`

## 已完成

1. 读取并核对了任务 `019fadb6-024a-7701-99d5-3b3be9ab26b6` 的 P0-P4 结论。
2. 对照了当前 runtime 的公共导出、预设和 Pass：
   `ArtisticOutlineController`、`ARTISTIC_OUTLINE_PRESETS`、`COMIC_LOOK_PRESETS`、
   `BoundaryIdPass`、`EdgeMaskPass`、`InkEdgePass`、`CurvatureEdgePass`、
   `SketchHatchPass`、`ComicPrintPass`、`PaperTexturePass`。
3. 找到现有偏差根因：`src/client/renderRuntimeAdapter.ts` 强制设置
   `uHatchSpaceMode = 0`，因此使用的是旧的全屏 Screen / Print 网纹；它也没有提供
   World Sketch 所需的 normal/depth 预通道。
4. 已先修改测试目标（尚未修改生产实现）：
   - `tests/renderAi.test.ts`
   - `tests/renderScheme.test.ts`
5. 已运行这两个测试文件并得到预期失败基线：18 项中 11 通过、7 失败。失败点正好覆盖：
   - 尚无 `runtime.outline-style`
   - presentation 尚不接受世界空间参数与 Comic 模式
   - 尚无 Comic Clean / Print 内置方案
   - 明确要求素描但 AI 忽略时，当前不会触发一次修正调用

## 完成结果

1. `RenderPlan` 已开放并编译以下安全能力：
   - `runtime.outline-style`：`none/clean/ink/echo/curvature` 与受限参数
   - `runtime.presentation-style`：`none/sketch/comic-clean/comic-print`
   - World Sketch 的坐标空间、世界密度、排线和纸张参数
   - Comic 命名配方内的网点、套印和线条微调
2. 明确要求素描、漫画、水墨或卡通但计划遗漏时，会进入已有的一次修正流程。
3. `RenderRuntimeAdapter` 已接入 normal/depth、Boundary ID、EdgeMask、Ink、Curvature、Paper、Comic 和 World Sketch：
   - normal/depth 只渲染地图内容根
   - 物体/材质 ID 只遍历 `modelsRoot`
   - 编辑器 gizmo、辅助物与透明物不进入预通道
4. 内置“淡彩素描晨雾”已升级为 World Sketch + Ink + Paper，并新增“清线漫画”“套色漫画”。
5. 协议、架构、README、类型声明和 Vite 公共入口已同步。
6. 验证结果：
   - 初始失败基线：18 项中 11 通过、7 失败
   - 聚焦测试：18/18 通过
   - 全量测试：56/56 通过
   - `npm run build` 通过
   - 浏览器检查覆盖 World Sketch、Comic Clean、Comic Print 和切回自然日光
   - 无 Shader / WebGL error；选中框保持独立，不进入素描排线

## 工作区注意

- `worldforge-studio` 当前原本就有大量未提交改动；全部保留，不要使用 `git add .`。
- 本轮生产代码、测试与文档改动仍保持未提交状态。
- `3d-generate` 主工作区也有用户原有 `.claude/*`、`agentworld-test` 和 `.workbuddy` 未提交内容，不要碰。
- `C:\tmp\3d-generate-render-runtime-v2` 工作树仍有用户改动，不能清理。

## 2026-07-30：能力白名单与开发者模式

- `RenderPlan` 升级为兼容 V1 的 V2，支持带 `key/scope` 的重复能力。
- 接入色彩分级、模型水面、标签材质、灯光配方、Bloom/SSAO 和标签特效。
- 每个渲染方案新增独立 `accessPolicy`，分别限制 AI 与开发者的参数、范围、枚举值和控件形式。
- 开发者模式可编辑预设值与权限；数值参数提供滑条、精确数值和当前值，修改后实时刷新画面。
- Shader 扩展只对专业开发者开放；当前只保存隔离代码，不编译执行。
- 结构化湖泊/河流已接入 `runtime.water-style`；景深执行仍待后续宿主接线。
