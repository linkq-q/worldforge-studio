import { describe, expect, it } from 'vitest';
import {
  renderMapCodePlanSummary,
  renderMapCompositionPlanApproval,
  renderMapCompositionSummary
} from '../src/client/mapCompositionPanel';
import type { MapAiSuggestion } from '../src/shared/mapOperations';

describe('map composition preview panel', () => {
  it('renders code planning tools and escaped source in the normal preview panel', () => {
    const html = renderMapCodePlanSummary({
      summary: 'code plan',
      operations: [],
      renderPromptSuggestions: [],
      generatedAssets: [],
      codePlan: {
        code: 'function plan(api) { if (x < 2) api.place({ position:[0,0] }); }',
        placementCount: 12,
        functions: ['noise2D', 'place']
      }
    });
    expect(html).toContain('Code 规划详情');
    expect(html).toContain('12 个摆放意图');
    expect(html).toContain('noise2D');
    expect(html).toContain('&lt; 2');
    expect(html).not.toContain('if (x < 2)');
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
