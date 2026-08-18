import { describe, expect, it } from 'vitest';
import { normalizeRenderPlan } from '../src/shared/renderPlan';
import { compileRuntimeWeather } from '../src/shared/weather';

describe('runtime weather', () => {
  it('keeps bounded high-level weather controls in the render plan', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{
        id: 'runtime.weather',
        params: {
          preset: 'snow', intensity: 0.8, wind: 0.35, flakeSize: 1.2,
          snowCover: 0.9, transitionSeconds: 6, timeOfDay: 8, daySpeed: 0
        }
      }]
    });

    const weather = compileRuntimeWeather(plan);
    expect(weather).toMatchObject({
      preset: 'snow', precipitationKind: 'snow', precipitation: 0.48,
      wind: 0.35, flakeSize: 1.2, snowCover: 0.9,
      transitionSeconds: 6, timeOfDay: 8, daySpeed: 0
    });
  });

  it('maps all five presets to distinct lighting, fog, and precipitation targets', () => {
    const states = ['clear', 'overcast', 'rain', 'snow', 'storm'].map((preset) => compileRuntimeWeather({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{ id: 'runtime.weather', params: { preset, intensity: 1 } }]
    }));

    expect(states.map((state) => state.preset)).toEqual(['clear', 'overcast', 'rain', 'snow', 'storm']);
    expect(states[0].precipitation).toBe(0);
    expect(states[2].precipitationKind).toBe('rain');
    expect(states[3].precipitationKind).toBe('snow');
    expect(states[4].lightning).toBe(true);
    expect(states[4].fogDensity).toBeGreaterThan(states[1].fogDensity);
  });
});
