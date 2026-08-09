import { adaptEffectPackageToV2 } from './LegacyPackageAdapter.js';
import { MaterialLayerResolver } from './MaterialLayerResolver.js';
import { BatchIsolationService } from './BatchIsolationService.js';
import { MaterialOverrideSystem } from './MaterialOverrideSystem.js';
import { BatchReclassifier } from './BatchReclassifier.js';
import { EffectBatchCoordinator } from './EffectBatchCoordinator.js';
import { markBloomObjects } from '../../RenderLayers.js';

function targetObject(target) {
  return target?.object || target?.mesh || (target?.isObject3D || target?.isMesh ? target : null);
}

function targetPartId(target) {
  if (typeof target === 'string') return target;
  return target?.partId || target?.nodeId || target?.userData?.nodeId || target?.userData?.partId || null;
}

function appendEffectSlots(target, layers) {
  if (!target?.userData) return;
  const previous = Array.isArray(target.userData.effectSlots) ? target.userData.effectSlots : [];
  const incomingIds = new Set(layers.map(layer => layer.id));
  target.userData.effectSlots = [
    ...previous.filter(layer => !incomingIds.has(layer.id)),
    ...layers.map(layer => ({
      id: layer.id,
      type: layer.type,
      slot: layer.slot,
      route: layer.route,
      scope: layer.scope,
      batchPolicy: layer.batchPolicy,
      params: { ...(layer.params || {}) },
    })),
  ];
}

function visitEffectTargets(target, callback) {
  if (!target) return 0;
  let count = 0;
  if (target.isMesh && !target.isInstancedMesh) {
    callback(target);
    return 1;
  }
  if (typeof target.traverse === 'function') {
    target.traverse((object) => {
      if (!object.isMesh || object.isInstancedMesh) return;
      callback(object);
      count++;
    });
  }
  return count;
}

function clearEffectMaterialMetadata(material) {
  if (!material?.userData) return;
  delete material.userData.effectMaterialType;
  delete material.userData.effectLayerId;
  delete material.userData.effectLayers;
  delete material.userData.effectVariant;
  delete material.userData.glassParams;
  delete material.userData.inkSurfaceParams;
  delete material.userData.whiteStrokeParams;
  delete material.userData.effectNotes;
}

export class EffectSlotManager {
  constructor(options = {}) {
    this.resolver = options.resolver || new MaterialLayerResolver(options);
    this.isolationService = options.isolationService || new BatchIsolationService({
      ...options,
      sceneManager: options.sceneManager || null,
    });
    this.materialOverrideSystem = options.materialOverrideSystem || new MaterialOverrideSystem(options);
    this.shaderPatchSystem = options.shaderPatchSystem || null;
    this.inkEdgeSystem = options.inkEdgeSystem || null;
    this.reclassifier = options.reclassifier || new BatchReclassifier(options);
    this.effectBatchCoordinator = options.effectBatchCoordinator === null
      ? null
      : (options.effectBatchCoordinator || new EffectBatchCoordinator(options));
    this.logger = options.logger || null;
  }

  applyPackage(target, effectPackage, runtimeContext = {}) {
    const v2Package = adaptEffectPackageToV2(effectPackage, runtimeContext);
    const plan = this.resolver.resolve(v2Package);
    this._log(
      `[EffectSlot] applyPackage target=${targetPartId(target) || target?.name || '(object)'} ` +
      `layers=${plan.layers.length} companions=${plan.companionEffects.length} package=${v2Package.schemaVersion}`
    );

    let activeTarget = targetObject(target) || target;
    const shouldIsolate = v2Package.targetPolicy?.isolateBeforeApply !== false
      && plan.layers.some(layer => layer.scope === 'object' && layer.route !== 'postProcess');
    let isolation = { isolated: false, mesh: activeTarget, reason: 'not-needed' };
    if (shouldIsolate) {
      isolation = this.isolationService.ensureStandalone(target, runtimeContext);
      if (isolation.mesh) activeTarget = isolation.mesh;
    }

    for (const layer of plan.layers) {
      this._log(`[EffectResolve] route=${layer.route} layer=${layer.type} slot=${layer.slot}`);
    }

    let materialOverride = { applied: 0 };
    if (plan.materialOverrideLayers.length > 0) {
      materialOverride = this.materialOverrideSystem.apply(activeTarget, plan.materialOverrideLayers, runtimeContext);
    }

    let shaderPatch = { applied: 0 };
    if (plan.shaderPatchLayers.length > 0) {
      if (this.shaderPatchSystem?.apply) {
        shaderPatch = this.shaderPatchSystem.apply(activeTarget, plan.shaderPatchLayers, runtimeContext) || shaderPatch;
      } else if (runtimeContext.runtime?.applyToObject3D) {
        const legacyPackage = {
          schemaVersion: '1.0',
          materialLayers: plan.shaderPatchLayers.map(layer => layer.type),
          layerParams: Object.fromEntries(plan.shaderPatchLayers.map(layer => [layer.type, layer.params || {}])),
        };
        shaderPatch = runtimeContext.runtime.applyToObject3D(activeTarget, legacyPackage);
      }
    }

    const needsBloom = plan.layers.some(layer => layer.type === 'Flame' || layer.type === 'EmissivePulse');
    if (needsBloom) {
      visitEffectTargets(activeTarget, (mesh) => { mesh.userData.effectForceBloom = true; });
      markBloomObjects(activeTarget);
    }

    const localInkEdgeLayers = plan.layers.filter(layer => (
      layer.type === 'WhiteStroke' && layer.params?.useLocalInkMask === true
    ));
    const inkEdge = localInkEdgeLayers.length > 0 && this.inkEdgeSystem?.applyLocalMask
      ? this.inkEdgeSystem.applyLocalMask(activeTarget, localInkEdgeLayers, runtimeContext) || { registered: 0 }
      : { registered: 0 };

    appendEffectSlots(activeTarget, plan.layers);
    const batchDecision = this.reclassifier.classify({
      target: activeTarget,
      layers: plan.layers,
      geometryFamily: runtimeContext.geometryFamily,
    });
    let effectBatch = { action: 'disabled' };
    if (this.effectBatchCoordinator?.consume) {
      try {
        effectBatch = this.effectBatchCoordinator.consume({
          target: activeTarget,
          layers: plan.layers,
          batchDecision,
          geometryFamily: runtimeContext.geometryFamily,
        }) || effectBatch;
      } catch (error) {
        effectBatch = { action: 'error', error };
        this._log(`[EffectBatchCoordinator] failed: ${error?.message || error}`);
      }
    }

    const companionEffects = plan.companionEffects;
    return {
      ok: true,
      target: activeTarget,
      package: v2Package,
      plan,
      isolation,
      materialOverride,
      shaderPatch,
      inkEdge,
      companionEffects,
      batchDecision,
      effectBatch,
    };
  }

