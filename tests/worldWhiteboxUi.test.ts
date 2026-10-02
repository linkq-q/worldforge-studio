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
    expect(source).toContain('2.4, 2.4, 8');
    expect(source).toContain('2.2, 2.2, 1.6');
    expect(source).toContain('1.8, 1.6, 1.2');
    expect(source).toContain('生态规则缩放会改变实际实例大小');
    expect(source).toContain('栋公共建筑未落位；确认只会生成已落位位置用到的资产');
    expect(source).toContain('施工诊断');
  });

  it('generates assets only from the explicit preview confirmation and keeps the approved bundle', () => {
    expect(source).toContain('id="generate-approved-world-assets"');
    expect(source).toContain('确认灰盒尺寸并生成 3D 资产');
    expect(source).toContain("mode: 'generate-approved-world-assets', bundle: world.bundle");
    expect(source).toContain('assets: review.draftAssets, reusableAssetIds');
    expect(source).toContain('const nextWorld = {bundle: world.bundle, assets: bindings};');
    expect(source).toContain("const operations: MapOperation[] = [{type: 'world.set', world: nextWorld}]");
    expect(source).toContain('世界规划未重做');
  });

  it('persists the review and resumes approval from a reloaded saved map without replanning', () => {
    expect(source).toContain('...(review ? {review} : {})');
    expect(source).toContain('map.world?.review && !this.mapAiPreviewMap');
    expect(source).toContain('已保存的白盒施工评审');
    expect(source).toContain('这份评审已随地图保存，可在重载后继续确认');
    expect(source).toContain('const world = preview?.world ?? map?.world;');
    expect(source).toContain("label: '确认白盒尺寸并绑定 3D 资产'");
    expect(source).toContain('this.state.map = normalizeMap(saved.map);');
    const approvalFlow = source.slice(source.indexOf('private async generateApprovedWorldAssets()'),
      source.indexOf('private async generateCompositionPlanPreview()'));
    expect(approvalFlow).not.toContain('generateWorldPreview(');
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
    expect(source).toContain('worldMapTerrainContext(world)');
    expect(source).toContain('地形与水体');
    expect(source).toContain('未按规划完整形成');
    expect(source).toContain('空间关系');
    expect(source).toContain('const text = (value: string) => escapeHtml(value);');
    expect(source).toContain('escapeHtml(JSON.stringify(plan, null, 2))');
  });
});
