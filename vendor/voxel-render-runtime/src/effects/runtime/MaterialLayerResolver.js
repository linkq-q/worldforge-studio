import { mergeLayerManifests } from './LayerManifestDefaults.js';
import {
  BATCH_POLICY_ENUM,
  ROUTE_ENUM,
  SCOPE_ENUM,
  SLOT_ENUM,
  SLOT_ORDER,
  isPlainObject,
} from './EffectRuntimeTypes.js';

export const SLOT_RULES = Object.freeze({
  baseShading: { maxInstances: 1, composition: 'replace' },
  surfaceDetail: { maxInstances: 3, composition: 'stack' },
  colorMod: { maxInstances: 3, composition: 'stack' },
  emissive: { maxInstances: 3, composition: 'additive', clamps: { intensity: [0, 3] } },
  runtimeFeedback: { maxInstances: 3, composition: 'stack' },
  finalStylization: { maxInstances: 1, composition: 'replace' },
});

const SLOT_SET = new Set(SLOT_ENUM);
const ROUTE_SET = new Set(ROUTE_ENUM);
const SCOPE_SET = new Set(SCOPE_ENUM);
const POLICY_SET = new Set(BATCH_POLICY_ENUM);

function routeBucketName(route) {
  return `${route}Layers`;
}

function clampLayerParams(layer, rule) {
  if (!rule?.clamps || !isPlainObject(layer.params)) return layer;
  const params = { ...layer.params };
  for (const [name, [min, max]] of Object.entries(rule.clamps)) {
    if (typeof params[name] === 'number') {
      params[name] = Math.max(min, Math.min(max, params[name]));
    }
  }
  return { ...layer, params };
}

export class MaterialLayerResolver {
  constructor(options = {}) {
    this.layerManifests = mergeLayerManifests(options.layerManifests);
    this.slotRules = options.slotRules || SLOT_RULES;
  }

  resolve(effectPackage) {
    const inputLayers = Array.isArray(effectPackage?.materialLayers)
      ? effectPackage.materialLayers
      : [];
    const layers = inputLayers
      .filter(layer => layer && layer.enabled !== false)
      .map((layer, index) => this._normalizeLayer(layer, index));

    const bySlot = new Map();
    for (const layer of layers) {
      const list = bySlot.get(layer.slot) || [];
      list.push(layer);
      bySlot.set(layer.slot, list);
      const rule = this.slotRules[layer.slot];
      if (rule?.maxInstances && list.length > rule.maxInstances) {
        throw new Error(`slot ${layer.slot} exceeds maxInstances=${rule.maxInstances}`);
      }
    }

    this._checkCrossSlotCompatibility(layers);

    const sorted = layers
      .map((layer, index) => ({ layer: clampLayerParams(layer, this.slotRules[layer.slot]), index }))
      .sort((a, b) => {
        const slotDiff = SLOT_ORDER.indexOf(a.layer.slot) - SLOT_ORDER.indexOf(b.layer.slot);
        return slotDiff || (a.index - b.index);
      })
      .map(entry => entry.layer);

    const plan = {
      layers: sorted,
      shaderPatchLayers: [],
      materialOverrideLayers: [],
      postProcessLayers: [],
      maskLayers: [],
      companionLayers: [],
      eventLayers: [],
      normalLayers: [],
      companionEffects: Array.isArray(effectPackage?.companionEffects)
        ? effectPackage.companionEffects.filter(effect => effect && effect.enabled !== false)
        : [],
    };

    for (const layer of sorted) {
      const bucket = routeBucketName(layer.route);
      if (!Array.isArray(plan[bucket])) plan[bucket] = [];
      plan[bucket].push(layer);
    }
    return plan;
  }

  _normalizeLayer(layer, index) {
    if (!isPlainObject(layer)) throw new Error(`material layer ${index} must be an object`);
    const type = layer.type || layer.id;
    const manifest = this.layerManifests[type] || {};
    const slot = layer.slot || manifest.slot;
    const route = layer.route || manifest.route;
    const scope = layer.scope || manifest.scope || 'object';
    const batchPolicy = layer.batchPolicy || manifest.defaultBatchPolicy || 'standalonePreferred';

    if (!type) throw new Error(`material layer ${index} missing type`);
    if (!SLOT_SET.has(slot)) throw new Error(`layer ${type} has invalid slot ${slot}`);
    if (!ROUTE_SET.has(route)) throw new Error(`layer ${type} has invalid route ${route}`);
    if (!SCOPE_SET.has(scope)) throw new Error(`layer ${type} has invalid scope ${scope}`);
    if (!POLICY_SET.has(batchPolicy)) throw new Error(`layer ${type} has invalid batchPolicy ${batchPolicy}`);

    return {
      ...layer,
      id: layer.id || `${type}_${index + 1}`,
      type,
      slot,
      route,
      scope,
      batchPolicy,
      params: { ...(manifest.defaultParams || {}), ...(layer.params || {}) },
      manifest,
    };
  }

  _checkCrossSlotCompatibility(layers) {
    const activeTypes = new Set(layers.map(layer => layer.type));
    for (const layer of layers) {
      const incompatible = [
        ...(layer.crossSlotIncompatible || []),
        ...(layer.manifest?.crossSlotIncompatible || []),
      ];
      for (const other of incompatible) {
        if (activeTypes.has(other)) {
          throw new Error(`cross-slot incompatible layers: ${layer.type} x ${other}`);
        }
      }
    }
  }
}