  removeEffect(target, effectId) {
    const object = targetObject(target) || target;
    if (!object?.userData || !Array.isArray(object.userData.effectSlots)) return 0;
    const before = object.userData.effectSlots.length;
    object.userData.effectSlots = object.userData.effectSlots.filter(effect => effect.id !== effectId);
    return before - object.userData.effectSlots.length;
  }

  updateEffect(target, effectId, params) {
    const object = targetObject(target) || target;
    const slot = object?.userData?.effectSlots?.find(effect => effect.id === effectId);
    if (!slot) return false;
    slot.params = { ...(slot.params || {}), ...(params || {}) };
    return true;
  }

  updateRuntimeParam(target, effectId, paramName, value) {
    const slotUpdated = this.updateEffect(target, effectId, { [paramName]: value });
    const object = targetObject(target) || target;
    const materialUpdated = this.materialOverrideSystem?.updateRuntimeParam
      ? this.materialOverrideSystem.updateRuntimeParam(object, effectId, paramName, value) > 0
      : false;
    return slotUpdated || materialUpdated;
  }

  clearEffects(target, options = {}) {
    const object = targetObject(target) || target;
    const effects = object?.userData?.effectSlots || [];
    const removedLayers = effects.length;
    let removedInkEdgeMasks = 0;
    if (options.clearCompanionEffects !== false && this.inkEdgeSystem?.clearLocalMask) {
      removedInkEdgeMasks = this.inkEdgeSystem.clearLocalMask(object, options) || 0;
    }
    if (options.restoreOriginalMaterial !== false) {
      visitEffectTargets(object, (mesh) => {
        delete mesh.userData?.effectForceBloom;
        const currentMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of currentMaterials) clearEffectMaterialMetadata(material);
        if (mesh.userData?.effectOriginalMaterial) {
          mesh.material = mesh.userData.effectOriginalMaterial;
          delete mesh.userData.effectOriginalMaterial;
        }
        if (mesh.userData && 'effectOriginalRenderOrder' in mesh.userData) {
          mesh.renderOrder = mesh.userData.effectOriginalRenderOrder;
          delete mesh.userData.effectOriginalRenderOrder;
        }
        // Restore bevel-replaced geometry
        this.materialOverrideSystem?._restoreBevelGeometry?.(mesh);
        if (mesh.userData) {
          delete mesh.userData.effectMaterial;
          delete mesh.userData.effectPackage;
          delete mesh.userData.effectLayerPackage;
        }
      });
      markBloomObjects(object);
    }
    if (object?.userData) {
      object.userData.effectSlots = [];
      delete object.userData.effectMaterial;
      delete object.userData.effectPackage;
      delete object.userData.effectLayerPackage;
    }
    const result = {
      removedLayers,
      removedCompanions: 0,
      removedInkEdgeMasks,
      restoredMaterial: options.restoreOriginalMaterial !== false,
      allowRebatch: options.allowRebatch === true,
    };
    this._log(
      `[EffectSlot] clearEffects target=${targetPartId(target) || object?.name || '(object)'} ` +
      `removedLayers=${removedLayers} restoreOriginalMaterial=${result.restoredMaterial}`
    );
    return result;
  }

  getEffects(target) {
    const object = targetObject(target) || target;
    return [...(object?.userData?.effectSlots || [])];
  }

  _log(message) {
    if (this.logger?.enabled && Array.isArray(this.logger.entries)) this.logger.entries.push(message);
    if (this.logger?.enabled && this.logger.console === true) console.log(message);
  }
}
