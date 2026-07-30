# WorldForge Studio

WorldForge Studio 是从 `hAIde-seek` 中独立提取的 Three.js 场景编辑器。这个仓库只保留地图、地形、资产与本地编辑服务，不包含原游戏、联机房间、WebSocket 或 Electron。

## 当前初版

已经可用：

- 创建、切换和保存场景
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
- 通过受控地图 Agent 将提示词转换为可预览、可放弃、可整笔撤销的地形与资产摆放事务
- 地图 Agent 可生成结构化湖泊与河流，并在渲染阶段复用同一套 `runtime.water-style`
- 地图 Agent 会检查共享资产库，自动调用 Voxel Studio 生成最多 3 类缺失资产，再用真实资产 ID 重新规划
- 将地图提示中的氛围语义保存为渲染阶段建议，不自动混入地图生成
- 调用现有 Voxel Studio 后端生成模型资产
- 本地文件存储和供 Agent 使用的 HTTP/CLI 编辑接口
- 基础 AI 与外部 Agent 共用的地图操作协议
- 原子提交一批地图操作，并撤销最近一次事务

还未实现：

- 专业版 Agent 权限确认与长任务取消
- 多级 AI/Agent 事务历史（当前仅保存并撤销最近一次事务；手工编辑已有多级撤销）
- 渲染方案多轮 refine 对话与更多可用模型（当前生成失败时只自动修正一次）
- 完整的 Shader 隔离编译与预览管线（当前只允许专业模式保存隔离代码，不执行）
- 景深执行适配器（当前已有高层协议和权限配置）
- 结构化道路
- 用户手工维护 `assetTags` 的界面（当前会从资产名称、提示词和显式标签自动派生）

这些边界记录在 [docs/architecture.md](docs/architecture.md)。

## 启动

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`。本地编辑 API 运行在 `http://localhost:8787`。

生产构建：

```bash
npm run build
npm run server
```

此时打开 `http://127.0.0.1:8787`。

## 数据

默认数据目录为 `data/map-editor`，其中地图、资产与自定义渲染方案分开保存。可以通过 `WORLDFORGE_DATA_DIR` 指定其他目录。

地图命令：

```bash
npm run map -- help
```

Agent 应优先使用 CLI 或 `/api/editor`，不要直接改写数据文件。

事务操作格式和调用方式见 [docs/map-transactions.md](docs/map-transactions.md)。

渲染 AI 使用的模块白名单、校验和保存格式见 [docs/render-plan.md](docs/render-plan.md)。

## 来源

初版编辑器提取自本地 `hAIde-seek` 的提交 `dd5067879257127d5b0059a71cf1950fe0687f9e`，新仓库采用独立 Git 历史。
