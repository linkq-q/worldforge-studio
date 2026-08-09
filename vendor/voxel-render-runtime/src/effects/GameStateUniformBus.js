const DEFAULT_STATE = Object.freeze({
  uHitFlash: 0,
  uChargeLevel: 0,
  uDamageLevel: 0,
  uFireCooldown: 0,
  uRarityLevel: 0,
  uTeamColor: Object.freeze([1, 1, 1]),
});

const SCALAR_KEYS = Object.freeze([
  'uHitFlash',
  'uChargeLevel',
  'uDamageLevel',
  'uFireCooldown',
  'uRarityLevel',
]);

const DEFAULT_HIT_DECAY = 5;

function isObjectKey(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function createState() {
  return {
    ...DEFAULT_STATE,
    uTeamColor: DEFAULT_STATE.uTeamColor.slice(),
  };
}

function copyTeamColor(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const color = value.slice(0, 3);
  return color.every(Number.isFinite) ? color : null;
}

export class GameStateUniformBus {
  constructor({ effectRuntime } = {}) {
    this.effectRuntime = effectRuntime ?? null;
    this._states = new WeakMap();
    this._hitDecays = new WeakMap();
    this._activeObjects = new Set();
    this._boundObjects = new WeakSet();
    this._boundCount = 0;
    this._triggers = 0;
    this._updates = 0;
    this._uniformWrites = 0;
  }

  ensureState(object) {
    if (!isObjectKey(object)) return null;
    let state = this._states.get(object);
    if (!state) {
      state = createState();
      this._states.set(object, state);
    }
    return state;
  }

  getState(object) {
    if (!isObjectKey(object)) return null;
    return this._states.get(object) ?? null;
  }

  setState(object, patch) {
    if (!isObjectKey(object) || !patch || typeof patch !== 'object') return null;

    const state = this.ensureState(object);
    const accepted = {};
    for (const key of SCALAR_KEYS) {
      if (Object.hasOwn(patch, key) && Number.isFinite(patch[key])) {
        state[key] = patch[key];
        accepted[key] = patch[key];
      }
    }

    if (Object.hasOwn(patch, 'uTeamColor')) {
      const color = copyTeamColor(patch.uTeamColor);
      if (color) {
        state.uTeamColor = color;
        accepted.uTeamColor = color.slice();
      }
    }

    if (Object.hasOwn(accepted, 'uHitFlash')) {
      if (state.uHitFlash > 0) {
        if (!(this._hitDecays.get(object) > 0)) this._hitDecays.set(object, DEFAULT_HIT_DECAY);
        this._activeObjects.add(object);
      } else {
        this._activeObjects.delete(object);
        this._hitDecays.delete(object);
      }
    }

    if (Object.keys(accepted).length > 0) this._write(object, accepted);
    return state;
  }

  triggerHit(object, options = {}) {
    const normalizedOptions = options && typeof options === 'object' ? options : {};
    const { amount = 1.0, decay = 5.0 } = normalizedOptions;
    if (!isObjectKey(object) || !Number.isFinite(amount) || amount <= 0
      || !Number.isFinite(decay) || decay <= 0) return 0;

    const state = this.ensureState(object);
    state.uHitFlash = Math.max(state.uHitFlash, amount);
    this._hitDecays.set(object, decay);
    this._activeObjects.add(object);
    this._triggers++;
    return this._write(object, { uHitFlash: state.uHitFlash });
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) return 0;
    this._updates++;

    let writes = 0;
    for (const object of this._activeObjects) {
      const state = this._states.get(object);
      const decay = this._hitDecays.get(object);
      if (!state || !(decay > 0) || !(state.uHitFlash > 0)) {
        this._activeObjects.delete(object);
        this._hitDecays.delete(object);
        continue;
      }

      state.uHitFlash = Math.max(0, state.uHitFlash - decay * dt);
      const reachedZero = state.uHitFlash === 0;
      try {
        writes += this._write(object, { uHitFlash: state.uHitFlash });
      } finally {
        if (reachedZero) {
          this._activeObjects.delete(object);
          this._hitDecays.delete(object);
        }
      }
    }
    return writes;
  }

  bindObject(object) {
    if (!isObjectKey(object)) return null;
    this.ensureState(object);
    if (!this._boundObjects.has(object)) {
      this._boundObjects.add(object);
      this._boundCount++;
    }
    return object;
  }

  unbindObject(object) {
    if (!isObjectKey(object)) return false;
    const wasBound = this._boundObjects.has(object);
    const state = this._states.get(object);
    const wasActive = this._activeObjects.has(object);
    if (!wasBound && !state && !wasActive) return false;

    if (wasBound) {
      this._boundObjects.delete(object);
      this._boundCount--;
    }
    try {
      if (state && state.uHitFlash !== 0) {
        state.uHitFlash = 0;
        this._write(object, { uHitFlash: 0 });
      }
    } finally {
      this._activeObjects.delete(object);
      this._hitDecays.delete(object);
      this._states.delete(object);
    }
    return true;
  }

  applyToObject(object) {
    const state = this.getState(object);
    if (!state) return 0;
    return this._write(object, state);
  }

  applyToRoot(root) {
    return this.applyToObject(root);
  }

  stats() {
    return {
      boundObjects: this._boundCount,
      activeObjects: this._activeObjects.size,
      triggers: this._triggers,
      updates: this._updates,
      uniformWrites: this._uniformWrites,
    };
  }

  clear() {
    let firstError = null;
    try {
      for (const object of this._activeObjects) {
        const state = this._states.get(object);
        if (state) state.uHitFlash = 0;
        try {
          this._write(object, { uHitFlash: 0 });
        } catch (error) {
          if (!firstError) firstError = error;
        }
      }
    } finally {
      this._activeObjects.clear();
      this._states = new WeakMap();
      this._hitDecays = new WeakMap();
      this._boundObjects = new WeakSet();
      this._boundCount = 0;
    }
    if (firstError) throw firstError;
  }

  _write(object, patch) {
    if (!object || typeof this.effectRuntime?.updateRuntimeUniforms !== 'function') return 0;
    const writes = this.effectRuntime.updateRuntimeUniforms(object, patch);
    const count = Number.isFinite(writes) && writes > 0 ? writes : 0;
    this._uniformWrites += count;
    return count;
  }
}
