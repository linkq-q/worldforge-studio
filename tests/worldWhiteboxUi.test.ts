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
});
