# 场景生成服务 API v1

调用链：曼德鸭浏览器 → 曼德鸭服务端 → WorldForge 服务 API → 模型后端。

曼德鸭服务端管理玩家身份、地图归属、请求频率和联机房间发布；WorldForge 负责场景生成、预览、微调和原子保存。服务 API 使用现有 GPT 后端规划，资产默认使用 DeepSeek。Codex 插件的当前任务模型只用于本地 Codex 模式，不参与此服务 API。

## 启动

安装项目依赖后，在 WorldForge 仓库运行（PowerShell）：

```powershell
$env:WORLDFORGE_SERVICE_TOKEN = '<服务端专用随机凭据，建议至少 32 字节>'
$env:PORT = '8798'
$env:WORLDFORGE_DATA_DIR = 'C:\WorldForgeData\service'
npm.cmd run service
```

曼德鸭服务端持有相同凭据，每次请求发送 `Authorization: Bearer <凭据>`。凭据不得放入浏览器代码或 `VITE_*` 环境变量。

`npm run service` 必须配置凭据，默认只监听 `127.0.0.1`，默认数据目录为 `data/service-api`。它只提供 `/api/health` 和以下服务 API；编辑器、静态页面和无鉴权的 `/api/maps` 均返回 404。部署者决定如何将它接入服务器内网或 HTTPS 反向代理，需要跨主机监听时配置 `HOST`。代理应仅开放健康检查和 `/api/service/v1/`。

接口没有浏览器 CORS 授权。一个服务凭据代表一个可信调用方，有权访问该实例中的地图；它不代替曼德鸭的玩家鉴权和地图归属检查。玩家数据应使用专用服务实例，不能与开发者制作的地图库混用。

## 请求与响应

所有请求路径以 `/api/service/v1` 开头；POST 使用 `Content-Type: application/json`。默认响应为 JSON。

| 方法 | 路径 | 请求与返回 |
| --- | --- | --- |
| POST | `/maps` | `{name?, size?, sceneMode?}` → `{map}`，创建空地图 |
| GET | `/maps/:id` | 返回已保存的 `{map}`，包含引用资产的 `modelJson` 和碰撞数据 |
| POST | `/maps/:id/generate` | `{prompt, maxNewAssets?, ...}` → `{suggestion, baseVersion}`，只接受空地图 |
| POST | `/maps/:id/refine` | `{prompt, baseOperations?, expectedVersion?, ...}` → `{suggestion, baseVersion}`，返回修改差量 |
| POST | `/maps/:id/preview` | `{operations, expectedVersion}` → `{map, baseVersion}`，在内存中应用候选操作并补齐资产数据，不保存地图 |
| POST | `/maps/:id/transactions` | `{approved:true, expectedVersion, source:"agent", operations, label?, ai?}` → `{map, transaction}`，原子保存一次 |
| POST | `/maps/:id/visual-review` | `{imageDataUrl, baseOperations?, expectedVersion?}` → `{review, generationTraceId}`，检查游戏客户端提供的实际场景截图 |

`map` 使用 WorldForge 的 `EditableMap` 结构。曼德鸭目前已经使用 WorldForge viewer；服务端可将 `preview.map` 返回给客户端渲染。地图数据与最终渲染风格保持分离，本版服务 API 专注地图制作，渲染方案生成仍通过现有编辑器或 Codex 插件完成。

生成和微调默认 `provider:"gpt"`、`assetProvider:"deepseek"`、`sceneAgent:true`，可由可信游戏服务端显式设置支持的提供方。其他生成选项复用 [Scene Code 协议](code-driven-map-planner.md)，包括资产复用、生成预算和局部对象选择。`planOnly:true` 仅返回规划，不能把未执行的规划当作完整场景。

`suggestion.operations` 是候选 `MapOperation[]`。生成资产可能已经写入服务资产库，但候选操作尚未修改地图。`suggestion.blocked === true` 表示候选仍有未满足的要求，游戏服务端应展示诊断并要求继续修改，不能自动批准。服务端只有在玩家确认后才发送 `approved:true`；该字段记录调用方的确认，不提供独立的玩家授权证明。

