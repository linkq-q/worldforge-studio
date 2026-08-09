/**
 * RenderCache — manages InstancedMesh batch lifecycle for AIPrimitiveBatcher.
 *
 * Responsibilities:
 *  - Create/register InstancedMesh batches
 *  - Track batch capacity and part→instance mapping
 *  - Dispose geometry/material references on clear
 *  - Support instanceMatrix and instanceColor updates
 *
 * NOT authoritative — VoxelPart is the source of truth.
 * Dispose old RenderCache before scene reload.
 */

import * as THREE from 'three';

export class RenderCache {
  constructor() {
    /** @type {Map<string, BatchRecord>} */
    this.batches = new Map();
    /** @type {Map<string, string>} partId → batchId */
    this.partToBatch = new Map();
  }

  /**
   * Get or create a batch for a given batchKey.
   * @param {string} batchKey
   * @param {object} opts
   * @param {THREE.BufferGeometry} opts.unitGeometry — shared unit geometry
   * @param {THREE.Material} opts.batchMaterial — shared material (clone per batch)
   * @param {number} opts.initialCapacity
   * @param {number} [opts.maxCapacity] — max instances (default 1000)
   * @returns {BatchRecord}
   */
  getOrCreateBatch(batchKey, opts) {
    let batch = this.batches.get(batchKey);
    if (batch) return batch;

    const capacity = Math.max(1, opts.initialCapacity || 16);
    const maxCapacity = opts.maxCapacity || 1000;
    const geometry = opts.unitGeometry;
    const material = opts.batchMaterial;

    const instancedMesh = new THREE.InstancedMesh(geometry, material, capacity);
    instancedMesh.castShadow = true;
    instancedMesh.receiveShadow = true;
    instancedMesh.frustumCulled = true;
    instancedMesh.name = `AIPrimitiveBatch:${batchKey}:${capacity}`;
    instancedMesh.userData.isAIPrimitiveBatch = true;
    instancedMesh.userData.batchKey = batchKey;

    batch = {
      batchKey,
      instancedMesh,
      unitGeometry: geometry,
      material,
      partIds: new Array(capacity).fill(null),
      freeList: [],
      count: 0,
      capacity,
      maxCapacity,
      dirtyMatrices: false,
      dirtyColors: false,
      boundsDirty: true,
    };

    // Initialize free list in reverse order (pop from end is O(1))
    for (let i = capacity - 1; i >= 0; i--) {
      batch.freeList.push(i);
    }

    this.batches.set(batchKey, batch);
    return batch;
  }

  /**
   * Add a part to a batch. Returns the instanceId or -1 if at capacity.
   * @param {BatchRecord} batch
   * @param {string} partId
   * @param {THREE.Matrix4} instanceMatrix
   * @param {THREE.Color} [instanceColor] — optional per-instance color
   * @returns {number} instanceId
   */
  addInstance(batch, partId, instanceMatrix, instanceColor) {
    if (this.partToBatch.has(partId)) return -1;
    if (batch.count >= batch.maxCapacity) return -1;

    // Grow if needed
    if (batch.freeList.length === 0) {
      const nextCapacity = Math.min(
        Math.max(batch.capacity * 2, batch.capacity + 1),
        batch.maxCapacity,
      );
      if (nextCapacity <= batch.capacity || !this._growBatch(batch, nextCapacity)) return -1;
    }

    const instanceId = batch.freeList[batch.freeList.length - 1];
    const instancedMesh = batch.instancedMesh;
    let wroteColor = false;
    try {
      if (instanceColor) {
        this._ensureInstanceColors(batch);
        instancedMesh.setColorAt(instanceId, instanceColor);
        wroteColor = true;
      } else if (instancedMesh.instanceColor) {
        instancedMesh.setColorAt(instanceId, new THREE.Color(1, 1, 1));
        wroteColor = true;
      }
      instancedMesh.setMatrixAt(instanceId, instanceMatrix);
    } catch (_error) {
      return -1;
    }

    batch.freeList.pop();
    batch.partIds[instanceId] = partId;
    batch.count++;
    if (wroteColor) batch.dirtyColors = true;
    batch.dirtyMatrices = true;
    batch.boundsDirty = true;

    this.partToBatch.set(partId, batch.batchKey);
    return instanceId;
  }

