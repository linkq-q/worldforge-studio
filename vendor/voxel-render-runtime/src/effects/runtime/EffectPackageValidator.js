function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value, range) {
  if (!Array.isArray(range) || range.length < 2 || typeof value !== 'number') return value;
  return Math.max(range[0], Math.min(range[1], value));
}

function isHexColor(value) {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

function isRgbArray(value) {
  return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number');
}

export class EffectPackageValidator {
  constructor(options = {}) {
    this.registry = options.registry || null;
  }

  validate(effectPackage, options = {}) {
    const errors = [];
    const warnings = [];
    const mode = options.mode || 'ai';
    const effectId = effectPackage?.effectId;
    const definition = this.registry?.getDefinition?.(effectId);
    if (!effectId) errors.push('missing effectId');
    if (effectId && !definition) errors.push(`unknown effectId "${effectId}"`);

    const params = isPlainObject(effectPackage?.params) ? effectPackage.params : {};
    const clampedParams = definition
      ? this.clampParams(effectId, params, mode, { warnings, errors })
      : { ...params };

    if (definition) {
      const schemas = definition.params || {};
      for (const [name, value] of Object.entries(params)) {
        const schema = schemas[name];
        if (!schema) {
          warnings.push(`unknown param "${name}" ignored`);
          continue;
        }
        if (!this._matchesType(value, schema)) {
          errors.push(`param "${name}" expected ${schema.type}`);
        }
        if (typeof value === 'number' && Array.isArray(schema.hardRange)) {
          if (value < schema.hardRange[0] || value > schema.hardRange[1]) {
            warnings.push(`param "${name}" clamped from ${value} to ${clampedParams[name]}`);
          }
        }
        if (schema.type === 'enum' && Array.isArray(schema.values) && !schema.values.includes(value)) {
          errors.push(`param "${name}" is not an allowed enum value`);
        }
      }
    }

    return {
      valid: errors.length === 0 && warnings.length === 0,
      errors,
      warnings,
      clamped: {
        ...effectPackage,
        params: clampedParams,
      },
    };
  }

  clampParams(effectId, params = {}, mode = 'ai', report = {}) {
    const definition = this.registry?.getDefinition?.(effectId);
    if (!definition) return { ...(params || {}) };
    const output = {};
    const schemas = definition.params || {};
    for (const [name, schema] of Object.entries(schemas)) {
      if (!Object.prototype.hasOwnProperty.call(params, name)) continue;
      let value = params[name];
      if (typeof value === 'number') {
        const range = mode === 'ai' ? (schema.aiRange || schema.hardRange) : (schema.designerRange || schema.hardRange);
        const before = value;
        value = clampNumber(value, range);
        value = clampNumber(value, schema.hardRange);
        if (before !== value) report.warnings?.push?.(`param "${name}" clamped from ${before} to ${value}`);
      }
      output[name] = value;
    }
    return output;
  }

  getViolations(effectPackage) {
    const result = this.validate(effectPackage);
    return [...result.errors, ...result.warnings];
  }

  _matchesType(value, schema) {
    switch (schema.type) {
      case 'float':
      case 'int':
        return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'int' || Number.isInteger(value));
      case 'color':
        return isHexColor(value) || isRgbArray(value);
      case 'bool':
        return typeof value === 'boolean';
      case 'enum':
        return typeof value === 'string';
      case 'vec2':
        return Array.isArray(value) && value.length === 2 && value.every((entry) => typeof entry === 'number');
      case 'vec3':
        return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number');
      default:
        return true;
    }
  }
}

export default EffectPackageValidator;
