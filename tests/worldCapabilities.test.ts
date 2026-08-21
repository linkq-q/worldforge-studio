import { describe, expect, it } from 'vitest';
import {
  WORLD_CAPABILITIES,
  worldCapabilitySummary
} from '../src/shared/worldCapabilities';

describe('world capability manifest', () => {
  it('publishes the deterministic world-building tools', () => {
    expect(WORLD_CAPABILITIES.map((capability) => capability.id)).toEqual([
      'topology.create-route-network',
      'settlement.create-street-grid',
      'settlement.place-street-frontage',
      'roadside.decorate-route'
    ]);
    expect(WORLD_CAPABILITIES.every((capability) => capability.deterministic)).toBe(true);
    expect(WORLD_CAPABILITIES.every((capability) => capability.inputSchema.type === 'object')).toBe(true);
    expect(WORLD_CAPABILITIES.every((capability) => capability.bindings.length > 0)).toBe(true);
  });

  it('returns detached JSON-safe summaries for prompts and HTTP clients', () => {
    const first = worldCapabilitySummary();
    const second = worldCapabilitySummary();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0].inputSchema).not.toBe(WORLD_CAPABILITIES[0].inputSchema);
  });
});
