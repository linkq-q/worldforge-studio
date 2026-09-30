import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');

describe('whitebox world planning UI', () => {
  it('keeps normal world generation and adds a fixed-size asset-free whitebox request', () => {
    expect(source).toContain('id="generate-world-ai"');
    expect(source).toContain('id="generate-world-whitebox"');
    expect(source).toContain("{mode: 'whitebox', prompt: this.mapAiPrompt, seed: map.seed, size: 500, generateAssets: false}");
  });

  it('shows the complete whitebox planning trace in escaped details', () => {
    expect(source).toContain('白盒规划检查');
    expect(source).toContain('原始规划');
    expect(source).toContain('观察指标');
    expect(source).toContain('调整决定');
    expect(source).toContain('最终规划');
    expect(source).toContain('最终观察指标');
    expect(source).toContain('escapeHtml(JSON.stringify(value, null, 2))');
  });

  it('shows persisted whitebox semantics after a saved map is reloaded', () => {
    expect(source).toContain('renderSavedWorldWhiteboxDetails(map.world)');
    expect(source).toContain('已保存的白盒语义');
    expect(source).toContain('创作概念');
    expect(source).toContain('聚落角色');
    expect(source).toContain('移动路线');
    expect(source).toContain('兴趣点与探索顺序');
    expect(source).toContain('被水覆盖的锚点');
    expect(source).toContain('worldMapSampler(world)');
    expect(source).toContain('const text = (value: string) => escapeHtml(value);');
    expect(source).toContain('escapeHtml(JSON.stringify(plan, null, 2))');
  });
});
