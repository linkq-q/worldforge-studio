import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');

describe('map code asset reuse controls', () => {
  it('sends the shared asset-library selection through Code generation', () => {
    const requestStart = source.indexOf('/code-generate');
    const codeRequest = source.slice(requestStart, requestStart + 1_200);

    expect(requestStart).toBeGreaterThanOrEqual(0);
    expect(codeRequest).toContain('reuseExistingAssets: this.mapAiReuseExistingAssets');
    expect(codeRequest).toContain('assetLibraryId: this.mapAiReuseExistingAssets ? this.activeAssetLibraryId : undefined');
  });

  it('exposes the indoor Code generation path for indoor maps', () => {
    expect(source).toContain("map.sceneMode === 'indoor' ? '室内 Code 生成' : 'Code 生成'");
    expect(source).toContain('房间、墙面、门窗与家具功能组 API');
    expect(source).toContain('程序化室内规划代码');
  });
});
