# 分层世界规划实验：AI 规划，程序执行

状态：独立工作树 `codex/terrain-biome-lab`，在 64×64 km 连续地形上完成两批可运行实验。原编辑器、运行时 data、正式保存协议没有改变。64km样例继续使用比例白模；500米样例已接入现有中世纪资产与低丘，仍不代表完成美术。

## 分工和已经接通的链路

```text
用户描述
  → 当前 Codex 编写 WorldPlan（群落配方、城镇位置、公共道路、生态规则）
  → 验证并导出 TownTask（范围、道路出口、地基、过渡宽度、版本）
  → 城镇子 agent 分别编写 TownPatch（用途、街道、建筑占地）
  → 校验并合并 WorldBundle
  → 共享地表采样器 + 固定生态分块
  → 近景实例渲染 / 中距简化模型 / 远景群落底色
```

第一批：程序生态。第二批：区域任务、独立城镇与渐变合并。两批均接入实验页和验证工具，不依赖新 npm 包。

规划调用由当前 Codex 会话承担。本轮的世界计划由主 agent 编写，城镇任务由专用子 agent 分别完成，产物在 scripts/fixtures/。页面“加载分层规划样例”加载的是这些实际产物。页面原有“方位+群落”输入仍是有界语法解析器，未伪装成在线 LLM。导入界面支持新 WorldPlan、完整 WorldBundle 和单独 TownPatch。

## 生态怎样避免大地图开销

- 保存 seed 与 EcologyRule；没有全世界树坐标清单。
- 生态块固定为 256 m，与会变化的地形 LOD 网格独立。当前视距只选 5×5，最多 25 块；缓存最多 49 块。总览视距超过约 3 km 时停止单株显示，有 300 m 回差。
- 候选 ID 由 seed、规则 ID、全局格坐标组成。负坐标使用 floor。
- 先用原始候选的局部优先级解决间距，再用群落权重、坡度、道路退让、城镇渐变密度筛选。跨块查询有限邻域，加载顺序不影响结果。
- 调密度仅改变接受阈值。规则 ID、间距等不变时，低密度集合是高密度集合的子集；共同植株的位置、旋转、尺度不变。
- 分块按 broadleaf / pine / shrub / rock 合并为 InstancedMesh。中距去掉树干、降低树冠面数，切换有回差。没有给每棵树创建独立场景节点或物理碰撞体。
- UI 滑块是规则密度的预览倍数；正式调整由 AI 修改 WorldPlan.ecology。改变规则 ID、间距或种子会改变候选集合，不承诺保留位置。

当前性能预算有明确上限：8 条生态规则，间距 6–100 m，scale 不超过 8；世界 8–256 km。不是无限生成和无上限物种系统。全部世界道路及已完成城镇道路合计最多 32,768 个细分顶点，导入超预算计划会被拒绝。

## 城镇怎样独立生成、再嵌合

WorldPlan 使用现有 MapGuide 道路结构，不复制小地图的全局对象列表。城镇采用局部坐标，首版区域是正方形。世界规划器固定中心、核心半宽、地基高度、过渡带和公共道路出口。

子任务只能提交自身街道和建筑。验证器拒绝旧 worldKey、未知字段、越界建筑、建筑重叠、道路占地冲突、缺失/错宽出口、不连通路网和重复 ID。交叉道路只有明确共享顶点才视为连通。worldKey 是完整规范化计划内容，世界计划改变后需重新签发任务。一次局部合并先完全验证，再替换对应城镇；失败保持已有计划不变。不同任务完成顺序得到相同规范化结果。

“扩散式嵌合”首版实现为有限过渡带，不调用生成式 diffusion 模型：

- 完成的城镇核心使用规划地基高程，外圈用五次平滑权重过渡到连续原始地形；带外精确保持原值。
- 植被沿同一过渡宽度渐变变稀；完成城镇允许空地绿化，未完成城镇提前预留整个建设核心。
- 道路出口位置和宽度必须一致，不能靠模糊地形解决路网错位。
- 建设核心保持不重叠，过渡带可重叠；使用归一化权重融合，核心精确保持所属地基高程。区域仍为方形，尚未实现任意多边形或完整扩散方程求解。
- 核心土地/地基差值、外圈坡度、世界道路的水面和坡度做有限采样诊断；不是连续导航或碰撞的数学证明。

样例：林间工坊镇 31 栋/7 条街道；沙漠商队镇 33 栋/10 条街道；一条跨区商路。前者为错落分叉巷道，后者为集市环街和商队院落。建筑用途保留在计划中，白模外观尚不表达全部语义差异。

## 重跑与交给 Agent 的工作流程

