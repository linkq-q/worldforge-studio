import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
});
