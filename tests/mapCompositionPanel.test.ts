import { describe, expect, it } from 'vitest';
import {
  renderMapCodePlanApproval,
  renderMapCodePlanSummary,
  renderMapCompositionPlanApproval,
  renderMapCompositionSummary,
  renderMapDesignSummary,
  renderMapGenerationFailure
} from '../src/client/mapCompositionPanel';
import type { MapAiSuggestion } from '../src/shared/mapOperations';
import { createEmptyMap } from '../src/shared/map';

describe('map composition preview panel', () => {
  it('renders an indoor Code approval without invoking the old director plan', () => {
    const html = renderMapCodePlanApproval({
      summary: '教室功能布局', operations: [], renderPromptSuggestions: [], generatedAssets: [],
      codePlan: {
        code: 'function plan(api) { api.roomPoint(0, 0); }',
        functions: ['roomPoint', 'opening'], placementCount: 12, repairAttempts: 1,
        assetRequirements: [
          { key: 'desk', name: '课桌', variants: 2, role: 'functional', dimensions: [1.2, 0.75, 0.6] },
          { key: 'plant', name: '盆栽', variants: 1, role: 'decor', optional: true }
        ]
      }
    });

    expect(html).toContain('待确认的室内功能规划');
    expect(html).toContain('摆放意图 <b>12</b>');
    expect(html).toContain('资产变体 <b>3</b>');
    expect(html).toContain('课桌 · 功能 · 2 个');
    expect(html).toContain('盆栽 · 装饰 · 1 个 · 可选');
    expect(html).toContain('id="approve-code-plan"');
    expect(html).not.toContain('房间俯视分区图');
  });

  it('renders a top-down approval plan with explicit whitespace meaning before generation', () => {
    const plan = {
      version: 1 as const,
      summary: '教堂平面规划',
      globalBrief: {
        spatialTheme: '中轴对称', visualHierarchy: '讲台是焦点', assetArtDirection: '木质体素',
        focalZoneId: 'altar', terrainBase: { preset: 'plain' as const, seed: 1, amplitude: 0, roughness: 0 }
      },
      intentRequirements: [],
      zones: [{
        id: 'altar', label: '讲台区', role: 'primary' as const, importance: 1,
        region: { kind: 'circle' as const, center: [0, -0.6] as [number, number], radius: 0.22 },
        brief: { atmosphere: '肃静', hierarchy: '视觉焦点', openness: 0.2, transitionIntent: '连接座席' },
        terrain: { elevation: 0, roughness: 0, flatness: 1 }, layers: [], grassLayers: [], excludeZoneIds: []
      }, {
        id: 'aisle', label: '中央过道', role: 'negative-space' as const, importance: 0.8,
        region: { kind: 'circle' as const, center: [0, 0.2] as [number, number], radius: 0.18 },
        brief: { atmosphere: '清晰通行', hierarchy: '保持入口到讲台视线', openness: 1, transitionIntent: '用于通行与仪式' },
        terrain: { elevation: 0, roughness: 0, flatness: 1 }, layers: [], grassLayers: [], excludeZoneIds: []
      }],
      transitions: [], assetFamilies: [], grassFamilies: [], consultations: [], renderPromptSuggestions: []
    };

    const html = renderMapCompositionPlanApproval(plan);

    expect(html).toContain('<svg');
    expect(html).toContain('中央过道');
    expect(html).toContain('用于通行与仪式');
    expect(html).toContain('默认对称');
    expect(html).toContain('确认规划并开始生成');
  });

  it('shows focal hierarchy, zones, dynamic specialists, and final review without persisting another map format', () => {
    const html = renderMapCompositionSummary({
      summary: 'forest',
      operations: [],
      renderPromptSuggestions: [],
      generatedAssets: [],
      diagnostics: [
        { code: 'object.overlap', severity: 'warning', message: 'Bench overlap', repaired: false },
        { code: 'object.overlap', severity: 'warning', message: 'Bench overlap', repaired: false }
      ],
      composition: {
        plan: {
          version: 1,
          summary: 'forest',
          globalBrief: {
            spatialTheme: 'forest around a clearing',
            visualHierarchy: 'The cabin is framed by the pond and forest.',
            assetArtDirection: 'coherent voxel forms',
            focalZoneId: 'camp',
            terrainBase: { preset: 'hills', seed: 1, amplitude: 3, roughness: 0.5 }
          },
          intentRequirements: [{
            id: 'terrain-foundation', kind: 'terrain', description: 'terrain', targetZoneId: 'camp', minCount: 1
          }],
          zones: [
            {
              id: 'camp', label: '<Cabin>', role: 'primary', importance: 1,
              region: { kind: 'circle', center: [0, 0], radius: 0.3 },
              brief: { atmosphere: '', hierarchy: '', openness: 0.5, transitionIntent: '' },
              terrain: { elevation: 0, roughness: 0.3, flatness: 0.5 },
              layers: [], grassLayers: [], excludeZoneIds: []
            }
          ],
          transitions: [],
          assetFamilies: [],
          grassFamilies: [],
          consultations: [],
          renderPromptSuggestions: []
        },
        metrics: {
          zoneCoverage: 0.64,
          zoneCount: 1,
          initialObjectCount: 3,
          objectCount: 12,
          waterCount: 0,
          familyCounts: {},
          zoneCounts: { camp: 12 },
          unresolvedFamilyIds: []
        },
        consultations: [{
          id: 'layout-specialist',
          summary: 'improved',
          findings: [{ code: 'focus', severity: 'info', message: 'Cabin is readable.' }]
        }],
        review: { status: 'pass', summary: 'coherent', findings: [], patches: [] },
        outcome: {
          checks: [
            { requirementId: 'terrain-foundation', kind: 'terrain', status: 'pass', message: '地形高度场已生成。' },
            { requirementId: 'front-blackboard', kind: 'asset-family', status: 'warning', message: '前方黑板无合法位置，已降级跳过。' }
          ],
          repairCount: 0
        }
      }
    } satisfies MapAiSuggestion);

    expect(html).toContain('覆盖 <b>64%</b>');
    expect(html).toContain('自动降级 1');
    expect(html).toContain('前方黑板无合法位置');
    expect(html).toContain('动态专家：layout-specialist');
    expect(html).toContain('The cabin is framed by the pond and forest.');
    expect(html).toContain('&lt;Cabin&gt;');
    expect(html).not.toContain('<Cabin>');
    expect(html).toContain('<details class="inspector-disclosure compact map-ai-composition-details">');
    expect(html).not.toContain('map-ai-composition-details" open');
    expect(html).toContain('map-ai-composition-quality');
    expect(html).toContain('规划不足');
    expect(html).toContain('初始规划正常落位 <b>3 / 12</b>');
    expect(html.match(/Bench overlap/g)).toHaveLength(1);
    expect(html.indexOf('map-composition-quality-danger')).toBeLessThan(html.indexOf('<details'));
  });

  it.each([
    [2, 10, '规划不足', 'danger'],
    [5, 10, '需要注意', 'warning'],
    [8, 10, '规划良好', 'good']
  ])('shows three placement quality tiers for %i of %i initially planned objects', (initial, total, label, tone) => {
    const suggestion = compositionSuggestion(initial, total);

    const html = renderMapCompositionSummary(suggestion);

    expect(html).toContain(label);
    expect(html).toContain(`map-composition-quality-${tone}`);
  });

  it('offers a continuation repair whenever initial planning quality is below good', () => {
    expect(renderMapCompositionSummary(compositionSuggestion(3, 12))).toContain('id="repair-map-ai-composition"');
    expect(renderMapCompositionSummary(compositionSuggestion(6, 12))).toContain('id="repair-map-ai-composition"');
    expect(renderMapCompositionSummary(compositionSuggestion(10, 12))).not.toContain('id="repair-map-ai-composition"');
  });

  it('shows the unified scene Code trace with simple Chinese tool labels and escaped source', () => {
    const html = renderMapCodePlanSummary({
      summary: 'arena', operations: [], renderPromptSuggestions: [], generatedAssets: [],
      codePlan: {
        code: 'place("gate", { label: "<main>" });',
        functions: ['place', 'circlePoint'],
        placementCount: 24,
        sceneIntent: 'authored',
        sceneIntentReason: '人工营造的<竞技场>'
      }
    });

    expect(html).toContain('场景 Code 详情');
    expect(html).toContain('营造场景');
    expect(html).toContain('24 个摆放意图');
    expect(html).toContain('<span>物体摆放</span>');
    expect(html).toContain('<span>环形布局</span>');
    expect(html).toContain('人工营造的&lt;竞技场&gt;');
    expect(html).toContain('&lt;main&gt;');
    expect(html).not.toContain('<main>');
  });

  it('offers a focused repair action when asset generation degraded the Scene Code result', () => {
    const html = renderMapCodePlanSummary({
      summary: 'garden', operations: [], renderPromptSuggestions: [], generatedAssets: [],
      diagnostics: [{
        code: 'asset.generation-degraded', severity: 'warning', repaired: false,
        message: '资产“游廊”生成失败，其余内容已保留。'
      }],
      codePlan: { code: 'function plan(api) {}', functions: [], placementCount: 0 }
    });

    expect(html).toContain('资产“游廊”生成失败，其余内容已保留。');
    expect(html).toContain('id="repair-map-ai-assets"');
    expect(html).toContain('修复失败项');
  });

  it('renders selectable Chinese design groups, focus roles and layer density', () => {
    const map = createEmptyMap();
    map.designSemantics = {
      version: 1, experienceMode: 'mixed', intent: '主次平衡', viewpoints: [], relations: [],
      groups: [{
        id: 'library', name: '图书馆组', intent: '突出主楼', focusIds: ['main'], guideIds: [],
        entryGuideIds: [], exitGuideIds: [], axisGuideIds: [], protectedObjectIds: [], removableObjectIds: [],
        layers: [{ level: 1, intent: '主体', density: 'tight' }, { level: 4, intent: '点景', density: 'open' }]
      }],
      focuses: [{ id: 'main', groupId: 'library', name: '主楼', kind: 'primary', rank: 1, reveal: 'visible' }]
    };

    const html = renderMapDesignSummary(map);
    expect(html).toContain('设计组与焦点');
    expect(html).toContain('data-map-design-group="library"');
    expect(html).toContain('图书馆组');
    expect(html).toContain('主焦点 · 主楼 · 直接可见');
    expect(html).toContain('1级密、4级疏');
  });

  it('renders generation failure as a non-blocking retry action', () => {
    const html = renderMapGenerationFailure({ detail: 'Empty <AI> response', retainedCandidate: false });
    expect(html).toContain('当前地图未受影响');
    expect(html).toContain('不会阻断编辑');
    expect(html).toContain('id="retry-map-ai"');
    expect(html).toContain('重新尝试');
    expect(html).toContain('Empty &lt;AI&gt; response');
    expect(html).not.toContain('disabled');
  });

  it('offers layout-only replay after generated assets were preserved', () => {
    const html = renderMapGenerationFailure({
      detail: '资产已保存',
      retainedCandidate: false,
      replayAvailable: true
    });

    expect(html).toContain('重新重放布局');
    expect(html).toContain('不会再次请求 AI 或生成重复资产');
    expect(html).not.toContain('>重新尝试<');
  });
});

