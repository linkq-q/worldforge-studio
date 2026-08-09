import { FresnelRim } from '../coreLayers.manifest.js';
import { Glass, Petrify, WhiteStroke } from '../overrideLayers.manifest.js';

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function legacyDefinitionFromManifest(manifest, { id, label = manifest.displayName } = {}) {
  return Object.freeze({
    id: id || manifest.id,
    label,
    category: 'material',
    applyPolicy: { material: 'replace-stack', companion: 'none', clearBeforeApply: true },
    params: clone(manifest.params || {}),
    forbidden: clone(manifest.forbidden || []),
    notes: [
      ...(manifest.notes || []),
      'Derived from unified effect layer manifest. Do not hand-edit defaultDefinitions directly.',
    ],
  });
}

export const GLASS_EFFECT_DEFINITION = legacyDefinitionFromManifest(Glass, { id: 'glass' });
export const PETRIFY_EFFECT_DEFINITION = legacyDefinitionFromManifest(Petrify, { id: 'petrify' });
export const INK_EDGE_EFFECT_DEFINITION = legacyDefinitionFromManifest(WhiteStroke, { id: 'ink_edge', label: 'Ink Edge' });
export const FRESNEL_RIM_EFFECT_DEFINITION = legacyDefinitionFromManifest(FresnelRim, { id: 'fresnel_rim' });

export const DEFAULT_EFFECT_DEFINITIONS = Object.freeze([
  GLASS_EFFECT_DEFINITION,
  PETRIFY_EFFECT_DEFINITION,
  INK_EDGE_EFFECT_DEFINITION,
  FRESNEL_RIM_EFFECT_DEFINITION,
]);

export default DEFAULT_EFFECT_DEFINITIONS;
