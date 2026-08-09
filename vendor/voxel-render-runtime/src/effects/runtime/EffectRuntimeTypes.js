export const SLOT_ENUM = Object.freeze([
  'baseShading',
  'surfaceDetail',
  'colorMod',
  'emissive',
  'runtimeFeedback',
  'finalStylization',
]);

export const ROUTE_ENUM = Object.freeze([
  'shaderPatch',
  'materialOverride',
  'postProcess',
  'mask',
  'companion',
  'event',
  'normal',
]);

export const SCOPE_ENUM = Object.freeze([
  'object',
  'scene',
  'screen',
  'weapon',
  'hitEvent',
  'ground',
]);

export const BATCH_POLICY_ENUM = Object.freeze([
  'effectBatchable',
  'standaloneOnly',
  'standalonePreferred',
  'notMaterialRelated',
]);

export const ATTACH_TARGET_ENUM = Object.freeze([
  'object',
  'weapon',
  'hitPoint',
  'ground',
  'betweenObjects',
]);

export const ATTACH_ANCHOR_ENUM = Object.freeze([
  'center',
  'tip',
  'bottom',
  'surface',
  'customSocket',
]);

export const LIFECYCLE_MODE_ENUM = Object.freeze([
  'persistent',
  'duration',
  'eventOnce',
  'whileCharging',
  'whileEquipped',
]);

export const SLOT_TO_STAGE = Object.freeze({
  baseShading: 'base',
  surfaceDetail: 'surface',
  colorMod: 'color',
  emissive: 'emissive',
  runtimeFeedback: 'feedback',
  finalStylization: 'stylization',
});

export const STAGE_TO_SLOT = Object.freeze({
  base: 'baseShading',
  surface: 'surfaceDetail',
  color: 'colorMod',
  emissive: 'emissive',
  feedback: 'runtimeFeedback',
  stylization: 'finalStylization',
});

export const SLOT_ORDER = Object.freeze([...SLOT_ENUM]);

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function hashStable(value) {
  return stableStringify(value);
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function makeLayerId(type, index = 0) {
  return `${type}_${String(index + 1).padStart(3, '0')}`;
}
