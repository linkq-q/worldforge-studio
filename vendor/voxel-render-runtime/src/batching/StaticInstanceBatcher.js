import * as THREE from 'three';
import {
  canBatchMesh,
  makeBatchKey,
  makeGeometryBatchKey,
  makeMaterialBatchKey,
} from './BatchingKeys.js';
import { listMaterialShaderPatches } from '../utils/MaterialShaderPatchChain.js';
import { TraceGate } from '../debug/TraceGate.js';

const DEFAULT_MIN_GROUP_SIZE = 2;
// Shader-patch chain keys whose effect we can faithfully rebuild on a cloned batch
// material (CSM is re-registered via onBatchMaterialReady). A material whose entire
// chain is a subset of this set is safe to batch; anything else (toon/PBR overlay,
// rim light, ...) stays skipped because cloning can't reproduce it.
const BATCHABLE_PATCH_KEYS = new Set(['csm']);
const SAFE_CEL_SHADER_MATERIAL_REASON = 'safe-cel-shader-material';
const defaultOnBeforeCompileString = (() => {
  const material = new THREE.Material();
  return typeof material.onBeforeCompile === 'function'
    ? material.onBeforeCompile.toString()
    : '';
})();

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function fmt(ms) {
  return Number(ms || 0).toFixed(1);
}

function incrementReason(skipReasons, reason) {
  skipReasons[reason] = (skipReasons[reason] || 0) + 1;
}

function isAllowedBatchMaterial(material) {
  return !!(
    material?.isMeshStandardMaterial
    || material?.isMeshBasicMaterial
    || material?.isMeshLambertMaterial
    || material?.isMeshPhongMaterial
  );
}

function isSafeBatchableCelShaderMaterial(mat) {
  return !!(
    mat?.isShaderMaterial
    && mat.userData?.shaderMode === 'cel'
    && mat.transparent !== true
    && Number(mat.opacity ?? 1) >= 0.999
    && Number(mat.alphaTest ?? 0) === 0
    && mat.depthWrite !== false
    && mat.blending === THREE.NormalBlending
    && mat.userData?.supportsInstancing === true
    && mat.userData?.batchable === true
  );
}

function createShaderMaterialAudit() {
  return {
    totalShaderMaterials: 0,
    celShaderMaterials: 0,
    safeCelShaderMaterials: 0,
    unsafeCelShaderMaterials: 0,
    transparentShaderMaterials: 0,
    alphaTestShaderMaterials: 0,
    depthWriteFalseShaderMaterials: 0,
    supportsInstancingFalse: 0,
    batchableFlagMissing: 0,
  };
}

function auditShaderMaterial(mat, audit) {
  if (!mat?.isShaderMaterial && !mat?.isRawShaderMaterial) return;
  audit.totalShaderMaterials++;
  const isCel = mat.userData?.shaderMode === 'cel';
  if (isCel) audit.celShaderMaterials++;
  if (mat.transparent === true) audit.transparentShaderMaterials++;
  if (Number(mat.alphaTest ?? 0) > 0) audit.alphaTestShaderMaterials++;
  if (mat.depthWrite === false) audit.depthWriteFalseShaderMaterials++;
  if (mat.userData?.supportsInstancing !== true) audit.supportsInstancingFalse++;
  if (mat.userData?.batchable !== true) audit.batchableFlagMissing++;
  if (isSafeBatchableCelShaderMaterial(mat)) {
    audit.safeCelShaderMaterials++;
  } else if (isCel) {
    audit.unsafeCelShaderMaterials++;
  }
}

function hasCustomOnBeforeCompile(material) {
  if (typeof material?.onBeforeCompile !== 'function') return false;
  return material.onBeforeCompile.toString() !== defaultOnBeforeCompileString;
}

// True when the material's custom onBeforeCompile is solely the MaterialShaderPatchChain
// dispatcher and every registered patch is in BATCHABLE_PATCH_KEYS. Such a material can be
// batched: the clone's chain (lost by r160 Material.copy) is rebuilt via onBatchMaterialReady.
function hasOnlyBatchablePatches(material) {
  const keys = listMaterialShaderPatches(material);
  if (keys.length === 0) return false;
  return keys.every(key => BATCHABLE_PATCH_KEYS.has(key));
}

