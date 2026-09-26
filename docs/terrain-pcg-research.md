# 自然山脉与河谷：研究与首版落地

日期：2026-09-24。目标是清晰山脊、冲刷沟壑和山脚过渡；保留 WorldForge 的 Three.js、高度场与单事务编辑方式。

## 找回的上下文

- [调研 Houdini 与 UE5 地形生成](codex://threads/01a0b3b0-50e5-7813-a495-44f2cd84aa4e)：之前已经讨论了高度场、区域遮罩、侵蚀、LLM 控制参数，以及 Controllable Landscape 和 MESA。这次重新读取了对话，并核对官方资料与当前源码。
- 另一条 [AI 与程序约束的讨论](codex://threads/01a0b318-e3cc-7740-93bd-c52f79480c1d) 强调先做空间结构，再补细节。对地形的对应关系是：先定山脉和谷地，再做冲刷，最后布置道路、建筑与植被。

## “噪声图如何映射成山”

高度图可以看成二维表格：每个格子存放一个高度。对平面坐标 `(x,z)` 查表得到 `h`，对应三维顶点就是 `(x,h,z)`。连接相邻顶点成为三角形，再计算法线和光照，就能看到山坡。图片只是高度数据的一种保存形式，并不要求调用生图模型。

常见制作顺序是：

1. **大尺度轮廓**：决定山脉走向、谷地和海岸位置。
2. **多尺度噪声与遮罩**：低频控制宽阔起伏，高频控制局部变化；遮罩决定它们在哪里生效。脊状噪声和坐标扭曲能避免只得到圆包或规则条纹。
3. **侵蚀**：沿下坡方向汇流，切出沟谷；碎石从陡坡向下移动。更完整的模型还会搬运泥沙并在缓坡、谷底沉积。
4. **表面与散布**：根据坡度、高度、湿度等信息布置岩石、土壤、草地和植被。

这是一种可控的地貌近似，不是从一张任意噪声图精确反推真实地质历史。SideFX 的 [HeightField Noise](https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_noise) 提供分形、粗糙度、遮罩以及谷地细节抑制；[侵蚀指南](https://www.sidefx.com/docs/houdini/heightfields/erosion.html) 展示了沟道、沉积与多尺度迭代的作用。

UE 的 [PCG Framework](https://dev.epicgames.com/documentation/unreal-engine/procedural-content-generation-overview) 是通用程序化内容工具集，常见流程是在 Landscape 上取样、筛选并生成物体。它与塑造山体的高度场算法是相关但不同的环节。当前项目不需要迁移到 UE 或安装 Houdini 才能改进山形。

## 哪些研究适合引入

| 来源 | 可用于本项目的部分 | 当前决定 |
| --- | --- | --- |
| [Controllable Procedural Generation of Landscapes，ACM MM 2024](https://cg.cs.tsinghua.edu.cn/Shao-Kui/Papers/Landscape.pdf)、[作者代码](https://github.com/omegafantasy/ControllableLandscape) | LLM 把意图转成参数，程序优化布局、细化地形和布置内容 | 沿用现有 Scene Code → MapOperation 链路；借鉴分工，不搬整套 Unity/Python 工作流 |
| [Braun & Willett 2013](https://www.sciencedirect.com/science/article/pii/S0169555X12004618)、[Landlab Fastscape 文档](https://landlab.readthedocs.io/en/latest/generated/api/landlab.components.stream_power.fastscape_stream_power.html) | 集水面积、坡度驱动的河流下切；从下游向上游做隐式更新 | 本次实现轻量思路，不移植库；目前排序是 O(N log N)，并非论文完整 O(N) 算法 |
| [Visually Improved Erosion Algorithm，2022](https://arxiv.org/abs/2210.14496) | 图结构侵蚀、局部高度约束和降雨控制 | 下一阶段可借鉴保护区域与地形意图约束；本次未实现该论文算法 |
| [MESA，2025](https://arxiv.org/abs/2504.07210) | 用真实遥感高程数据训练文本条件地形扩散模型 | 可作为未来地形样本来源；本次没有下载模型、训练或接入推理 |
| [Houdini HeightField Erode](https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_erode) | 多尺度水蚀、热侵蚀及沉积、碎屑、流向等输出层 | 先改善形状与排水；完整泥沙输送及输出遮罩留待后续 |

## 当前代码的问题与修改

源码位置：`src/shared/terrainGeneration.ts`。

原有 `hills` 把四层平滑 value noise 映射为高度。局部 mountain/ridge 修改器主要把圆形、路径或多边形权重转为抬升，其中 walkable 模式还主动限制高度。因此扩大振幅并不等于获得有支脊、有沟谷的自然山地。

原有排水刻蚀有三个限制：选择最低邻点而非实际最陡坡；只执行一次，不受 `iterations` 控制；按汇流量削低高度，却没有以下游高度约束下切，可能继续挖低终点洼地。

本次落地：

- 增加 `mountains` 基础地貌，UI 名称“自然山脉”。使用坐标扭曲、分层脊状噪声及山脚包络；谷地抑制高频细节。根据网格限制细节频率，保留已有地图分辨率。
- 排水按世界距离计算最陡坡，集水量按实际格子面积累计。每轮重算流向，再从下游向上游更新高度；平坦洼地、边界出口及海平面以下不做河流下切。
- `iterations` 同时控制热侵蚀与排水刻蚀；强度为零时对应步骤跳过。默认迭代和强度仍由既有参数控制。
- 共享预设校验、编辑器选项、Scene Code 与基础规划提示已接入新地貌；原有丘陵算法不变。

已有地图保存的是烘焙后的高度数组，单纯加载不会重生成。重新执行历史 `terrain.refine` 操作会采用新算法，结果可能与旧版不同。

## 使用方式

编辑器“地形 → 整体地貌 → 自然山脉”可预览新山脉基底。当前地形面板没有单独的侵蚀控件；完整沟谷效果可通过 Agent/CLI 组合 `terrain.refine`，或直接打开本次研究地图。

标准完整 Scene Code 能这样组合：

```js
function plan(api) {
  api.terrain('mountains', {
    amplitude: 48, roughness: 0.65, direction: 25, seed: 42
  });
  api.refineTerrain({ erosion: 0.3, drainage: 0.55, iterations: 8, talus: 38 });
  // 后续再处理道路、建筑地基、水体与植被。
}
```

这个参数例子使用 `192 × 64 × 192` 米地图，不能原样假定适合 12 米高的小地图。`terrain.refine` 是全图操作，已有道路/地基需谨慎排序，不保证所有山坡可走。

研究地图：`PCG研究 · 自然山脉与河谷`，ID `map-ebc9edef-6ae9-4b47`。两个地形操作作为一个事务保存，已验证撤销回平地、重做精确恢复全部 16,641 个高度值。没有修改既有地图，没有应用最终渲染方案。

运行开发服务器时打开 [地形对比页](http://127.0.0.1:5180/scripts/terrainStudy.html)：丘陵、宽脊山体、排水刻蚀和局部平滑/坡道使用相同尺寸、种子、网格、镜头和 MapViewer。可切换 96 米与 192 米地图。该页只在内存中生成，不保存数据。

## 验证与边界

- 新增测试覆盖山脉种子确定性、方向变化、幅度与网格保留、排水轮数、终点不下挖、平地稳定、长方形格子的真实坡度，以及 Scene Code 到事务的调用链。
- 浏览器已看到新山脊与顺坡沟纹；129×129 网格、8 轮侵蚀在本机页面一次测量约 103 ms（仅地形操作，不含渲染构建；不是跨设备性能保证）。
- 仍然是高度场：一个 `(x,z)` 只有一个高度，不支持洞穴与倒悬。
- 当前不模拟完整水量、泥沙运输和沉积，也没有自动疏通封闭洼地。八邻域流向仍有网格方向偏差，细小沟纹受现有约 1.5 米格距限制。
- 后续优先级：先由实际场景验收山形，再考虑受保护的道路/建筑遮罩、沉积与流向语义层；更高精度地形应先测网格、碰撞与渲染成本。

## 村庄尺度的低起伏地形

项目当前小地图为 48×12×48 米，中地图为 96×16×96 米；高度维度是编辑空间上限，不是建议把地面抬升到该高度。此次演示使用 192×64×192 米，并不代表中地图应该拥有相同山势。

村庄地块可视作一片大地貌的局部，不需要在边界内塞入完整山脉。建议先尝试 15–40 米宽、0.5–3 米高差的缓坡；边缘土丘视构图使用 2–6 米高差；地面细节由地表材质承担。这些是待视觉验收的起点，不是统一的地理标准。

已增加 `terrain.brush` 的 `smooth` 模式：从笔触前的高度快照求加权邻域平均，再按笔刷圆形衰减混合，可反复软化局部尖点而不移动远处地形。已增加 `terrain.ramp`：起止点、宽度、端点高度（默认采样原地形）、边缘柔度和强度可控，用于道路与平台之间的连续坡度。两者都进入 `MapOperation[]` 事务，并通过标准/首轮 Scene Code 与 Scene Program 对 AI 开放；编辑器手动笔刷也新增“平滑”。可参考 [UE 地形雕刻工具](https://dev.epicgames.com/documentation/en-us/unreal-engine/landscape-sculpt-mode-in-unreal-engine) 中 Smooth、Flatten、Ramp 的分工。

山脉预设改为更宽的主山体和光滑峰顶，减少高频重复尖脊。针对中地图可从 `hills` 或低振幅 `mountains` 起步，再由 AI 用平滑与坡道处理局部。下面的 Scene Code 是 96×16×96 米地图的低起伏示例：

```js
function plan(api) {
  api.terrain('hills', { amplitude: 3, roughness: 0.4, seed: 42 });
  api.sculptTerrain({ mode: 'smooth', point: [0, 0], radius: 8, strength: 0.8 });
  api.rampTerrain({ start: [-20, 0], end: [20, 0], width: 5, softness: 0.8 });
}
```

当前格距约 1.5 米，原先半径 1.8 米的默认笔刷直径只有约 2.4 个格距，容易雕出单格尖点；默认半径现改为 3.5 米。对于小土坡、浅沟，先使用较宽的笔刷更合适；如仍不足，可实验性地把中地图 65×65 提升到 129×129（0.75 米格距、约 4 倍采样量），分别测渲染、碰撞与编辑成本。不要把厘米级凹凸塞进这张网格。

对比页现可切换 96 米村庄地块与 192 米山地地块，并展示局部平滑、坡道结果。尚未调整既有地图，也未默认提高地形分辨率；应先在具体地图视觉验收，再根据可见锯齿决定是否增加精度。完整水蚀不是这一尺度下的首要条件。
