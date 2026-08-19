# Code-Driven Map Planner

WorldForge 的室外整体生成由一个受限的 Scene Code 程序统一负责。它不再先运行“总导演”，也不会把建筑和生态交给两个互不共享空间推理的规划器。

```text
用户提示词
  -> AI 判断场景意图并编写一个完整 JavaScript 规划
  -> 沙箱发现资产需求
  -> 并行生成新资产
  -> 用真实资产 ID 确定性重放同一程序
  -> 本地可玩性修复与地图 lint
  -> 一个 MapOperation[] 预览事务
```

这样，地形、湖泊、道路、围墙、门、亭廊、树木和生物都在同一坐标系中规划。建筑不会再因为后续生态步骤不了解其入口和空间关系而被拆散，已经生成的资产也必须在最终事务中实际使用。

## 场景意图由 AI 判断

完整场景程序必须先调用：

```js
api.sceneIntent({
  kind: 'authored', // 或 natural
  reason: '中式园林是人工营造的文化空间'
});
```

`authored` 表示园林、庭院、竞技场、村落、校园等人工营造空间；`natural` 表示没有建造意图的森林、湿地、山地等自然空间。这个判断来自模型对用户语义的理解，不使用“园林/建筑”等关键词正则分流。

本地只验证判断与结果是否自洽：

- AI 声明 `authored` 时，必须生成至少一个明确的结构锚点，并安排入口或通行动线。
- AI 声明 `natural` 时，可以完全不生成建筑。
- 如果人工场景缺少结构，执行器把明确错误交回同一个 Code 请求，最多定向修复两次；不会启动新的总导演或完整 Agent 工作流。

中式园林的提示契约明确要求用围墙、月洞门、亭、廊、桥、铺地、池水之间的关系表达园林，而不是退化成“一片湖加一些树”。

## 统一场景 API

Scene Code 只能调用冻结的 `api`，不能访问文件、网络、定时器、导入、`eval`、`Function` 或宿主全局。代码同步执行，有时间和数量上限。

地形修改与地表绘制使用随模型请求一同提供的结构化表单。枚举字段只能填写表单列出的值，描述文字放在 `id` 或注释中：

```js
api.modifyTerrain({
  modifier: 'basin',
  region: { kind: 'circle', x: 0, z: 0, radius: 24 },
  amplitude: -1.4,
  softness: 0.8
});
api.surface({
  id: 'garden-ground',
  surface: 'soil',
  region: { kind: 'polygon', points: [[-20,-20],[20,-20],[20,20],[-20,20]] },
  intensity: 0.65
});
```

合法 `modifier` 为 `mountain / ridge / valley / basin / cliff / terrace / dune / island`；合法 `surface` 为 `grass / sand / rock / soil / paving`。Scene Code 编译器负责把 AI 表单转换成严格操作：`center:[x,z]` 转为内部坐标、方向向量转为角度、分层数组转为层数，语义化布局与通行要求转为项目枚举；草地区域的 `outline / boundary` 转为多边形，`origin / outerRadius` 转为圆形，并从名称语义推断草地预设。`rolling`、`gentle central basin`、`packed earth` 等旧式明确语义也在这一编译层映射；不会通过静默丢弃字段来换取通过。

- 意图：`sceneIntent`
- 基础地形：`terrain`
- 局部塑形：`modifyTerrain`、`refineTerrain`
- 地表：`surface`
- 水体：`water`
- 草地：`grass`
- 出生点：`spawn`
- 物体：`place`、`placeBetween`、`bridge`
- 差量调整：`move`、`removeObject`、`updateWater`、`removeWater`
- 曲线：`linePoint`、`bezierPoint`、`sampleBezier`、`sampleBezierFrames`、`sampleBezierFramesBySpacing`
- 布局：`circlePoint`、`gridPoints`、`poissonDisk`
- 确定性变化：`random`、`noise2D`、`fbm2D`
- 资产：`requireAsset`、`asset`

地图种子驱动随机和噪声。程序最多输出 2,000 个摆放意图和 256 项场景操作。

## 建筑与环境角色

新资产族必须声明角色：