在独立工作树根目录运行：

```powershell
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5193 --strictPort
```

打开 http://127.0.0.1:5193/scripts/terrainBiomeLab.html，点击“加载分层规划样例”。可选城镇、进入林地、调整密度和运行镜头巡检。Ctrl+C 停止服务。已有服务运行时无需重复启动。

CLI 不调用模型、不自动绑定过期输出、不写 data/：

```powershell
node --import tsx scripts/worldPlanner.ts validate scripts/fixtures/world-plan.json
node --import tsx scripts/worldPlanner.ts tasks scripts/fixtures/world-plan.json output/terrain-biome-lab/town-tasks
node --import tsx scripts/worldPlanner.ts merge scripts/fixtures/world-plan.json scripts/fixtures/forest-town.json scripts/fixtures/oasis-town.json --out output/terrain-biome-lab/world-bundle.json
node --import tsx scripts/benchmarkWorldPlanning.ts
```

新描述的 Agent 操作顺序：

1. 读取 src/shared/worldPlanning.ts 与 worldEcology.ts 的契约，编写 WorldPlan。先在共享世界采样器上寻找地形合适的城镇位置；不要为满足布局无条件填海、削山。
2. CLI validate 成功后导出 tasks。若用户授权并行，每个子 agent 只处理自己的 TownTask，直接复制输入 worldKey，遵守端口和局部边界。
3. 子 agent 输出不同功能结构的街道和建筑占地，不输出树林散点。所有使用同一条路的支路必须有共同顶点。
4. CLI merge 返回具体拒绝原因时修复所属任务，然后重试。不要改 worldKey 绕开版本冲突。
5. 导入 Bundle 后检查城镇近景、道路连接和自然边界；要重做某城镇，仅导入对应 TownPatch。
6. 原编辑器适配应另做：沿用 MapOperation[] 事务、版本和撤销，但持久化大世界配方/局部差异，不能把 64 km 展开成旧 EditableMap 的全量对象与 513×513 高度数组。

## 验证记录

本轮最终全量使用 npm.cmd test -- --maxWorkers=2：138 个测试文件、1091 项通过；npm run build 通过，保留既有大 bundle 提示。默认并发的一次复测有9项既有测试超过5秒并伴随临时目录清理竞态，降低并发后全部通过；未修改测试断言或超时。原失败日志 full-tests.log 与最终 full-tests-bounded.log 均保留，便于区分。实验页为 Vite 开发入口，生产 build 未把它作为发布页面。新增测试覆盖密度包含关系、跨块竞争、负坐标、道路避让、坡度、预算、旧版本拒绝、路网连通、碰撞、合并顺序、局部保持和共享地表法线。

[CPU 报告](../output/terrain-biome-lab/planning-benchmark.json)：16/64/256 km 在相同近景预算下都只生成 25 块，原始候选约 3.13 万，接受实例分别 710/661/722；单块生成 P95 约 4.24/3.53/3.78 ms。这是当前机器 Node CPU 结果，不是 GPU 帧率保证。密度 0.25/0.5/1/2 倍，测试块实例 3/10/25/49，共同实例属性完全一致。

[浏览器巡检报告](../output/terrain-biome-lab/planning-browser-survey.json) 记录两个城镇和一个林地位置：加载完成后各旋转 2 秒，P95 帧时间约 16.9 ms，318–702 个生态实例，81–94 个 draw calls，生态块生成 P95 约 2.9–3.0 ms。UI 另已验证 0 倍密度清空植被、2 倍增密、旧版本拒绝保持原世界、有效单镇计划导入。控制台无 error/warn。巡检在每站加载完成后旋转 2 秒，不能代表高速连续飞行或复杂生产资产的表现。

## 当前边界

- 可以通过当前 Codex → 文件契约 → 页面导入完成新世界；未接页面上的实时模型请求或后台自动 agent 调度。
- 64km样例使用白模；500米样例已接入四种静态资产快照和基础阴影。没有真实草地细节、风、完整园林、导航和碰撞。
- 导入局部计划保持数据层的无关内容不变；预览目前会重新准备 terrain/生态缓存，未实现修改区块级缓存失效。
- 城镇总数上限 12、每镇 128 栋；城镇模型暂全量驻留，有视锥剔除。更大城镇数量需要建筑分块流式加载。
- 道路跟随地表，未求解完整纵断面、桥隧、道路交叉口或城镇路网生成器；AI 输出只负责布局。
- 地形仍沿用前一批连续采样器和 LOD 裙边，远近切换可能跳变；局部高度场没有河网与侵蚀。

## 研究依据

