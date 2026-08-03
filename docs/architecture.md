# WorldForge Studio 产品与架构边界

## HDRI catalog

Place `.exr` files in `data/map-editor/hdri/`. The render developer panel writes each selected panorama's two small classification axes (`morning/day/evening` and `cool/warm`) to `catalog.json`; unrelated free-form tags and optional `skyColor` / `groundColor` swatches are preserved.

When the library is non-empty, every UI render-generation request requires the AI to choose one indexed panorama. It may tune rotation, exposure, saturation, intensity, tint and tint strength, but may not invent a filename. The selected/tinted lower-panorama swatch harmonizes distance fog and hemisphere ground light, while the upper swatch drives sky light and a restrained sun tint. Swatches do not have to be catalogued beforehand: the client samples the panorama decoded by the sky dome and re-runs `harmonizeHdriAtmosphere` on the draft. Which data half is sky depends on `texture.flipY` (three sets it true for `.hdr`, false for `.exr`).

AI-authored fog uses `atmosphere.fog.visibilityDistance` in metres; the compiler converts it to exponential density at 95% opacity. Human-facing language therefore maps to stable ranges (`thin 240-450m`, `normal 120-220m`, `dense 40-90m`) instead of asking the model to guess a renderer-specific density.

## Render runtime lifecycle

Each rendered map owns one `RuntimeIndex` for the whole map lifetime. `AIPrimitiveBatcher` registers shared primitive batches in it, while standalone fallback meshes are registered with the same `${mapObjectId}:${partId}` identity. Picking, future material isolation, and object culling must consume this shared index instead of building parallel object maps.

`ObjectDistanceCuller` runs after camera controls update and before the render runtime tick. Its maximum distance follows the active exponential-fog curve at 99.5% opacity; with fog disabled it falls back to the camera far plane. Disposal restores culler-owned visibility before batches and the index are cleared.

Never remove children during `Object3D.traverse()`. Collect targets first and detach them after traversal so Three.js does not iterate a shortened `children` array with its original length.

Frame rendering is scheduled through the runtime `RenderPipeline` and `RenderGraph`: planar reflections run first, the shared normal/depth producer runs only when demanded, water then consumes the scene depth, and the registered composer passes run last. WorldForge owns only the host callbacks in `renderFrameCoordinator.ts`; it must not rebuild a second pass scheduler inside `RenderRuntimeAdapter`.

Water meshes never write the shared normal/depth target. They consume the depth of terrain and opaque scene objects so shallow/deep blending, shore fading, SSAO, distance fog, and presentation passes share one coherent screen-space scene description. HDRI environment reflection and planar scene reflection have separate strengths; a bright panorama must not wash out the local scene reflection.

Large-map directional shadows use the runtime `CSMController` through `mapShadowRuntime.ts`. The controller owns one map lifetime, patches both `modelsRoot` (including primitive batches) and the terrain material, and restores the fallback directional shadow when the map is replaced. Editor helpers, sky and other scene-level objects remain outside its material scope.

## 目标

一个面向非技术创作者与专业开发者的场景编辑器。两种模式编辑同一份地图数据，用户可以在两种模式间继续编辑，而不是导入导出两个不兼容项目。

## 两阶段生成

1. 地图阶段：提示词只描述空间内容，包括高度场、道路、水域、植被、建筑和物体摆放。
2. 用户确认地图。
3. 渲染阶段：提示词只描述视觉风格。地图阶段出现的氛围词保存成建议标签，但不自动应用。

地图保存 `renderSchemeId`，并允许重新选择已有渲染方案。地图与渲染方案分别保存、分别 refine；渲染方案默认以新 ID 保存，避免静默改变其他地图。

## 两种 AI 模式

### 基础版

编辑器调用项目后端 API。AI 主要做意图解析、选择已有能力和白名单参数，适合无开发经验的用户。

