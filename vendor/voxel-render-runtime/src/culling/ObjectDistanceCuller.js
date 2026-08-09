import * as THREE from 'three';

const _worldSphere = new THREE.Sphere();
const _cameraPosition = new THREE.Vector3();

function localBoundingSphere(object) {
  if (object.boundingSphere) return object.boundingSphere;
  if (object.isInstancedMesh && object.computeBoundingSphere) {
    object.computeBoundingSphere();
    return object.boundingSphere;
  }
  const geometry = object.geometry;
  if (!geometry) return null;
  if (!geometry.boundingSphere && geometry.computeBoundingSphere) geometry.computeBoundingSphere();
  return geometry.boundingSphere || null;
}

/** Object-level distance culling with visibility ownership and hysteresis. */
export class ObjectDistanceCuller {
  constructor({ hysteresis = 0.1 } = {}) {
    this.hysteresis = THREE.MathUtils.clamp(Number(hysteresis) || 0, 0, 0.9);
    this.targets = new Map();
    this.runtimeIndex = null;
    this.runtimeRevision = -1;
  }

  setTargets(objects = []) {
    const next = new Set(objects);
    for (const [object, state] of this.targets) {
      if (next.has(object)) continue;
      if (state.culled) object.visible = state.baseVisible;
      this.targets.delete(object);
    }
    for (const object of next) {
      if (!object?.isObject3D || this.targets.has(object)) continue;
      this.targets.set(object, { baseVisible: object.visible, culled: false });
    }
  }

  syncRuntimeIndex(runtimeIndex) {
    if (!runtimeIndex) return false;
    if (this.runtimeIndex === runtimeIndex && this.runtimeRevision === runtimeIndex.renderRevision) return false;
    this.runtimeIndex = runtimeIndex;
    this.runtimeRevision = runtimeIndex.renderRevision;
    this.setTargets(new Set(
      [...runtimeIndex.partToRender.values()].map(ref => ref?.object).filter(Boolean),
    ));
    return true;
  }

  update(camera, maxDistance) {
    const limit = Number(maxDistance);
    if (!camera?.position || !Number.isFinite(limit) || limit <= 0) {
      this._restoreAll();
      return { tested: 0, culled: 0 };
    }

    camera.updateWorldMatrix?.(true, false);
    camera.getWorldPosition(_cameraPosition);
    let tested = 0;
    let culled = 0;
    for (const [object, state] of this.targets) {
      if (!state.culled) state.baseVisible = object.visible;
      if (!state.baseVisible) continue;
      const sphere = localBoundingSphere(object);
      if (!sphere || sphere.isEmpty()) continue;
      object.updateWorldMatrix?.(true, false);
      _worldSphere.copy(sphere).applyMatrix4(object.matrixWorld);
      const surfaceDistance = Math.max(0, _cameraPosition.distanceTo(_worldSphere.center) - _worldSphere.radius);
      const threshold = state.culled ? limit * (1 - this.hysteresis) : limit;
      const shouldCull = surfaceDistance > threshold;
      object.visible = shouldCull ? false : state.baseVisible;
      state.culled = shouldCull;
      tested++;
      if (shouldCull) culled++;
    }
    return { tested, culled };
  }

  dispose() {
    this._restoreAll();
    this.targets.clear();
    this.runtimeIndex = null;
    this.runtimeRevision = -1;
  }

  _restoreAll() {
    for (const [object, state] of this.targets) {
      if (state.culled) object.visible = state.baseVisible;
      state.culled = false;
    }
  }
}

export default ObjectDistanceCuller;
