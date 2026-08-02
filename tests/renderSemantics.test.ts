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
    const result = stabilizeRenderSemantics('柔和的森林晨光', softSuggestion(), BUILTIN_RENDER_SCHEMES, false);

    expect(result.baseSchemeId).toBe('render-natural-day');
    expect(result.plan.modules).toContainEqual(expect.objectContaining({
      id: 'runtime.light-rig', params: expect.objectContaining({ recipe: 'soft-morning' })
    }));
    expect(result.plan.modules.find((module) => module.id === 'runtime.color-grade')?.params)
      .toMatchObject({ recipe: 'neutral', contrast: 0.96, saturation: 0.9, shadowLift: 0.035 });
  });

  it('does not override an explicitly misty soft atmosphere', () => {
    const source = softSuggestion();
    expect(stabilizeRenderSemantics('柔和晨雾', source, BUILTIN_RENDER_SCHEMES, false)).toBe(source);
  });
});
