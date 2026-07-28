适用场景：用 AI 生成低多边形 3D 模型和动画。本指南面向第三方前端集成——涵盖所有需要正确渲染的信息。

---
目录
1. 快速开始
2. 端点总览
3. 模型生成
4. 修改模型 (Refine)
5. 装载配件 (Mount)
6. 动画生成 (Motion Plan)
7. 模板模块 (Runtime)
8. 粒子系统
9. 简单 LLM 对话
10. 完整集成示例
11. 错误处理
12. 注意事项

---
1. 快速开始
const API = 'https://voxel-studio-backend.zeabur.app';

// 生成一个模型
const resp = await fetch(`${API}/api/generate/model`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ description: 'a lowpoly knight', provider: 'fireworks', mode: 'standard' }),
});
const text = await resp.text();
// 解析 SSE 取 modelJson

---
2. 端点总览
端点
方法
返回
用途
/health
GET
{"ok":true}
健康检查
/api/generate/model
POST
SSE 流
生成单个模型
/api/generate/batch
POST
SSE 流；stream:false 时为 JSON
批量生成多个模型
/api/generate/animation-quick
POST
JSON
Quick 动画（Motion Plan 参数驱动）
/api/generate/animation-pro
POST
JSON
Pro 动画（代码驱动，单阶段）
/api/generate/animation-pro-multiphase
POST
JSON
Pro 动画（代码驱动，多阶段）
/api/refine/model
POST
JSON
AI 修改已有模型
/api/mount
POST
JSON
装载配件（武器/穿戴/配饰）到已有模型
/api/chat
POST
JSON
简单 LLM 对话
/api/templates/module.js
GET
ES Module
runtime（动画模板 + 几何构建 + 粒子转换）
/api/templates/geometry-schema.js
GET
ES Module
几何参数 schema（module.js 相对 import）

---
3. 模型生成
3.1 单个模型 — POST /api/generate/model
Provider 选项（所有生成端点通用）：
key
说明
glm
GLM 模型
gpt
GPT 模型
fireworks
Fireworks 模型
deepseek
DeepSeek 模型
mode（必填；旧字段 promptMode 仍兼容）：
值
说明

standard（默认）
标准生成，质量最高

lite
快速生成，适合简单模型

voxel
体素风格（仅 box + group，~20 box 抽象）

voxel-pro
体素高细节（仅 box，60-100 mesh，整体感优先）。默认 provider=gpt

curve
曲线风格（sphere/cyl/torus，偏符号感）

wire
金属铁丝勾线风格（极细 cyl + 极少 tri，抽象符号化）

voxel-pro 默认 provider：当 mode: "voxel-pro" 且请求未显式传 provider 时，后端自动选 gpt。其他 mode 不传 provider 时默认 glm。
voxel-pro mesh 限制：所有几何节点 mesh.type 均为 box，前端按 box 参数（width/height/depth）渲染即可。返回格式与其他 mode 完全一致，无需特殊处理。
materialTags（可选，材质标签系统）：传入材质词表 JSON 对象时启用材质语义标签。后端把词表的 README 规则 + 各 tag 描述注入 AI 提示词（prompt），AI 在代码里给部件打标签，返回的 nodes[].tags 携带标签（见 §3.2）。省略或空对象 → 不启用，prompt 与输出均无任何材质相关字段。与 mode 正交，所有 mode 都支持。词表格式参考 material-tags-v1.json。
请求
{
  "description": "a lowpoly knight with a sword and shield",
  "provider": "glm",
  "mode": "standard",
  "materialTags": { "README": { "...": "词表 README" }, "tags": { "base": { "...": "..." } } }
}
返回：SSE 流
event: blockout
data: {"stage":"blockout","text":"Analyzing description..."}

event: thinking_start
data: {"stage":"thinking_start"}

event: thinking_done
data: {"stage":"thinking_done"}

event: code
data: {"stage":"code","text":"function"}

event: result
data: {"stage":"result","done":true,"modelJson":{...},"timing":{...}}

