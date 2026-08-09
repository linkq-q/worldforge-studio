/**
 * SelectionProxyRuntime — lightweight proxy Object3D for TransformControls editing
 * of AIPrimitiveBatcher InstancedMesh parts.
 *
 * The proxy is an invisible THREE.Group placed at the part's world position.
 * TransformControls attaches to it. On drag-end, the proxy's world matrix is
 * decomposed and written back to VoxelPart source data, then the model's
 * RenderCache is rebuilt.
 */

import * as THREE from 'three';
import { computeParentChainMatrix, classify } from './PrimitiveFamily.js';

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();

export class SelectionProxyRuntime {
  constructor({ runtimeIndex, aiPrimitiveBatcher, sceneManager, helperRoot, transformControls = null }) {
    this.runtimeIndex = runtimeIndex;
    this.aiPrimitiveBatcher = aiPrimitiveBatcher;
    this.sceneManager = sceneManager;
    this.helperRoot = helperRoot;
    // Optional TransformControls reference. clear() detaches TC when it is still
    // attached to the proxy being removed, so a proxy that disappears (e.g. the
    // part transitioned instanced→fallback on rebuild) never leaves TC pointing
    // at an orphaned object ("attached 3D object must be a part of the scene graph").
    this.transformControls = transformControls;

    this._activeGlobalPartId = null;
    this._proxyGroup = null;
    this._selectedModelId = null;
    this._instanceId = -1;
    this._batchId = null;
    this._lastRenderRef = null;
  }

  selectPart(globalPartId) {
    if (!globalPartId) { this.clear(); return { ok: false, reason: 'no-globalPartId' }; }
    const ref = this.runtimeIndex.getRenderRef(globalPartId);
    if (!ref) { this.clear(); return { ok: false, reason: 'renderRef-not-found', globalPartId }; }
    const renderIndex = ref.mode === 'batched' ? ref.geometryId : ref.instanceId;
    if ((ref.mode === 'instanced' || ref.mode === 'batched')
      && (!Number.isInteger(renderIndex) || renderIndex < 0)) {
      this.clear();
      return { ok: false, reason: 'invalid-render-index', renderIndex, globalPartId };
    }

    const modelId = ref.modelId || globalPartId.split(':')[0];
    const rootGroup = this.sceneManager.getRootGroup(modelId);
    if (!rootGroup) { this.clear(); return { ok: false, reason: 'rootGroup-not-found', modelId }; }

    this._activeGlobalPartId = globalPartId;
    this._selectedModelId = modelId;
    this._instanceId = renderIndex ?? -1;
    this._batchId = ref.batchId;
    this._lastRenderRef = ref;

    if (!this._proxyGroup) {
      this._proxyGroup = new THREE.Group();
      this._proxyGroup.name = `SelectionProxy:${globalPartId}`;
      this._proxyGroup.userData.isSelectionProxy = true;
      this._proxyGroup.userData.globalPartId = globalPartId;
      this._proxyGroup.visible = true;
      this.helperRoot.add(this._proxyGroup);
    }

    this._syncProxyFromInstanceMatrix();
    return { ok: true, proxyGroup: this._proxyGroup, renderRef: ref };
  }

  clear() {
    if (this._proxyGroup) {
      // Detach TransformControls FIRST if it is attached to this proxy — otherwise
      // removing the proxy from the scene graph orphans the gizmo's target.
      if (this.transformControls && this.transformControls.object === this._proxyGroup) {
        this.transformControls.detach();
      }
      if (this._proxyGroup.parent) this._proxyGroup.parent.remove(this._proxyGroup);
      this._proxyGroup = null;
    }
    this._activeGlobalPartId = null;
    this._selectedModelId = null;
    this._instanceId = -1;
    this._batchId = null;
    this._lastRenderRef = null;
  }

