/**
 * GroupSelectionProxy — TransformControls editing of a whole VoxelPart *group*
 * whose leaf parts may be flattened into AIPrimitiveBatcher InstancedMeshes.
 *
 * The group VoxelPart stays authoritative (point 1): the proxy is an invisible
 * THREE.Group placed at the group's world transform. TransformControls attaches
 * to it; on drag-end the proxy world matrix is decomposed back into the group's
 * local offset / quaternion / scale, then ONLY this model's RenderCache is
 * rebuilt (point 8). Child parts are never written individually — they follow
 * via computeParentChainMatrix, which already folds parent-group TRS into every
 * instance matrix (point 9).
 *
 * Mirrors SelectionProxyRuntime (the per-part variant) so the scene-builder
 * wiring is symmetric.
 */

import * as THREE from 'three';
import { computeParentChainMatrix } from './PrimitiveFamily.js';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();

export class GroupSelectionProxy {
  constructor({ runtimeIndex, sceneManager, helperRoot }) {
    this.runtimeIndex = runtimeIndex;
    this.sceneManager = sceneManager;
    this.helperRoot = helperRoot;

    this._activeGroupId = null;     // globalGroupId = `${modelId}:${groupId}`
    this._selectedModelId = null;
    this._rawGroupId = null;
    this._proxyGroup = null;
  }

  /**
   * Select a group for transform editing.
   * @param {string} globalGroupId — `${modelId}:${groupId}`
   * @returns {{ok:boolean, proxyGroup?:THREE.Group, reason?:string}}
   */
  selectGroup(globalGroupId) {
    if (!globalGroupId) { this.clear(); return { ok: false, reason: 'no-globalGroupId' }; }

    const ref = this.runtimeIndex?.getGroupRef?.(globalGroupId);
    const modelId = ref?.modelId || globalGroupId.split(':')[0];
    const rawGroupId = ref?.rawGroupId || globalGroupId.split(':').slice(1).join(':');

    const model = this.sceneManager.getModel(modelId);
    if (!model) { this.clear(); return { ok: false, reason: 'model-not-found', modelId }; }
    const groupPart = model.getPart?.(rawGroupId) || model.parts?.find?.(p => p.id === rawGroupId);
    if (!groupPart) { this.clear(); return { ok: false, reason: 'group-part-not-found', rawGroupId }; }
    if (!groupPart.isGroup) { this.clear(); return { ok: false, reason: 'not-a-group', rawGroupId }; }
    const rootGroup = this.sceneManager.getRootGroup(modelId);
    if (!rootGroup) { this.clear(); return { ok: false, reason: 'rootGroup-not-found', modelId }; }

    this._activeGroupId = globalGroupId;
    this._selectedModelId = modelId;
    this._rawGroupId = rawGroupId;

    if (!this._proxyGroup) {
      this._proxyGroup = new THREE.Group();
      this._proxyGroup.userData.isSelectionProxy = true;
      this._proxyGroup.userData.isGroupSelectionProxy = true;
      this.helperRoot.add(this._proxyGroup);
    }
    this._proxyGroup.name = `GroupSelectionProxy:${globalGroupId}`;
    this._proxyGroup.userData.globalGroupId = globalGroupId;

    this._syncProxyFromGroup();
    return { ok: true, proxyGroup: this._proxyGroup, modelId, rawGroupId };
  }

  clear() {
    if (this._proxyGroup) {
      if (this._proxyGroup.parent) this._proxyGroup.parent.remove(this._proxyGroup);
      this._proxyGroup = null;
    }
    this._activeGroupId = null;
    this._selectedModelId = null;
    this._rawGroupId = null;
  }

  /** Recompute the proxy world transform from the group VoxelPart source data. */
  syncProxyFromGroup() { this._syncProxyFromGroup(); }

  _syncProxyFromGroup() {
    if (!this._proxyGroup || !this._activeGroupId) return;
    const model = this.sceneManager.getModel(this._selectedModelId);
    const rootGroup = this.sceneManager.getRootGroup(this._selectedModelId);
    if (!model || !rootGroup) return;
    const groupPart = model.getPart?.(this._rawGroupId);
    if (!groupPart) return;

    rootGroup.updateWorldMatrix(true, false);
    // world = rootGroup.matrixWorld × parentChain(group) × groupLocalTRS
    const parentChain = computeParentChainMatrix(model, groupPart); // model-root → parent of group
    const localTRS = this._partLocalMatrix(groupPart);
    const worldMat = new THREE.Matrix4()
      .copy(rootGroup.matrixWorld)
      .multiply(parentChain)
      .multiply(localTRS);

    worldMat.decompose(_pos, _quat, _scl);
    this._proxyGroup.position.copy(_pos);
    this._proxyGroup.quaternion.copy(_quat);
    this._proxyGroup.scale.copy(_scl);
    this._proxyGroup.updateMatrixWorld(true);
  }

