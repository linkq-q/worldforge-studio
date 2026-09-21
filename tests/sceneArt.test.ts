import { describe, expect, it } from 'vitest';
import { compileSceneArt, normalizeColorStops, normalizeSceneArtConfig, sampleColorRamp } from '../src/shared/sceneArt';
import { createDefaultRenderAccessPolicy, normalizeRenderPlan } from '../src/shared/renderPlan';

describe('bounded scene art', () => {
  it('keeps independently positioned colors instead of inventing intermediate stops', () => {
    const stops = normalizeColorStops([[0, '#001122'], [0.3, '#336699'], [1, '#ffffff']]);
    expect(sampleColorRamp(stops, 0.3)).toBe('#336699');
    expect(sampleColorRamp(stops, -1)).toBe('#001122');
    expect(() => normalizeColorStops([[0.8, '#000000'], [0.2, '#ffffff']])).toThrow();
    expect(() => normalizeColorStops(Array(9).fill([0, '#ffffff']))).toThrow();
  });

  it('exposes artistic grass controls but retains resource limits', () => {
    const policy = createDefaultRenderAccessPolicy();
    const enabled = (parameter: string) => policy.parameters.find(p => p.moduleId === 'runtime.grass-style' && p.parameter === parameter)?.ai.enabled;
    expect(enabled('gradientBias')).toBe(true);
    expect(enabled('rootDarken')).toBe(true);
    expect(enabled('maxInstances')).toBe(false);
  });

  it('allows AI to author bounded spatial color and shader rules', () => {
    const plan = normalizeRenderPlan({ version: 2, baseSchemeId: 'test', modules: [
      { id: 'runtime.color-field', key: 'shore', params: { config: JSON.stringify({ zoneId: 'shore', axis: 'x', start: -4, end: 4, stops: [[0, '#234567'], [1, '#aabbcc']] }) } },
      { id: 'runtime.surface-detail', key: 'sign', params: { config: JSON.stringify({ objectId: 'sign', colorExpression: 'color * (0.8 + 0.2 * sin(time))' }) } }
    ] }, ['test'], createDefaultRenderAccessPolicy(), 'ai');
    expect(plan.modules).toHaveLength(2);
    expect(() => normalizeSceneArtConfig('runtime.surface-detail', { objectId: 'x', colorExpression: 'texture2D(secret, uv).rgb' })).toThrow();
  });

  it('rejects unbounded or malformed rules rather than silently applying defaults', () => {
    expect(() => normalizeSceneArtConfig('runtime.color-field', { stops: [[0, '#000000'], [1, '#ffffff']], start: 2, end: 2 })).toThrow();
    expect(() => normalizeSceneArtConfig('runtime.local-light', { objectId: 'lamp', surprise: 1 })).toThrow();
    expect(() => normalizeSceneArtConfig('runtime.surface-detail', { roughness: 0.1 })).toThrow();
  });

  it('allows sixteen independently tuned glass surfaces without removing the budget', () => {
    const modules = Array.from({ length: 16 }, (_, index) => ({
      id: 'runtime.surface-detail' as const,
      key: `glass-${index}`,
      params: { config: JSON.stringify({ objectId: `window-${index}`, transmission: 0.9 }) }
    }));

    expect(compileSceneArt({ version: 2, baseSchemeId: 'test', modules }).surfaces).toHaveLength(16);
    expect(() => compileSceneArt({
      version: 2,
      baseSchemeId: 'test',
      modules: [...modules, { ...modules[0], key: 'glass-16' }]
    })).toThrow('scene_art_budget_exceeded');
  });
});
