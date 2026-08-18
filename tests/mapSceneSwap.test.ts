import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldPromoteLiveMapPreview } from '../src/client/mapEditor';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');

describe('map scene swap', () => {
  it('keeps the current scene attached until the replacement finishes building', () => {
    const start = source.indexOf('private async rebuildScene(): Promise<void>');
    const end = source.indexOf('private handlePointer', start);
    const rebuild = source.slice(start, end);
    const build = rebuild.indexOf('await buildEditableMapGroup');
    const detach = rebuild.indexOf('this.renderScene?.attach(null)', build);

    expect(build).toBeGreaterThan(-1);
    expect(detach).toBeGreaterThan(build);
  });

  it('does not replace a fuller live scene with a partial agent candidate', () => {
    expect(shouldPromoteLiveMapPreview(8, 2)).toBe(false);
    expect(shouldPromoteLiveMapPreview(8, 8)).toBe(true);
    expect(shouldPromoteLiveMapPreview(8, 10)).toBe(true);
  });
});