  syncProxyFromPart() {
    if (!this._activeGlobalPartId) return;
    const ref = this.runtimeIndex.getRenderRef(this._activeGlobalPartId);
    if (!ref) { this.clear(); return; }
    this._instanceId = (ref.mode === 'batched' ? ref.geometryId : ref.instanceId) ?? -1;
    this._batchId = ref.batchId;
    this._lastRenderRef = ref;
    this._syncProxyFromInstanceMatrix();
  }

  _syncProxyFromInstanceMatrix() {
    const ref = this._lastRenderRef;
    if (!ref || !this._proxyGroup) return;
    const renderObject = ref.object;
    if (!renderObject) return;
    // Ensure the InstancedMesh world matrix is current. After a RenderCache
    // rebuild (commit), the new InstancedMesh is freshly attached and its
    // matrixWorld may still be identity until the next render tick — reading it
    // stale would offset the proxy by the model rootGroup transform.
    renderObject.updateWorldMatrix(true, false);
    let worldMat;
    if ((ref.mode === 'instanced' || ref.mode === 'batched') && renderObject.getMatrixAt) {
      renderObject.getMatrixAt(this._instanceId, _mat4);
      worldMat = new THREE.Matrix4().copy(renderObject.matrixWorld).multiply(_mat4);
    } else {
      worldMat = new THREE.Matrix4().copy(renderObject.matrixWorld);
    }
    worldMat.decompose(_pos, _quat, _scl);
    this._proxyGroup.position.copy(_pos);
    this._proxyGroup.quaternion.copy(_quat);
    this._proxyGroup.scale.copy(_scl);
  }

  commitProxyToPart(options = {}) {
    const shouldRebuild = options.rebuild !== false;
    if (!this._activeGlobalPartId || !this._proxyGroup) return { ok: false, reason: 'no-active-part' };

    const globalPartId = this._activeGlobalPartId;
    const modelId = this._selectedModelId;
    const model = this.sceneManager.getModel(modelId);
    if (!model) return { ok: false, reason: 'model-not-found', modelId };
    const rawPartId = this._lastRenderRef?.rawPartId || globalPartId.split(':').slice(1).join(':');
    const part = model.getPart?.(rawPartId) || model.parts?.find?.(p => p.id === rawPartId);
    if (!part) return { ok: false, reason: 'part-not-found', rawPartId };
    const rootGroup = this.sceneManager.getRootGroup(modelId);
    if (!rootGroup) return { ok: false, reason: 'rootGroup-not-found' };

    const changedFields = [];

    // proxyWorld → modelLocal → partLocal
    const proxyWorld = this._proxyGroup.matrixWorld.clone();
    const modelRootWorldInv = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
    const modelLocal = new THREE.Matrix4().multiplyMatrices(modelRootWorldInv, proxyWorld);

    const parentChain = computeParentChainMatrix(model, part);
    let partLocal;
    if (parentChain) {
      partLocal = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().copy(parentChain).invert(), modelLocal);
    } else {
      partLocal = modelLocal.clone();
    }

    // Decompose ONCE — must use decompose (not setFromRotationMatrix) so that
    // non-uniform geometry scale (cylinder [r,h,r], box [w,h,d], etc.) is
    // separated from rotation. setFromRotationMatrix on a non-uniformly-scaled
    // matrix yields a garbage quaternion and falsely flags a rotation change.
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    partLocal.decompose(pos, quat, scl);

    // Position
    const beforePos = { x: part.offset.x, y: part.offset.y, z: part.offset.z };
    if (Math.abs(pos.x - beforePos.x) > 0.0001 || Math.abs(pos.y - beforePos.y) > 0.0001 || Math.abs(pos.z - beforePos.z) > 0.0001) {
      part.offset.x = parseFloat(pos.x.toFixed(6));
      part.offset.y = parseFloat(pos.y.toFixed(6));
      part.offset.z = parseFloat(pos.z.toFixed(6));
      changedFields.push('offset');
    }

