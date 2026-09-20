import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');
const httpSource = readFileSync(new URL('../src/server/mapHttp.ts', import.meta.url), 'utf8');
const mapAiSource = readFileSync(new URL('../src/server/mapAi.ts', import.meta.url), 'utf8');

describe('map AI controls', () => {
  it('keeps map generation palette independent and disabled by default', () => {
    expect(source).toContain("private mapAiPaletteId = '';");
    expect(source).toContain('palette.id === this.mapAiPaletteId');
    expect(source).toContain('this.mapAiPaletteId = (event.target as HTMLSelectElement).value;');
    expect(source).toContain('paletteId: this.mapAiPaletteId || undefined');
    expect(source).not.toContain('paletteId: this.selectedPaletteId || undefined');
  });

  it('renders, persists and sends independent Scene Code modes', () => {
    expect(source).toContain("private mapAiCodePromptMode: MapCodePromptMode = 'standard';");
    expect(source).toContain("private mapAiCodeRevisionMode: MapCodeRevisionMode = 'repair';");
    expect(source).toContain("private mapAiCodeSpatialPolicy: MapCodeSpatialPolicy = 'repair';");
    expect(source).toContain('id="map-ai-code-prompt-mode"');
    expect(source).toContain('id="map-ai-code-revision-mode"');
    expect(source).toContain('id="map-ai-code-spatial-policy"');
    expect(source.match(/codePromptMode: this\.mapAiCodePromptMode/g)).toHaveLength(3);
    expect(source.match(/codeRevisionMode: this\.mapAiCodeRevisionMode/g)).toHaveLength(3);
    expect(source.match(/codeSpatialPolicy: this\.mapAiCodeSpatialPolicy/g)).toHaveLength(3);
    expect(source).toContain("plan.options.codePromptMode ?? 'standard'");
    expect(source).toContain("plan.options.codeRevisionMode ?? 'repair'");
    expect(source).toContain("plan.options.codeSpatialPolicy ?? 'repair'");
    expect(httpSource).toContain("body.codePromptMode === 'minimal' ? 'minimal' : 'standard'");
    expect(httpSource).toContain("body.codeRevisionMode === 'first-pass' ? 'first-pass' : 'repair'");
    expect(httpSource).toContain("body.codeSpatialPolicy === 'diagnose' ? 'diagnose' : 'repair'");
    expect(mapAiSource).toContain('promptMode: options.codePromptMode');
    expect(mapAiSource).toContain('revisionMode: options.codeRevisionMode');
    expect(mapAiSource).toContain('spatialPolicy: options.codeSpatialPolicy');
  });

  it('separates planning and asset-generation providers', () => {
    expect(source).toContain("private mapAiProvider: ChatProvider = 'gpt';");
    expect(source).toContain("private mapAiAssetProvider: ModelProvider | '' = '';");
    expect(source).toContain('id="map-ai-provider"');
    expect(source).toContain('id="map-ai-asset-provider"');
    expect(source).toContain('跟随规划模型');
    expect(source.match(/assetProvider: this\.mapAiAssetProvider/g)).toHaveLength(3);
    expect(source).toContain("plan.options.provider ?? 'gpt'");
    expect(source).toContain("plan.options.assetProvider ?? ''");
    expect(httpSource).toContain('isModelProvider(body.assetProvider)');
    expect(httpSource).toContain('body.assetProvider ?? modelProviderForChatProvider(provider)');
  });
});
