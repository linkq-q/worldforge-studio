# WorldForge Studio 策划交接

## 本轮交接重点（2026-08-13）

- 新建地图时先选“室外 / 室内 / 室内 + 室外”。室内地图以参数化房间为边界，并保留可编辑的门窗预留位。
- 角色高度和“亲近 / 均衡 / 宏大”世界尺度会共同影响资产尺寸、家具间距、碰撞与质检；不要只靠视觉缩放修正比例。
- 室内 AI 可先输出俯视构图供确认，再生成完整场景；编译阶段会处理功能分区、家具关系、墙地顶依附、门口净空和主要通道。
- 缺失资产最多同时生成 3 个。进度卡片会显示每个资产的排队、生成、重试和失败状态；任一最终失败会中止本次事务，不会保存半套场景。
- 室内灯具可携带点光或聚光语义，渲染方案的晨间、正午、傍晚、夜间会同步驱动窗光、灯具和室内曝光。
- 室内色板、表面配方和程序化地毯正在接入地图美术方向；最终天空、雾、后处理仍属于地图确认后的渲染阶段。该批工作区改动尚未通过完整测试与构建，暂不作为稳定交付。
- 当前九张金样中，电影院、复古快餐店、服装店、餐厅用于室内流程验收；其余五张用于室外、地形、水体和通用渲染回归。

## 交付内容

- `worldforge-golden-pack-YYYY-MM-DD.zip`：九张可直接导入的金样场景；每张内含地图、模型资产、渲染方案，以及它实际使用的 HDRI。适合通过微信等渠道单独发送。
- `assets/starter-data/`：Git 跟踪的共享种子；空白数据目录会自动获得九张金样及其引用资源，后续新增的渲染方案和色卡会按文件补入一次。
- `assets/hdri/`：Git LFS 跟踪的完整共享 HDRI 库；克隆并完成 LFS 下载后可直接使用。
- `data/map-editor/`：本机工作数据。它不进入 Git，并且优先覆盖同名共享 HDRI；已有地图和资产不会被种子覆盖，同 ID 的本地渲染方案和色卡也保持不变。

金样不是“唯一正确的地图”，而是稳定的验收基线：新同学导入后，应能看到与当前版本相同的草、水、模型、HDRI、材质 Tag、渲染方案和游玩视角。后续版本变更后，也可用它们快速检查是否发生明显回退。

## Windows 启动

1. 安装 Node.js 20 或更高版本，以及 Git LFS；无需安装或检出 `3d-generate`。
2. PowerShell 进入 `worldforge-studio`：依次执行 `git lfs install`、`git lfs pull`、`npm install`（首次一次）。
3. 启动：`npm run dev`。
4. 浏览器打开 `http://localhost:5180`；若本机没有既有工作数据，会自动出现九张金样。

## 策划日常操作

1. 顶栏左侧地图菜单：选择地图、重命名、创建或删除地图。新建时先确定场景类型、角色高度和世界尺度；室内场景再设置房间尺寸。
2. 地图阶段：输入一句提示词。室内场景可勾选先生成俯视规划，确认分区和动线后再继续；已有地图用“调整当前地图”做差量 Refine。
3. 查看 AI 预览和合成诊断后选择应用或放弃。门窗、家具、灯具、表面美术方向和自动修复应作为同一笔地图事务提交。
4. 资产生成时查看进度卡片中的并发任务状态；最终失败时先查看具体资产和原因，再缩小描述或检查模型服务。
5. 确认地图后进入“渲染”：可套用方案、生成方案或继续 Refine；开发者模式才用于调整开放参数范围。室内应至少检查一个日间和一个夜间方案。
6. 顶栏“游玩”从出生点检视实际视角，重点检查入口、主通道和人物尺度；Esc 退出。确认后点击“保存”，顶栏“更多”可导出地图、渲染方案或完整场景包。

## 室内场景验收

- 房间墙体、门窗预留和绑定模型位置一致；切换墙体显示方式时没有明显破面或遮挡。
- 家具与 1.6m 默认角色的比例合理，重复座椅或桌组保持模块化，不是一整屋不可编辑模型。
- 出生点、入口、主通道和主要活动区可通行；锁定对象不会被自动修复静默移动。
- 日间窗光方向合理，夜间主要活动区有实用灯覆盖；灯具模型与实际光源位置一致。
- 墙、地、顶、地毯和主要资产色板协调；表面纹理跨门窗分段后仍保持连续。
- 地图预览只确认布局和地图语义，天空、雾、曝光、后处理等最终风格留到渲染阶段确认。