export class StaticInstanceBatcher {
  constructor({
    scene = null,
    renderer = null,
    getMeshRegistry = null,
    getRenderMode = null,
    minGroupSize = DEFAULT_MIN_GROUP_SIZE,
    runtimeIndex = null,
    onBatchMaterialReady = null,
  } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.getMeshRegistry = typeof getMeshRegistry === 'function' ? getMeshRegistry : null;
    this.getRenderMode = typeof getRenderMode === 'function' ? getRenderMode : null;
    // Called with (batchMaterial, sourceMaterial) right after the batch material is cloned,
    // so the host can rebuild patches the clone can't inherit (e.g. CSM in three r160).
    this.onBatchMaterialReady = typeof onBatchMaterialReady === 'function' ? onBatchMaterialReady : null;
    this.minGroupSize = Math.max(2, Number(minGroupSize) || DEFAULT_MIN_GROUP_SIZE);
    // RuntimeIndex：partId(nodeId) ↔ InstancedMesh+instanceId 映射层（可选）。
    this.runtimeIndex = runtimeIndex || null;

    this.batchRoot = new THREE.Group();
    this.batchRoot.name = '__staticBatchRoot__';
    this.batchRoot.visible = false;
    this.batchRoot.userData.isStaticBatchRoot = true;
    this.batchRoot.userData.skipBatching = true;
    this.batchRoot.userData.skipSelection = true;

    this.groups = new Map();
    this.originalMeshToGroup = new Map();
    this.originalVisibility = new Map();
    this.enabled = false;
    this.lastAnalysis = null;
    this.lastBuildStats = null;
  }

  _ensureBatchRoot() {
    if (!this.scene) return null;
    if (this.batchRoot.parent !== this.scene) this.scene.add(this.batchRoot);
    return this.batchRoot;
  }

  _clearBatchMeshes() {
    for (const child of [...this.batchRoot.children]) {
      this.batchRoot.remove(child);
      if (Array.isArray(child.material)) {
        child.material.forEach(material => material?.dispose?.());
      } else {
        child.material?.dispose?.();
      }
      child.dispose?.();
    }
    this.groups.clear();
    this.originalMeshToGroup.clear();
  }

  _collectMeshes() {
    const registry = this.getMeshRegistry?.();
    if (registry instanceof Map) return [...registry.values()];
    if (Array.isArray(registry)) return registry;
    const meshes = [];
    this.scene?.traverse?.(object => {
      if (object?.isMesh) meshes.push(object);
    });
    return meshes;
  }

