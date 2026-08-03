import { describe, expect, it } from 'vitest';
import { createEmptyMap, normalizeMap } from '../src/shared/map';
import { normalizeRenderPlan } from '../src/shared/renderPlan';
import {
  compileVisualDirection,
  normalizeMapVisualSemantics,
  normalizeVisualDirection
} from '../src/shared/visualDirection';

describe('visual direction contract', () => {
  it('keeps legacy render plans compatible', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: []
    });

    expect(plan.visualDirection).toBeUndefined();
  });

  it('normalizes AI-facing semantic values before they reach render code', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [],
      visualDirection: {
        version: 99,
        contrastMode: 'dramatic',
        timeOfDay: 'evening',
        temperature: 'warm',
        palette: { sky: '#ABCDEF', fog: 'invalid' },
        atmosphereFx: { masterStrength: 4, pollen: -1, sunShafts: 0.7 }
      }
    }, undefined, undefined, 'ai');

    expect(plan.visualDirection).toMatchObject({
      version: 1,
      contrastMode: 'dramatic',
      timeOfDay: 'evening',
      palette: { sky: '#abcdef', fog: '#a9c8ce' },
      atmosphereFx: { masterStrength: 1, pollen: 0, sunShafts: 0.7 }
    });
  });

  it('compiles distinct bounded contrast methods', () => {
    const bright = compileVisualDirection(normalizeVisualDirection({ contrastMode: 'bright-cartoon' }));
    const colored = compileVisualDirection(normalizeVisualDirection({ contrastMode: 'colored-shadow' }));
    const dramatic = compileVisualDirection(normalizeVisualDirection({ contrastMode: 'dramatic' }));

    expect(bright.surfaceShadowFloor).toBeGreaterThan(colored.surfaceShadowFloor);
    expect(colored.surfaceShadowFloor).toBeGreaterThan(dramatic.surfaceShadowFloor);
    expect(dramatic.lightRig.recipe).toBe('backlit');
  });
});

describe('map visual semantics contract', () => {
  it('adds a deterministic default wind field to old and new maps', () => {
    expect(createEmptyMap('wind').visualSemantics.wind.speed).toBeGreaterThan(0);
    expect(normalizeMap({ id: 'legacy-map' }).visualSemantics.zones).toEqual([]);
  });

  it('normalizes spatial zones and shared wind without inventing effect recipes', () => {
    const semantics = normalizeMapVisualSemantics({
      zones: [
        { id: 'pond', tags: ['water', 'lowland', 'unknown'], center: [12, -4], radius: 0, intensity: 2 },
        { id: '', tags: ['forest'], center: [0, 0], radius: 12 }
      ],
      wind: { direction: [3, 4], speed: 9, gustStrength: -1, gustFrequency: 0 }
    });

    expect(semantics.zones).toEqual([{
      id: 'pond',
      tags: ['water', 'lowland'],
      center: [12, -4],
      radius: 0.5,
      intensity: 1
    }]);
    expect(semantics.wind.direction[0]).toBeCloseTo(0.6);
    expect(semantics.wind.direction[1]).toBeCloseTo(0.8);
    expect(semantics.wind).toMatchObject({ speed: 2, gustStrength: 0, gustFrequency: 0.01 });
  });
});