空地图的一句话生成采用 `MapCompositionWorkflow`，它是有界编排器而不是固定场景模板：场景总导演先输出临时 `SceneCompositionPlan`，自由决定本次提示需要的区块、主次关系、视觉焦点、过渡、地形意图、资产家族、密度、尺度和留白。资产家族的语义角色是自由文本；代码不写死“森林必须有营地”等内容。导演可为真正困难的局部关系声明 0-2 个 `consultations`，编排器才会动态调用对应专业角色，普通区块不会机械启动 Agent。

`SceneCompositionPlan.intentRequirements` 是本次提示的实体交付清单。导演必须把用户明确点名的地形、水体和必要资产家族写入该清单；`sceneCompositionOutcome` 在确定性编译后检查真实高度场、结构化水体和实例数量，而不是相信模型的文字总结。缺失项只按导演已选择的区块与资产家族做差量补齐，仍不让 LLM 直接生成坐标。合成审查不得删除清单中的必要水体；验收结果随预览展示，并与地图质检一起进入同一可撤销事务。

专家只能对既有计划输出受校验的差量 patch，不能生成资产、直接输出 `MapOperation` 或加入出生点/战斗等玩法内容。随后资产解析器从整个共享资产库中按标签和尺度匹配；小/中/大地图分别组织 2-4、6-10、8-14 个可辨识资产变体，已有资产先计入，不足部分才按地图默认生成模式创建。程序会在资产解析前补齐导演所选家族的变体数；若家族结构本身不足以达到下限，则要求导演结构化重规划。确定性编译器再把计划烘成地形、水体与 `object.add`，负责 seed、软边界、丛簇、留白排除、避水、坡度、间距和碰撞。最后独立合成审查只检查视觉连续性、焦点、空白/重复、尺度和地形水体衔接，可修正一次计划后重新编译。`SceneCompositionPlan`、专家建议与审查结果只存在于预览响应；地图仍只持久化共享 `MapOperation[]`。

每个模型角色的结构化输出最多自动修复一次；专家失败可跳过，导演失败终止，审查失败则保留已通过程序校验的导演方案。工作流没有开放式工具循环，也没有由模型自行决定无限递归或调用次数。地图操作仍需用户预览确认后作为一个事务提交。

已有内容的地图不能重新走构图生成，必须使用地图 Refine。Refine 只输出相对当前地图的差量操作：重复物体可按真实 `assetId` 与数量确定性删减；单个物体、水位和河宽可更新；未点名内容必须保留。预览上的再次 Refine 会把前一轮操作作为临时基线，最终仍作为一笔事务确认。

湖泊不是浮在地形上的平面：`water.add` 与 `water.update` 会把盆地刻进高度场，湖底降到 `level - depth`，岸边按深度成比例的缓坡回升，因此高度场允许负值（`y=0` 是海平面而不是地板）。刻蚀对每个格点取"当前高度与目标上限的较小值"，只由湖多边形决定，因此重复执行不会越挖越深；缩小或删除湖泊会留下已有洼地，需要用笔刷填回。河流暂未刻蚀——在有沿程高度剖面之前，平底沟槽配上倾斜河面反而更糟。

地图创建使用小（48×12×48，33² 高度场）、中（96×16×96，65²）和大（192×24×192，129²）三档。AI 的笔刷、水域、物体和资产配额根据地图面积计算。重复植被或岩石由模型输出 `scatters` 分布意图，服务端使用带 seed 的抖动网格生成坐标，并拒绝水域、陡坡、间距不足或与已有碰撞体重叠的候选点；多组散布会共享已占用空间。出生点若落在水域、陡坡或物体碰撞范围内，会在请求点附近寻找安全位置。`scatters` 不进入持久化事务协议；预览前就展开成普通 `object.add`，确保预览与提交坐标完全相同。

创建地图时选择一个 Voxel Studio 默认模型生成模式（`standard/lite/voxel/voxel-pro/curve/wire/math`），保存为地图级 `assetGenerationMode`。地图 Agent、地图 Refine 和手工生成缺失资产时默认使用该模式；旧地图缺少该字段时确定性回退为 `voxel`。

