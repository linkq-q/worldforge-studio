import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapPrimitiveBatching.ts', import.meta.url), 'utf8');

describe('map primitive batch runtime effects', () => {
  it('ticks base material shader uniforms for instanced batches', () => {
    expect(source).toMatch(/effectRuntime\.updateRuntimeUniforms\(root,\s*\{[\s\S]*uTime:/);
  });
});
