# 地图事务协议

基础 AI 和外部 Agent 必须输出同一种 `MapOperation[]`。服务端先在内存中按顺序验证并应用全部操作，成功后只保存一次；任一操作失败时地图不变。

## HTTP

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

## CLI

把操作数组保存为 JSON 文件后执行：

```bash
npm run map -- apply-transaction --map <mapId> --file <operations.json> --source agent --label "生成田园场景"
npm run map -- undo-transaction --map <mapId>
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

每张地图只保存最近一次 AI/Agent 事务的撤销快照。新的事务会替换旧快照；任何普通编辑和保存都会清除快照，避免撤销时覆盖之后的手工修改。