`assetGenerationMode` 不再是场景资产门禁。同一地图可以引用和混合任意生成模式的已有资产；Agent 与客户端资产面板都能看见完整共享库，名称旁显示模式以便判断。存储事务仍校验资产 ID 必须真实存在，但不再拒绝跨模式引用。

每张地图保存一个全局 `seed`；旧地图按地图 ID 确定性补齐。AI 先输出高层 `terrain.generate`（`plain/hills/valley/island/canyon`），共享 PCG 模块用四层 fBm 烘焙进现有高度场，再依次执行局部笔刷、湖泊刻蚀和散布。LLM 不再负责枚举基础地形坐标。坡度分析与地形生成分属独立共享模块，渲染端只消费最终高度场，并按高度、坡度和水线生成顶点颜色。

渲染生成同样使用受限协议，而不是让模型直接修改 Three.js：AI 选择基础方案并组合 `RenderPlan` 能力模块，服务端按该方案的 `accessPolicy` 校验模块、参数、角色权限和范围。非法结果或明确风格遗漏只允许自动修正一次。当前模块覆盖环境、HDRI 天空、表面、描边、世界空间素描、漫画、色彩分级、标签材质、命名灯光、Bloom/SSAO、标签特效，以及结构化湖泊/河流与模型水面。`environment.hdri` 的贴图来自 `data/map-editor/hdri/` 目录扫描，同一张全景图既作为 `HDRISkyDome` 背景，也经 PMREM 成为 `scene.environment`；环境变更由宿主桥同步给 Voxel 材质标签表面绑定和 `WaterSurface`，清除 HDRI 时也同步解绑。距离雾统一使用 Runtime 的深度后处理，覆盖普通材质、透明水体和风格化输出，避免自定义 Shader 绕开 Three 内建雾；水体参与该深度预通道，但仍不进入普通材质替换。统一描边的距离淡出使用世界米制阈值，默认从 120m 到 260m，且只向开发者开放。水体的 HDRI 环境反射与场景平面倒影使用独立强度，切换方案时都重新绑定，避免亮天空洗白局部倒影。贴图名是开发者专用参数，AI 只能调旋转、曝光、饱和度、强度和色调。材质与特效只接收 `modelsRoot`；后处理 normal/depth 预通道只接收地图内容根，物体/材质 ID 只遍历 `modelsRoot`，编辑器 gizmo 和辅助物不会进入风格链。景深仅保留高层协议。

“艳阳/烈日/高对比”采用方向性色彩契约：暖色太阳主光、偏冷天空补光、中等后处理对比和非零暗部下限共同塑造清晰度，不能用压黑阴影替代光照层次；明确冷调时才反转整体色彩倾向。
结构化湖泊和河流在启用水体方案时还会注册到 Runtime 的 `PlanarReflectionPass`：反射相机先渲染场景到共享纹理，再把纹理和投影矩阵送入各个 `WaterSurface`。HDRI 环境反射与场景平面反射是两条独立输入，前者负责远景环境，后者负责岸边地形、树木和建筑。
渲染 Refine 以当前完整 `RenderPlan` 为输入，强制保持 `baseSchemeId` 不变并返回合并后的完整计划，因此“雾再浓一点”不会重新选择预设或丢失素描、漫画等既有模块。

基础版 Agent API 使用 SSE 返回真实执行阶段。空地图链路公开场景构图、按需专家会诊、资产解析、逐个资产生成、失败重试、确定性编译、合成审查、校验与修复；单个资产生成最多尝试三次，前端展示当前资产、尝试次数和失败原因。Refine 与渲染链路继续公开自己的规划、校验和自动修正。客户端进度条只根据后端已发生的阶段推进，耗时只用于解释等待时间，不伪造完成百分比。

