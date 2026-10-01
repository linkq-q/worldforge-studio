import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');

describe('whitebox world planning UI', () => {
  it('keeps complete and standalone planning asset-free until explicit preview approval', () => {
    expect(source).toContain('id="generate-world-ai"');
    expect(source).toContain('id="generate-world-whitebox"');
    expect(source).toContain("generateWorldPreview('generate-complete')");
    expect(source).toContain("{mode: 'generate-complete', prompt: this.mapAiPrompt, seed: map.seed, size: 500");
    expect(source).toContain('generateAssets: false, repairAttempts: 0');
    expect(source).toContain("{mode: 'whitebox', prompt: this.mapAiPrompt, seed: map.seed, size: 500, generateAssets: false}");
    expect(source).not.toContain('id="world-assets"');
  });

  it('continues from the saved canonical whitebox with a bounded first-pass construction request', () => {
    expect(source).toContain('id="construct-world-whitebox"');
    expect(source).toContain('沿当前已保存白盒施工');
    expect(source).toContain("mode: 'construct-whitebox'");
    expect(source).toContain('whiteboxPlan: savedWhiteboxPlan');
    expect(source).toContain('generateAssets: false, assetGenerationLimit: 3');
    expect(source).toContain('assetGenerationLimit: 3');
    expect(source).toContain('repairAttempts: 0');
    expect(source).toContain("generateWorldPreview('construct-whitebox')");
    expect(source).toContain("const operations: MapOperation[] = [{type: 'world.set'");
  });

  it('shows dimensions, unresolved planning, and diagnostics in the original editor preview', () => {
    expect(source).toContain('paidCallCount?: number;');
    expect(source).toContain('沿白盒施工预览');
    expect(source).toContain('已放置建筑灰盒（宽 × 深 × 高）');
    expect(source).toContain('规划公共建筑状态（宽 × 深 × 高）');
    expect(source).toContain('3D 资产草案（宽 × 深 × 高）');
    expect(source).toContain('未解决：未落位');
    expect(source).toContain('尺寸未指定');
    expect(source).toContain('施工诊断');
  });

  it('generates assets only from the explicit preview confirmation and keeps the approved bundle', () => {
    expect(source).toContain('id="generate-approved-world-assets"');
    expect(source).toContain('确认灰盒尺寸并生成 3D 资产');
    expect(source).toContain("mode: 'generate-approved-world-assets', bundle: world.bundle");
    expect(source).toContain('assets: details.draftAssets, reusableAssetIds');
    expect(source).toContain('const nextWorld = {...world, assets: bindings};');
    expect(source).toContain("const operations: MapOperation[] = [{type: 'world.set', world: nextWorld}]");
    expect(source).toContain('世界规划未重做');
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
