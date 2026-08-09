import * as THREE from 'three';

function targetPartId(target) {
  if (typeof target === 'string') return target;
  return target?.partId || target?.nodeId || target?.userData?.nodeId || target?.userData?.partId || null;
}

function cloneLayers(layers) {
  return (Array.isArray(layers) ? layers : []).map(layer => ({
    id: layer.id,
    type: layer.type,
    slot: layer.slot,
    route: layer.route,
    scope: layer.scope,
    batchPolicy: layer.batchPolicy,
    params: { ...(layer.params || {}) },
  }));
}

function isBatchableDecision(batchDecision) {
  return batchDecision?.result === 'effectBatch' && !!batchDecision.effectBatchKey;
}

export class EffectBatchCoordinator {
  constructor(options = {}) {
    this.runtimeIndex = options.runtimeIndex || null;
    this.batchParent = options.batchParent || options.standaloneParent || null;
    this.minGroupSize = Math.max(2, Number(options.minGroupSize || options.effectBatchMinGroupSize || 8));
    this.source = options.source || 'effect-batch-coordinator';
    this.pendingByKey = new Map();
    this.batches = new Map();
    this.sequence = 0;
    this.logger = options.logger || null;
  }

  consume({ target, layers = [], batchDecision } = {}) {
    if (!isBatchableDecision(batchDecision)) return { action: 'skip', reason: batchDecision?.reason || 'not-effect-batch' };
    if (!target?.isMesh || target.isInstancedMesh) return { action: 'skip', reason: 'target-not-standalone-mesh' };
    const partId = targetPartId(target);
    if (!partId) return { action: 'skip', reason: 'missing-part-id' };
    if (!target.geometry || !target.material) return { action: 'skip', reason: 'missing-render-data' };
    if (!target.parent && !this.batchParent) return { action: 'skip', reason: 'missing-parent' };

    const key = batchDecision.effectBatchKey;
    const pending = this._pendingFor(key);
    if (pending.items.some(item => item.partId === partId || item.mesh === target)) {
      return { action: 'pending', key, count: pending.items.length, reason: 'already-pending' };
    }

    pending.items.push({ partId, mesh: target, layers: cloneLayers(layers) });
    pending.items = pending.items.filter(item => item.mesh?.parent);

    if (pending.items.length < this.minGroupSize) {
      this._log(`[EffectBatchCoordinator] pending key=${key} count=${pending.items.length}/${this.minGroupSize}`);
      return { action: 'pending', key, count: pending.items.length };
    }

    return this._buildBatch(key, pending);
  }

  clear() {
    for (const entry of this.batches.values()) {
      if (entry.batchMesh?.parent) entry.batchMesh.parent.remove(entry.batchMesh);
      entry.batchMesh?.dispose?.();
    }
    this.batches.clear();
    this.pendingByKey.clear();
    this.runtimeIndex?.unregisterBatchesBySource?.(this.source);
  }

  _pendingFor(key) {
    let pending = this.pendingByKey.get(key);
    if (!pending) {
      pending = { key, items: [] };
      this.pendingByKey.set(key, pending);
    }
    return pending;
  }

  _buildBatch(key, pending) {
    const items = pending.items.splice(0, pending.items.length);
    this.pendingByKey.delete(key);
    const first = items[0];
    if (!first) return { action: 'skip', reason: 'empty-group' };

    const parent = this.batchParent || first.mesh.parent;
    if (!parent) return { action: 'skip', reason: 'missing-parent' };
    parent.updateWorldMatrix?.(true, true);
    const parentInverse = new THREE.Matrix4();
    if (parent.matrixWorld) parentInverse.copy(parent.matrixWorld).invert();

    const geometry = first.mesh.geometry;
    // Material.clone() drops onBeforeCompile closures. Move the first resolved
    // live material into the batch so the installed effect patch chain survives.
    const material = first.mesh.material;
    const batchMesh = new THREE.InstancedMesh(geometry, material, items.length);
    const batchId = `${this.source}:${++this.sequence}`;
    batchMesh.name = `EffectBatch:${this.sequence}`;
    batchMesh.castShadow = first.mesh.castShadow;
    batchMesh.receiveShadow = first.mesh.receiveShadow;
    batchMesh.frustumCulled = !first.layers.some(layer => layer.type === 'VegetationSway');
    batchMesh.userData = {
      ...(batchMesh.userData || {}),
      isEffectBatch: true,
      effectBatchKey: key,
      effectBatchPartIds: items.map(item => item.partId),
      effectSlots: cloneLayers(first.layers),
      runtimeIndexSource: this.source,
      batchId,
      skipBatching: true,
    };

    const world = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    items.forEach((item, index) => {
      item.mesh.updateWorldMatrix?.(true, false);
      world.copy(item.mesh.matrixWorld || item.mesh.matrix);
      local.copy(parentInverse).multiply(world);
      batchMesh.setMatrixAt(index, local);
      if (item.mesh.parent) item.mesh.parent.remove(item.mesh);
    });
    if (batchMesh.instanceMatrix) batchMesh.instanceMatrix.needsUpdate = true;
    batchMesh.computeBoundingBox();
    batchMesh.computeBoundingSphere();
    parent.add(batchMesh);
    batchMesh.updateMatrixWorld?.(true);

    const partIds = items.map(item => item.partId);
    this.runtimeIndex?.registerInstancedBatch?.(batchId, batchMesh, partIds, {
      source: this.source,
      batchKey: key,
    });

    const result = { action: 'batched', key, batchId, batchMesh, partIds, count: partIds.length };
    this.batches.set(batchId, result);
    this._log(`[EffectBatchCoordinator] batched key=${key} count=${partIds.length} batchId=${batchId}`);
    return result;
  }

  _log(message) {
    if (this.logger?.enabled && Array.isArray(this.logger.entries)) this.logger.entries.push(message);
    if (this.logger?.enabled && this.logger.console === true) console.log(message);
  }
}

export default EffectBatchCoordinator;
