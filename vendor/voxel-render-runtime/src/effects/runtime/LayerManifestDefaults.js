import {
  STAGE_TO_SLOT,
  hashStable,
} from './EffectRuntimeTypes.js';
import {
  CORE_LAYER_MANIFESTS,
} from '../coreLayers.manifest.js';

function defaultsFromParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params || {}).map(([key, schema]) => [key, Array.isArray(schema.default) ? [...schema.default] : schema.default])
  );
}

function projectLayerManifest(manifest, overrides = {}) {
  const route = overrides.route || manifest.route || 'shaderPatch';
  const slot = overrides.slot || manifest.slot || STAGE_TO_SLOT[manifest.stage] || 'surfaceDetail';
  const defaultBatchPolicy = overrides.defaultBatchPolicy
    || manifest.batchPolicy
    || (route === 'shaderPatch' ? 'effectBatchable' : 'standalonePreferred');
  return {
    id: manifest.id,
    slot,
    route,
    scope: overrides.scope || manifest.scope || 'object',
    defaultBatchPolicy,
    defaultParams: defaultsFromParams(manifest.params),
    getEffectBatchKey: manifest.getEffectBatchKey || function getEffectBatchKey(params = {}) {
      return `${manifest.id}|${hashStable(params)}`;
    },
    ...(manifest.crossSlotIncompatible ? { crossSlotIncompatible: [...manifest.crossSlotIncompatible] } : {}),
    ...overrides,
  };
}

export const DEFAULT_LAYER_MANIFESTS = Object.freeze({
  ...Object.fromEntries(CORE_LAYER_MANIFESTS.map(manifest => [manifest.id, projectLayerManifest(manifest)])),
});

export function mergeLayerManifests(layerManifests = {}) {
  return { ...DEFAULT_LAYER_MANIFESTS, ...(layerManifests || {}) };
}
