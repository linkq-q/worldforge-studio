import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');

describe('map AI controls', () => {
  it('keeps map generation palette independent and disabled by default', () => {
    expect(source).toContain("private mapAiPaletteId = '';");
    expect(source).toContain('palette.id === this.mapAiPaletteId');
    expect(source).toContain('this.mapAiPaletteId = (event.target as HTMLSelectElement).value;');
    expect(source).toContain('paletteId: this.mapAiPaletteId || undefined');
    expect(source).not.toContain('paletteId: this.selectedPaletteId || undefined');
  });
});
