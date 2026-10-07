import * as THREE from 'three';
import { addMaterialShaderPatch, removeMaterialShaderPatch } from '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js';

const KEY = 'worldforge:outdoor-edge-normal';

/** A small shading bevel, in metres. Geometry, silhouettes and authored material tags are untouched. */
export class OutdoorEdgeNormals {
  private readonly materials = new Set<THREE.Material>();

  apply(root: THREE.Object3D, width: number, roughnessScale = 1): void {
    this.clear();
    if (!Number.isFinite(width) || (width <= 0 && roughnessScale === 1)) return;
    const candidates = new Map<THREE.MeshStandardMaterial, THREE.Box3>();
    const excluded = new Set<THREE.Material>();
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const box = mesh.geometry.type === 'BoxGeometry';
      for (const source of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const material = source as THREE.MeshStandardMaterial;
        if (!material?.isMeshStandardMaterial) continue;
        const sets = [material.userData.effectVariant?.uniforms,
          ...Object.values(material.userData.effectLayers ?? {}).map((layer: any) => layer.uniforms)];
        if (!box || mesh.userData.skipShaderApply || material.transparent
          || sets.some(set => set?.uFoliageTransmission)) { excluded.add(material); continue; }
        mesh.geometry.computeBoundingBox();
        const bounds = mesh.geometry.boundingBox!;
        const previous = candidates.get(material);
        if (previous && !previous.equals(bounds)) excluded.add(material);
        else candidates.set(material, bounds.clone());
      }
    });
    let sceneRoot = root;
    while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
    sceneRoot.traverse(object => {
      let ancestor: THREE.Object3D | null = object;
      while (ancestor && ancestor !== root) ancestor = ancestor.parent;
      if (ancestor) return;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) excluded.add(material);
    });
    for (const [material, bounds] of candidates) {
      if (excluded.has(material)) continue;
      this.materials.add(material);
      addMaterialShaderPatch(material, KEY, shader => {
        shader.uniforms.uOutdoorEdgeMin = { value: bounds.min };
        shader.uniforms.uOutdoorEdgeMax = { value: bounds.max };
        shader.uniforms.uOutdoorEdgeWidth = { value: Math.min(0.15, width) };
        shader.uniforms.uOutdoorRoughnessScale = { value: THREE.MathUtils.clamp(roughnessScale, 0.5, 1.5) };
        const varying = `varying vec3 vOutdoorEdgePosition, vOutdoorEdgeScale;
          varying vec3 vOutdoorEdgeViewX, vOutdoorEdgeViewY, vOutdoorEdgeViewZ;\n`;
        shader.vertexShader = varying + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          vOutdoorEdgePosition = position;
          mat4 outdoorEdgeTransform = modelMatrix;
          #ifdef USE_INSTANCING
            outdoorEdgeTransform *= instanceMatrix;
          #endif
          vOutdoorEdgeScale = vec3(length(outdoorEdgeTransform[0].xyz), length(outdoorEdgeTransform[1].xyz), length(outdoorEdgeTransform[2].xyz));
          vOutdoorEdgeViewX = normalize(mat3(viewMatrix) * outdoorEdgeTransform[0].xyz);
          vOutdoorEdgeViewY = normalize(mat3(viewMatrix) * outdoorEdgeTransform[1].xyz);
          vOutdoorEdgeViewZ = normalize(mat3(viewMatrix) * outdoorEdgeTransform[2].xyz);`);
        shader.fragmentShader = varying + 'uniform vec3 uOutdoorEdgeMin, uOutdoorEdgeMax;\nuniform float uOutdoorEdgeWidth, uOutdoorRoughnessScale;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>',
          'roughnessFactor = clamp(roughnessFactor * uOutdoorRoughnessScale, 0.045, 1.0);\n#include <lights_physical_fragment>');
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          vec3 outdoorEdgeCenter = (uOutdoorEdgeMin + uOutdoorEdgeMax) * 0.5;
          vec3 outdoorEdgeHalf = (uOutdoorEdgeMax - uOutdoorEdgeMin) * 0.5 * vOutdoorEdgeScale;
          vec3 outdoorEdgeLocal = (vOutdoorEdgePosition - outdoorEdgeCenter) * vOutdoorEdgeScale;
          float outdoorBevelWidth = min(uOutdoorEdgeWidth, min(outdoorEdgeHalf.x, min(outdoorEdgeHalf.y, outdoorEdgeHalf.z)) * 0.22);
          vec3 outdoorBevel = max(abs(outdoorEdgeLocal) - (outdoorEdgeHalf - outdoorBevelWidth), vec3(0.0));
          outdoorBevel = normalize(outdoorBevel + vec3(1e-8)) * sign(outdoorEdgeLocal);
          vec3 outdoorBevelView = normalize(vOutdoorEdgeViewX * outdoorBevel.x + vOutdoorEdgeViewY * outdoorBevel.y + vOutdoorEdgeViewZ * outdoorBevel.z);
          // Fade subpixel edge normals instead of producing sparkling highlights during motion.
          float outdoorEdgeCoverage = clamp(outdoorBevelWidth / max(length(fwidth(outdoorEdgeLocal)), 0.0001), 0.0, 1.0);
          normal = normalize(mix(normal, outdoorBevelView, outdoorEdgeCoverage * 0.9));`);
      }, { order: 270, cacheKey: () => KEY });
    }
  }

  clear(): void {
    for (const material of this.materials) removeMaterialShaderPatch(material, KEY);
    this.materials.clear();
  }
  dispose(): void { this.clear(); }
}
