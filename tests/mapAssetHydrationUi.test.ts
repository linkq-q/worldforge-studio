import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');

describe('editor asset hydration', () => {
  it('keeps the global catalog lightweight and hydrates selected assets by exact id', () => {
    expect(source).toContain('assetSummaries: MapAssetSummary[];');
    expect(source).toContain("editorFetch<{ assets: MapAssetSummary[] }>('/api/editor/assets')");
    expect(source).toContain("'/api/editor/assets/' + encodeURIComponent(assetId)");
  });

  it('retains only assets referenced by the loaded map plus explicitly hydrated selections', () => {
    expect(source).toContain('this.retainHydratedMapAssets(savedMap);');
    expect(source).toContain('...savedMap.world?.assets.map((binding) => binding.assetId) ?? []');
  });
});
