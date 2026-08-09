function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeDefinition(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('Effect definition must be an object');
  if (!definition.id) throw new Error('Effect definition missing id');
  return {
    category: 'material',
    params: {},
    presets: [],
    ...clone(definition),
  };
}

export class EffectRegistry {
  constructor(definitions = [], presets = []) {
    this.definitions = new Map();
    this.presets = new Map();
    for (const definition of definitions || []) this.registerDefinition(definition);
    for (const preset of presets || []) this.registerPreset(preset);
  }

  registerDefinition(definition) {
    const normalized = normalizeDefinition(definition);
    this.definitions.set(normalized.id, normalized);
    return normalized;
  }

  registerPreset(preset) {
    if (!preset || typeof preset !== 'object') throw new Error('Effect preset must be an object');
    const presetId = preset.presetId || preset.id;
    if (!presetId) throw new Error('Effect preset missing presetId');
    const normalized = clone({ ...preset, presetId });
    this.presets.set(presetId, normalized);
    return normalized;
  }

  getDefinition(effectId) {
    const definition = this.definitions.get(effectId);
    return definition ? clone(definition) : null;
  }

  getPreset(presetId) {
    const preset = this.presets.get(presetId);
    return preset ? clone(preset) : null;
  }

  listEffects(filter = {}) {
    return [...this.definitions.values()]
      .filter((definition) => !filter.category || definition.category === filter.category)
      .map((definition) => clone(definition));
  }

  getParamSchema(effectId) {
    return clone(this.definitions.get(effectId)?.params || null);
  }

  getDefaults(effectId) {
    const params = this.definitions.get(effectId)?.params || {};
    return Object.fromEntries(Object.entries(params).map(([name, schema]) => [name, clone(schema.default)]));
  }

  exportPreset(effectId, params = {}, options = {}) {
    const definition = this.definitions.get(effectId);
    if (!definition) {
      // Graceful fallback for effects without a registered definition
      console.warn(`[EffectRegistry] Unknown effect "${effectId}" — returning fallback preset`);
      return {
        type: 'effectPreset',
        effectId,
        presetId: options.presetId || `${effectId}_runtime_001`,
        label: options.label || `${effectId} Runtime 001`,
        params: clone(params || {}),
      };
    }
    return {
      type: 'effectPreset',
      effectId,
      presetId: options.presetId || `${effectId}_runtime_001`,
      label: options.label || `${definition.label || effectId} Runtime 001`,
      params: { ...this.getDefaults(effectId), ...clone(params || {}) },
    };
  }

  exportConstraint(effectId) {
    const definition = this.definitions.get(effectId);
    if (!definition) {
      console.warn(`[EffectRegistry] Unknown effect "${effectId}" — returning empty constraint`);
      return {
        type: 'effectConstraint',
        effectId,
        aiAllowedParams: {},
        forbidden: [],
        notes: ['No constraint definition registered for this effect.'],
      };
    }
    const aiAllowedParams = {};
    for (const [name, schema] of Object.entries(definition.params || {})) {
      if (schema.aiRange) aiAllowedParams[name] = clone(schema.aiRange);
    }
    return {
      type: 'effectConstraint',
      effectId,
      aiAllowedParams,
      forbidden: clone(definition.forbidden || []),
      notes: clone(definition.notes || []),
    };
  }
}

export default EffectRegistry;