  _getMeshSkipReason(mesh, { renderMode = this.getRenderMode?.() || 'unknown', shaderMaterialAudit = null } = {}) {
    if (!mesh || !mesh.isMesh) return 'not-mesh';
    if (mesh.isInstancedMesh) return 'instanced-mesh';
    if (mesh.visible === false) return 'invisible';
    if (!mesh.geometry) return 'no-geometry';

    const mat = mesh.material;
    if (!mat) return 'no-material';
    if (Array.isArray(mat)) return 'multi-material';
    if (mat.isShaderMaterial || mat.isRawShaderMaterial) {
      if (shaderMaterialAudit) auditShaderMaterial(mat, shaderMaterialAudit);
      if (renderMode === 'cel' && isSafeBatchableCelShaderMaterial(mat)) {
        return null; // safe-cel-shader-material
      }
      if (mat.transparent === true) return 'transparent';
      if (Number(mat.opacity ?? 1) < 0.999) return 'opacity-lt-one';
      if (Number(mat.alphaTest ?? 0) > 0) return 'alpha-test';
      if (mat.depthWrite === false) return 'depth-write-false';
      return 'shader-material';
    }
    if (mat.transparent === true) return 'transparent';
    if (Number(mat.opacity ?? 1) < 0.999) return 'opacity-lt-one';
    // alphaTest is a `discard` — needs no per-instance depth sorting, so it is safe to batch.
    if (mat.depthWrite === false) return 'depth-write-false';
    if (mat.blending !== THREE.NormalBlending) return 'non-normal-blending';
    if (mesh.renderOrder !== 0) return 'custom-render-order';
    // Reject custom onBeforeCompile unless it is only CSM's patch (rebuilt on the clone).
    if (hasCustomOnBeforeCompile(mat) && !hasOnlyBatchablePatches(mat)) return 'custom-onBeforeCompile';
    if (!isAllowedBatchMaterial(mat)) return 'unsafe-material-type';

    const userData = mesh.userData || {};
    if (userData.skipBatch === true || userData.skipBatching === true) return 'user-skip-batch';
    if (userData.skipShaderApply === true) return 'skip-shader-apply';
    if (userData.isWater === true) return 'water';
    if (userData.isSky === true) return 'sky';
    if (userData.isGlass === true) return 'glass';
    if (userData.isGizmo === true) return 'gizmo';
    if (userData.isSelectionHelper === true) return 'selection-helper';
    if (userData.isHelper === true) return 'helper';
    if (userData.isEnvironment === true || userData.isEnvironmentObject === true) return 'environment';
    if (userData.isEditorObject === true) return 'editor-object';
    if (userData.isOutline === true || userData.shaderOutline === true) return 'outline';
    if (userData.isDebugMesh === true) return 'debug';
    if (userData.animated === true) return 'animated';
    if (mesh.isSkinnedMesh || mesh.morphTargetInfluences || mesh.morphTargetDictionary) return 'animated';

    let current = mesh;
    while (current) {
      const nameRaw = String(current.name || '');
      const name = nameRaw.toLowerCase();
      const type = String(current.type || '').toLowerCase();
      if (name.includes('water')) return 'water';
      if (name.includes('sky')) return 'sky';
      if (name.includes('glass')) return 'glass';
      if (name.includes('gizmo') || nameRaw.includes('TransformControls')) return 'gizmo';
      if (name.includes('selection') || nameRaw.includes('Selection')) return 'selection-helper';
      if (name.includes('helper') || name.includes('grid') || type.includes('helper')) return 'helper';
      if (name.includes('debug')) return 'debug';
      if (type === 'transformcontrols' || current.name === 'TransformControlsPlane') return 'gizmo';
      if (current.userData?.skipBatch === true || current.userData?.skipBatching === true) return 'user-skip-batch';
      if (current.userData?.skipShaderApply === true) return 'skip-shader-apply';
      if (current.userData?.isStaticBatchRoot === true) return 'static-batch-root';
      current = current.parent;
    }

    if (!canBatchMesh(mesh)) return 'legacy-can-batch-mesh';
    // RuntimeIndex 约定：无可解析 partId 的 mesh 禁止进入合批（否则 instance → partId 断链）。
    if (!this._resolvePartId(mesh)) return 'missing-part-id';
    return null;
  }

  /**
   * 解析 mesh 的语义 ID（nodeId）。本代码库 buildMeshRegistry 会在合批前写入
   * userData.nodeId（`${modelId}:${partId}`）；这里做防御式兜底。
   * @returns {string|null}
   */
  _resolvePartId(mesh) {
    if (!mesh) return null;
    const ud = mesh.userData || {};
    if (ud.nodeId) return String(ud.nodeId);
    const partId = ud.partId || mesh.parent?.userData?.partId;
    if (!partId) return null;
    const modelId = ud.sceneModelId || ud.modelId || mesh.parent?.userData?.sceneModelId;
    return modelId ? `${modelId}:${partId}` : String(partId);
  }

  _cloneBatchMaterial(sourceMaterial) {
    const batchMaterial = sourceMaterial.clone();
    batchMaterial.transparent = sourceMaterial.transparent;
    batchMaterial.opacity = sourceMaterial.opacity;
    batchMaterial.depthWrite = sourceMaterial.depthWrite;
    batchMaterial.depthTest = sourceMaterial.depthTest;
    batchMaterial.side = sourceMaterial.side;
    batchMaterial.alphaTest = sourceMaterial.alphaTest;
    batchMaterial.blending = sourceMaterial.blending;
    batchMaterial.flatShading = sourceMaterial.flatShading;
    batchMaterial.vertexColors = sourceMaterial.vertexColors;
    batchMaterial.needsUpdate = true;
    return batchMaterial;
  }

