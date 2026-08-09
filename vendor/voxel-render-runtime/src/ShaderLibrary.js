import * as THREE from 'three';
import { LoadSceneTrace } from './debug/LoadSceneTrace.js';
import { shouldSkipShaderApply } from './utils/ShaderApplyGuard.js';
import { RENDER_ORDER } from './render/RenderOrders.js';
import {
  MeshCategoryClassifier,
  SHADER_CATEGORIES,
  isUserContentObject,
  isProtectedRenderObject,
  isRenderableMesh,
  isOutlineMesh,
} from './materials/MeshCategoryClassifier.js';
import { GlassMaterial, applyShaderUniform } from './materials/GlassMaterial.js';

// ShaderLibrary 只负责 glass 材质（唯一仍未被替代的职责）+ mesh 分类协调。
// building/cartoon/PBR overlay 材质生产已退役：RenderStyleManager（cel）/ RenderPresets（pbr/ink）
// 通过 meshRegistry 直接拥有并覆盖这些 mesh 的材质，ShaderLibrary 的旧写入路径只会产出
// 立刻被覆盖的废材质（并曾因合批 InstancedMesh 绕过保护检查而装错 patch，见 2026-06-30 bug）。
// mesh 分类只读查询在 MeshCategoryClassifier.js；glass 材质生产/生命周期在 GlassMaterial.js；
// 这里只做两者的粘合 + applyToScene/applyCategoryToMesh 的遍历编排。
export { SHADER_CATEGORIES };
export const ASSIGN_SHADER_CATEGORIES = ['glass'];

function firstMaterial(material) {
  return Array.isArray(material) ? material[0] : material;
}

export class ShaderLibrary {
  constructor() {
    this._classifier = new MeshCategoryClassifier();
    this._glass = new GlassMaterial(this._classifier);
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.getComposer = null;
    this.modelRoot = null;
    this._derivedMaterialCache = new Map();
    this._batchLevel = 0;
    this._batchDirty = false;
  }

  /**
   * 批量操作开始：抑制 _requestRender() 调用，避免每次 setCategory/setShaderParameter 触发完整渲染。
   * 支持嵌套（计数），只有最外层 endBatch 才触发一次渲染。
   */
  beginBatch() {
    this._batchLevel++;
  }

  /**
   * 批量操作结束：如果标记 dirty，触发一次渲染。
   */
  endBatch() {
    if (this._batchLevel > 0) {
      this._batchLevel--;
    }
    if (this._batchLevel === 0 && this._batchDirty) {
      this._batchDirty = false;
      this._markRenderNeeded();
    }
  }

  /**
   * 内部使用：标记需要渲染（批量模式下仅标记 dirty，不实际渲染）。
   */
  _markRenderNeeded() {
    if (this._batchLevel > 0) {
      this._batchDirty = true;
    } else {
      this._requestRender();
    }
  }

  setRenderContext({ renderer = null, scene = null, camera = null, getComposer = null, modelRoot = null } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.getComposer = typeof getComposer === 'function' ? getComposer : null;
    this.modelRoot = modelRoot || null;
  }

  setModelRoot(modelRoot) {
    this.modelRoot = modelRoot || null;
  }

  /**
   * 获取实际应遍历的根节点：优先 modelRoot，其次 scene
   */
  _getTraverseRoot() {
    return this.modelRoot || this.scene;
  }

  setGlassRenderTarget(renderTarget, resolution) {
    this._glass.setRenderTarget(renderTarget, resolution, this._getTraverseRoot());
  }

