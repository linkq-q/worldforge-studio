# WorldForge Studio 策划交接

## 交付内容

- `worldforge-golden-pack-YYYY-MM-DD.zip`：九张可直接导入的金样场景；每张内含地图、模型资产、渲染方案，以及它实际使用的 HDRI。适合通过微信等渠道单独发送。
- `assets/starter-data/`：Git 跟踪的首次启动种子；空白数据目录会自动获得九张金样及其引用资源。
- `assets/hdri/`：Git LFS 跟踪的完整共享 HDRI 库；克隆并完成 LFS 下载后可直接使用。
- `data/map-editor/`：本机工作数据。它不进入 Git，并且优先覆盖同名共享 HDRI；已有数据目录不会被首次启动种子覆盖。

金样不是“唯一正确的地图”，而是稳定的验收基线：新同学导入后，应能看到与当前版本相同的草、水、模型、HDRI、材质 Tag、渲染方案和游玩视角。后续版本变更后，也可用它们快速检查是否发生明显回退。

## Windows 启动

1. 安装 Node.js 20 或更高版本，以及 Git LFS；无需安装或检出 `3d-generate`。
2. PowerShell 进入 `worldforge-studio`：依次执行 `git lfs install`、`git lfs pull`、`npm install`（首次一次）。
3. 启动：`npm run dev`。
4. 浏览器打开 `http://localhost:5173`；若本机没有既有工作数据，会自动出现九张金样。

## 策划日常操作

1. 顶栏左侧地图菜单：选择地图、重命名、创建或删除地图。
2. 地图阶段：输入一句提示词，点击“生成新规划”；查看 AI 预览后选择应用或放弃。已有地图用“调整当前地图”继续 Refine。
3. 确认地图后进入“渲染”：可套用方案、生成方案或继续 Refine；开发者模式才用于调整开放参数范围。
4. 顶栏“游玩”从出生点检视实际视角；Esc 退出。
5. 点击“保存”；顶栏“更多”可导出地图、渲染方案或完整场景包。
6. 生成失败时查看进度卡片的具体阶段；网络错误可重试，资产生成会在单个资产失败时自动重试。

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
