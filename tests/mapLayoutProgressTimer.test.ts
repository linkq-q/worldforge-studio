import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('map layout AI progress', () => {
  it('streams progress, displays elapsed time and supports cancellation', () => {
    expect(source).toContain('elapsedMs: this.mapLayoutElapsedMs');
    expect(source).toContain("#cancel-map-layout");
    expect(source).toMatch(/this\.startMapLayoutProgressTimer\(\);[\s\S]*?await editorAgentFetch/);
    expect(source).toMatch(/finally\s*\{[\s\S]*?this\.stopMapLayoutProgressTimer\(\);/);
    expect(source).toContain('this.mapLayoutAbortController?.abort()');
  });

  it('keeps region prompts hidden until the user confirms the partition', () => {
    expect(source).toContain('确认并使用此分区');
    expect(source).toContain('确认后才会显示各区块的建议提示词和生成工具');
    expect(source).toContain('${!this.mapLayoutSuggestion && selected ? `<div class="map-region-editor">');
  });

  it('gives the prompt its own row and auto-saves a confirmed layout before region generation', () => {
    expect(styles).toMatch(/\.map-layout-planner\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
    expect(source).toMatch(/id="generate-map-region"[^>]*(?!this\.state\.dirty)[^>]*>/);
    expect(source).toMatch(/#generate-map-region[\s\S]*?await this\.saveMap\(\)[\s\S]*?await this\.generateMapAiPreview\('refine'\)/);
  });

  it('teaches one-sentence prompts without asking players for technical parameters', () => {
    expect(source).toContain('全地图提示词（建议一句话）');
    expect(source).toContain('写整体环境、2–3 个主要内容和大致关系');
    expect(source).toContain('区块提示词（建议一句话）');
    expect(source).toContain('AI 会决定密度、位置和边界过渡');
  });

  it('shows a bounded medium-map area multiplier for the super-size preset', () => {
    expect(source).toContain('id="new-map-super-units"');
    expect(source).toContain('id="new-map-super-size-hint"');
  });

  it('keeps the first indoor round savable while one automatic refinement runs', () => {
    expect(source).toContain('this.mapAiAutoRefineRunning = true');
    expect(source).toMatch(/quality\.tone !== 'good'[\s\S]*?generateMapAiPreview\('refine',[\s\S]*?true\)/);
    expect(source).toContain("this.mapAiAutoRefineRunning ? '保存当前轮' : '应用到地图'");
    expect(source).toContain('if (automatic && this.mapAiRoundSavePromise) await this.mapAiRoundSavePromise');
    expect(source).toContain('const baseWasSaved = automatic && this.mapAiAutoRefineBaseSaved');
  });
});