    // Rotation
    if (Math.abs(quat.x) > 0.0001 || Math.abs(quat.y) > 0.0001 || Math.abs(quat.z) > 0.0001 || Math.abs(quat.w - 1) > 0.0001) {
      part.quaternion = { x: parseFloat(quat.x.toFixed(6)), y: parseFloat(quat.y.toFixed(6)), z: parseFloat(quat.z.toFixed(6)), w: parseFloat(quat.w.toFixed(6)) };
      part.rotation = null;
      changedFields.push('quaternion');
    }

    // Scale (geometry dims separated)
    let geomScale = { x: 1, y: 1, z: 1 };
    // Use classify() (pure geometry, render-mode independent) for the geometry-derived
    // scale. canBatch() additionally gates on render mode and returns no scale in cel
    // mode → geomScale would stay {1,1,1} and a WRONG part.scale gets written (the part
    // resizes when moved). classify() always yields the true geometry dims.
    try { const cls = classify(part); if (cls?.supported && cls.instanceScale) geomScale = cls.instanceScale; } catch (_) {}
    let parentScl = { x: 1, y: 1, z: 1 };
    if (parentChain) { const ps = new THREE.Vector3().setFromMatrixScale(parentChain); parentScl = { x: ps.x, y: ps.y, z: ps.z }; }
    const nsx = parseFloat((scl.x / geomScale.x / parentScl.x).toFixed(6));
    const nsy = parseFloat((scl.y / geomScale.y / parentScl.y).toFixed(6));
    const nsz = parseFloat((scl.z / geomScale.z / parentScl.z).toFixed(6));
    const cs = part.scale || { x: 1, y: 1, z: 1 };
    if (Math.abs(nsx - cs.x) > 0.001 || Math.abs(nsy - cs.y) > 0.001 || Math.abs(nsz - cs.z) > 0.001) {
      part.scale = (Math.abs(nsx - 1) < 0.001 && Math.abs(nsy - 1) < 0.001 && Math.abs(nsz - 1) < 0.001) ? null : { x: nsx, y: nsy, z: nsz };
      changedFields.push('scale');
    }

    const result = { ok: true, globalPartId, changedFields, before: { offset: { ...beforePos } }, after: { offset: { ...part.offset } } };
    if (shouldRebuild && changedFields.length > 0) {
      result.rebuiltModelId = modelId;
      result.rebuildAudit = this.sceneManager.rebuildModelRenderCache(modelId);
    }
    return result;
  }

  debug() {
    return {
      ok: true,
      selectedPartId: this._activeGlobalPartId,
      selectionMode: this._activeGlobalPartId ? 'part' : 'none',
      proxyExists: !!this._proxyGroup,
      proxyAttachedToTransformControls: !!(this._proxyGroup?.parent),
      proxyPosition: this._proxyGroup ? { x: +this._proxyGroup.position.x.toFixed(4), y: +this._proxyGroup.position.y.toFixed(4), z: +this._proxyGroup.position.z.toFixed(4) } : null,
      proxyQuaternion: this._proxyGroup ? { x: +this._proxyGroup.quaternion.x.toFixed(4), y: +this._proxyGroup.quaternion.y.toFixed(4), z: +this._proxyGroup.quaternion.z.toFixed(4), w: +this._proxyGroup.quaternion.w.toFixed(4) } : null,
      proxyScale: this._proxyGroup ? { x: +this._proxyGroup.scale.x.toFixed(4), y: +this._proxyGroup.scale.y.toFixed(4), z: +this._proxyGroup.scale.z.toFixed(4) } : null,
      proxyParent: this._proxyGroup?.parent?.type ?? null,
      transformControlsObjectName: null,
      renderRefMode: this._lastRenderRef?.mode ?? null,
      modelId: this._selectedModelId,
      rawPartId: this._lastRenderRef?.rawPartId ?? null,
      instanceId: this._instanceId,
      batchId: this._batchId,
    };
  }
}

export default SelectionProxyRuntime;