## 生成、预览与确认

以下代码运行在曼德鸭服务端，基础地址和凭据由服务端配置提供：

```js
const base = process.env.WORLDFORGE_SERVICE_URL; // 例如 http://127.0.0.1:8798
const token = process.env.WORLDFORGE_SERVICE_TOKEN;

async function worldforge(route, body) {
  const response = await fetch(`${base}/api/service/v1${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
  return result;
}

const { map } = await worldforge('/maps', { name: '玩家的湖边营地' });
// 将 map.id 与当前玩家绑定，后续先检查归属，再调用 WorldForge。
const draft = await worldforge(`/maps/${map.id}/generate`, {
  prompt: '湖边的一小片营地，中央留出空地', maxNewAssets: 4
});
if (draft.suggestion.blocked) throw new Error('候选需要继续修改');
const preview = await worldforge(`/maps/${map.id}/preview`, {
  expectedVersion: draft.baseVersion,
  operations: draft.suggestion.operations
});
// 把 preview.map 发给玩家预览；在游戏服务端保存 draft，等待玩家确认。
```

玩家确认后的服务端处理：

```js
const saved = await worldforge(`/maps/${map.id}/transactions`, {
  approved: true,
  expectedVersion: draft.baseVersion,
  source: 'agent',
  label: draft.suggestion.summary,
  operations: draft.suggestion.operations,
  ai: { generationTraceId: draft.suggestion.generationTraceId }
});
// saved.map 是正式版本。是否允许房间使用，由曼德鸭服务端决定。
```

微调已保存地图：调用 `/refine`，预览并确认同样使用上述流程。微调尚未确认的草稿：给 `/refine` 传 `baseOperations: draft.suggestion.operations` 和 `expectedVersion: draft.baseVersion`；将返回的差量追加为 `[...baseOperations, ...suggestion.operations]`，再预览并一次性提交。不要把差量误当作完整草稿。

`baseVersion` 是生成时实际读取的地图版本。预览和保存要求 `expectedVersion`；携带 `baseOperations` 的微调和视觉检查也要求它。版本变化返回 409，调用方应重新读取地图并决定如何重新生成预览。事务的版本检查与保存处在同一把锁内；两个基于同一版本的并发保存只会成功一个。

## 长请求、错误与部署边界

生成/微调支持 `Accept: text/event-stream`。事件包括 `progress`、`plan`、`asset-ready`、`preview`、`result` 和 `error`；最终 `result` 包含 `baseVersion`。收到 HTTP 200 只表示流已建立，必须继续读取到 `result`，并处理 `error`。微调流中收到的中间预览不能当作已保存地图。连接断开时沿用现有取消逻辑。

这是持续 HTTP 请求，当前没有持久化后台任务队列或断线续传。调用方和代理需允许场景生成所需的请求时长。不要自动重试创建、生成或确认请求：创建和生成会产生新数据，重复确认会因版本变化返回 409；遇到不确定的确认结果，先 GET 地图核对版本。异步排队、玩家配额和限流可在曼德鸭服务端接入。

当前文件存储的事务锁在进程内，同一数据目录只能由一个 WorldForge 服务进程写入。本版的并发版本保护不覆盖多个进程共同写同一目录。

| 状态 | 含义 |
| --- | --- |
| 400 | 缺少确认、版本无效或操作不合法；服务 API 不接受 Codex run header |
| 401 | 缺少或错误的服务端凭据 |
| 404 | 地图不存在或接口不在公开列表中 |
| 405 | HTTP 方法不支持 |
| 409 | 地图版本已变化，或对非空地图调用了 generate |
| 503 | 未配置服务端凭据，服务 API 未启用 |

本次提供 WorldForge 服务接口与接入说明。曼德鸭的网页按钮、玩家路由、归属记录、房间发布和线上部署需要在游戏项目中接入；不能把 WorldForge 的服务凭据直接发给浏览器。
