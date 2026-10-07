import * as THREE from 'three';
import {
  addMaterialShaderPatch,
  removeMaterialShaderPatch
} from '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js';
import { OutdoorFoliagePasses, patchOutdoorFoliage } from './outdoorFoliageRuntime';

const PATCH_KEY = 'worldforge:outdoor-material';
type Uniforms = Record<string, { value: unknown }>;
interface NumberChange {
  target: Record<string, unknown>;
  key: string;
  before: number;
  applied: number;
}
interface BoundsChange { uniform: { value: unknown }; before: unknown; applied: Float32Array }

/** Opt-in surface treatment. Authored tags, geometry and colors remain intact. */
export class OutdoorMaterialRuntime {
  private readonly changes: NumberChange[] = [];
  private readonly materials = new Set<THREE.Material>();
  private readonly foliagePasses = new OutdoorFoliagePasses();
  private readonly boundsChanges: BoundsChange[] = [];
  private readonly sunDirection = { value: new THREE.Vector3(-0.32, 0.91, 0.26).normalize() };

  setSunDirection(direction: THREE.Vector3): void {
    if (direction.lengthSq() > 0) this.sunDirection.value.copy(direction).normalize();
  }

  // In v2 strength controls surface detail; even zero retains corrected PBR/cutout rendering.
  apply(root: THREE.Object3D | null, strength: number, sunDirection?: THREE.Vector3, quality = 1): void {
    this.clear();
    if (sunDirection) this.setSunDirection(sunDirection);
    const amount = Number.isFinite(strength) ? THREE.MathUtils.clamp(strength, 0, 1) : 0;
    if (!root || (amount === 0 && quality < 2)) return;

    const candidates = new Set<THREE.MeshStandardMaterial>();
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || object.userData.skipShaderApply) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if ((material as THREE.MeshStandardMaterial)?.isMeshStandardMaterial) {
          candidates.add(material as THREE.MeshStandardMaterial);
        }
      }
    });
    // A material shared with an object outside modelsRoot is not ours to change.
    let sceneRoot = root;
    while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
    sceneRoot.traverse(object => {
      let ancestor: THREE.Object3D | null = object;
      while (ancestor && ancestor !== root) ancestor = ancestor.parent;
      if (ancestor) return;
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        candidates.delete(material as THREE.MeshStandardMaterial);
      }
    });

    const foliageMaterials = new Set<THREE.MeshStandardMaterial>();
    for (const material of candidates) {
      if (this.applyMaterial(material, amount, quality)) foliageMaterials.add(material);
    }
    const leafBounds = new Map<THREE.MeshStandardMaterial, THREE.Box3 | null>();
    if (quality >= 2) root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || object.userData.skipShaderApply) return;
      // Custom shadow materials are per object; one homogeneous material also covers instanced/batched meshes.
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const source = materials[0] as THREE.MeshStandardMaterial;
      if (foliageMaterials.has(source) && materials.every(material => material === source)) {
        this.foliagePasses.apply(mesh, source);
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bounds = mesh.geometry.boundingBox;
        if (!bounds || bounds.isEmpty()) return;
        if (!leafBounds.has(source)) leafBounds.set(source, bounds.clone());
        else if (!leafBounds.get(source)?.equals(bounds)) leafBounds.set(source, null);
      }
    });
    for (const [material, bounds] of leafBounds) {
      if (!bounds) continue;
      // Base batching applies effects to the material, which otherwise leaves [0,1] default bounds.
      const uniforms = [material.userData.effectVariant?.uniforms,
        ...Object.values(material.userData.effectLayers ?? {}).map(entry => (entry as { uniforms?: Uniforms }).uniforms)]
        .find(uniforms => uniforms?.uFoliageTransmission) as Uniforms | undefined;
      for (const [key, vector] of [['uEffLayerBoundsMin', bounds.min], ['uEffLayerBoundsSize', bounds.getSize(new THREE.Vector3())]] as const) {
        const uniform = uniforms?.[key];
        if (!uniform) continue;
        const applied = new Float32Array(vector.toArray());
        this.boundsChanges.push({ uniform, before: uniform.value, applied });
        uniform.value = applied;
      }
    }
  }

  clear(): void {
    this.foliagePasses.clear();
    for (const { uniform, before, applied } of this.boundsChanges) {
      if (uniform.value === applied) uniform.value = before;
    }
    this.boundsChanges.length = 0;
    for (const material of this.materials) removeMaterialShaderPatch(material, PATCH_KEY);
    // A later scheme/tag restore may already own a value: don't overwrite it.
    for (const change of this.changes.reverse()) {
      if (change.target[change.key] === change.applied) change.target[change.key] = change.before;
    }
    this.changes.length = 0;
    this.materials.clear();
  }

  dispose(): void { this.clear(); }

  private change(target: object, key: string, next: number, amount: number): void {
    const record = target as Record<string, unknown>;
    const before = record[key];
    if (typeof before !== 'number') return;
    const applied = THREE.MathUtils.lerp(before, next, amount);
    this.changes.push({ target: record, key, before, applied });
    record[key] = applied;
  }

  private applyMaterial(material: THREE.MeshStandardMaterial, detail: number, quality: number): boolean {
    const version2 = quality >= 2;
    const amount = version2 ? 1 : detail;
    const uniformSets: Uniforms[] = [
      material.userData.effectVariant?.uniforms,
      ...Object.values(material.userData.effectLayers ?? {}).map(entry => (entry as { uniforms?: Uniforms }).uniforms)
    ].filter((uniforms): uniforms is Uniforms => !!uniforms);
    const triplanar = uniformSets.find(uniforms => uniforms.uTriplanarPattern);
    const foliage = uniformSets.find(uniforms => uniforms.uFoliageTransmission);
    const matcap = material.userData.worldforgeMaterialMatcapUniforms as Uniforms | undefined;
    const pattern = triplanar?.uTriplanarPattern.value;
    const stone = typeof pattern === 'number' && pattern >= 1 && pattern <= 4;
    const wood = pattern === 0 || pattern === 5;
    if (!stone && !wood && !foliage && !matcap) return false;
    this.materials.add(material);

    const roughness = version2
      ? (foliage ? 0.68 : matcap ? 0.38 : stone ? 0.8 : pattern === 5 ? 0.82 : 0.65)
      : (foliage ? 0.86 : matcap ? 0.46 : stone ? 0.86 : 0.78);
    const metalness = matcap ? 1 : 0;
    this.change(material, 'roughness', roughness, amount);
    this.change(material, 'metalness', metalness, amount);
    const surfaceRoughness = material.roughness;
    const surfaceMetalness = material.metalness;
    if (triplanar && (stone || wood)) {
      const tune = (key: string, next: number) => {
        if (triplanar[key]) this.change(triplanar[key], 'value', next, amount);
      };
      const value = (key: string) => Number(triplanar[key]?.value ?? 0);
      tune('uTriplanarStrength', value('uTriplanarStrength') * (stone ? 0.72 : 0.85));
      tune('uTriplanarMacroStrength', Math.min(value('uTriplanarMacroStrength'), stone ? 0.14 : 0.18));
      tune('uTriplanarFineNoise', value('uTriplanarFineNoise') * 0.6);
      if (stone) {
        tune('uTriplanarScale', value('uTriplanarScale') * 0.72);
        tune('uTriplanarEdge', value('uTriplanarEdge') * 0.72);
        tune('uTriplanarMarbleRoughnessVariation', 0.06);
        tune('uTriplanarMarbleNormalStrength', 0.018);
        tune('uTriplanarStoneNormalStrength', Math.min(0.04, Math.max(0.015, value('uTriplanarStoneNormalStrength'))));
      }
      if (version2) {
        for (const key of ['uTriplanarStrength', 'uTriplanarFineNoise', 'uTriplanarMacroStrength',
          'uTriplanarStoneNormalStrength', 'uTriplanarBarkNormalStrength',
          'uTriplanarMarbleRoughnessVariation', 'uTriplanarMarbleNormalStrength']) {
          tune(key, value(key) * detail);
        }
      }
    }
    if (foliage) {
      for (const [key, value] of Object.entries({
        ...(version2 ? { uFoliageCutoutThreshold: 0.35, uFoliageCutoutScale: 6 } : {}),
        uFoliageAoStrength: version2 ? 0 : 0.10,
        uFoliageTransmission: version2 ? 0.7 : 0.85,
        uFoliageClusterVariance: version2 ? 0.08 : 0.12,
        uFoliageQuantSteps: 0
      })) if (foliage[key]) this.change(foliage[key], 'value', value, amount);
    }
    if (matcap?.uTextureMatcapBlend) {
      this.change(matcap.uTextureMatcapBlend, 'value', version2 ? 0 : Math.min(Number(matcap.uTextureMatcapBlend.value), 0.18), amount);
    }

    addMaterialShaderPatch(material, PATCH_KEY, shader => {
      shader.uniforms.uOutdoorMaterialStrength = { value: amount };
      shader.uniforms.uOutdoorSunDirection = this.sunDirection;
      shader.uniforms.uOutdoorSurfaceRoughness = { value: surfaceRoughness };
      shader.uniforms.uOutdoorSurfaceMetalness = { value: surfaceMetalness };
      shader.fragmentShader = 'uniform float uOutdoorMaterialStrength;\nuniform vec3 uOutdoorSunDirection;\nuniform float uOutdoorSurfaceRoughness;\nuniform float uOutdoorSurfaceMetalness;\n' + shader.fragmentShader;
      // HDRI loading reapplies tag-owned surface properties asynchronously.
      // Keep this scheme's response after that restore, ahead of the micro normals.
      shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  roughnessFactor = clamp(uOutdoorSurfaceRoughness + roughnessFactor - roughness, 0.0, 1.0);
  metalnessFactor = clamp(uOutdoorSurfaceMetalness + metalnessFactor - metalness, 0.0, 1.0);`);
      if (triplanar && (stone || wood)) shader.fragmentShader = moveTriplanarToAlbedo(shader.fragmentShader);
      if (stone) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '* uTriplanarMarbleRoughnessVariation, 0.20, 0.58)',
          '* uTriplanarMarbleRoughnessVariation, mix(0.20, 0.62, uOutdoorMaterialStrength), mix(0.58, 0.96, uOutdoorMaterialStrength))'
        );
      }
      if (foliage && version2) {
        patchOutdoorFoliage(shader);
      } else if (foliage) {
        shader.fragmentShader = shader.fragmentShader.replace(
          'foliageLightDirection = normalize(directionalLights[0].direction);',
          'foliageLightDirection = normalize(mat3(viewMatrix) * uOutdoorSunDirection);'
        ).replace(
          'gl_FragColor.rgb += max(gl_FragColor.rgb, vec3(0.05))\n  * vec3(0.30, 0.72, 0.08) * foliageTransmissionGlow * 0.72;',
          `#if NUM_DIR_LIGHTS > 0
  // The sun supplies leaf transmission; a dark canopy does not become emissive.
  vec3 outdoorLeafLight = min(directionalLights[0].color, vec3(4.0));
  vec3 outdoorLeafTransmission = diffuseColor.rgb * outdoorLeafLight
    * vec3(0.32, 0.58, 0.12) * foliageTransmissionGlow * 0.20;
  gl_FragColor.rgb += mix(max(gl_FragColor.rgb, vec3(0.05))
    * vec3(0.30, 0.72, 0.08) * foliageTransmissionGlow * 0.72,
    outdoorLeafTransmission, uOutdoorMaterialStrength);
#endif`
        );
      }
    }, { order: 250, cacheKey: () => `outdoor-material:${quality}:${stone}:${wood}:${!!foliage}:${!!matcap}` });
    return !!foliage;
  }
}

function moveTriplanarToAlbedo(fragment: string): string {
  const match = fragment.match(/\/\/ wf-triplanar-color-begin\n([\s\S]*?)\/\/ wf-triplanar-color-end/);
  const anchor = '#include <lights_physical_fragment>';
  if (!match || !fragment.includes(anchor)) return fragment;
  const albedo = match[1].replace(
    /vec3 triLighting =[\s\S]*gl_FragColor\.rgb = mix\(gl_FragColor\.rgb, triResult, clamp\(uTriplanarStrength, 0\.0, 1\.0\)\);/,
    'diffuseColor.rgb *= mix(vec3(1.0), triTint, clamp(uTriplanarStrength, 0.0, 1.0));'
  );
  return fragment.replace(match[0], '').replace(anchor, `${albedo}\n${anchor}`);
}