  applyTexture(category, uniformName, texture) {
    if (!texture) return;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;

    const root = this._getTraverseRoot();
    if (root) {
      root.traverse(object => {
        if (!isRenderableMesh(object) || isOutlineMesh(object)) return;
        if (isProtectedRenderObject(object)) return;
        if (this.getCategory(object.uuid) !== category) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          applyShaderUniform(material, uniformName, texture);
        }
      });
    }
    this._markRenderNeeded();
  }

  resetTexture(category, uniformName) {
    const texture = null;
    if (texture) this.applyTexture(category, uniformName, texture);
  }

  classify(sceneOrRoot) {
    return this._classifier.classify(sceneOrRoot || this._getTraverseRoot());
  }

  setCategory(meshUuid, category, mode = 'cartoon') {
    this._classifier.setCategory(meshUuid, category);
    this.applyCategoryToMesh(meshUuid, mode);
  }

  setGroupCategory(groupKey, category, mode = 'cartoon') {
    const uuids = this._classifier.groupMap[groupKey] || [];
    for (const uuid of uuids) {
      if (this._classifier.ungrouped.has(uuid)) continue;
      this.setCategory(uuid, category, mode);
    }
  }

  getShaderParams(category) {
    return category === 'glass' ? this._glass.getParams() : {};
  }

  /** glass-only：ASSIGN_SHADER_CATEGORIES 现在只含 'glass'，其余 category 直接忽略。 */
  setShaderParameter(category, uniformName, value) {
    if (!ASSIGN_SHADER_CATEGORIES.includes(category)) return;
    this._glass.setParameter(uniformName, value, this._getTraverseRoot());
    this._markRenderNeeded();
  }

  getMesh(meshUuid) {
    return this._classifier.getMesh(meshUuid);
  }

  ungroupMesh(meshUuid) {
    this._classifier.ungroupMesh(meshUuid);
  }

  /**
   * glass-only 写入：building/default 材质完全由 RenderStyleManager（cel）/ RenderPresets（pbr/ink）
   * 拥有并覆盖，这里不再触碰。category !== 'glass' 时直接跳过——是 setCategory() 的真正落点，
   * 这也是 2026-06-30 那次 bug 的根（旧版会无条件覆盖材质，包括合批 InstancedMesh）的修复点。
   */
  applyCategoryToMesh(meshUuid, mode = 'cartoon') {
    const mesh = this._classifier.getMesh(meshUuid);
    if (!mesh) return;
    const category = this.getCategory(meshUuid);
    if (category !== 'glass') return;

    const targets = [];
    mesh.traverse(child => {
      if (!isRenderableMesh(child)) return;
      if (isOutlineMesh(child)) return;
      targets.push(child);
    });

    for (const child of targets) {
      child.material = this._getDerivedMaterial(child, mode, category);
      child.visible = true;
      child.renderOrder = RENDER_ORDER.WATER_GLASS;
      if (child.material) child.material.needsUpdate = true;
    }
    this._markRenderNeeded();
  }

  getCategory(meshUuid) {
    return this._classifier.getCategory(meshUuid);
  }

  getGroupForMesh(meshUuid) {
    return this._classifier.getGroupForMesh(meshUuid);
  }

  /** glass-only：调用方（applyCategoryToMesh/applyToScene）现在只会以 category === 'glass' 进来。 */
  _getDerivedMaterial(object, mode, category) {
    const variant = category;
    const originalMaterial = object.userData?._originalMaterial || object.material;
    const originalId = firstMaterial(originalMaterial)?.uuid || firstMaterial(object.material)?.uuid || object.uuid;
    const cacheKey = `${originalId}:${mode}:${variant}`;

    if (
      object.userData.shaderAppliedMode === mode &&
      object.userData.shaderAppliedVariant === variant &&
      this._derivedMaterialCache.get(cacheKey) === object.material
    ) {
      return object.material;
    }

    let derived = this._derivedMaterialCache.get(cacheKey);
    if (!derived) {
      derived = this._glass.create(object);
      this._derivedMaterialCache.set(cacheKey, derived);
    }

    object.userData.shaderAppliedMode = mode;
    object.userData.shaderAppliedVariant = variant;
    object.userData.originalMaterialUUID = originalId;
    // 材质生成/替换钩子：让 matcap 等可选 shading layer 在每次材质重建后重装，
    // 避免切换 cartoon/cel/pbr 模式时丢失。derived 可能是单材质或数组。
    if (typeof this.onMaterialDerived === 'function') {
      try { this.onMaterialDerived(derived, object, mode, variant); } catch (e) {
        console.warn('[ShaderLibrary] onMaterialDerived hook error:', e?.message || e);
      }
    }
    return derived;
  }

  /**
   * 增量应用 glass 材质到场景对象。building/default 材质完全由 RenderStyleManager/RenderPresets
   * 拥有——它们在 applyPBR()/applyCel()/applyInk() 里已经直接覆盖了 meshRegistry 的每个 mesh，
   * 所以这里对非 glass 对象一律跳过，不再重复（也更早地）写一份立刻被覆盖的材质。
   *
   * @param {THREE.Object3D} sceneOrRoot
   * @param {string} mode - 'cartoon' | 'default'（只影响 _getDerivedMaterial 的缓存 key，glass 材质本身不分 mode）
   * @returns {{traversed:number, skipped:number, alreadyApplied:number, changed:number}}
   */
  applyToScene(sceneOrRoot, mode = 'cartoon') {
    const root = sceneOrRoot || this._getTraverseRoot();
    if (!root) return { traversed: 0, skipped: 0, alreadyApplied: 0, changed: 0 };
    this.scene = this.scene || (root.isScene ? root : null);
    let traversed = 0;
    let skipped = 0;
    let alreadyApplied = 0;
    let changed = 0;
    const _t0 = typeof performance !== 'undefined' ? performance.now() : 0;

    LoadSceneTrace.begin('shader:applyToScene');

    root.traverse(object => {
      traversed++;
      if (!isRenderableMesh(object)) return;
      if (shouldSkipShaderApply(object) || isProtectedRenderObject(object)) {
        skipped++;
        return;
      }
      if (!isUserContentObject(object)) {
        skipped++;
        return;
      }

      const category = this.getCategory(object.uuid);
      if (category !== 'glass') {
        skipped++;
        return;
      }

      // ── 增量检查：相同 mode + 相同 variant 的对象跳过材质替换 ──
      if (
        object.userData.shaderAppliedMode === mode &&
        object.userData.shaderAppliedVariant === category &&
        object.material
      ) {
        alreadyApplied++;
        return;
      }

      const derived = this._getDerivedMaterial(object, mode, category);
      if (derived !== object.material) {
        object.material = derived;
        changed++;
      } else {
        alreadyApplied++;
      }
      object.visible = true;
      object.renderOrder = RENDER_ORDER.WATER_GLASS;

      if (object.material) object.material.needsUpdate = true;
    });

    const _ms = typeof performance !== 'undefined' ? (performance.now() - _t0) : 0;
    LoadSceneTrace.end('shader:applyToScene', {
      traversed, skipped, alreadyApplied, changed, mode, elapsed: _ms.toFixed(1),
    });
    this._markRenderNeeded();
    return { traversed, skipped, alreadyApplied, changed };
  }

  getMeshList(sceneOrRoot) {
    return this._classifier.getMeshList(sceneOrRoot || this._getTraverseRoot());
  }

  getGroupedMeshList(scene) {
    return this._classifier.getGroupedMeshList(scene || this._getTraverseRoot());
  }

  tick(elapsed) {
    this._glass.tick(elapsed, this._getTraverseRoot());
  }

  dispose() {
    for (const material of this._derivedMaterialCache.values()) {
      if (Array.isArray(material)) {
        for (const item of material) item?.dispose?.();
      } else {
        material?.dispose?.();
      }
    }
    this._derivedMaterialCache.clear();
  }

  _requestRender() {
    const composer = this.getComposer?.();
    if (composer) {
      composer.render();
      return;
    }
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