  /**
   * Replace a batch mesh with a larger one while preserving instance IDs.
   * @param {BatchRecord} batch
   * @param {number} requestedCapacity
   * @returns {boolean}
   */
  _growBatch(batch, requestedCapacity) {
    if (!Number.isInteger(requestedCapacity) || requestedCapacity <= batch.capacity) return false;

    const oldMesh = batch.instancedMesh;
    const oldCapacity = batch.capacity;
    const parent = oldMesh.parent;
    const parentIndex = parent ? parent.children.indexOf(oldMesh) : -1;
    let replacement;

    try {
      replacement = new THREE.InstancedMesh(
        batch.unitGeometry,
        batch.material,
        requestedCapacity,
      );

      const copiedMatrix = new THREE.Matrix4();
      const copiedColor = oldMesh.instanceColor ? new THREE.Color() : null;
      for (let i = 0; i < oldCapacity; i++) {
        if (batch.partIds[i] == null) continue;
        oldMesh.getMatrixAt(i, copiedMatrix);
        replacement.setMatrixAt(i, copiedMatrix);
        if (copiedColor) {
          oldMesh.getColorAt(i, copiedColor);
          replacement.setColorAt(i, copiedColor);
        }
      }

      replacement.name = oldMesh.name;
      replacement.castShadow = oldMesh.castShadow;
      replacement.receiveShadow = oldMesh.receiveShadow;
      replacement.frustumCulled = oldMesh.frustumCulled;
      replacement.userData = { ...oldMesh.userData };
      replacement.count = oldMesh.count;
    } catch (_error) {
      try {
        replacement?.dispose?.();
      } catch (_disposeError) {
        // Allocation/copy failure remains a normal failed growth attempt.
      }
      return false;
    }

    const discardReplacement = () => {
      try {
        if (replacement.parent) replacement.parent.remove(replacement);
      } catch (_cleanupError) {
        // Best-effort cleanup for custom parents that reject removal.
      }
      const candidateOwners = new Set([replacement.parent, parent].filter(Boolean));
      for (const owner of candidateOwners) {
        if (!Array.isArray(owner.children)) continue;
        for (let i = owner.children.length - 1; i >= 0; i--) {
          if (owner.children[i] === replacement) owner.children.splice(i, 1);
        }
      }
      replacement.parent = null;
      try {
        replacement.dispose?.();
      } catch (_disposeError) {
        // A failed candidate must not make growth failure propagate.
      }
    };

    if (parent) {
      try {
        parent.add(replacement);
      } catch (_error) {
        discardReplacement();
        return false;
      }

      try {
        parent.remove(oldMesh);
      } catch (_error) {
        discardReplacement();
        try {
          if (oldMesh.parent !== parent) parent.add(oldMesh);
        } catch (_restoreError) {
          // Never propagate a custom parent's rollback failure.
        }
        const currentIndex = parent.children.indexOf(oldMesh);
        if (oldMesh.parent !== parent || currentIndex !== parentIndex) {
          for (let i = parent.children.length - 1; i >= 0; i--) {
            if (parent.children[i] === oldMesh) parent.children.splice(i, 1);
          }
          const restoreIndex = Math.max(0, Math.min(parentIndex, parent.children.length));
          parent.children.splice(restoreIndex, 0, oldMesh);
          oldMesh.parent = parent;
        }
        return false;
      }
    }

    const furShell = oldMesh.userData?.furShell;
    if (furShell) {
      oldMesh.remove(furShell);
      furShell._furShellSource = replacement;
      furShell.instanceMatrix = replacement.instanceMatrix;
      furShell.instanceColor = replacement.instanceColor;
      replacement.add(furShell);
      replacement.userData.furShell = furShell;
    }

    batch.instancedMesh = replacement;
    batch.capacity = requestedCapacity;
    batch.partIds = batch.partIds.concat(
      new Array(requestedCapacity - oldCapacity).fill(null),
    );
    for (let i = requestedCapacity - 1; i >= oldCapacity; i--) {
      batch.freeList.push(i);
    }
    if (replacement.instanceColor) batch.dirtyColors = true;
    batch.boundsDirty = true;
    try {
      oldMesh.dispose?.();
    } catch (_disposeError) {
      // The replacement is already committed; disposal cannot roll it back.
    }
    return true;
  }