## 开发者接手边界

- `src/shared/`：地图 schema、参数化房间、尺度、室内规划、灯光覆盖、美术方向、确定性编译和 lint。这里是客户端、服务端与 CLI 的共同规则源。
- `src/server/`：AI 提示、构图工作流、资产解析与最多 3 路并发生成。一次生成结果仍必须汇总为一个 `MapOperation[]` 事务。
- `src/client/`：编辑器交互、构图与进度面板、房间 / 表面 / 灯光渲染。不要在客户端另写一套地图归一化规则。
- `assets/starter-data/`：九张 Git 跟踪金样及其引用资源；修改金样后要重新生成并验证交接包。
- `data/map-editor/`：本机运行数据，禁止直接提交，也不要绕过 `/api/editor`、CLI 或编辑器事务手改。

改动室内生成或渲染后，至少执行：

```powershell
npm test
npm run build
```

编辑器相关改动还要实际检查：新建室内地图 → 俯视规划 → 生成 / 预览 → 应用 → 日夜渲染 → 游玩 → 撤销 / 重做。金样有变动时，再执行下文的交接包回环验证。

当前工作区验证状态：`npm test` 为 410/411 通过，室内色板漂移修复用例因 `empty_operations` 失败；`npm run build` 在 `mapRenderer.ts` 的房间表面类型检查处失败。接手者应先让这两项恢复为全绿，再把室内美术方向从“开发中”改为稳定能力。

## 导入金样

1. 解压 `worldforge-golden-pack-*.zip`。
2. 在编辑器顶栏“更多” > “导入文件…”。
3. 逐个导入 `scenes/` 下的 `.worldforge-scene.zip`。

每个场景包独立导入为新地图，不会覆盖现有地图；资产 ID、渲染方案和同名但内容不同的 HDRI 会自动避让。

## 生成或备份交接包

当前九张金样默认是：开阔平原、清新树林、樱花竹林、夕阳草原、电影院样例、复古快餐店样例、服装店样例、餐厅样例、海岛公园。

```powershell
npm run handoff:goldens
```

输出默认位于 `data/exports/worldforge-golden-pack-YYYY-MM-DD.zip`。如当天已生成过，脚本会停止而不是覆盖旧文件；可显式指定新文件名：

```powershell
npm run handoff:goldens -- --output 'D:\Share\worldforge-golden-pack.zip'
```

在交付前可执行一次无损回环检查；它会导入临时空数据目录并在结束时自动删除：

```powershell
npm run handoff:verify -- data/exports/worldforge-golden-pack-YYYY-MM-DD.zip
```

备份完整工作数据（地图、资产、渲染方案、HDRI、历史记录）：

```powershell
npm run backup:data
```

默认输出为 `data/backups/map-editor-时间戳/`，不会覆盖既有备份。若使用了 `WORLDFORGE_DATA_DIR`，该命令会备份那个目录。

## HDRI 分发与 GitHub

日常交接优先使用完整场景包：它只携带每张金样实际引用的 HDRI，体积最小，也不会依赖收件人的贴图库。

若同学需要**完整**天空库用于继续创作，复制整个 `data/map-editor/hdri/` 目录（包括可选的 `catalog.json`）到对方同一路径；不要只复制图片，否则开发者分类信息会丢失。

不要把 HDRI 直接提交到普通 Git：EXR/HDR 很大，删除文件后历史体积仍会永久增长。确认贴图许可允许再分发、且确实需要版本化共享时，单独建立 `assets/hdri/` 目录并使用 Git LFS：

```powershell
git lfs install
git lfs track "assets/hdri/*.exr" "assets/hdri/*.hdr"
git add .gitattributes assets/hdri
git commit -m "assets: add shared HDRI library"
```

当前工作目录 `data/map-editor/hdri/` 仍保持 Git 忽略；不要为了上传 HDRI 而取消整条 `data/` 忽略规则。

## 连通检查

本地编辑器 API：

```powershell
Invoke-WebRequest http://127.0.0.1:8797/api/health | Select-Object -Expand Content
```

实验室 Voxel Studio 后端（将占位地址替换为实际地址）：

```powershell
Invoke-WebRequest <VOXEL_STUDIO_BACKEND_URL>/health | Select-Object -Expand Content
```

两条都应返回包含 `ok: true` 的 JSON。前者失败说明本地服务未启动；后者失败时先检查 VPN、网络和实验室后端状态，再重试生成。
