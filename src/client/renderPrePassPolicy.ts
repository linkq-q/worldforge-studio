import type * as THREE from 'three';

/** Water consumes scene depth; it must never write its own surface into it. */
export function isNormalDepthPrePassMesh(mesh: THREE.Mesh): boolean {
  if (!mesh.visible) return false;
  let forceNormalDepthPrePass = false;
  let current: THREE.Object3D | null = mesh;
  while (current) {
    forceNormalDepthPrePass ||= current.userData.forceNormalDepthPrePass === true;
    if (
      current.userData.isWater
      || current.userData.skipNormalDepthPrePass
      || current.userData.noNormalDepth
      || current.userData.isEditorObject
      || current.userData.isHelper
      || current.userData.shaderOutline
      || current.userData.isOutline
      || current.name === '__outlineMesh__'
    ) return false;
    current = current.parent;
  }
  if (!forceNormalDepthPrePass) {
    current = mesh;
    while (current) {
      if (current.userData.skipShaderApply || current.userData.isEnvironmentObject) return false;
      current = current.parent;
    }
  }
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return !materials.some((material) => material?.transparent || Number(material?.opacity ?? 1) < 1);
}