  _groupMeshes({ renderMode = this.getRenderMode?.() || 'unknown' } = {}) {
    const groups = new Map();
    let totalMeshes = 0;
    let eligibleMeshes = 0;
    let skippedMeshes = 0;
    const skipReasons = {};
    const shaderMaterialAudit = createShaderMaterialAudit();

    for (const mesh of this._collectMeshes()) {
      totalMeshes++;
      const skipReason = this._getMeshSkipReason(mesh, { renderMode, shaderMaterialAudit });
      if (skipReason) {
        skippedMeshes++;
        incrementReason(skipReasons, skipReason);
        continue;
      }
      eligibleMeshes++;
      const geometryKey = makeGeometryBatchKey(mesh);
      const materialKey = makeMaterialBatchKey(mesh.material);
      const batchKey = makeBatchKey(mesh, { geometryKey, materialKey });
      if (!groups.has(batchKey)) {
        groups.set(batchKey, {
          key: batchKey,
          geometryKey,
          materialKey,
          meshes: [],
        });
      }
      groups.get(batchKey).meshes.push(mesh);
    }

    return { groups, totalMeshes, eligibleMeshes, skippedMeshes, skipReasons, shaderMaterialAudit };
  }

  analyze({ renderMode = this.getRenderMode?.() || 'unknown' } = {}) {
    const t0 = now();
    const grouped = this._groupMeshes({ renderMode });
    const groups = [...grouped.groups.values()];
    const eligibleGroups = groups.filter(group => group.meshes.length >= this.minGroupSize);
    const estimatedDrawCallBefore = grouped.eligibleMeshes;
    const estimatedDrawCallAfter = eligibleGroups.length
      + groups.filter(group => group.meshes.length < this.minGroupSize).reduce((sum, group) => sum + group.meshes.length, 0);
    const estimatedReduction = Math.max(0, estimatedDrawCallBefore - estimatedDrawCallAfter);
    const topGroups = eligibleGroups
      .map(group => ({ key: group.key, count: group.meshes.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    this.lastAnalysis = {
      totalMeshes: grouped.totalMeshes,
      eligibleMeshes: grouped.eligibleMeshes,
      skippedMeshes: grouped.skippedMeshes,
      groupsTotal: groups.length,
      groupsEligible: eligibleGroups.length,
      minGroupSize: this.minGroupSize,
      renderMode,
      estimatedDrawCallBefore,
      estimatedDrawCallAfter,
      estimatedReduction,
      skipReasons: grouped.skipReasons,
      shaderMaterialAudit: grouped.shaderMaterialAudit,
      topGroups,
      elapsed: now() - t0,
    };

    console.log(
      `[StaticBatchAnalyze] totalMeshes=${this.lastAnalysis.totalMeshes}` +
      ` eligibleMeshes=${this.lastAnalysis.eligibleMeshes}` +
      ` skippedMeshes=${this.lastAnalysis.skippedMeshes}` +
      ` groupsTotal=${this.lastAnalysis.groupsTotal}` +
      ` groupsEligible=${this.lastAnalysis.groupsEligible}` +
      ` minGroupSize=${this.lastAnalysis.minGroupSize}` +
      ` renderMode=${renderMode}` +
      ` estimatedDrawCallBefore=${estimatedDrawCallBefore}` +
      ` estimatedDrawCallAfter=${estimatedDrawCallAfter}` +
      ` estimatedReduction=${estimatedReduction}` +
      ` skipReasons=${JSON.stringify(this.lastAnalysis.skipReasons)}` +
      ` topGroups=${topGroups.map(group => `${group.count}x:${group.key}`).join(' ; ') || 'none'}` +
      ` elapsed=${fmt(this.lastAnalysis.elapsed)}ms`
    );
    console.log(
      `[StaticBatchShaderMaterialAudit]` +
      ` totalShaderMaterials=${grouped.shaderMaterialAudit.totalShaderMaterials}` +
      ` celShaderMaterials=${grouped.shaderMaterialAudit.celShaderMaterials}` +
      ` safeCelShaderMaterials=${grouped.shaderMaterialAudit.safeCelShaderMaterials}` +
      ` unsafeCelShaderMaterials=${grouped.shaderMaterialAudit.unsafeCelShaderMaterials}` +
      ` transparentShaderMaterials=${grouped.shaderMaterialAudit.transparentShaderMaterials}` +
      ` alphaTestShaderMaterials=${grouped.shaderMaterialAudit.alphaTestShaderMaterials}` +
      ` depthWriteFalseShaderMaterials=${grouped.shaderMaterialAudit.depthWriteFalseShaderMaterials}` +
      ` supportsInstancingFalse=${grouped.shaderMaterialAudit.supportsInstancingFalse}` +
      ` batchableFlagMissing=${grouped.shaderMaterialAudit.batchableFlagMissing}`
    );

    return this.lastAnalysis;
  }

  auditEligibility({ renderMode = this.getRenderMode?.() || 'unknown' } = {}) {
    const analysis = this.analyze({ renderMode });
    const skipReasons = analysis.skipReasons || {};
    const result = {
      ...analysis,
      renderMode,
      eligibleOpaqueMeshes: analysis.eligibleMeshes,
      transparentSkipped: skipReasons.transparent || 0,
      shaderSkipped: skipReasons['shader-material'] || 0,
      waterSkipped: skipReasons.water || 0,
      customShaderSkipped: skipReasons['custom-onBeforeCompile'] || 0,
    };

    console.log(
      `[StaticBatchEligibilityAudit]` +
      ` renderMode=${result.renderMode}` +
      ` totalMeshes=${result.totalMeshes}` +
      ` eligibleOpaqueMeshes=${result.eligibleOpaqueMeshes}` +
      ` transparentSkipped=${result.transparentSkipped}` +
      ` shaderSkipped=${result.shaderSkipped}` +
      ` waterSkipped=${result.waterSkipped}` +
      ` customShaderSkipped=${result.customShaderSkipped}` +
      ` groupsEligible=${result.groupsEligible}` +
      ` estimatedReduction=${result.estimatedReduction}`
    );

    return result;
  }

  build() {
    const t0 = now();
    if (TraceGate.shouldLog('staticBatch')) {
      console.log('[StaticInstanceBatcher][diagnose]', {
        action: 'build',
        enabled: this.enabled,
        groupsSize: this.groups.size,
        originalVisibilitySize: this.originalVisibility.size,
      batchGroupChildren: this.batchRoot.children.length,
      originalMeshToGroupSize: this.originalMeshToGroup.size,
    });
    }
    this.disable({ reason: 'build', silent: true });
    this._ensureBatchRoot();
    this._clearBatchMeshes();
    // 旧 batchMesh 已从 batchRoot 移除/销毁，清掉 RuntimeIndex 里失效的 batch 引用。
    this.runtimeIndex?.pruneDisposedBatches?.();

    const grouped = this._groupMeshes({ renderMode: this.getRenderMode?.() || 'unknown' });
    const dummy = new THREE.Object3D();
    let batchMeshCount = 0;
    let originalMeshCount = 0;

    for (const group of grouped.groups.values()) {
      if (group.meshes.length < this.minGroupSize) continue;
      const source = group.meshes[0];
      const sourceMaterial = source.material;
      const batchMaterial = this._cloneBatchMaterial(sourceMaterial);
      // r160 Material.copy drops function-valued userData (the shader patch chain), so let
      // the host re-register patches (e.g. CSM) on the clone before it goes live.
      this.onBatchMaterialReady?.(batchMaterial, sourceMaterial);
      const batchMesh = new THREE.InstancedMesh(source.geometry, batchMaterial, group.meshes.length);
      batchMesh.name = `StaticBatch:${group.meshes.length}:${source.name || source.uuid}`;
      batchMesh.castShadow = source.castShadow;
      batchMesh.receiveShadow = source.receiveShadow;
      batchMesh.frustumCulled = false;
      batchMesh.userData.isStaticBatchMesh = true;
      batchMesh.userData.skipBatching = true;
      batchMesh.userData.skipSelection = true;
      batchMesh.userData.geometryBatchKey = group.geometryKey;
      batchMesh.userData.materialBatchKey = group.materialKey;
      batchMesh.userData.batchKey = group.key;
      batchMesh.userData.isUserContent = true;

      const partIds = new Array(group.meshes.length).fill(null);
      group.meshes.forEach((mesh, index) => {
        mesh.updateWorldMatrix(true, false);
        dummy.matrix.copy(mesh.matrixWorld);
        dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
        dummy.updateMatrix();
        batchMesh.setMatrixAt(index, dummy.matrix);
        this.originalMeshToGroup.set(mesh, group);
        // partIds[index] 严格对应 instanceId=index（与 setMatrixAt 同序）。
        partIds[index] = this._resolvePartId(mesh);
      });
      batchMesh.instanceMatrix.needsUpdate = true;
      this.batchRoot.add(batchMesh);
      group.batchMesh = batchMesh;
      group.partIds = partIds;
      this.groups.set(group.key, group);
      batchMeshCount++;
      originalMeshCount += group.meshes.length;

      // RuntimeIndex 注册：InstancedMesh batch（partIds[index] → instanceId=index）。
      this.runtimeIndex?.registerInstancedBatch?.(group.key, batchMesh, partIds, {
        source: 'static-batcher',
        batchKey: group.key,
      });
    }

    this.batchRoot.visible = false;
    this.enabled = false;
    this.lastBuildStats = {
      batchMeshCount,
      originalMeshCount,
      groupsBuilt: this.groups.size,
      minGroupSize: this.minGroupSize,
      elapsed: now() - t0,
    };
    console.log(
      `[StaticBatchTrace] action=build groupsBuilt=${this.groups.size}` +
      ` batchMeshCount=${batchMeshCount} originalMeshCount=${originalMeshCount}` +
      ` minGroupSize=${this.minGroupSize} renderMode=${this.getRenderMode?.() || 'unknown'}` +
      ` elapsed=${fmt(this.lastBuildStats.elapsed)}ms`
    );
    return this.lastBuildStats;
  }

  enable() {
    const t0 = now();
    if (TraceGate.shouldLog('staticBatch')) {
      console.log('[StaticInstanceBatcher][diagnose]', {
        action: 'enable',
        enabled: this.enabled,
        groupsSize: this.groups.size,
        originalVisibilitySize: this.originalVisibility.size,
        batchGroupChildren: this.batchRoot.children.length,
        originalMeshToGroupSize: this.originalMeshToGroup.size,
      });
    }
    if (this.groups.size === 0) this.build();
    this._ensureBatchRoot();
    this.batchRoot.visible = true;
    let hidden = 0;
    for (const group of this.groups.values()) {
      for (const mesh of group.meshes) {
        if (!this.originalVisibility.has(mesh)) this.originalVisibility.set(mesh, mesh.visible);
        mesh.visible = false;
        mesh.userData.batchedHidden = true;
        hidden++;
      }
      // RuntimeIndex：确保该 batch 的 partId → instanced（可能被先前 disable 降级回 mesh）。
      if (this.runtimeIndex && group.batchMesh && Array.isArray(group.partIds)) {
        this.runtimeIndex.registerInstancedBatch?.(group.key, group.batchMesh, group.partIds, {
          source: 'static-batcher',
          batchKey: group.key,
        });
      }
    }
    this.enabled = true;
    if (TraceGate.shouldLog('staticBatch')) {
      console.log(`[StaticBatchToggle] action=enable hidden=${hidden} batchMeshes=${this.batchRoot.children.length} elapsed=${fmt(now() - t0)}ms`);
    }
    return this.stats();
  }

  disable(options = {}) {
    const { reason = 'manual', silent = false } = typeof options === 'string'
      ? { reason: options }
      : (options || {});
    const t0 = now();
    let restored = 0;
    for (const [mesh, visible] of this.originalVisibility.entries()) {
      mesh.visible = visible;
      if (mesh.userData) delete mesh.userData.batchedHidden;
      restored++;
    }
    this.originalVisibility.clear();
    this.batchRoot.visible = false;
    this.enabled = false;

    // RuntimeIndex：原始 mesh 恢复可见，把这些 partId 从 instanced 降级回 mesh，
    // 使 getRenderRef/getPartIdFromHit 指向当前可见的原始对象。
    if (this.runtimeIndex) {
      for (const group of this.groups.values()) {
        const partIds = group.partIds;
        if (!Array.isArray(partIds)) continue;
        group.meshes.forEach((mesh, index) => {
          const partId = partIds[index];
          if (!partId) return;
          this.runtimeIndex.registerMesh?.(partId, mesh, {
            modelId: mesh.userData?.sceneModelId,
            rawPartId: mesh.userData?.partId,
            source: 'static-batcher-restore',
            mode: 'mesh',
          });
        });
      }
    }
    if (TraceGate.shouldLog('staticBatch')) {
      console.log('[StaticInstanceBatcher][diagnose]', {
        action: 'disable',
        reason,
        enabled: false,
        restored,
        originalVisibilitySizeBefore: restored,  // already consumed
        batchGroupChildren: this.batchRoot.children.length,
        groupsSize: this.groups.size,
        originalMeshToGroupSize: this.originalMeshToGroup.size,
      });
    }
    if (!silent) {
      if (TraceGate.shouldLog('staticBatch')) {
        console.log(`[StaticBatchToggle] action=disable reason=${reason} restored=${restored} elapsed=${fmt(now() - t0)}ms`);
      }
    }
    return this.stats();
  }

  rebuild({ enable = this.enabled } = {}) {
    const t0 = now();
    if (TraceGate.shouldLog('staticBatch')) {
      console.log('[StaticInstanceBatcher][diagnose]', {
        action: 'rebuild',
        enabled: this.enabled,
        groupsSize: this.groups.size,
        originalVisibilitySize: this.originalVisibility.size,
        batchGroupChildren: this.batchRoot.children.length,
        originalMeshToGroupSize: this.originalMeshToGroup.size,
        enableParam: enable,
      });
    }
    this.disable({ reason: 'rebuild', silent: true });
    const buildStats = this.build();
    if (enable) this.enable();
    if (TraceGate.shouldLog('staticBatch')) {
      console.log(`[StaticBatchTrace] action=rebuild enable=${enable} groupsBuilt=${buildStats.groupsBuilt} elapsed=${fmt(now() - t0)}ms`);
    }
    return this.stats();
  }

  dispose() {
    if (TraceGate.shouldLog('staticBatch')) {
      console.log('[StaticInstanceBatcher][diagnose]', {
        action: 'dispose',
        enabled: this.enabled,
        originalVisibilitySize: this.originalVisibility.size,
        batchGroupChildren: this.batchRoot.children.length,
        groupsSize: this.groups.size,
        originalMeshToGroupSize: this.originalMeshToGroup.size,
      });
    }
    this.disable({ reason: 'dispose', silent: true });
    this._clearBatchMeshes();
    this.runtimeIndex?.pruneDisposedBatches?.();
    if (this.batchRoot.parent) this.batchRoot.parent.remove(this.batchRoot);
    this.lastAnalysis = null;
    this.lastBuildStats = null;
    console.log('[StaticBatchTrace] action=dispose');
  }

  stats() {
    return {
      enabled: this.enabled,
      minGroupSize: this.minGroupSize,
      groupsBuilt: this.groups.size,
      batchMeshCount: this.batchRoot.children.length,
      originalMeshCount: [...this.groups.values()].reduce((sum, group) => sum + group.meshes.length, 0),
      renderMode: this.getRenderMode?.() || null,
      lastAnalysis: this.lastAnalysis,
      lastBuildStats: this.lastBuildStats,
    };
  }

  /** Full runtime audit — call from console for A/B performance testing */
  runtimeAudit() {
    const t0 = now();

    // Ensure analysis is fresh for full-scene mesh counts
    const analysis = this.analyze();

    // ── Ground truth: full scene scan for original meshes ──
    let originalMeshCount = 0;
    let visibleOriginalMeshes = 0;
    let batchedHiddenOriginalMeshes = 0;
    const originalMaterialIds = new Set();
    const scene = this.scene;
    if (scene) {
      scene.traverse(obj => {
        if (!obj.isMesh) return;
        if (obj.isInstancedMesh) return;
        if (obj.userData?.isStaticBatchMesh) return;
        if (obj.userData?.isStaticBatchRoot) return;
        originalMeshCount++;
        if (obj.visible) {
          visibleOriginalMeshes++;
          if (obj.material) originalMaterialIds.add(obj.material.uuid);
        }
        if (obj.userData?.batchedHidden) batchedHiddenOriginalMeshes++;
      });
    }
    // Fallback to analysis if scene scan found nothing (e.g. models not in batcher's scene ref)
    if (originalMeshCount === 0) {
      originalMeshCount = analysis.totalMeshes;
      visibleOriginalMeshes = analysis.totalMeshes; // assume all visible when not batched
    }

    // ── Count batch meshes in batchRoot ──
    let instancedMeshCount = 0;
    let visibleInstancedMeshes = 0;
    let totalInstances = 0;
    const batchMaterialIds = new Set();
    this.batchRoot.traverse(obj => {
      if (obj.isInstancedMesh) {
        instancedMeshCount++;
        totalInstances += obj.count;
        if (obj.visible) {
          visibleInstancedMeshes++;
          if (obj.material) batchMaterialIds.add(obj.material.uuid);
        }
      }
    });

    // ── Compute aggregate metrics ──
    const allVisibleMaterials = new Set([...batchMaterialIds, ...originalMaterialIds]);
    // When batching is ON: visible = InstancedMeshes (originals hidden)
    // When batching is OFF: visible = original meshes
    const effectiveVisibleOriginals = Math.max(0, visibleOriginalMeshes - batchedHiddenOriginalMeshes);
    const actualVisibleRenderableCount = visibleInstancedMeshes + effectiveVisibleOriginals;

    // estimatedDrawCallBefore: all original meshes before batching
    const estimatedDrawCallBefore = originalMeshCount;
    // estimatedDrawCallAfter: InstancedMesh draw calls + remaining unbatched originals
    const estimatedDrawCallAfter = this.enabled
      ? visibleInstancedMeshes + effectiveVisibleOriginals
      : estimatedDrawCallBefore;

    const result = {
      enabled: this.enabled,
      batchRootCount: this.batchRoot.children.length,
      instancedMeshCount,
      visibleInstancedMeshes,
      totalInstances,
      originalMeshCount,
      visibleOriginalMeshes,
      batchedHiddenOriginalMeshes,
      actualVisibleRenderableCount,
      estimatedDrawCallBefore,
      estimatedDrawCallAfter,
      visibleMaterialCount: allVisibleMaterials.size,
      groupsBuilt: this.groups.size,
      minGroupSize: this.minGroupSize,
      renderMode: this.getRenderMode?.() || 'unknown',
      elapsed: now() - t0,
    };

    console.log(
      `[StaticBatchRuntimeAudit]` +
      ` enabled=${result.enabled}` +
      ` batchRootCount=${result.batchRootCount}` +
      ` instancedMeshCount=${result.instancedMeshCount}` +
      ` visibleInstancedMeshes=${result.visibleInstancedMeshes}` +
      ` totalInstances=${result.totalInstances}` +
      ` originalMeshCount=${result.originalMeshCount}` +
      ` visibleOriginalMeshes=${result.visibleOriginalMeshes}` +
      ` batchedHiddenOriginalMeshes=${result.batchedHiddenOriginalMeshes}` +
      ` actualVisibleRenderableCount=${result.actualVisibleRenderableCount}` +
      ` estimatedDrawCallBefore=${result.estimatedDrawCallBefore}` +
      ` estimatedDrawCallAfter=${result.estimatedDrawCallAfter}` +
      ` visibleMaterialCount=${result.visibleMaterialCount}` +
      ` groupsBuilt=${result.groupsBuilt}` +
      ` minGroupSize=${result.minGroupSize}` +
      ` renderMode=${result.renderMode}` +
      ` elapsed=${fmt(result.elapsed)}ms`
    );

    return result;
  }
}
