# @voxel-studio/render-runtime

共享的体素材质、合批、特效、环境与后处理运行时。包只依赖 `three` peer dependency；场景组织、编辑器 UI 与宿主接线由消费方负责。

当前消费者：

- `scene-builder.html`：完整渲染运行时。
- `js/editor/VoxelMaterialTagController.js`：Voxel Studio 材质标签薄适配层。

公共入口：

- `@voxel-studio/render-runtime`：管线、风格、CSM、RuntimeIndex 等核心能力。
- `@voxel-studio/render-runtime/batching`：合批与选择/材质覆盖运行时。
- `@voxel-studio/render-runtime/environment`：无 UI 的环境运行时；当前包含 WaterSurface。
- `@voxel-studio/render-runtime/effects`：材质标签、效果和粒子运行时。
- `@voxel-studio/render-runtime/materials`：材质默认值、分类和材质标签词表。
- `@voxel-studio/render-runtime/outline`：共享边缘、语义描边、描边模式与参数状态控制。
- `@voxel-studio/render-runtime/postprocess`：无 UI 后处理 pass 与 Comic Look 预设。

新消费者只能从上述入口导入。`./src/*` 通配出口仅为现有 Scene Builder 与 Voxel Studio 深层导入保留，待生产消费者迁移完成后删除。
