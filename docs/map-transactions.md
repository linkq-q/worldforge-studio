# 地图事务协议

基础 AI 和外部 Agent 必须输出同一种 `MapOperation[]`。服务端先在内存中按顺序验证并应用全部操作，成功后只保存一次；任一操作失败时地图不变。

## HTTP

基础版地图 AI 生成预览：

```http
POST /api/editor/maps/:mapId/generate
Content-Type: application/json

{
  "prompt": "起伏的田园，有一片树林，把出生点放在南侧",
  "provider": "gpt"
}
```

返回的 `suggestion.operations` 只是预览建议。前端先在内存中应用；用户确认后，再把同一批操作提交到事务入口。AI 输出中的视觉氛围词保存为 `renderPromptSuggestions`，留给第二阶段选择使用。`suggestion.composition` 可包含本次导演计划、动态专家与合成审查信息，但它只服务预览解释，不进入地图持久化。

空地图生成接口内部运行有界场景编排：总导演输出 `SceneCompositionPlan`；按导演决策调用 0-2 个局部专家；服务端按语义标签从完整共享库解析资产，小/中/大地图分别组织 2-4、6-10、8-14 个可辨识资产变体，已有跨模式资产计入额度，缺失项按地图默认模式生成；确定性编译器展开地形、水体和散布；合成审查最多修正一次计划；最后 `mapLint` 验证编译后的真实地图状态。任一模型角色的无效 JSON 最多修复一次，不存在无限 Agent loop。

`POST /generate` 只接受空地图。已有地形、水体、绘制或物体时必须使用 `POST /refine`，避免重新构图静默覆盖已有工作。普通生成链路不规划出生点、战斗、掩体或玩法规则。

重复物体不要求模型逐个编写坐标。模型可输出 `scatters` 分布意图：

```json
{
  "assetIds": ["asset-pine", "asset-birch"],
  "region": { "kind": "circle", "x": -20, "z": 10, "r": 25 },
  "density": 0.06,
  "avoidWater": 2,
  "maxSlope": 25,
  "minSpacing": 3,
  "scaleRange": [0.8, 1.4],
  "seed": 7
}
```

服务端以确定性抖动网格展开坐标，避开湖泊、河流缓冲区、陡坡、已有物体碰撞范围和间距不足的位置，并添加随机朝向与缩放。多组散布按顺序共享占用空间；出生点也会避开水域、陡坡和最终物体碰撞范围。返回客户端前，`scatters` 已全部展开为最终 `object.add`；因此预览和提交使用同一份坐标，事务协议本身不新增 `scatter` 操作。

结构化水域使用同一事务协议：

- `water.add`：新增湖泊边界或河流中心线
- `water.update`：修改水位、宽度、名称或控制点
- `water.remove`：移除水域

湖泊至少 3 个边界点；河流至少 2 个中心线点并使用 `width`。服务端会校验并裁剪到地图范围，渲染阶段通过 `runtime.water-style` 统一控制。

提交：

```http
POST /api/editor/maps/:mapId/transactions
Content-Type: application/json

{
  "label": "生成田园场景",
  "source": "agent",
  "operations": [
    { "type": "map.update", "name": "田园场景", "size": [48, 12, 48] },
    {
      "type": "object.add",
      "object": {
        "id": "tree-01",
        "name": "橡树",
        "assetId": "asset-tree",
        "transform": { "position": [4, 0, -3] }
      }
    },
    { "type": "sun.set", "point": [-18, 24, 14] }
  ]
}
```

查询当前可撤销事务：

```http
GET /api/editor/maps/:mapId/transactions
```

撤销：

```http
POST /api/editor/maps/:mapId/transactions/undo
```

重做刚撤销的事务：

```http
POST /api/editor/maps/:mapId/transactions/redo
```

## CLI

把操作数组保存为 JSON 文件后执行：

```bash
npm run map -- apply-transaction --map <mapId> --file <operations.json> --source agent --label "生成田园场景"
npm run map -- undo-transaction --map <mapId>
npm run map -- redo-transaction --map <mapId>
```

## 操作类型

- `map.update`：名称、尺寸、六面颜色
- `terrain.set`：设置完整高度场
- `terrain.brush`：抬高、降低或平整局部地形
- `paint.add`：增加表面笔刷
- `object.add`：增加对象；若同一事务后续要引用它，应显式提供稳定 ID
- `object.update`：修改对象、层级、资产引用或 Transform
- `object.remove`：删除对象，并解除子对象的父级引用
- `reference.set`：设置场景参考点和可选朝向
- `sun.set`：设置太阳位置

## 当前限制

每张地图只保存最近一次 AI/Agent 事务的撤销快照；撤销后保存对应的一步重做快照。新的事务会替换旧快照；任何普通编辑和保存都会清除撤销与重做快照，避免历史操作覆盖之后的手工修改。
