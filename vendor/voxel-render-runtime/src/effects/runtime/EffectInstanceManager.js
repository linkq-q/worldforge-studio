function targetObject(target) {
  return target?.object || target?.mesh || (target?.isObject3D || target?.isMesh ? target : null);
}

function targetId(target, object) {
  return target?.targetId || target?.partId || target?.nodeId || object?.userData?.nodeId || object?.userData?.sceneModelId || object?.name || '(object)';
}

function materialLayers(effectPackage) {
  return Array.isArray(effectPackage?.materialLayers) ? effectPackage.materialLayers : [];
}

function layerId(layer, index) {
  return layer?.id || layer?.type || `layer_${index + 1}`;
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

export class EffectInstanceManager {
  constructor(options = {}) {
    this.effectSlotManager = options.effectSlotManager || null;
    this.registry = options.registry || null;
    this.logger = options.logger || null;
    this._states = new WeakMap();
  }

  apply(target, effectPackage, options = {}) {
    const object = targetObject(target) || target;
    if (!object) return { ok: false, reason: 'no-target' };
    const policy = {
      material: 'replace-stack',
      companion: 'replace-same-slot',
      clearBeforeApply: true,
      ...(effectPackage?.applyPolicy || {}),
      ...(options.applyPolicy || {}),
    };
    const layers = materialLayers(effectPackage);
    const hasMaterial = layers.length > 0;
    if (hasMaterial && policy.clearBeforeApply !== false && policy.material === 'replace-stack') {
      this.clearMaterialStack(target, { restoreOriginalMaterial: true, source: options.source || 'effectInstanceManager' });
    }

    const result = this.effectSlotManager?.applyPackage
      ? this.effectSlotManager.applyPackage(target, effectPackage, options)
      : { ok: false, reason: 'no-effect-slot-manager' };
    if (result?.ok !== false) {
      this._states.set(object, {
        targetId: targetId(target, object),
        object,
        sourceTarget: target,
        materialStack: hasMaterial ? {
          effectId: effectPackage.effectId || effectPackage.id || layers[0]?.type || 'material',
          package: clone(effectPackage),
          appliedAt: Date.now(),
        } : null,
        companionSlots: {},
        layerIds: layers.map(layerId),
        params: this._extractParams(effectPackage),
      });
    }
    return result;
  }

  clearMaterialStack(target, options = {}) {
    const object = targetObject(target) || target;
    if (!this.effectSlotManager?.clearEffects) return { removedLayers: 0 };
    const result = this.effectSlotManager.clearEffects(target, {
      clearMaterialLayers: true,
      clearCompanionEffects: false,
      restoreOriginalMaterial: options.restoreOriginalMaterial !== false,
      source: options.source || 'effectInstanceManager',
    });
    if (object) this._states.delete(object);
    return result;
  }

  clearCompanionSlot(target, slot) {
    const object = targetObject(target) || target;
    const state = object ? this._states.get(object) : null;
    if (!state?.companionSlots) return false;
    delete state.companionSlots[slot];
    return true;
  }

  clearAll(target, options = {}) {
    const object = targetObject(target) || target;
    const result = this.effectSlotManager?.clearEffects
      ? this.effectSlotManager.clearEffects(target, {
          clearMaterialLayers: true,
          clearCompanionEffects: true,
          restoreOriginalMaterial: options.restoreOriginalMaterial !== false,
          source: options.source || 'effectInstanceManager',
        })
      : { removedLayers: 0 };
    if (object) this._states.delete(object);
    return result;
  }

  getInstance(target) {
    const object = targetObject(target) || target;
    const state = object ? this._states.get(object) : null;
    return state ? {
      targetId: state.targetId,
      object: state.object,
      sourceTarget: state.sourceTarget,
      materialStack: state.materialStack ? {
        ...state.materialStack,
        package: clone(state.materialStack.package),
      } : null,
      companionSlots: clone(state.companionSlots || {}),
      layerIds: [...(state.layerIds || [])],
      params: clone(state.params || {}),
    } : null;
  }

  updateParams(target, params = {}) {
    const object = targetObject(target) || target;
    const state = object ? this._states.get(object) : null;
    if (!state) return { updated: 0, reason: 'no-active-effect' };
    let updated = 0;
    for (const id of state.layerIds || []) {
      for (const [name, value] of Object.entries(params)) {
        if (this.effectSlotManager?.updateRuntimeParam?.(state.sourceTarget || target, id, name, value)) updated++;
      }
    }
    state.params = { ...(state.params || {}), ...clone(params) };
    if (state.materialStack?.package) {
      state.materialStack.package = this._mergePackageParams(state.materialStack.package, params);
    }
    this._states.set(object, state);
    return { updated };
  }

  exportPreset(target) {
    const object = targetObject(target) || target;
    const state = object ? this._states.get(object) : null;
    if (!state?.materialStack) return null;
    const effectId = state.materialStack.effectId;
    if (this.registry?.exportPreset) return this.registry.exportPreset(effectId, state.params);
    return { type: 'effectPreset', effectId, params: clone(state.params || {}) };
  }

  exportConstraint(effectId) {
    return this.registry?.exportConstraint ? this.registry.exportConstraint(effectId) : null;
  }

  _extractParams(effectPackage) {
    const params = { ...(effectPackage?.params || {}) };
    for (const layer of materialLayers(effectPackage)) Object.assign(params, layer?.params || {});
    return clone(params);
  }

  _mergePackageParams(effectPackage, params = {}) {
    const next = clone(effectPackage);
    next.params = { ...(next.params || {}), ...clone(params) };
    if (Array.isArray(next.materialLayers)) {
      next.materialLayers = next.materialLayers.map(layer => ({
        ...layer,
        params: { ...(layer?.params || {}), ...clone(params) },
      }));
    }
    return next;
  }
}

export default EffectInstanceManager;