event: error
data: {"stage":"error","errorCode":"GENERATION_FAILED"}
SSE 事件类型：
- blockout — 结构分析阶段
- thinking_start / thinking_done — AI 思考中，可用于 UI 加载动画
- code — 代码生成中，text 字段是增量代码
- result — 完成，modelJson 是渲染就绪的模型数据
- error — 生成失败，读取 errorCode；当前值为 GENERATION_FAILED。
前端解析示例：
async function generateModel(description) {
  const resp = await fetch(`${API}/api/generate/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, provider: 'fireworks', mode: 'standard' }),
  });
  const text = await resp.text();
  let modelJson = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const event = JSON.parse(line.slice(5).trim());
    if (event.stage === 'error') throw new Error(event.errorCode || 'GENERATION_FAILED');
    if (event.done || event.stage === 'result') {
      modelJson = event.modelJson;
    }
  }
  return modelJson;
}
3.2 modelJson 格式（v2）
生成返回的 modelJson 是 v2 格式（format: 2）：一个扁平 nodes 数组，每个 node 的 transform 都是相对父级的局部坐标，层级由 parent 字段表达。
{
  "name": "Knight",
  "type": "lowpoly",
  "format": 2,
  "nodes": [
    { "id": "body", "transform": { "pos": [0, 2.5, 0] } },
    { "id": "m0", "parent": "body",
      "transform": { "pos": [0, 0, 0] },
      "mesh": { "type": "box", "params": { "width": 2, "height": 3, "depth": 1.4 }, "color": 10066329 } },
    { "id": "m5", "parent": "upperArmR",
      "transform": { "pos": [0.19, -0.32, 0.16], "quat": [0.61, 0, -0.73, 0.33] },
      "mesh": { "type": "cylinder",
                "params": { "radiusTop": 0.18, "radiusBottom": 0.2, "height": 0.9, "radialSegments": 8 },
                "color": 9055202, "boneFrom": "upperArmR_wp0", "boneTo": "upperArmR_wp1" } },
    { "id": "torch_head", "parent": "body",
      "transform": { "pos": [0, 4, 0] },
      "mesh": { "type": "sphere", "params": { "radius": 0.3 }, "color": 16753920 },
      "tags": [ { "tag": "fire", "value": 0.75, "variant": "normal" } ] }
  ],
  "_meta": { "skipAutoCenter": true, "ai": { "v": 1, "data": "<encrypted>", "edits": "" } }
}
group vs mesh：node 有 mesh → 几何叶节点；无 mesh → group（= 动画骨骼节点）。动画 plan 的 key 指向任意 node id（group 即骨骼）。
⚠️ 朝向（最常见的渲染错误）
cylinder / cone 的默认轴是 +Y（竖直）。斜向件的朝向由 node 的 transform.quat 给出。渲染时必须 obj.quaternion.set(...quat)，否则所有圆柱竖直 → 模型朝向全错。
node 字段
字段
类型
说明
id
string
唯一 id
parent
string
父 node id（省略则根）
transform.pos
[x,y,z]
相对父级的局部偏移
transform.quat
[x,y,z,w]
朝向（cylinder/cone 必需）。默认轴 +Y，quat 将 +Y 转到目标方向
transform.scale
[sx,sy,sz]
可选的非均匀缩放，默认 [1,1,1]。应用前建议检查全 > 0
mesh
object
有 → 叶几何节点；无 → group
mesh.type
string
box sphere cylinder cone torus wedge tri patch icosahedron dodecahedron octahedron
mesh.params
object
几何参数（完整表见 §6）。用 runtime.buildGeometry(type, params) 构建
mesh.color
number
0xRRGGBB 简写
mesh.material
object
完整材质 {color, roughness?, metalness?, opacity?, transparent?, flatShading?}，存在时覆盖 color
mesh.boneFrom / mesh.boneTo
string
chain/connect 圆柱的骨骼端点（动画链检测用；静态渲染可忽略）
tags
array?
可选。材质语义标签，仅当请求启用 materialTags 时出现。见下方「材质标签渲染约定」
顶层字段
字段
说明
name / type
模型名 / 固定 lowpoly
format
2（版本号，渲染器可 feature-detect）
_meta.skipAutoCenter
渲染端忽略
_meta.ai
渲染端忽略
材质标签渲染约定
当请求传入非空 materialTags 时，nodes[] 的任意节点（group 或 mesh）可能携带可选 tags 数组，每条形如：
{ "tag": "base", "value": "gold" }                    // enum 模式:每部件至多一个
{ "tag": "fire", "value": 0.75, "variant": "green" }  // blend 模式:value ∈ {0,0.25,0.5,0.75,1};variant 仅部分 tag 支持
渲染端约定：
- 继承：group 节点的 tags 沿 parent 链向下传播给所有后代 mesh；mesh 节点重新声明同名 tag 覆盖继承值。收集一个 mesh 的有效 tags = 沿父链向上取所有 group tags，再用 mesh 自身 tags 覆盖同名项。
- 编译：渲染端用有效 tags 查词表（material-tags-v1.json）编译成分层材质（effect layers）+ 可选粒子（companion），完全覆盖节点 mesh.color / mesh.material 的基础着色。同一个 (tag, value, variant) 组合的部件 batch key 相同，可合批。
- 未实现的 tag：词表中 status: notImplemented 的 tag（如 electric/poison/ice/wet 等）渲染端先落默认材质；数据格式已冻结，渲染层补齐后存量模型自动生效，前端不应因遇到未知 tag 报错。
- 无 tags 字段：请求未传 materialTags 时，所有节点都没有 tags 字段（不是空数组），渲染端走常规 mesh.color / mesh.material。
3.3 批量生成 — POST /api/generate/batch
请求
{
  "descriptions": ["a knight", "a dragon", "a castle"],
  "provider": "glm",
  "mode": "standard",
  "materialTags": { "README": {}, "tags": {} }
}
materialTags 可选，语义同 §3.1。若提供，则应用到批量内的每一个 description。
返回：SSE 流（默认）
event: start
data: {"stage":"start","total":3}

event: item
data: {"stage":"item","completed":1,"total":3,"result":{"success":true,"index":0,"modelJson":{...},"name":"Knight","meshCount":85}}

event: item
data: {"stage":"item","completed":2,"total":3,"result":{"success":false,"index":2,"errorCode":"GENERATION_FAILED"}}

event: done
data: {"stage":"done","total":3,"succeeded":2,"failed":1,"results":[...]}
默认返回 text/event-stream，后端仍按现有并发策略启动任务，但每个模型完成后立即发送一个 item 事件，失败项不阻塞其他项。
兼容 JSON 返回
请求体传入 "stream": false 时，返回旧版普通 JSON：
{
  "total": 3,
  "succeeded": 3,
  "failed": 0,
  "results": [
    { "success": true, "index": 0, "modelJson": {...}, "name": "Knight", "meshCount": 85 },
    { "success": false, "index": 2, "errorCode": "GENERATION_FAILED" }
  ]
}
3.4 修改已有模型 — POST /api/refine/model
对已生成的模型进行 AI 修改。需要模型保留 _meta.ai 元数据（仅限通过 /api/generate/model 生成的模型）。
请求
{
  "modelJson": { ... },
  "description": "make the sword bigger, add a cape",
  "provider": "fireworks",
  "refModelJson": { ... },
  "materialTags": { "README": {}, "tags": {} }
}
字段
类型
说明
modelJson
object
完整模型数据（须含 _meta.ai）
description
string
修改描述
provider
string
AI provider，同模型生成
refModelJson
object?
可选参考模型。LLM 会参考其设计/样式/结构实现 description 中的需求（如"穿上 ref 这件衣服"）。原模型 mode 优先——不强制采用 ref 的 mode 约束
materialTags
object?
可选材质词表，语义同 §3.1。提供时 AI 会在修改后的代码里给部件打/改 tags，返回的 nodes[].tags 反映新标签；省略则不启用材质系统
返回：JSON
{
  "ok": true,
  "modelJson": { ... }
}
错误
error
含义
no_metadata
模型缺少 AI 元数据（非 AI 生成或手动编辑过）
metadata_corrupted
元数据损坏，需重新生成模型
非流式。Refine 一次返回完整结果，不像模型生成那样走 SSE。
3.5 装载配件 — POST /api/mount
将配件（武器/穿戴/配饰）装到已有模型上。需要 primary 和 secondary 都保留 _meta.ai 元数据。
请求
{
  "primary": { ... },
  "secondary": "文字描述",
  "description": "右手持枪，枪口朝上",
  "provider": "gpt"
}
字段
类型
说明
primary
object
完整模型数据（须含 _meta.ai）
secondary
object | string
配件模型数据（须含 _meta.ai）或文字描述（AI 自动生成）
description
string
装配说明，如"戴在头上"、"右手持枪"
provider
string
AI provider，同模型生成
返回：JSON
{
  "ok": true,
  "modelJson": { ... },
  "mountedGroupId": "mount01"
}

**错误**

| error | 含义 |
|-------|------|
| `no_metadata` | primary 或 secondary 缺少 AI 元数据 |
| `metadata_corrupted` | 元数据损坏 |
| `invalid plan` | AI 输出无法解析 |

> **非流式**。返回的 `modelJson` 中，配件 mesh 位于 `mounted: true` 的 group 下，前端可据此识别可拆卸部件。

---

## 5. Quick 动画 (Motion Plan)

### `POST /api/generate/animation-quick`

**请求**
```json
{
  "modelJson": { ... },
  "description": "running cycle, arms swinging",
  "duration": 2.0,
  "provider": "fireworks",
  "emitParticles": false
}
字段
类型
说明
modelJson
object
模型数据
description
string
动画描述
duration
number
动画时长（秒），默认 2.0
provider
string
AI provider，同模型生成
emitParticles
boolean
是否生成粒子特效 emit track，默认 false
返回：JSON
{
  "ok": true,
  "plan": {
    "_duration": 2.0,
    "_loop": true,
    "body": { "bounce": { "amplitude": 0.15, "frequency": 2 } },
    "leftArm": { "swing": { "axis": "x", "amplitude": 0.4, "frequency": 1 } },
    "rightArm": { "swing": { "axis": "x", "amplitude": 0.4, "frequency": 1, "phase": 0.5 } }
  }
}
Motion Plan 结构
- _duration（秒）、_loop（是否循环）是元数据
- 其他 key 是 group ID（对应 modelJson 中无 mesh 的 node）
- 每个 group 的值是一个或多个动画模板的参数配置，key 为模板名，value 为参数对象
- 同一 group 可以有多个模板叠加（如 swing + emit）
- _attach：父级空间跟随配置（可选，渲染端读取）
内置动画模板
所有可用模板可通过 runtime.listAnimationTemplates() 动态获取。以下为常见模板及其参数含义：
模板
效果
典型参数
bounce
弹跳
amplitude(幅度), frequency(频率)
swing
摆动
axis(轴), amplitude(幅度), frequency(频率), phase(相位)
sway
轻摆
同 swing
slide
滑动
axis(轴), distance(距离), frequency(频率)
spin
旋转
axis(轴), frequency(频率), direction(cw/ccw)
breathe
呼吸缩放
amplitude(幅度), frequency(频率)
wave
波浪
amplitude(幅度), frequency(频率), delay(子节点延迟)
drop
坠落
amplitude(幅度), axis(轴), bounce(反弹)
impulse
冲击
amplitude(幅度), axis(轴)
launch
发射
axis(轴), speed(速度), decel(减速度)
dash
冲刺
axis(轴), speed(速度)
slash
挥砍
axis(轴), amplitude(幅度), speed(速度)
tilt
倾斜
axis(轴), angle(角度)
shift
位移
axis(轴), distance(距离)
squash
挤压
axis(轴), amount(缩放量)
flow
流动
axis(轴), speed(速度), distance(距离)
emit
粒子发射
见 §6 粒子系统
前端播放
使用 runtime.evaluateMotion() 每帧计算姿态增量（delta）：
function onAnimationFrame(t) {
  const pose = runtime.evaluateMotion(plan, duration, t, lookups);
  // pose = { body: { position:[0,0.15,0], rotation:[0,0,0], scale:null }, ... }
  // ⚠️ 返回值是增量，需叠加到基础姿态，不可直接赋值！
  for (const [partId, delta] of Object.entries(pose)) {
    if (partId.startsWith('_')) continue;
    applyDelta(partId, delta); // 叠加增量到基础姿态
  }
}

---
6. 模板模块 (Runtime)
GET /api/templates/module.js
返回一个 ES Module，是前端的运行时核心。几何参数 schema 单独 serve 在 GET /api/templates/geometry-schema.js，module.js 会相对 import 它——无需 bundler，浏览器原生 ESM。
THREE 注入（推荐）——不必污染全局 window.THREE：
import * as THREE from 'three';
const mod = await import(`${API}/api/templates/module.js`);
const runtime = mod.create({ THREE });   // 绑定 THREE 实例
向后兼容：不调 create() 时回退到全局 THREE；mod.voxelStudioRuntime 也仍导出。
Runtime API
const rt = mod.create({ THREE });

// ═══ 动画 ═══

// 列出所有动画模板（slider UI 用）
rt.listAnimationTemplates()
// → [{ key:'bounce', label:'Bounce', params:[{key:'amplitude',type:'float',min:-1,max:1,default:0.2,curve:2.5},...], isLooping:true }, ...]

// ⚠️ emit 模板的 params 使用扁平 key（如 velDirX, colorStartR），与 plan 中的嵌套 emit config 不同。
// 用下面的 flattenEmitConfig / unflattenEmitConfig 在 flat ↔ nested 之间转换。

// 评估完整 Motion Plan（每帧播放用）— v2: (plan, duration, t, lookups?)
//   lookups = { getPart(id), getChildren(id) }，解耦具体 model 表示；
//   wave/flow/tilt 等需要结构信息的模板从 lookups 取，无则安全降级。
rt.evaluateMotion(plan, duration, t, lookups)
// → { groupId: { position:[dx,dy,dz], rotation:[rx,ry,rz], scale:[sx,sy,sz]|null } }
//   ⚠️ 返回值是增量（delta），需叠加到基础姿态

// 评估单个模板（Canvas 曲线预览用）
rt.evaluateTemplate(name, params, t, duration)
// → { position:[x,y,z] } 或 { rotation:[rx,ry,rz] } 或 { scale:[sx,sy,sz] }

// ═══ 粒子 ═══

// 将 plan 中的嵌套 emit config 转为扁平 key（slider UI 用）
rt.flattenEmitConfig(nestedConfig)
// nested:  { rate:20, velocity:{dir:[0,1,0],speed:[1,3],spread:0.3}, acceleration:[0,-2,0], ... }
// flat:    { rate:20, velDirX:0, velDirY:1, velDirZ:0, velSpeedMin:1, velSpeedMax:3, ... }

// 将扁平 slider key 还原为嵌套 emit config（写入 plan / 传给粒子系统）
rt.unflattenEmitConfig(flatConfig)
// flat → nested（结构与上面相反）

// ═══ 几何 ═══

// 列出所有已知几何类型
rt.listGeometryTypes()
// → ['box','sphere','cylinder','cone','torus','wedge','tri','patch','icosahedron','dodecahedron','octahedron']

// 构建 Three.js geometry
rt.buildGeometry(type, params)
// → THREE.BoxGeometry / THREE.BufferGeometry / ...
// 类型不存在时 throw Error
evaluateMotion 返回值
每个 group 返回的是增量（delta），不是绝对位姿：
{
  position: [dx, dy, dz],  // 位移增量
  rotation: [rx, ry, rz],  // 旋转增量（弧度）
  scale: null | [sx,sy,sz] // 缩放，null 表示不变
}
⚠️ 关键：必须将 delta 叠加到 group 的基础姿态上（加/乘），不可直接赋值替换。见 §8 集成示例。
buildGeometry 参数
每种 type 的 geometry 参数（括号内为默认值）：
type
geometry 参数
box
width(1), height(1), depth(1)
sphere
radius(1), widthSegments(8), heightSegments(6)
cylinder
radiusTop(1), radiusBottom(1), height(1), radialSegments(8)
cone
radius(1), height(1), radialSegments(8)
torus
radius(1), tube(0.3), radialSegments(8), tubularSegments(12)
icosahedron / dodecahedron / octahedron
radius(1), detail(0)
wedge
width(1), height(1), depth(1)
tri
a[x,y,z], b[x,y,z], c[x,y,z], d(0；>0 时为有厚度的三角棱柱)
patch
vertices[x1,y1,z1,...]（每 3 顶点一个三角形）, d(0；>0 时双面偏移成带厚薄片)
朝向提醒：cylinder/cone 默认轴是 +Y，斜向件的朝向由 mesh 的 quaternion 给出（见 §3.2）。buildGeometry 只返回裸几何，不应用 quaternion——前端创建 Mesh 后自行 mesh.quaternion.set(...)。
材质提醒：buildGeometry 不含材质。用 mesh 的 color 或 material 字段创建 MeshStandardMaterial，lowpoly 风格建议 flatShading:true。tri/patch 当 d==0（零厚度薄片）时材质需 side: THREE.DoubleSide 才能双面可见。

---
7. 粒子系统
当 emitParticles: true 时，Motion Plan 中可能包含 emit track。emit 不产生 transform 增量，而是配置一个粒子发射器——前端需自行实现粒子渲染。
6.1 emit 配置格式
emit 以嵌套结构存储在 plan 中：
{
  "rightHand": {
    "swing": { "axis": "y", "amplitude": 0.8, "frequency": 1.5 },
    "emit": {
      "emitMode": "point",
      "mesh": "sphere",
      "meshSize": 0.4,
      "rate": 25,
      "lifetime": [0.4, 0.8],
      "velocity": { "dir": [0, 1, 0], "speed": [1, 2], "spread": 0.4 },
      "acceleration": [0, -3, 0],
      "offset": [0, 0, 0],
      "colorStart": [1, 0.8, 0.2],
      "colorEnd": [0.5, 0, 0],
      "scaleStart": 1.0,
      "scaleEnd": 0.3
    }
  }
}
注意：emit 使用嵌套结构。UI slider 开发时，用 rt.flattenEmitConfig() / rt.unflattenEmitConfig() 在 flat ↔ nested 之间转换。粒子渲染时直接读取嵌套格式。
6.2 参数说明
参数
类型
默认
说明
emitMode
string
"point"
发射模式："point"—从 group 世界坐标中心 + offset 发射；"volume"—从 group 的 AABB 体积内随机点发射
mesh
string
"sphere"
粒子形状："box" 或 "sphere"
meshSize
number
0.4
粒子基础尺寸（世界单位），乘以 scaleStart/scaleEnd 得实际大小
rate
number
15
每秒发射粒子数
lifetime
[min, max]
[0.5, 1.5]
粒子寿命范围（秒），每个粒子在范围内随机取值
velocity.dir
[x,y,z]
[0,1,0]
发射主方向（无需归一化，内部会归一化）
velocity.speed
[min,max]
[1,3]
初速范围（世界单位/秒），每个粒子在范围内随机取值
velocity.spread
number
0.3
散布角度（0=平行发射，1=半球散布）
acceleration
[x,y,z]
[0,0,0]
加速度（世界单位/s²）。重力效果用负 Y：[0,-5,0]；上升烟雾用正 Y
offset
[x,y,z]
[0,0,0]
发射点偏移（相对 group 世界坐标，仅 emitMode:"point" 有效）
colorStart
[r,g,b]
[1,0.8,0.2]
粒子出生颜色（0~1 RGB）
colorEnd
[r,g,b]
[0.5,0,0]
粒子死亡颜色（0~1 RGB）
scaleStart
number
1.0
出生时尺寸倍数（× meshSize）
scaleEnd
number
0.3
死亡时尺寸倍数（× meshSize）
6.3 渲染实现指南
粒子渲染核心流程：spawn → simulate → interpolate → render。
1. 发射器初始化
扫描 plan 中所有 emit track，为每个创建发射器。推荐使用 THREE.InstancedMesh（单 draw call 高效渲染数百粒子）：
// 最大粒子数 = rate × maxLifetime（向上取整，建议上限 500）
const maxCount = Math.min(500, Math.ceil(rate * maxLifetime + 5));
const geometry = mesh === 'box'
  ? new THREE.BoxGeometry(1, 1, 1)
  : new THREE.IcosahedronGeometry(0.5, 0); // sphere
const material = new THREE.MeshStandardMaterial({
  flatShading: true, transparent: true, opacity: 0.9,
});
const im = new THREE.InstancedMesh(geometry, material, maxCount);
im.count = 0;
im.castShadow = false;
im.frustumCulled = false;  // 粒子可能飞离视锥边界
scene.add(im);
2. 每帧更新
for each emitter:
  1. 获取 group 的世界位置 (group.getWorldPosition)
  2. 若 emitMode === 'volume'：计算 group 的世界 AABB
     - 遍历 group 所有子 mesh
     - geometry.computeBoundingBox() → applyMatrix4(mesh.matrixWorld)
     - Box3.union() 合并所有子 mesh 的包围盒
     - 若 AABB 为空，回退为 point 模式
  3. 按 rate 生成新粒子 (accumulator += rate × dt)
     - point 模式：pos = worldPos + offset
     - volume 模式：pos = randomPointInAABB(min, max)
  4. 模拟已有粒子：pos += vel × dt; vel += accel × dt; life -= dt
  5. 移除死亡粒子 (life ≤ 0)
  6. 同步 InstancedMesh：为每个存活粒子设置 matrix + color
3. 颜色/尺寸插值
每个粒子在 lifetime 内从起始值线性过渡到终止值。使用 t = 1 - life / maxLife（0=出生, 1=死亡）：
// 尺寸插值
const s = meshSize * (scaleStart + (scaleEnd - scaleStart) * t);
// 颜色插值
const r = colorStart[0] + (colorEnd[0] - colorStart[0]) * t;
const g = colorStart[1] + (colorEnd[1] - colorStart[1]) * t;
const b = colorStart[2] + (colorEnd[2] - colorStart[2]) * t;

// 更新 InstancedMesh
dummy.position.set(px, py, pz);
dummy.scale.set(s, s, s);
dummy.updateMatrix();
im.setMatrixAt(i, dummy.matrix);
im.setColorAt(i, new THREE.Color(r, g, b));
im.instanceMatrix.needsUpdate = true;
im.instanceColor.needsUpdate = true;
4. 速度生成
// 方向 + 随机散布
let vx = dir[0] + (Math.random() - 0.5) * spread * 2;
let vy = dir[1] + (Math.random() - 0.5) * spread * 2;
let vz = dir[2] + (Math.random() - 0.5) * spread * 2;
const len = Math.sqrt(vx*vx + vy*vy + vz*vz) || 1;
// 随机速度
const speed = speedMin + Math.random() * (speedMax - speedMin);
// 最终速度 = 归一化方向 × 速度标量
vel = [(vx/len)*speed, (vy/len)*speed, (vz/len)*speed];
5. AABB 体积发射
// 计算 group 的世界 AABB
const aabb = new THREE.Box3().makeEmpty();
group.traverse(child => {
  if (child.isMesh && child.geometry) {
    child.geometry.computeBoundingBox();
    const childBox = child.geometry.boundingBox.clone();
    childBox.applyMatrix4(child.matrixWorld);
    aabb.union(childBox);
  }
});
// 体积模式：在 AABB 中随机取点
const pos = new THREE.Vector3(
  aabb.min.x + Math.random() * (aabb.max.x - aabb.min.x),
  aabb.min.y + Math.random() * (aabb.max.y - aabb.min.y),
  aabb.min.z + Math.random() * (aabb.max.z - aabb.min.z)
);
6. 生命周期管理
- 播放开始：为每个 emit group 创建发射器
- 动画自然结束（非循环，t ≥ duration）：销毁所有发射器，移除 InstancedMesh
- 动画停止/切换：销毁所有发射器
- 循环动画：粒子持续运行，无需处理
6.4 UI 开发注意事项
- listAnimationTemplates() 中 emit 的 params 使用扁平 key（如 velDirX、colorStartR），与 plan 中的嵌套格式不同
- Slider 读取 emit 参数：rt.flattenEmitConfig(plan[groupId].emit) → 得扁平对象
- Slider 写入 emit 参数：从 slider 收集扁平值 → rt.unflattenEmitConfig(flat) → 写回 plan[groupId].emit
- 粒子效果在 slider 调整时需实时重建发射器以预览变化

---
8. 简单 LLM 对话
POST /api/chat
用于标题生成、剧情创作等辅助功能。
请求
{
  "messages": [
    { "role": "system", "content": "you are a game writer" },
    { "role": "user", "content": "generate a quest title" }
  ],
  "temperature": 0.7,
  "maxTokens": 1024,
  "provider": "fireworks"
}
返回
{ "ok": true, "content": "The Dragon's Awakening" }

---
9. 完整集成示例
最小化的前端应用
import * as THREE from 'three';

const API = 'https://voxel-studio-backend.zeabur.app';

// 1. 加载 runtime（THREE 注入）
const mod = await import(`${API}/api/templates/module.js`);
const runtime = mod.create({ THREE });

// 2. 生成模型
async function genModel(desc) {
  const resp = await fetch(`${API}/api/generate/model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: desc, provider: 'fireworks', mode: 'standard' }),
  });
  const text = await resp.text();
  let modelJson = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const e = JSON.parse(line.slice(5).trim());
    if (e.done) { modelJson = e.modelJson; break; }
    if (e.stage === 'error') throw new Error(e.error);
  }
  return modelJson;
}

// 3. 构建 Three.js 场景 — v2 扁平 nodes（局部坐标，parent 表达层级）
function buildScene(modelJson) {
  const scene = new THREE.Scene();

  function makeMaterial(mesh) {
    const mat = mesh.material || {};
    const color = mat.color ?? mesh.color ?? 0x888888;
    const zeroThick = (mesh.type === 'tri' || mesh.type === 'patch') && ((mesh.params?.d ?? 0) <= 0);
    return new THREE.MeshStandardMaterial({
      color,
      roughness: mat.roughness ?? 0.5,
      metalness: mat.metalness ?? 0.05,
      transparent: mat.transparent === true,
      opacity: mat.opacity ?? 1,
      flatShading: mat.flatShading !== false,
      side: zeroThick ? THREE.DoubleSide : THREE.FrontSide,
    });
  }

  // 两遍式：先按 node 建 Object3D，再按 parent 挂载
  const objs = new Map();
  for (const n of (modelJson.nodes || [])) {
    const obj = n.mesh
      ? new THREE.Mesh(runtime.buildGeometry(n.mesh.type, n.mesh.params || {}), makeMaterial(n.mesh))
      : new THREE.Group();
    obj.name = n.id;
    const t = n.transform || {};
    const p = t.pos || [0, 0, 0];
    obj.position.set(p[0], p[1], p[2]);
    if (t.quat) obj.quaternion.set(t.quat[0], t.quat[1], t.quat[2], t.quat[3]);
    if (t.scale && t.scale[0] > 0 && t.scale[1] > 0 && t.scale[2] > 0) {
      obj.scale.set(t.scale[0], t.scale[1], t.scale[2]);
    }
    objs.set(n.id, obj);
  }
  for (const n of (modelJson.nodes || [])) {
    const obj = objs.get(n.id);
    if (n.parent && objs.has(n.parent)) objs.get(n.parent).add(obj);
    else scene.add(obj);
  }
  return { scene, objs };
}

// 4. 存储基础姿态（动画停止时恢复用）
function saveBasePose(objs) {
  const base = new Map();
  for (const [id, obj] of objs) {
    base.set(id, {
      position: obj.position.clone(),
      rotation: obj.rotation.clone().toArray(),
      scale: obj.scale.clone(),
    });
  }
  return base;
}

// 5. 生成动画
async function genAnimation(modelJson, desc, emitParticles = false) {
  const resp = await fetch(`${API}/api/generate/animation-quick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelJson, description: desc, duration: 2.0, provider: 'fireworks', emitParticles }),
  });
  const { plan } = await resp.json();
  return plan;
}

