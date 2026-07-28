# WorldForge Studio

WorldForge Studio 是从 `hAIde-seek` 中独立提取的 Three.js 场景编辑器。这个仓库只保留地图、地形、资产与本地编辑服务，不包含原游戏、联机房间、WebSocket 或 Electron。

## 当前初版

已经可用：

- 创建、切换和保存场景
- 编辑场景尺寸、六面颜色和光照方向
- 平滑高度场地形笔刷
- 表面绘制
- 对象层级、变换与资产绑定
- 调用现有 Voxel Studio 后端生成模型资产
- 本地文件存储和供 Agent 使用的 HTTP/CLI 编辑接口

还未实现：

- 基础版自然语言地图生成
- 专业版 Agent 事务执行、权限确认、取消与撤销
- 地图确认后进入渲染阶段
- 可复用 `renderSchemeId` 与渲染方案 refine
- 结构化道路、湖泊与河流
- `assetTags`、批量材质替换和 Shader 安全管线

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

默认数据目录为 `data/map-editor`，其中地图与资产分开保存。可以通过 `WORLDFORGE_DATA_DIR` 指定其他目录。

地图命令：

```bash
npm run map -- help
```

Agent 应优先使用 CLI 或 `/api/editor`，不要直接改写数据文件。

## 来源

初版编辑器提取自本地 `hAIde-seek` 的提交 `dd5067879257127d5b0059a71cf1950fe0687f9e`，新仓库采用独立 Git 历史。