function compositionSuggestion(initialObjectCount: number, objectCount: number): MapAiSuggestion {
  return {
    summary: 'room', operations: [], renderPromptSuggestions: [], generatedAssets: [],
    composition: {
      plan: {
        version: 1, summary: 'room',
        globalBrief: {
          spatialTheme: 'room', visualHierarchy: 'balanced room', assetArtDirection: 'voxel', focalZoneId: 'room',
          terrainBase: { preset: 'plain', seed: 1, amplitude: 0, roughness: 0 }
        },
        intentRequirements: [],
        zones: [{
          id: 'room', label: '房间', role: 'primary', importance: 1,
          region: { kind: 'circle', center: [0, 0], radius: 1 },
          brief: { atmosphere: '', hierarchy: '', openness: 0.5, transitionIntent: '' },
          terrain: { elevation: 0, roughness: 0, flatness: 1 }, layers: [], grassLayers: [], excludeZoneIds: []
        }],
        transitions: [], assetFamilies: [], grassFamilies: [], consultations: [], renderPromptSuggestions: []
      },
      metrics: {
        zoneCoverage: 1, zoneCount: 1, initialObjectCount, objectCount, waterCount: 0,
        familyCounts: {}, zoneCounts: { room: objectCount }, unresolvedFamilyIds: []
      },
      consultations: [], review: { status: 'pass', summary: 'pass', findings: [], patches: [] },
      outcome: { checks: [], repairCount: objectCount - initialObjectCount }
    }
  };
}