// 6. 播放动画 — ⚠️ evaluateMotion 返回增量（delta），必须叠加到基础姿态
function playAnimation(plan, objs, duration) {
  // 保存基础姿态
  const basePose = saveBasePose(objs);
  const start = performance.now();

  function loop() {
    const t = (performance.now() - start) / 1000;
    const ct = plan._loop ? t % duration : Math.min(t, duration);

    // 获取动画增量
    const pose = runtime.evaluateMotion(plan, duration, ct);

    // 叠加增量到每个 group
    for (const [partId, delta] of Object.entries(pose)) {
      if (partId.startsWith('_')) continue;
      const obj = objs.get(partId);
      const base = basePose.get(partId);
      if (!obj || !base) continue;

      // 位置 = 基础 + 增量
      if (delta.position) {
        obj.position.set(
          base.position.x + delta.position[0],
          base.position.y + delta.position[1],
          base.position.z + delta.position[2]
        );
      }
      // 旋转 = 基础 + 增量（用 Euler 临时叠加；生产环境建议用 Quaternion）
      if (delta.rotation) {
        obj.rotation.set(
          base.rotation[0] + delta.rotation[0],
          base.rotation[1] + delta.rotation[1],
          base.rotation[2] + delta.rotation[2]
        );
      }
      // 缩放 = 基础 × 增量（scale 为乘法叠加）
      if (delta.scale) {
        obj.scale.set(
          base.scale.x * delta.scale[0],
          base.scale.y * delta.scale[1],
          base.scale.z * delta.scale[2]
        );
      }
    }

    // 动画结束处理
    if (!plan._loop && ct >= duration) {
      // 恢复基础姿态
      for (const [partId, base] of basePose) {
        const obj = objs.get(partId);
        if (obj) {
          obj.position.copy(base.position);
          obj.rotation.set(base.rotation[0], base.rotation[1], base.rotation[2]);
          obj.scale.copy(base.scale);
        }
      }
      return; // 停止循环
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// ═══ 启动 ═══
const modelJson = await genModel('a lowpoly dragon');
const { scene, objs } = buildScene(modelJson);
const plan = await genAnimation(modelJson, 'flying loop');
playAnimation(plan, objs, plan._duration);

---
10. 错误处理
HTTP 状态
含义
处理
200 SSE 含 errorCode=GENERATION_FAILED
AI 生成失败
展示通用失败提示，可安全重试
429
该 provider 被限速
换一个 provider 重试
500
请求未完成
展示通用失败提示
Provider 可用列表：
const PROVIDERS = ['fireworks', 'glm', 'gpt', 'deepseek'];
建议实现 fallback chain：fireworks → glm → gpt → deepseek。

---
11. 注意事项
1. 不要硬编码模板名或几何类型名。所有类型信息从 runtime.listAnimationTemplates() 和 runtime.listGeometryTypes() 动态获取。
2. 不要硬编码 geometry 参数名。用 runtime.buildGeometry(type, params) 构建几何——参数名由模板定义，前端只负责传递 modelJson 中的 mesh.params。
3. 播放动画必须叠加增量。runtime.evaluateMotion 返回的是增量（delta），不是绝对位姿。必须叠加到基础姿态上——见 §8 完整示例的 playAnimation 函数。
4. 动画 Canvas 预览用 runtime.evaluateTemplate。传入单个模板名、参数、时间、duration，得到单个模板的增量。
5. 模型生成是 SSE 流式。POST /api/generate/model 返回 text/event-stream，按 \n\n 分隔事件。
6. 批量生成默认是 SSE 流式。POST /api/generate/batch 会先返回 start，随后逐条返回 item，最后返回 done；需要旧版普通 JSON 时传 stream:false。
7. 粒子需独立渲染。emit track 不产生 transform 增量（evaluateMotion 会跳过它）。前端需自行实现 InstancedMesh 粒子系统——见 §6 完整指南。
8. 粒子 slider UI 需要 flat ↔ nested 转换。listAnimationTemplates() 中 emit 的 params 是扁平 key。从 plan 读取 emit 参数时用 rt.flattenEmitConfig()，写回时用 rt.unflattenEmitConfig()。
9. Health check：GET /health 返回 {"ok":true}，可用于启动时验证后端可用。
10. CORS：后端已配置 Access-Control-Allow-Origin，本地开发不需要代理。
