import * as THREE from 'three';
import { glassFragmentShader, glassVertexShader } from '../shaders/CartoonGlass.js';
import { isRenderableMesh, isOutlineMesh, isProtectedRenderObject } from './MeshCategoryClassifier.js';
import { RENDER_ORDER } from '../render/RenderOrders.js';

const DEFAULT_GLASS_PARAMS = {
  uGlassColor: '#add8e6',
  uColorStrength: 0.45,
  uRefractStrength: 0.04,
  uFresnelPower: 3.0,
  uOpacity: 0.35,
};

/**
 * 通用 uniform 写入：ShaderLibrary.applyTexture()（贴图上传）也复用这个工具，
 * 所以保留为独立导出函数而不是私有方法。
 */
export function applyShaderUniform(material, uniformName, value) {
  if (!material) return false;
  const uniform = material.userData?.shader?.uniforms?.[uniformName]
    || material.userData?.shaderLibraryUniforms?.[uniformName]
    || material.userData?.pbrAnimationUniforms?.[uniformName]
    || material.uniforms?.[uniformName];
  if (!uniform) {
    if (uniformName in material) {
      material[uniformName] = value;
      material.needsUpdate = true;
      return true;
    }
    return false;
  }
  if (uniform.value instanceof THREE.Color) {
    uniform.value.set(value);
    if (['uColor', 'uGlassColor'].includes(uniformName) && material.color) {
      material.color.copy(uniform.value);
    }
  } else if (uniform.value instanceof THREE.Vector3) {
    if (value instanceof THREE.Vector3) uniform.value.copy(value);
    else if (Array.isArray(value)) {
      uniform.value.set(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
    }
  } else if (value?.isTexture) {
    uniform.value = value;
  } else {
    uniform.value = Number(value);
  }
  material.needsUpdate = true;
  return true;
}

/**
 * Glass 材质生产 + 生命周期：ShaderLibrary 里唯一仍在写 mesh.material 的路径。
 * 依赖 MeshCategoryClassifier 判断 category === 'glass'，但不拥有分类状态本身。
 */
export class GlassMaterial {
  constructor(classifier) {
    this.classifier = classifier;
    this.params = { ...DEFAULT_GLASS_PARAMS };
    this.renderTarget = null;
    this.resolution = new THREE.Vector2(1, 1);
  }

  getParams() {
    return { ...this.params };
  }

  setRenderTarget(renderTarget, resolution, root) {
    this.renderTarget = renderTarget || null;
    if (resolution instanceof THREE.Vector2) {
      this.resolution.copy(resolution);
    }
    this.syncRenderTargetUniforms(root);
  }

  setParameter(uniformName, value, root) {
    this.params[uniformName] = value;
    this.applyParamsToScene(root);
  }

  create(mesh) {
    const params = this.params;
    const material = new THREE.ShaderMaterial({
      vertexShader: glassVertexShader,
      fragmentShader: glassFragmentShader,
      uniforms: {
        uEnvTex: { value: this.renderTarget?.texture || null },
        uResolution: { value: this.resolution.clone() },
        uRefractStrength: { value: Number(params.uRefractStrength ?? 0.04) },
        uFresnelPower: { value: Number(params.uFresnelPower ?? 3) },
        uGlassColor: { value: new THREE.Color(params.uGlassColor || '#add8e6') },
        uColorStrength: { value: Number(params.uColorStrength ?? 0.45) },
        uOpacity: { value: Number(params.uOpacity ?? 0.35) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    material.color = material.uniforms.uGlassColor.value;
    material.roughness = 0;
    material.metalness = 0;
    material.emissive = new THREE.Color(0x000000);
    material.emissiveIntensity = 0;
    material.userData.shaderEditorSetColor = nextColor => {
      material.uniforms.uGlassColor.value.copy(nextColor);
      this.params.uGlassColor = `#${nextColor.getHexString()}`;
      this.classifier?.originalColors?.set(mesh.uuid, nextColor.clone());
    };
    return material;
  }

  applyParamsToScene(root) {
    if (!root) return;
    const params = this.params;
    root.traverse(object => {
      if (!isRenderableMesh(object) || isOutlineMesh(object)) return;
      if (isProtectedRenderObject(object)) return;
      if (this.classifier?.getCategory(object.uuid) !== 'glass') return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material?.uniforms) continue;
        applyShaderUniform(material, 'uGlassColor', params.uGlassColor);
        applyShaderUniform(material, 'uColorStrength', params.uColorStrength);
        applyShaderUniform(material, 'uRefractStrength', params.uRefractStrength);
        applyShaderUniform(material, 'uFresnelPower', params.uFresnelPower);
        applyShaderUniform(material, 'uOpacity', params.uOpacity);
        material.needsUpdate = true;
      }
      object.renderOrder = RENDER_ORDER.WATER_GLASS;
    });
  }

  syncRenderTargetUniforms(root) {
    if (!root) return;
    root.traverse(object => {
      if (!isRenderableMesh(object) || isOutlineMesh(object)) return;
      if (isProtectedRenderObject(object)) return;
      if (this.classifier?.getCategory(object.uuid) !== 'glass') return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material?.uniforms?.uEnvTex) continue;
        material.uniforms.uEnvTex.value = this.renderTarget?.texture || null;
        material.uniforms.uResolution.value.copy(this.resolution);
        material.needsUpdate = true;
      }
    });
  }

  tick(elapsed, root) {
    if (!root) return;
    root.traverse(object => {
      if (!isRenderableMesh(object) || isOutlineMesh(object)) return;
      if (isProtectedRenderObject(object)) return;
      if (this.classifier?.getCategory(object.uuid) !== 'glass') return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) this._setTimeOnMaterial(material, elapsed);
    });
  }

  _setTimeOnMaterial(material, elapsed) {
    const uniform = material?.uniforms?.uTime;
    if (uniform) uniform.value = elapsed;
    const shaderLibUniform = material?.userData?.shaderLibraryUniforms?.uTime;
    if (shaderLibUniform) shaderLibUniform.value = elapsed;
    const pbrUniform = material?.userData?.pbrAnimationUniforms?.uTime;
    if (pbrUniform) pbrUniform.value = elapsed;
    const compiledUniform = material?.userData?.shader?.uniforms?.uTime;
    if (compiledUniform) compiledUniform.value = elapsed;
  }
}
