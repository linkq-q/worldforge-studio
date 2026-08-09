import { mergeLayerManifests } from './LayerManifestDefaults.js';
import { makeLayerId, isPlainObject } from './EffectRuntimeTypes.js';

function normalizeLayer(layer, index, layerManifests, layerParams = {}) {
  if (typeof layer === 'string') {
    const manifest = layerManifests[layer] || {};
    return {
      id: makeLayerId(layer, index),
      slot: manifest.slot || 'surfaceDetail',
      type: layer,
      route: manifest.route || 'shaderPatch',
      scope: manifest.scope || 'object',
      enabled: true,
      batchPolicy: manifest.defaultBatchPolicy,
      params: {
        ...(manifest.defaultParams || {}),
        ...(isPlainObject(layerParams[layer]) ? layerParams[layer] : {}),
      },
    };
  }

  if (!isPlainObject(layer)) {
    throw new Error(`materialLayers[${index}] must be a string or object`);
  }

  const type = layer.type || layer.id;
  if (!type) throw new Error(`materialLayers[${index}] missing type`);
  const manifest = layerManifests[type] || {};
  return {
    id: layer.id || makeLayerId(type, index),
    slot: layer.slot || manifest.slot || 'surfaceDetail',
    type,
    route: layer.route || manifest.route || 'shaderPatch',
    scope: layer.scope || manifest.scope || 'object',
    enabled: layer.enabled !== false,
    batchPolicy: layer.batchPolicy || manifest.defaultBatchPolicy,
    params: {
      ...(manifest.defaultParams || {}),
      ...(isPlainObject(layer.params) ? layer.params : {}),
    },
  };
}

export function adaptEffectPackageToV2(effectPackage, options = {}) {
  if (!isPlainObject(effectPackage)) {
    throw new Error('effect package must be an object');
  }

  const layerManifests = mergeLayerManifests(options.layerManifests);
  const materialLayers = Array.isArray(effectPackage.materialLayers)
    ? effectPackage.materialLayers
    : [];
  const companionEffects = Array.isArray(effectPackage.companionEffects)
    ? effectPackage.companionEffects
    : [];

  return {
    ...effectPackage,
    schemaVersion: 'v2',
    targetPolicy: {
      defaultScope: 'object',
      isolateBeforeApply: true,
      ...(isPlainObject(effectPackage.targetPolicy) ? effectPackage.targetPolicy : {}),
    },
    materialLayers: materialLayers.map((layer, index) => (
      normalizeLayer(layer, index, layerManifests, effectPackage.layerParams || {})
    )),
    companionEffects: companionEffects.map((effect, index) => {
      if (typeof effect === 'string') {
        return {
          id: makeLayerId(effect, index),
          type: effect,
          route: 'companion',
          scope: 'object',
          enabled: true,
          params: {},
        };
      }
      if (!isPlainObject(effect)) throw new Error(`companionEffects[${index}] must be a string or object`);
      return {
        route: 'companion',
        scope: 'object',
        enabled: true,
        params: {},
        ...effect,
      };
    }),
  };
}