  /**
   * Lazily create a white instance-color buffer for the full batch capacity.
   * @param {BatchRecord} batch
   */
  _ensureInstanceColors(batch) {
    const im = batch.instancedMesh;
    if (im.instanceColor) return;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < batch.capacity; i++) im.setColorAt(i, white);
  }

  /**
   * @param {string} batchId
   * @returns {BatchRecord|null}
   */
  getBatch(batchId) {
    return this.batches.get(batchId) || null;
  }

  /**
   * Update a live instance matrix without changing its stable slot.
   * @param {string} batchId
   * @param {number} instanceId
   * @param {THREE.Matrix4} matrix
   * @returns {boolean}
   */
  updateInstanceMatrix(batchId, instanceId, matrix) {
    const batch = this.getBatch(batchId);
    if (!batch || !Number.isInteger(instanceId) || batch.partIds[instanceId] == null) return false;
    batch.instancedMesh.setMatrixAt(instanceId, matrix);
    batch.dirtyMatrices = true;
    batch.boundsDirty = true;
    return true;
  }

  /**
   * Return the high-water slot needed to render every live instance.
   * @param {BatchRecord} batch
   * @returns {number}
   */
  _getDrawCount(batch) {
    for (let i = batch.partIds.length - 1; i >= 0; i--) {
      if (batch.partIds[i] != null) return i + 1;
    }
    return 0;
  }

  /**
   * Remove a part from its batch (for material change fallback).
   * @param {string} partId
   * @returns {boolean} whether removal succeeded
   */
  removeInstance(partId) {
    const batchKey = this.partToBatch.get(partId);
    if (!batchKey) return false;
    const batch = this.batches.get(batchKey);
    if (!batch) return false;

    const idx = batch.partIds.indexOf(partId);
    if (idx === -1) return false;

    // Set a null matrix (scale to zero) to hide this instance
    const nullMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    batch.instancedMesh.setMatrixAt(idx, nullMatrix);
    batch.partIds[idx] = null;
    batch.freeList.push(idx);
    batch.count--;
    batch.dirtyMatrices = true;
    batch.boundsDirty = true;
    this.partToBatch.delete(partId);
    return true;
  }

  /**
   * Update per-instance color for a batched part.
   * Lazy-initializes the instanceColor buffer (all slots white = "use material color")
   * so non-overridden instances are not affected.
   * @param {string} partId — globalPartId (modelId:partId)
   * @param {THREE.Color} color
   * @returns {boolean} whether the update succeeded
   */
  updateInstanceColor(partId, color) {
    const batchKey = this.partToBatch.get(partId);
    if (!batchKey) return false;
    const batch = this.batches.get(batchKey);
    if (!batch) return false;
    const idx = batch.partIds.indexOf(partId);
    if (idx === -1) return false;
    const im = batch.instancedMesh;
    // Lazy-init instanceColor buffer: all slots white so they render with
    // the shared material colour unchanged. Per-instance colour is a tint.
    try {
      this._ensureInstanceColors(batch);
      im.setColorAt(idx, color);
    } catch (_error) {
      return false;
    }
    batch.dirtyColors = true;
    return true;
  }

  /**
   * Flush pending matrix/color updates to GPU.
   */
  flush() {
    for (const batch of this.batches.values()) {
      if (batch.dirtyMatrices) {
        // Only render active instances (avoid garbage identity-matrix draws)
        batch.instancedMesh.count = this._getDrawCount(batch);
        batch.instancedMesh.instanceMatrix.needsUpdate = true;
        batch.dirtyMatrices = false;
      }
      if (batch.boundsDirty) {
        this._rebuildBounds(batch);
        batch.boundsDirty = false;
      }
      if (batch.dirtyColors && batch.instancedMesh.instanceColor) {
        batch.instancedMesh.instanceColor.needsUpdate = true;
        batch.dirtyColors = false;
      }
    }
  }

  /** Rebuild local aggregate bounds from live slots only. */
  _rebuildBounds(batch) {
    const mesh = batch.instancedMesh;
    const geometry = batch.unitGeometry;
    if (!geometry?.boundingBox && geometry?.computeBoundingBox) geometry.computeBoundingBox();
    if (!geometry?.boundingSphere && geometry?.computeBoundingSphere) geometry.computeBoundingSphere();
    if (!geometry?.boundingBox || !geometry?.boundingSphere) return false;

    const bounds = new THREE.Box3().makeEmpty();
    const sphere = new THREE.Sphere().makeEmpty();
    const matrix = new THREE.Matrix4();
    const instanceBox = new THREE.Box3();
    const instanceSphere = new THREE.Sphere();
    for (let i = 0; i < batch.partIds.length; i++) {
      if (batch.partIds[i] == null) continue;
      mesh.getMatrixAt(i, matrix);
      instanceBox.copy(geometry.boundingBox).applyMatrix4(matrix);
      instanceSphere.copy(geometry.boundingSphere).applyMatrix4(matrix);
      bounds.union(instanceBox);
      sphere.union(instanceSphere);
    }
    mesh.boundingBox = bounds;
    mesh.boundingSphere = sphere;
    return true;
  }

  /**
   * Add all batch InstancedMeshes to a parent Object3D.
   * @param {THREE.Object3D} parent
   */
  attachToParent(parent) {
    for (const batch of this.batches.values()) {
      if (batch.instancedMesh.parent !== parent) {
        parent.add(batch.instancedMesh);
      }
    }
  }

  /**
   * Add all batches to the scene-level shared root.
   * @param {THREE.Object3D} root
   */
  attachToSharedRoot(root) {
    this.attachToParent(root);
  }

  /**
   * Remove all batch InstancedMeshes from their parents.
   */
  detachAll() {
    for (const batch of this.batches.values()) {
      if (batch.instancedMesh.parent) {
        batch.instancedMesh.parent.remove(batch.instancedMesh);
      }
    }
  }

  /**
   * Dispose all batch resources. Call before scene reload.
   */
  dispose() {
    this.detachAll();
    for (const batch of this.batches.values()) {
      // Don't dispose unitGeometry — it's shared
      const furShell = batch.instancedMesh.userData?.furShell;
      if (furShell) {
        const materials = Array.isArray(furShell.material) ? furShell.material : [furShell.material];
        for (const material of materials) material?.dispose?.();
        furShell.dispose?.();
      }
      batch.material?.dispose?.();
      batch.instancedMesh.dispose?.();
    }
    this.batches.clear();
    this.partToBatch.clear();
  }

  /**
   * @returns {number} total instance count across all batches
   */
  totalInstances() {
    let total = 0;
    for (const batch of this.batches.values()) total += batch.count;
    return total;
  }

  /**
   * @returns {number} total currently reusable slots across all batches
   */
  freeSlotCount() {
    let total = 0;
    for (const batch of this.batches.values()) total += batch.freeList.length;
    return total;
  }
}

/**
 * @typedef {Object} BatchRecord
 * @property {string} batchKey
 * @property {THREE.InstancedMesh} instancedMesh
 * @property {THREE.BufferGeometry} unitGeometry
 * @property {THREE.Material} material
 * @property {Array<string|null>} partIds — partIds[instanceId] = partId
 * @property {number[]} freeList — stack of free instanceIds
 * @property {number} count — active instance count
 * @property {number} capacity — current max capacity
 * @property {number} maxCapacity — absolute max
 * @property {boolean} dirtyMatrices
 * @property {boolean} dirtyColors
 * @property {boolean} boundsDirty
 */