  /**
   * Write the proxy world transform back into the group VoxelPart and rebuild
   * (only) this model's RenderCache.
   * @param {{rebuild?:boolean}} [options]
   */
  commitProxyToGroup(options = {}) {
    const shouldRebuild = options.rebuild !== false;
    if (!this._activeGroupId || !this._proxyGroup) return { ok: false, reason: 'no-active-group' };

    const modelId = this._selectedModelId;
    const model = this.sceneManager.getModel(modelId);
    if (!model) return { ok: false, reason: 'model-not-found', modelId };
    const groupPart = model.getPart?.(this._rawGroupId) || model.parts?.find?.(p => p.id === this._rawGroupId);
    if (!groupPart) return { ok: false, reason: 'group-part-not-found', rawGroupId: this._rawGroupId };
    const rootGroup = this.sceneManager.getRootGroup(modelId);
    if (!rootGroup) return { ok: false, reason: 'rootGroup-not-found' };

    this._proxyGroup.updateMatrixWorld(true);
    rootGroup.updateWorldMatrix(true, false);

    // proxyWorld → modelLocal → groupLocal (relative to parent chain).
    const proxyWorld = this._proxyGroup.matrixWorld.clone();
    const modelRootWorldInv = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
    const modelLocal = new THREE.Matrix4().multiplyMatrices(modelRootWorldInv, proxyWorld);

    const parentChain = computeParentChainMatrix(model, groupPart);
    const parentChainInv = new THREE.Matrix4().copy(parentChain).invert();
    const groupLocal = new THREE.Matrix4().multiplyMatrices(parentChainInv, modelLocal);

    // Groups have no geometry scale, so a plain decompose is exact.
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    groupLocal.decompose(pos, quat, scl);

    const changedFields = [];

    // Offset
    const before = { x: groupPart.offset.x, y: groupPart.offset.y, z: groupPart.offset.z };
    if (Math.abs(pos.x - before.x) > 0.0001 || Math.abs(pos.y - before.y) > 0.0001 || Math.abs(pos.z - before.z) > 0.0001) {
      groupPart.offset.x = parseFloat(pos.x.toFixed(6));
      groupPart.offset.y = parseFloat(pos.y.toFixed(6));
      groupPart.offset.z = parseFloat(pos.z.toFixed(6));
      changedFields.push('offset');
    }

    // Rotation (store as quaternion, clear euler — matches per-part proxy)
    if (Math.abs(quat.x) > 0.0001 || Math.abs(quat.y) > 0.0001 || Math.abs(quat.z) > 0.0001 || Math.abs(quat.w - 1) > 0.0001) {
      groupPart.quaternion = {
        x: parseFloat(quat.x.toFixed(6)), y: parseFloat(quat.y.toFixed(6)),
        z: parseFloat(quat.z.toFixed(6)), w: parseFloat(quat.w.toFixed(6)),
      };
      groupPart.rotation = null;
      changedFields.push('rotation');
    } else if (groupPart.quaternion) {
      // returned to identity
      groupPart.quaternion = null;
      changedFields.push('rotation');
    }

    // Scale
    const nsx = parseFloat(scl.x.toFixed(6));
    const nsy = parseFloat(scl.y.toFixed(6));
    const nsz = parseFloat(scl.z.toFixed(6));
    const cs = groupPart.scale || { x: 1, y: 1, z: 1 };
    if (Math.abs(nsx - cs.x) > 0.001 || Math.abs(nsy - cs.y) > 0.001 || Math.abs(nsz - cs.z) > 0.001) {
      groupPart.scale = (Math.abs(nsx - 1) < 0.001 && Math.abs(nsy - 1) < 0.001 && Math.abs(nsz - 1) < 0.001)
        ? null : { x: nsx, y: nsy, z: nsz };
      changedFields.push('scale');
    }

    const result = {
      ok: true,
      globalGroupId: this._activeGroupId,
      modelId,
      rawGroupId: this._rawGroupId,
      changedFields,
      before: { offset: { ...before } },
      after: { offset: { ...groupPart.offset } },
    };
    if (shouldRebuild && changedFields.length > 0) {
      result.rebuiltModelId = modelId;
      result.rebuildAudit = this.sceneManager.rebuildModelRenderCache(modelId);
    }
    return result;
  }

  /** Build a part's local TRS matrix (T × R × S) from its source transform. */
  _partLocalMatrix(part) {
    const t = new THREE.Matrix4().makeTranslation(part.offset.x || 0, part.offset.y || 0, part.offset.z || 0);
    let r = null;
    if (part.quaternion) {
      r = new THREE.Matrix4().makeRotationFromQuaternion(
        new THREE.Quaternion(part.quaternion.x, part.quaternion.y, part.quaternion.z, part.quaternion.w)
      );
    } else if (part.rotation && (part.rotation.x || part.rotation.y || part.rotation.z)) {
      r = new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(part.rotation.x || 0, part.rotation.y || 0, part.rotation.z || 0, 'XYZ')
      );
    }
    const s = new THREE.Matrix4().makeScale(part.scale?.x ?? 1, part.scale?.y ?? 1, part.scale?.z ?? 1);
    const m = new THREE.Matrix4();
    if (r) m.multiplyMatrices(t, r).multiply(s);
    else m.multiplyMatrices(t, s);
    return m;
  }

  debug() {
    const p = this._proxyGroup;
    return {
      ok: true,
      selectionMode: this._activeGroupId ? 'group' : 'none',
      selectedGroupId: this._activeGroupId,
      modelId: this._selectedModelId,
      rawGroupId: this._rawGroupId,
      proxyExists: !!p,
      proxyAttached: !!(p?.parent),
      proxyPosition: p ? { x: +p.position.x.toFixed(4), y: +p.position.y.toFixed(4), z: +p.position.z.toFixed(4) } : null,
      proxyQuaternion: p ? { x: +p.quaternion.x.toFixed(4), y: +p.quaternion.y.toFixed(4), z: +p.quaternion.z.toFixed(4), w: +p.quaternion.w.toFixed(4) } : null,
      proxyScale: p ? { x: +p.scale.x.toFixed(4), y: +p.scale.y.toFixed(4), z: +p.scale.z.toFixed(4) } : null,
      childLeafParts: this._activeGroupId ? (this.runtimeIndex?.getGroupLeafParts?.(this._activeGroupId)?.length ?? null) : null,
    };
  }
}

export default GroupSelectionProxy;
