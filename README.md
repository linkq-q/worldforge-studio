# WorldForge Studio

WorldForge Studio 是从 `hAIde-seek` 中独立提取的 Three.js 场景编辑器。这个仓库只保留地图、地形、资产与本地编辑服务，不包含原游戏、联机房间、WebSocket 或 Electron。

## 当前初版

已经可用：

- 按小（48×12×48）、中（96×16×96）、大（192×24×192）三档创建、切换和保存场景，地形分辨率随档位调整
- 编辑场景尺寸、六面颜色和光照方向
- 平滑高度场地形笔刷
- 表面绘制
- 对象层级、变换与资产绑定
- 右键旋转、中键平移、视角预设与聚焦
- 手工编辑撤销/重做、未保存离开保护
- 资产预览后点击地形落地
- 确认地图后进入独立渲染阶段
- 为地图选择可复用的渲染方案，并在白名单内微调后另存新方案
- 通过 Voxel Studio `/api/chat` 将风格提示词转换为受限 RenderPlan，组合环境、雾、光照、曝光与 runtime 风格模块
- 通过 `@voxel-studio/render-runtime` 公共入口应用卡通表面、统一描边、世界空间素描与漫画印刷能力；内置“卡通日光”“淡彩素描晨雾”“清线漫画”和“套色漫画”可离线验收
- 组合色彩分级、命名灯光、Bloom/SSAO、标签材质、水体与标签特效；所有批量材质操作只作用于地图模型根
- 开发者模式可为每个渲染方案配置 AI/开发者权限、数值范围、枚举白名单和控件形式；数值参数以滑条与精确值实时预览
- 通过“场景总导演 → 按需专家 → 确定性编译 → 合成审查”的有界地图 Agent，将提示词转换为可预览、可放弃、可整笔撤销/重做的地形与资产摆放事务
- 地图 Agent 可生成结构化湖泊与河流，并在渲染阶段复用同一套 `runtime.water-style`
- 地图 Agent 以分布意图散布植被和岩石，由确定性散布器负责坐标、避水、坡度、间距与旋转缩放抖动
- 地图 Agent 先按区块、主次、过渡、资产家族和尺度组织完整场景；只从地图所选建模模式中匹配资产，并按小/中/大地图自动调用 Voxel Studio 生成最多 3/5/8 类必要缺失资产
- 地图与渲染分别支持多轮 Refine：地图用差量操作增删改对象/水域，渲染锁定当前基础方案并只修改用户点名的白名单能力；两者继续使用预览、放弃和事务确认
- Agent 请求会实时展示场景构图、动态专家、资产解析/生成、编译、合成审查、校验与完成阶段，并保留取消入口
- 将地图提示中的氛围语义保存为渲染阶段建议，不自动混入地图生成
- 调用现有 Voxel Studio 后端生成模型资产，并随请求发送 runtime 包的 `material-tags-v1` 词表；返回标签由同一套编译器应用到模型部件
- 结构化湖泊/河流与模型 `water:pool` / `water:fall` 标签使用 Voxel Render Runtime 的 `WaterSurface` / `WaterfallSurface` 材质
- 本地文件存储和供 Agent 使用的 HTTP/CLI 编辑接口
- 基础 AI 与外部 Agent 共用的地图操作协议
- 原子提交一批地图操作，并撤销/重做最近一次事务

还未实现：

- 专业版 Agent 权限确认与长任务取消
- 多级 AI/Agent 事务历史（当前为单步撤销/重做；手工编辑已有多级撤销/重做）
- 更多可用模型（当前生成失败时只自动修正一次）
- 完整的 Shader 隔离编译与预览管线（当前只允许专业模式保存隔离代码，不执行）
- 景深执行适配器（当前已有高层协议和权限配置）
- 结构化道路
- 用户手工维护 `assetTags` 的界面（当前会从资产名称、提示词和显式标签自动派生）

这些边界记录在 [docs/architecture.md](docs/architecture.md)。

## 启动

