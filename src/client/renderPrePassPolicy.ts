import type * as THREE from 'three';

/** Water consumes scene depth; it must never write its own surface into it. */
export function isNormalDepthPrePassMesh(mesh: THREE.Mesh): boolean {
  if (!mesh.visible) return false;
  let current: THREE.Object3D | null = mesh;
  while (current) {
    if (
      current.userData.isWater
      || current.userData.skipShaderApply
      || current.userData.skipNormalDepthPrePass
      || current.userData.noNormalDepth
      || current.userData.isEditorObject
      || current.userData.isEnvironmentObject
      || current.userData.isHelper
      || current.userData.shaderOutline
      || current.userData.isOutline
      || current.name === '__outlineMesh__'
    ) return false;
    current = current.parent;
  }
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return !materials.some((material) => material?.transparent || Number(material?.opacity ?? 1) < 1);
}