- [CityEngine Graphs](https://doc.arcgis.com/en/cityengine/latest/help/help-graph-layer.htm)：道路节点/线段形成街区，支持先骨架再局部内容。
- [Houdini HeightField Layer](https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_layer.html)：高度场按 mask 合成，mask 外保留底层。
- [Matérn 模型研究报告](https://data.math.au.dk/publications/csgb/2013/math-csgb-2013-05.pdf)：有限邻域原始候选竞争；此实现借鉴其思想，抖动网格不宣称严格 Poisson disk。
- [Bridson 原论文](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf)：有限域 Poisson disk；独立逐块运行不能自动保证边界一致。
- [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)：重复 geometry/material 的批量渲染、矩阵及包围体更新。
- [CityGenAgent](https://arxiv.org/html/2602.05362v1)：街区用途/占地与建筑程序分层。论文包含专门训练；本实验不声称复现其质量。


## 预览证据

![林间工坊镇与周围程序生态](../output/terrain-biome-lab/forest-town.png)

![沙漠商队镇](../output/terrain-biome-lab/oasis-town.png)

![按需生成的林地](../output/terrain-biome-lab/procedural-forest.png)


## 500×500 米自然聚落与中世纪资产预览

当前地址：http://127.0.0.1:5193/scripts/terrainBiomeLab.html?demo=compact 。刷新保留样例，默认斜视全图；“俯视”看分布，选择城镇或双击地面进入近景。

已替换第一版等大方格/等距房屋：老集市27栋、工坊街15栋、林园住居13栋、新街住居20栋，共75栋。核心半宽分别80/55/60/65米，以5条弯折公共道路连接；各镇使用不同的支巷骨架。重复地块沿街生成，错开间距与退距，门面朝向道路。旋转占地用保守的轴对齐包围盒检查；完成的城镇仅排除建筑和道路占地，空地保留35%的基础绿化密度，过渡带连续混合。未完成城镇仍预留核心区。

在用户认可的布局上增加5处局部地形变化，幅度6/22/26/28米。landforms 使用椭圆范围内的 (1-r²)^3 高程叠加，边界一、二阶导数归零，范围外保持原地形；目前最多16项，幅度不超过500米。聚落地基按核心区高程上下界平衡挖填，原有改造额度与坡度检查保持有效。500米道路以2米间距贴地采样，上浮0.12米避免深度冲突；道路细分同时计入共享几何预算。全域采样高程约152–199米，属于低丘实验，不是山地或侵蚀模拟。

用户选定复用的资产来自本地编辑器地图“环巷与集市组成的中世纪城镇”（map-09d705ff-5c13-48ce），通过只读API导出至 scripts/fixtures/medieval-assets.json：
- asset-fcf47977-3477-4321：木架民居。
- asset-44b4b653-aeaa-4cb2：带店面的石屋。
- asset-00e544fb-f018-4a87：红瓦工坊。
- asset-c985c7df-95b4-4b5a：果树。

建筑按用途选择三类模型，以实际包围盒等比缩放到既定地块，保留模型高度比例和朝向。复用 modelRenderer 的层级、颜色与原点处理，通过可选的本地 runtime 注入加载；既有调用路径保持原值。每种静态资产合并为一套顶点色几何，再用 InstancedMesh 重复绘制。树木沿用已有程序散布，近景使用果树资产，灌木与远景植被仍为简模。没有调用外部生成服务，也没有改写原编辑器地图或 data 文件。

复现布局：node --import tsx scripts/buildCompactTownDemo.ts。当前资产快照可独立于编辑器API预览；不是实时绑定资产库。

验证：
- npm.cmd test -- --maxWorkers=2：140个文件、1101项通过；npm.cmd run build 通过，仅有既有的大包提示。日志 medieval-full-tests.log / medieval-build.log。
- 新增检查覆盖完成聚落内绿化、旋转占地、过渡带重叠连续性、局部山丘边界、离线加载资产、实际模型落地/地块约束和共享几何释放。
- 浏览器全图、集市近景及5站各2秒旋转巡检均完成，无 error/warn。375株植被/4个生态块，P95帧时间约16.8ms，巡检记录的draw calls为34–76；模型装载与合并约125ms，地形首屏约482ms（从资产准备完毕后计时）。
- 指标是本机短程巡检，未证明64km密集生产资产场景的表现。residentGeometryMiB 只统计地形网格，不是总GPU显存。实验页仍为Vite开发入口，生产构建尚未发布该页面。

[镜头巡检数据](../output/terrain-biome-lab/medieval-browser-survey.json)

![500米中世纪聚落全图](../output/terrain-biome-lab/medieval-overview.png)

![集市模型近景](../output/terrain-biome-lab/medieval-closeup.png)