```js
const gate = api.requireAsset({
  key: 'gate',
  name: '月洞门',
  prompt: 'Standalone Chinese moon gate, entrance toward local Z+',
  tags: ['garden', 'gate'],
  variants: 1,
  role: 'structure'
});

const willow = api.requireAsset({
  key: 'willow',
  name: '垂柳',
  prompt: 'Standalone stylized willow tree',
  tags: ['tree', 'willow'],
  variants: 2,
  role: 'environment',
  optional: true
});
```

- `structure` 是构图主体，生成失败会终止本次规划；最终对象会锁定，普通 refine 不能移动或删除。
- `environment` 是环境内容，可以继续由同一个程序精确摆放。
- 只有可替代的自然点缀可以标记 `optional:true`，用于告诉 AI 哪些内容优先级较低。无论主体还是点缀，单个上游资产生成失败都不再终止整次地图流程：系统跳过对应摆放，保留其余成功资产、地形和构图，结果面板会列出缺失名称并显示“修复失败项”。修复会走室外差量 Scene Code，只补缺失资产及必要摆放，不重做整张地图。

发现阶段会拒绝“声明了却从未摆放”的资产变体。最终重放也会检查每个成功生成的新资产是否进入了事务，防止出现“生成很多，最后只用了几个”。

## 本地硬约束

AI 负责审美和整体构图，本地程序只负责确定性的可玩性底线：

- 操作、坐标、数量和地图边界合法。
- 地形、水体、草层和对象作为同一个原子事务应用。
- 门和入口两侧保留玩家可通过的走廊；挡路的未锁定环境物会被移动到走廊旁。
- 出生点会采样地形并避开水体和阻挡物。
- 安全修复追加到同一事务；纯审美问题只作为诊断，不用一串审查 Agent 把构图越改越保守。

## 资产朝向与连接

生成模型统一使用 `Y+` 向上、`Z+` 朝正面/入口、`X+` 向右。`facing.target`、`facing.direction`、曲线切线/法线会被解析为世界 `rotationY`。

连续墙体和廊道应使用 `placeBetween` 或按弧长采样的 `sampleBezierFramesBySpacing`。同一连续结构默认只用一个资产变体，避免相邻模块轮廓不兼容。

跨水桥梁使用 `bridge`。AI 负责判断桥的风格、所跨水体、过水中心和方向；本地求解器根据真实水岸轮廓计算两侧干岸端点、桥长、朝向与桥面高度，避免桥沉入水底、停在池塘中央或没有连接两岸。普通 `place` 生成的桥只产生可修复警告，不会阻断整次规划；用户可以通过“调整当前地图”让 AI 用 `replaceObjectId` 定向替换旧桥。

## 中式园林构图

中式园林不再只要求“至少有一个建筑”。统一 Scene Code 会在同一次构图中安排入口、障景转折、展开主景、对景/框景与回游路径，并强调不对称关系、空间收放、岸边植物与山石组团、装饰性小景和有意保留的留白。亭子、月洞门、回廊、桥、铺装、池塘和自然内容共享同一坐标规划，避免先排建筑、后撒树木造成彼此割裂。

这些要求是审美方向而非本地硬性验收清单。硬约束仍只处理可确定的坐标、边界、水面高度、两岸连接、入口通行和出生点安全，不会因为构图不够复杂或单个资产服务失败就阻止用户应用其余有效结果。

## 编辑器集成

```text
POST /api/editor/maps/:mapId/generate
```

室外生成和调整请求启用 `sceneAgent:true` 时都走统一 Scene Code：

```json
{
  "prompt": "生成一座围绕池塘展开的中式园林",
  "provider": "gpt",
  "sceneAgent": true,
  "minNewAssets": 2,
  "maxNewAssets": 16
}
```

SSE 进度显示完整场景 Code、资产生成、重放和验证阶段。响应仍使用 `MapAiSuggestion`：`generatedAssets` 列出新资产，`codePlan` 保存源码、场景意图、原因、摆放数量和使用的 API。地图只有在用户确认后，才通过现有事务接口一次性提交。

`mode:"refine"` 返回差量操作，只修改用户指定的内容，不重新生成基础地形，也不重置出生点。现有对象和水体 ID 会随请求结构一起提供给模型；例如“让桥连接两岸”会删除指定旧桥，并在同一个原子事务中加入本地求解后的新桥。

室内生成保持原来的房间约束工作流，不受这次室外路径替换影响。
