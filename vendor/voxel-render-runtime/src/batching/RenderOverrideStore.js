const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function normalizeReason(reason) {
  if (typeof reason !== 'string') return 'material';
  const normalized = reason.trim();
  return normalized || 'material';
}

function defineEnumerable(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function splitGlobalPartId(globalPartId) {
  if (typeof globalPartId !== 'string') return null;
  const separator = globalPartId.indexOf(':');
  if (separator <= 0 || separator === globalPartId.length - 1) return null;
  return {
    modelId: globalPartId.slice(0, separator),
    partId: globalPartId.slice(separator + 1),
  };
}

// Returns an extraction reason ONLY for material changes that genuinely need an
// INDEPENDENT (isolated/cloned) material — i.e. ones that can't live on a shared
// InstancedMesh batch material, or need per-part identity (bloom). Plain PBR scalars
// (roughness / metalness / emissiveIntensity / rimLightStrength), plain color, and
// shader uniforms are NOT extraction reasons: they apply in place and must never
// pull a part out of its batch or clone its material. (Regression fix: the old
// over-eager classification cloned every part's default PBR override at load.)
export function classifyMaterialOverride(override) {
  if (!override || typeof override !== 'object') return null;

  if (hasOwn(override, 'shader') || hasOwn(override, 'shaderPackage')
      || hasOwn(override, 'shaderCategory') || override.type === 'shader') {
    return 'shader';
  }
  if (hasOwn(override, 'effectLayer')) return 'effectLayer';
  if (hasOwn(override, 'materialLayers')) return 'materialLayers';
  if (hasOwn(override, 'matcap')) return 'matcap';
  if (override.glass === true || (typeof override.transmission === 'number' && override.transmission > 0)) return 'glass';
  if (override.transparent === true) return 'transparent';
  if (typeof override.opacity === 'number' && override.opacity < 1) return 'opacity';
  if (typeof override.alphaTest === 'number' && override.alphaTest > 0) return 'alphaTest';
  // emissive COLOR needs an independent material (selective bloom); emissiveIntensity
  // ALONE is a scalar and does NOT extract.
  if (hasOwn(override, 'emissive')) return 'emissive';

  for (const key of ['texture', 'textures', 'map', 'alphaMap', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
    if (hasOwn(override, key)) return 'texture';
  }
  return null;
}

export class RenderOverrideStore {
  constructor(initialState = {}) {
    this._state = new Map();
    this.importState(initialState);
  }

  importState(state = {}) {
    this._state = new Map();
    if (!state || typeof state !== 'object') return this.exportState();

    for (const [modelId, parts] of Object.entries(state)) {
      if (!parts || typeof parts !== 'object') continue;
      for (const [partId, policy] of Object.entries(parts)) {
        if (!policy || policy.forceExtracted !== true) continue;
        this._set(modelId, partId, policy.reason === undefined ? 'material' : policy.reason);
      }
    }
    return this.exportState();
  }

  exportState() {
    const result = {};
    for (const [modelId, parts] of this._state) {
      const exportedParts = {};
      defineEnumerable(result, modelId, exportedParts);
      for (const [partId, policy] of parts) {
        defineEnumerable(exportedParts, partId, { ...policy });
      }
    }
    return result;
  }

  get(globalPartId) {
    const split = splitGlobalPartId(globalPartId);
    if (!split) return null;
    const policy = this._state.get(split.modelId)?.get(split.partId);
    return policy ? { ...policy } : null;
  }

  isExtracted(globalPartId) {
    return this.get(globalPartId)?.forceExtracted === true;
  }

  extract(globalPartId, reason = 'material') {
    const split = splitGlobalPartId(globalPartId);
    if (!split) return null;
    this._set(split.modelId, split.partId, reason);
    return this.get(globalPartId);
  }

  clear(globalPartId) {
    const split = splitGlobalPartId(globalPartId);
    const parts = split ? this._state.get(split.modelId) : null;
    if (!parts?.delete(split.partId)) return false;
    if (parts.size === 0) this._state.delete(split.modelId);
    return true;
  }

  listModel(modelId) {
    const parts = this._state.get(modelId) || new Map();
    return [...parts].map(([partId, policy]) => ({
      globalPartId: `${modelId}:${partId}`,
      modelId,
      partId,
      ...policy,
    }));
  }

  listAll() {
    const result = [];
    for (const [modelId, parts] of this._state) {
      for (const [partId, policy] of parts) {
        result.push({
          globalPartId: `${modelId}:${partId}`,
          modelId,
          partId,
          ...policy,
        });
      }
    }
    return result;
  }

  classifyMaterialOverride(override) {
    return classifyMaterialOverride(override);
  }

  _set(modelId, partId, reason) {
    if (!this._state.has(modelId)) this._state.set(modelId, new Map());
    this._state.get(modelId).set(partId, {
      forceExtracted: true,
      reason: normalizeReason(reason),
    });
  }
}
