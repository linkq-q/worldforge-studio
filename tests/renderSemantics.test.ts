import { describe, expect, it } from 'vitest';
import { BUILTIN_RENDER_SCHEMES, type RenderSuggestion } from '../src/shared/renderScheme';
import { stabilizeRenderSemantics } from '../src/server/renderSemantics';

function softSuggestion(): RenderSuggestion {
  return {
    baseSchemeId: 'render-morning-mist', settings: {}, styleTags: [], explanation: '',
    plan: {
      version: 2,
      baseSchemeId: 'render-morning-mist',
      modules: [{
        id: 'runtime.color-grade',
        params: { recipe: 'misty', contrast: 0.82, saturation: 0.72, shadowLift: 0.1 }
      }]
    }
  };
}

describe('render semantic stabilization', () => {
  it('keeps soft light clear when the prompt did not request haze', () => {
    const result = stabilizeRenderSemantics('柔和的森林晨光', softSuggestion(), BUILTIN_RENDER_SCHEMES);

    expect(result.baseSchemeId).toBe('render-natural-day');
    expect(result.plan.modules).toContainEqual(expect.objectContaining({
      id: 'runtime.light-rig', params: expect.objectContaining({ recipe: 'soft-morning' })
    }));
    expect(result.plan.modules.find((module) => module.id === 'runtime.color-grade')?.params)
      .toMatchObject({ recipe: 'neutral', contrast: 0.96, saturation: 0.9, shadowLift: 0.035 });
  });

  it('does not override an explicitly misty soft atmosphere', () => {
    const source = softSuggestion();
    expect(stabilizeRenderSemantics('柔和晨雾', source, BUILTIN_RENDER_SCHEMES)).toBe(source);
  });

  it('keeps strong daylight colorful without crushing cel shadows', () => {
    const source = softSuggestion();
    source.plan.modules.push(
      { id: 'runtime.light-rig', params: { recipe: 'soft-morning', strength: 1.6, shadowSoftness: 0.1 } },
      { id: 'runtime.surface-style', params: { mode: 'cel', shadowFloor: 0.2 } }
    );

    const result = stabilizeRenderSemantics('艳阳下的高对比森林', source, BUILTIN_RENDER_SCHEMES);
    const grade = result.plan.modules.find((module) => module.id === 'runtime.color-grade')?.params;
    const rig = result.plan.modules.find((module) => module.id === 'runtime.light-rig')?.params;
    const surface = result.plan.modules.find((module) => module.id === 'runtime.surface-style')?.params;

    expect(result.baseSchemeId).toBe('render-natural-day');
    expect(grade).toMatchObject({
      recipe: 'warm', temperature: 0.12, contrast: 1.06, saturation: 1, shadowLift: 0.07, tint: '#fff1df'
    });
    expect(rig).toMatchObject({ recipe: 'hard-day', strength: 1.15, warmth: 0.18, shadowSoftness: 0.2 });
    expect(surface?.shadowFloor).toBe(0.34);
  });

  it('turns an explicit bluer-water refinement into a visible color change', () => {
    const currentPlan = {
      version: 2 as const,
      baseSchemeId: 'render-natural-day',
      modules: [{
        id: 'runtime.water-style' as const,
        params: { color: '#5599ab', shallowColor: '#8cc9c8', depthColor: '#28576a' }
      }]
    };
    const source: RenderSuggestion = {
      baseSchemeId: 'render-natural-day', settings: {}, styleTags: [], explanation: '',
      plan: {
        ...currentPlan,
        modules: [{
          id: 'runtime.water-style',
          params: {
            color: '#4b8fae', shallowColor: '#80bdd0', depthColor: '#234f73',
            reflectionStrength: 0.55, environmentReflectionStrength: 0.22,
            environmentReflectionExposure: 0.5, reflectionFresnel: 1.2
          }
        }]
      }
    };

    const result = stabilizeRenderSemantics(
      '\u6c34\u66f4\u84dd\uff0c\u53cd\u5149\u7a0d\u5fae\u5f31\u4e00\u70b9',
      source,
      BUILTIN_RENDER_SCHEMES,
      currentPlan
    );

    expect(result.plan.modules.find((module) => module.id === 'runtime.water-style')?.params).toMatchObject({
      color: '#3084bb',
      shallowColor: '#6ebada',
      depthColor: '#1a4d7a',
      environmentReflectionStrength: 0.14,
      environmentReflectionExposure: 0.45
    });
    expect(result.plan.modules.find((module) => module.id === 'runtime.water-style')?.params)
      .not.toHaveProperty('reflectionStrength');
    expect(result.plan.modules.find((module) => module.id === 'runtime.water-style')?.params)
      .not.toHaveProperty('reflectionFresnel');
  });
});
