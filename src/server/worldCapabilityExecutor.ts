import type { EditableMap, MapAsset } from '../shared/map';
import { applyMapOperations, type MapAiSuggestion } from '../shared/mapOperations';
import { evaluateSettlementQuality, type SettlementQualityMetrics } from '../shared/settlementQuality';
import { WORLD_CAPABILITIES, type WorldCapabilityManifest } from '../shared/worldCapabilities';
import { executeMapCodePlan } from './mapCodePlanner';

export interface WorldCapabilityObservation {
  operationCount: number;
  operationsByType: Record<string, number>;
  objectCount: number;
  guideCount: number;
  diagnostics: Array<{ code: string; severity: string; message: string; repaired: boolean }>;
  settlement: SettlementQualityMetrics;
}

export interface WorldCapabilityExecution {
  capability: WorldCapabilityManifest;
  suggestion: MapAiSuggestion;
  observation: WorldCapabilityObservation;
}

export function executeWorldCapability(
  capabilityId: string,
  input: unknown,
  map: EditableMap,
  assets: readonly MapAsset[] = []
): WorldCapabilityExecution {
  const capability = WORLD_CAPABILITIES.find((candidate) => candidate.id === capabilityId);
  if (!capability) throw new Error('unknown_world_capability');
  const binding = capability.bindings.find((candidate) => candidate.runtime === 'map-code');
  if (!binding) throw new Error('world_capability_runtime_unavailable');
  validateCapabilityInput(input, capability.inputSchema);
  const method = binding.method.match(/^api\.([A-Za-z][A-Za-z0-9]*)$/)?.[1];
  if (!method) throw new Error('invalid_world_capability_binding');
  const serialized = JSON.stringify(input);
  if (serialized.length > 64 * 1024) throw new Error('world_capability_input_too_large');
  const suggestion = executeMapCodePlan(`function plan(api) { api.${method}(${serialized}); }`, map, assets);
  const preview = applyMapOperations(map, suggestion.operations);
  return {
    capability,
    suggestion,
    observation: observeWorldCapability(preview, suggestion)
  };
}

export function observeWorldCapability(map: EditableMap, suggestion?: MapAiSuggestion): WorldCapabilityObservation {
  const operationsByType: Record<string, number> = {};
  for (const operation of suggestion?.operations ?? []) {
    operationsByType[operation.type] = (operationsByType[operation.type] ?? 0) + 1;
  }
  return {
    operationCount: suggestion?.operations.length ?? 0,
    operationsByType,
    objectCount: map.objects.length,
    guideCount: map.guides.length,
    diagnostics: (suggestion?.diagnostics ?? []).map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      repaired: issue.repaired
    })),
    settlement: evaluateSettlementQuality(map).metrics
  };
}

function validateCapabilityInput(input: unknown, schema: WorldCapabilityManifest['inputSchema']): void {
  if (!isPlainObject(input)) throw new Error('invalid_world_capability_input');
  const keys = Object.keys(input);
  for (const required of schema.required) {
    if (!(required in input)) throw new Error(`world_capability_missing_input:${required}`);
  }
  if (!schema.additionalProperties) {
    for (const key of keys) {
      if (!(key in schema.properties)) throw new Error(`world_capability_unknown_input:${key}`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    validateSchemaValue(value, schema.properties[key], key, 0);
  }
}

function validateSchemaValue(value: unknown, schemaValue: unknown, path: string, depth: number): void {
  if (depth > 8 || !isPlainObject(schemaValue)) return;
  const schema = schemaValue as Record<string, unknown>;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`world_capability_invalid_input:${path}`);
  if (schema.type === 'string' && typeof value !== 'string') throw new Error(`world_capability_invalid_input:${path}`);
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`world_capability_invalid_input:${path}`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(`world_capability_invalid_input:${path}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) throw new Error(`world_capability_invalid_input:${path}`);
  }
  if (schema.type === 'object') {
    if (!isPlainObject(value)) throw new Error(`world_capability_invalid_input:${path}`);
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) throw new Error(`world_capability_missing_input:${path}.${key}`);
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`world_capability_invalid_input:${path}`);
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) throw new Error(`world_capability_invalid_input:${path}`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) throw new Error(`world_capability_invalid_input:${path}`);
    for (let index = 0; index < value.length; index += 1) {
      validateSchemaValue(value[index], schema.items, `${path}[${index}]`, depth + 1);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