地图 Agent 的最终规划会先在内存中应用，再交给独立 `mapLint` 做确定性验收。出生点不安全、根物体越界/悬空、完全重复物体和湖面穿地会转换为追加在同一事务后的修复操作；明显重叠和内容稀疏只报告，不做有审美判断的自动修改。预览面板显示质检结果，SSE 在确实产生修复时才发送 `repairing` 阶段。

模型生成请求默认携带 `packages/voxel-render-runtime/model/material-tags-v1.json` 的单一真值。WorldForge 将 `nodes[].tags` 适配为 Voxel Studio 材质标签编译输入，标签继承、材质层和表面绑定沿用 runtime 公共入口；材质遍历仍只限 `modelsRoot`。水是路由标签：结构化湖泊/河流和 `water:pool` 使用 `WaterSurface`，`water:fall` 使用 `WaterfallSurface`，不会作为普通材质层处理。

资产标签与模型内部材质标签分开保存：Agent 在 `assetRequests.tags` 中输出 `tree/rock/building/landmark` 等对象语义，生成完成后直接写入 `MapAsset.tags`；代码根据实际碰撞体计算 `footprintRadius` 与 `sizeClass`。后续 AI 规划和散布优先读取这些结构化字段，名称正则仅保留为旧资产兼容回退。

重复资产的性能优化由宿主 `mapAssetInstancing` 模块负责，不把 WorldForge 对象协议塞进 Voxel Runtime。四个及以上、无 `nodes[].tags` 且全部不透明的同一资产可合并为 `InstancedMesh`，并保留不可见的逐对象选择代理和实例变换同步；带材质标签或透明材质的资产继续走独立 Mesh/Material 路径，避免材质主题、特效和水体语义串到其他实例。开发者模式显示 draw calls、triangles 与 frame ms，作为提高地图物体配额前的验收依据。

### 专业版

外部 Agent 通过稳定的 HTTP/CLI/Skill 契约编辑同一份数据。Agent 默认只能创建隔离扩展，不得修改核心源码。执行期间编辑器锁定，但允许用户取消；每次执行最终作为一个可撤销事务提交。

两种模式共享 `MapOperation[]` 与验证规则，通过同一个事务入口原子提交。当前已经支持保存并撤销最近一次事务；接入 API 模型与外部 Agent 时不得再生成第二套地图修改逻辑。

## 核心数据方向

- 地图：空间、地形、对象引用、结构化道路/水域以及 `renderSchemeId`
- 资产：共享资产库，地图通过 `assetId` 引用
- `assetTags`：整类对象语义，如树木、石头、建筑
- `materialTags`：模型内部材质或部件语义
- 渲染方案：全局效果、水体效果、按标签批量替换或覆盖材质
- 贴地状态：每个对象记录“跟随地形”或“固定高度”；自然物与建筑默认跟随地形

## Shader 权限阶梯

1. 组合已有 Shader 模块
2. 修改模板中的白名单片段
3. 生成完整 GLSL，仅在专业模式的实验权限中显式开启

完整 GLSL 必须隔离编译、限制资源与超时，并在应用前给出预览和失败回退。当前开发者模式只保存隔离代码，不执行它；不得默认修改编辑器核心源码。

## 渲染开发者模式

开发者模式编辑的仍是普通渲染方案，不生成第二套数据。每个方案可以独立决定参数是否向 AI/开发者开放、开放范围、枚举白名单和控件形式。“当前效果”与“开放策略”分离：数值参数先在 capability 的完整安全范围内用滑条和精确数值框实时预览，再由开发者填写允许 AI/开发者使用的子区间。水体当前值同时控制 HDRI 环境反射与场景平面反射，并额外开放平面反射扰动和 Fresnel。保存时复制为新方案，不覆盖内置预设。

## 初版暂不实现

- Three.js 多版本兼容层
- 协作、账号、计费和发布
- 复杂道路拓扑与海洋
- 开放式通用 Agent runtime；当前基础版只实现有界场景编排器，专业版继续提供契约、Skill 与权限边界
- 多级事务历史；实验阶段只保留最近一次 AI/Agent 事务