需要 Node.js 20 或更高版本，以及 Git LFS（用于完整 HDRI 天空库）。不再需要同级的 `3d-generate` 仓库。

```bash
git lfs install
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`。本地编辑 API 默认运行在 `http://localhost:8797`。

渲染 Runtime 已作为固定快照随本仓库发布，并与本仓库的同一份 `three` 一起安装，避免出现两个 Three.js 实例导致的材质、后处理异常。首次启动空白数据目录时，会自动导入四张金样地图及其引用资产、渲染方案；已有 `data/map-editor` 不会被覆盖。

若克隆时使用了 `GIT_LFS_SKIP_SMUDGE=1`，请在启动前补跑 `git lfs pull`，否则 HDRI 仍只是占位指针文件。

## 对外交付

两个可以被下游项目直接依赖的入口。下游项目按 `file:` 或 git 依赖引入本仓库即可：

```bash
npm install file:../worldforge-studio
```

### `worldforge-studio/map-core` — 玩法与服务端

`src/shared/` 打包成的**零依赖 ESM**：没有 `three`、没有 DOM、没有 Node 内置模块。地图 schema、地形采样、碰撞烘焙、出生点安全检查、水体查询都在里面，浏览器和 Node 服务端都能直接跑。

```bash
npm run build:map-core   # 产物在 dist-map-core/，构建后会跑一次 Node 冒烟检查
```

```js
import { bakeMapCollisions, movePlayerPositionForMap, findSafeSpawnPosition } from 'worldforge-studio/map-core';

const obstacles = bakeMapCollisions(map);
const [x, z] = findSafeSpawnPosition(map, 0, 0);
const next = movePlayerPositionForMap(position, delta, map, obstacles);
```

地图/渲染 AI 流水线和编辑器事务协议**不在**导出范围内，它们是 Studio 内部实现。

### `worldforge-studio/viewer` — 渲染这张图

把 `EditableMap + RenderScheme` 渲染成编辑器里看到的样子。以 TypeScript 源码形式导出，所以下游必须是 Vite/同栈项目，并复用同一套别名：

```ts
// 下游项目的 vite.config.ts
import { voxelStudioAliases } from 'worldforge-studio/vite';

export default defineConfig({
  resolve: { alias: voxelStudioAliases(process.env.VOXEL_STUDIO_ROOT) }
});
```

```ts
import { createMapViewer } from 'worldforge-studio/viewer';

const viewer = await createMapViewer({ canvas, map, scheme });
viewer.camera.position.set(20, 14, 20);
// 默认自带 requestAnimationFrame 循环；要接自己的游戏主循环就传 autoStart: false，
// 然后每帧调用 viewer.tick(deltaTime)。
```

资产随 `map.assets[].modelJson` 一起传输，不需要额外下载；渲染方案引用的 HDRI 全景图是唯一的外部文件，用 `hdriUrl` 选项告诉 viewer 去哪里取。

编辑器和 viewer 共用 `src/client/renderSceneRuntime.ts`：场景、灯光、阴影、后处理和渲染方案的应用只有这一份实现，所以两边的画面不会分叉。

生产构建：

```bash
npm run build
npm run server
```

此时打开 `http://127.0.0.1:8797`。

## 数据

默认数据目录为 `data/map-editor`，其中地图、资产与自定义渲染方案分开保存。可以通过 `WORLDFORGE_DATA_DIR` 指定其他目录。

地图命令：

```bash
npm run map -- help
```

策划交接、金样场景包、备份和 HDRI 分发方式见 [docs/planner-handoff.md](docs/planner-handoff.md)。

Agent 应优先使用 CLI 或 `/api/editor`，不要直接改写数据文件。

事务操作格式和调用方式见 [docs/map-transactions.md](docs/map-transactions.md)。

渲染 AI 使用的模块白名单、校验和保存格式见 [docs/render-plan.md](docs/render-plan.md)。

## 来源

初版编辑器提取自本地 `hAIde-seek` 的提交 `dd5067879257127d5b0059a71cf1950fe0687f9e`，新仓库采用独立 Git 历史。
