import { describe, expect, it, vi } from 'vitest';
import { buildMapCodePlannerSystemPrompt, executeMapCodePlan, generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { createRenderSceneProfile } from '../src/shared/renderSceneProfile';

// Zero-use tools in the 32 full-planning maps of the 64-map audit.
const removed = [
  'refineTerrain', 'streetGrid', 'placeStreetFrontage', 'grassField',
  'clamp', 'lerp', 'remap', 'smoothstep', 'rotate2D', 'mirrorPoint', 'linePoint',
  'sampleBezier', 'sampleBezierFrames', 'sampleBezierFramesBySpacing', 'ellipsePoint',
  'keepDry', 'gridPoints', 'offsetPolygon', 'insetPolygon', 'gridInsideRegion',
  'localToWorld3D', 'noise2D', 'fbm2D', 'optimizeLayout', 'assetSpace', 'connectionGap', 'placeRelative'
];

describe('outdoor map API pruning', () => {
  it.each(['generate', 'refine'] as const)('does not teach removed tools during %s', (mode) => {
    const prompt = buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 0, 0, 'scene', mode);
    for (const name of removed) expect(prompt).not.toMatch(new RegExp(`api\\.${name}\\b`));
    expect(prompt).toContain('Rendering handoff');
    expect(prompt).toContain('api.renderSuggestion(text)');
  });

  it('removes tools from actual model execution and preserves the render handoff', async () => {
    const code = `function plan(api) {
      for (const name of ${JSON.stringify(removed)}) {
        if (typeof api[name] !== 'undefined') throw new Error('retired_api_exposed:' + name);
      }
      api.place({name:'marker',position:[0,0]});
      api.renderSuggestion('Warm light and soft water reflections');
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code })));
    const map = createEmptyMap();
    const result = await generateMapCodeSuggestion('Place a marker', map, [], {
      fetchImpl, minNewAssets: 0, maxNewAssets: 0, scope: 'scene', revisionMode: 'first-pass'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.operations.some(op => op.type === 'object.add')).toBe(true);
    const profile = createRenderSceneProfile(applyMapOperations(map, result.operations));
    expect(profile.sceneArtBrief?.renderHints).toEqual(['Warm light and soft water reflections']);
  });

  it('keeps standalone historical code replay compatible', () => {
    const result = executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.refineTerrain({erosion:0.1,iterations:1});
      api.place({name:'legacy',position:api.ellipsePoint(0,8,5,3)});
    }`, createEmptyMap());
    expect(result.operations.some(op => op.type === 'terrain.refine')).toBe(true);
    expect(result.operations.some(op => op.type === 'object.add')).toBe(true);
  });
});
