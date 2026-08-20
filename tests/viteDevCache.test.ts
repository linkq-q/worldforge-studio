import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { voxelStudioAliases } from '../voxelStudioVite.mjs';

describe('Vite development cache policy', () => {
  it('never gives local runtime modules an immutable browser cache', () => {
    const source = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(source).toContain("'Cache-Control': 'no-store'");
    expect(source).toContain("exclude: ['@voxel-studio/render-runtime']");
    expect(source).toContain("command === 'serve' ? Date.now().toString(36)");

    const aliases = voxelStudioAliases(undefined, 'fresh');
    const runtimeReplacements = aliases
      .map((alias) => 'replacement' in alias ? alias.replacement : '')
      .filter((replacement) => replacement.includes('/@voxel-studio/render-runtime/'));
    expect(runtimeReplacements.length).toBeGreaterThan(0);
    expect(runtimeReplacements.every((replacement) => replacement.endsWith('?v=fresh'))).toBe(true);
  });
});
