# 地图库与生成实验

编辑器工具栏的「地图库」「实验」打开底部面板，上方场景持续可见。点击地图直接载入当前编辑器，保留未保存修改确认。面板可放大、收起，收起后保留未提交的表单和审查位置。
旧地址 /?workspace=library 或 /?workspace=experiments 也会打开编辑器内对应面板。

## 地图文件夹

文件夹是地图的组织信息，不是另一份地图。支持子文件夹、重命名、搜索、批量移动和移回「未归档」。
旧地图自动显示在「未归档」，无需迁移。移动不会修改地图 JSON、版本、资产或撤销记录。
编辑器选定的文件夹同时作为手工新建地图的目标；选择「全部地图」时新地图放入「未归档」。
实验必须指定目标文件夹，所有运行的工作地图都会归入该目录。失败运行可能留下部分或空工作地图，保留用于排查。
文件夹及归属保存在数据目录的 map-catalog.json。文件夹不是操作系统目录。

## 实验

- 同条件重复：每个结果独立规划。
- 资产模型对照：同一用例、同一规划重复组共用规划，分别交给不同资产 Provider，也可重复生成资产。
- 提示词对照：每份提示词独立重复，其他配置固定。
- API 对照：复用既有 core10 加单个辅助 API 的实验配置；不同组只改变 API 附录。此模式限定室外、first-pass，并在生成资产前检查代码是否使用未开放 API。
  当前不是任意 API 集合编辑器。
- 高级配置 JSON 的 cases[].systemPrompt 可替换规划系统提示词（仅 editor API 配置）。原始请求仍记录在生成日志中。

批量运行默认不修复代码、不按生成资产请求二次调整，并仅诊断空间问题；这与编辑器默认自动修复不同，界面和配置会明确显示。
可为普通实验开启修复。地图的基础随机条件在同一个实验内固定；这不承诺模型输出确定性。
每次生成走现有 Scene Code 规划器和共享资产生成工厂，保留标准资产重试、种子变体、校验、事务保存和日志链路。
任务本地串行执行，资产生成内部保留已有并行池。关闭页面不终止队列，但本地服务必须保持运行。

创建仅保存配置及展开后的清单；点击「开始 / 继续」才调用模型。运行配置不会被覆盖，修改时复制为新实验。
「暂停队列」不打断当前运行；「取消」尽力取消选定运行。「重试」新增尝试并保留旧记录。
有完整生成结果时，重试只重试保存/归档，不再次调用模型。地图版本已变化则拒绝套用旧结果。
服务重启后，原运行项标记中断，队列暂停，不自动重发不确定的模型请求。
「复用资产重放」复用最终代码和已保存资产，不请求规划或资产模型，关闭模型后续调整；程序空间修复沿用实验设置。
API/CLI 的 regenerate 可基于同一规划重新生成资产，原记录不变。

## 审查和留存

每个成功结果保存含内嵌资产的地图快照；查看实验预览使用该快照及统一中性渲染，不依赖工作地图后续修改。
地图阶段不自动确认地图，也不触发 AI 渲染生成。
结果可旋转查看、配对比较，按提示词满足程度、布局、资产质量、搭建质量填写快捷评价和问题标签。
Agent 初评与人工评价分开保存；Agent 需提供 evidence，不能把未看过的画面当视觉证据。
「填入 Agent 初评」仅填表，必须保存才成为人工评价。
未评价不等于差评，运行完成不等于质量通过。失败、重试及规划分组均保留。部分资产生成失败会单独标记，保留可查看的地图，不混入完整结果。
导出记录是实验配置、运行清单和评价 JSON；完整地图与代码分别通过 artifact 接口读取。
当前耗时为运行总耗时，共用规划的后续结果不重复计规划耗时，不能据此直接比较资产 Provider 的生成速度。

数据目录 experiments/ 中保存任务、规划、原始生成结果和最终地图快照；生成过程日志继续位于 logs/generation-*。
日志含提示词和模型返回内容，不提交到 Git。没有用量数据时不推算实际费用。
记录 Git commit、dirty 状态及源码差异摘要；这不是完整源码备份，复现实验仍需保留对应代码版本。

## Agent / 脚本

所有入口共用本地 HTTP 服务。默认 http://127.0.0.1:8797；CLI 可用 WORLDFORGE_API 指定其他本地端口。

npm run experiment -- help
npm run experiment -- folder-create "机场对照"
npm run experiment -- move folder-... map-... map-...
npm run experiment -- create experiment.json
npm run experiment -- start experiment-...
npm run experiment -- show experiment-...
npm run experiment -- review experiment-... run-... agent review.json

创建示例（folderId 替换为真实文件夹）：

~~~json
{
  "name": "机场资产模型对照",
  "question": "同一份规划下，资产质量与搭建质量是否一致？",
  "folderId": "folder-...",
  "template": "assets",
  "cases": [{"name": "机场", "prompt": "生成有航站楼和停机坪的机场", "apiProfile": "editor"}],
  "repeats": 3,
  "assetRepeats": 1,
  "provider": "gpt",
  "assetProviders": ["gpt", "deepseek"],
  "size": [96, 20, 96],
  "sceneMode": "outdoor",
  "assetGenerationMode": "voxel",
  "minNewAssets": 10,
  "maxNewAssets": 16,
  "promptMode": "standard",
  "revisionMode": "first-pass",
  "spatialPolicy": "diagnose"
}
~~~

| 方法 | 路径（前缀 /api/editor） | 内容 |
|---|---|---|
| GET / POST | /map-folders | 读取分类；创建/重命名/移动文件夹 {id?,name,parentId?} |
| POST | /map-folders/move | {mapIds,folderId}；null 移回未归档 |
| GET / POST | /experiments | 列表；提交完整配置 |
| GET | /experiments/:id | 状态、运行清单、评价 |
| POST | /experiments/:id/control | {action:"start"或"pause"或"cancel"或"retry"或"replay"或"regenerate",runId?} |
| GET | /experiments/:id/runs/:run/artifacts/:type | type 为 plan、result、snapshot |
| PUT | /experiments/:id/runs/:run/reviews/:actor | actor 为 human 或 agent |

评价示例：

~~~json
{
  "prompt": "good", "layout": "fair", "assets": "good", "assembly": "poor",
  "tags": ["连接断裂"], "note": "门口与道路不接合",
  "evidence": "实际查看了结果地图的正面与俯视预览"
}
~~~

评分枚举为 ""（未评价）、good、fair、poor、unknown。
可附 comparedRunId 及 preference（this、other、tie、unknown）。
