import * as THREE from 'three';

function copyMatrixToMesh(mesh, matrix) {
  if (!matrix) return;
  if (typeof matrix.decompose === 'function' && mesh.position && mesh.quaternion && mesh.scale) {
    matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    return;
  }
  if (mesh.matrix?.copy) {
    mesh.matrix.copy(matrix);
    mesh.matrixAutoUpdate = false;
  }
  const e = matrix.elements || [];
  if (mesh.position && e.length >= 15) {
    if (typeof mesh.position.set === 'function') mesh.position.set(e[12], e[13], e[14]);
    else {
      mesh.position.x = e[12];
      mesh.position.y = e[13];
      mesh.position.z = e[14];
    }
  }
}

function collapseInstance(instancedMesh, instanceId) {
  if (!instancedMesh?.isInstancedMesh || !Number.isInteger(instanceId) || instanceId < 0) return false;
  try {
    const nullMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    instancedMesh.setMatrixAt(instanceId, nullMatrix);
    if (instancedMesh.instanceMatrix) instancedMesh.instanceMatrix.needsUpdate = true;
    return true;
  } catch {
    return false;
  }
}

function getNodeId(target) {
  if (typeof target === 'string') return target;
  return target?.partId || target?.nodeId || target?.userData?.nodeId || target?.userData?.partId || null;
}

export class BatchIsolationService {
  constructor(options = {}) {
    this.runtimeIndex = options.runtimeIndex || null;
    this.renderCache = options.renderCache || null;
    this.standaloneParent = options.standaloneParent || null;
    this.sceneManager = options.sceneManager || null;
    this.logger = options.logger || null;
  }

  ensureStandalone(target, options = {}) {
    const partId = getNodeId(target);
    if (!partId) {
      if (target?.isMesh && !target.isInstancedMesh) return { isolated: false, mesh: target, reason: 'already-mesh' };
      return { isolated: false, mesh: target?.object || target || null, reason: 'no-part-id' };
    }

    const ref = this.runtimeIndex?.getRenderRef?.(partId) || null;
    if (!ref) return { isolated: false, mesh: target?.object || target || null, partId, reason: 'no-render-ref' };
    if (ref.mode !== 'instanced') return { isolated: false, mesh: ref.object, partId, ref, reason: 'already-standalone' };

    const instancedMesh = ref.object;
    const instanceId = ref.instanceId;
    const matrix = new THREE.Matrix4();
    instancedMesh.getMatrixAt(instanceId, matrix);

    const geometry = instancedMesh.geometry?.clone ? instancedMesh.geometry.clone() : instancedMesh.geometry;
    const material = instancedMesh.material?.clone ? instancedMesh.material.clone() : instancedMesh.material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `StandaloneSpecial:${partId}`;
    mesh.castShadow = instancedMesh.castShadow;
    mesh.receiveShadow = instancedMesh.receiveShadow;
    mesh.frustumCulled = true;
    mesh.userData = {
      ...(instancedMesh.userData || {}),
      ...(target?.userData || {}),
      nodeId: partId,
      partId: ref.rawPartId || partId,
      sceneModelId: ref.modelId,
      semanticGroupId: ref.semanticGroupId || target?.userData?.semanticGroupId || target?.semanticGroupId || null,
      sourceBatchId: ref.batchId,
      sourceInstanceId: instanceId,
      isStandaloneSpecialMesh: true,
      skipBatching: true,
    };
    // Preserve critical pick/resolve fields from the original mesh (if any)
    if (ref.object?.userData?.modelRootId) mesh.userData.modelRootId = ref.object.userData.modelRootId;
    if (ref.object?.userData?.semanticGroupId && !mesh.userData.semanticGroupId) mesh.userData.semanticGroupId = ref.object.userData.semanticGroupId;

    // Prefer model's rootGroup so the standalone mesh stays within the pick envelope.
    // Fallback: explicit standaloneParent → instancedMesh.parent.
    const modelRootGroup = ref.modelId && this.sceneManager?.getRootGroup?.(ref.modelId)
      ? this.sceneManager.getRootGroup(ref.modelId)
      : null;
    const parent = modelRootGroup || options.standaloneParent || this.standaloneParent || instancedMesh.parent;

    // Convert world-space instance matrix to local space when the new parent
    // differs from the original batch parent (sharedBatchRoot at origin).
    // Without this, a rootGroup with non-zero position would double-apply the
    // model transform and teleport the mesh.
    if (parent && parent !== instancedMesh.parent && parent.matrixWorld) {
      parent.updateWorldMatrix(true, true);
      const invParentWorld = new THREE.Matrix4().copy(parent.matrixWorld).invert();
      matrix.premultiply(invParentWorld);
    }

    if (parent?.add) parent.add(mesh);
    copyMatrixToMesh(mesh, matrix);

    const renderCache = typeof this.renderCache === 'function' ? this.renderCache() : this.renderCache;
    let removed = renderCache?.removeInstance?.(partId) ?? false;
    const removalStrategy = removed ? 'render-cache' : 'direct-instance-collapse';
    if (!removed) removed = collapseInstance(instancedMesh, instanceId);
    renderCache?.flush?.();
    this.runtimeIndex?.registerMesh?.(partId, mesh, {
      modelId: ref.modelId,
      rawPartId: ref.rawPartId,
      mode: 'special',
      source: 'batch-isolation',
    });

    const result = {
      isolated: true,
      mesh,
      partId,
      ref,
      batchId: ref.batchId,
      instanceId,
      removed,
      removalStrategy,
    };
    this._log(`[BatchIsolation] target partId=${partId} batchId=${ref.batchId} instanceId=${instanceId} isolated=true removed=${removed} strategy=${removalStrategy}`);
    return result;
  }

  _log(message) {
    if (this.logger?.enabled && Array.isArray(this.logger.entries)) this.logger.entries.push(message);
    if (this.logger?.enabled && this.logger.console === true) console.log(message);
  }
}
