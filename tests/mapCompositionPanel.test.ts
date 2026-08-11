import { describe, expect, it } from 'vitest';
import { renderMapCompositionSummary } from '../src/client/mapCompositionPanel';
import type { MapAiSuggestion } from '../src/shared/mapOperations';

describe('map composition preview panel', () => {
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
          checks: [{ requirementId: 'terrain-foundation', kind: 'terrain', status: 'pass', message: '地形高度场已生成。' }],
          repairCount: 0
        }
      }
    } satisfies MapAiSuggestion);

    expect(html).toContain('覆盖 <b>64%</b>');
    expect(html).toContain('动态专家：layout-specialist');
    expect(html).toContain('The cabin is framed by the pond and forest.');
    expect(html).toContain('&lt;Cabin&gt;');
    expect(html).not.toContain('<Cabin>');
    expect(html).toContain('<details class="inspector-disclosure compact map-ai-composition-details">');
    expect(html).not.toContain('map-ai-composition-details" open');
    expect(html).toContain('map-ai-composition-quality');
    expect(html.match(/Bench overlap/g)).toHaveLength(1);
  });
});
