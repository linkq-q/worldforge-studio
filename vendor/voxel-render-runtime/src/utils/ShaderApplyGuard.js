// gizmo 轴名集合，与 Object3D 父节点组合时视为 TransformControls 内部对象
const _GIZMO_AXIS_NAMES = new Set(['X', 'Y', 'Z', 'XY', 'YZ', 'XZ', 'XYZ', 'XYZE', 'E', 'START', 'END']);

/**
 * 判断一个对象是否应跳过全局材质/效果系统（ShaderLibrary、RenderLayers 等）处理。
 * 覆盖 TransformControls 本体、所有子节点以及 gizmo 轴 mesh。
 * 同时跳过环境对象（ProceduralSky、WaterSurface 等）。
 *
 * 零依赖（不 import three），供需要在纯 node 下测试的模块复用。
 * 参见 docs/architecture-constraints.md §4。
 * @param {object} obj
 * @returns {boolean}
 */
export function shouldSkipShaderApply(obj) {
  let current = obj;
  while (current) {
    if (current.userData?.skipShaderApply) return true;
    if (current.userData?.skipShaderLibrary) return true;
    if (current.userData?.isEnvironmentObject) return true;
    if (current.userData?.isEditorObject) return true;
    if (current.type === 'TransformControls') return true;
    if (current.name?.includes('TransformControls')) return true;
    if (current.name === 'TransformControlsPlane') return true;

    // 按名称跳过已知环境对象
    if (current.name === 'ProceduralSky') return true;
    if (current.name === 'WaterSurface') return true;
    if (current.name === 'RaymarchCloudLayer') return true;
    if (current.name === '__outlineMesh__') return true;
    if (current.userData?.isHelper) return true;
    if (current.userData?.isGizmo) return true;
    if (current.userData?.isGrid) return true;
    if (current.userData?.isSelectionHelper) return true;

    current = current.parent;
  }
  // gizmo 内部常见轴名 + 父节点为 Object3D
  if (_GIZMO_AXIS_NAMES.has(obj.name) && obj.parent?.type === 'Object3D') {
    return true;
  }
  return false;
}
