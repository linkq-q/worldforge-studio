import { describe, expect, it } from 'vitest';
import {
  compileRuntimeColorGrade,
  compileRuntimeEffectRecipes,
  compileRuntimeHdriSky,
  compileRuntimeGrassStyle,
  compileRuntimeLightRig,
  compileRuntimeMaterialThemes,
  compileRuntimePostQuality,
  compileRuntimeWaterStyles,
  compileRenderPlan,
  createDefaultRenderAccessPolicy,
  fogDensityForVisibilityDistance,
  normalizeRenderAccessPolicy,
  normalizeRenderPlan
} from '../src/shared/renderPlan';

describe('RenderPlan V2 capabilities', () => {
  it('supports repeatable scoped material and effect recipes', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [
        {
          key: 'leaves',
          id: 'runtime.material-theme',
          scope: { target: 'material-tag', tag: 'foliage' },
          params: { recipe: 'autumn', strength: 0.8 }
        },
        {
          key: 'rocks',
          id: 'runtime.material-theme',
          scope: { target: 'material-tag', tag: 'stone' },
          params: { recipe: 'weathered', strength: 0.6 }
        },
        {
          key: 'magic-metal',
          id: 'runtime.effect-recipe',
          scope: { target: 'material-tag', tag: 'metal' },
          params: { recipe: 'fresnel', intensity: 1.2, color: '#88bbff' }
        }
      ]
    }, ['render-natural-day']);

    expect(plan.version).toBe(2);
    expect(compileRuntimeMaterialThemes(plan)).toHaveLength(2);
    expect(compileRuntimeEffectRecipes(plan)).toEqual([expect.objectContaining({
      recipe: 'fresnel',
      scope: { target: 'material-tag', tag: 'metal' }
    })]);
  });

  it('keeps aura and vegetation sway inside the effect recipe whitelist', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [
        { id: 'runtime.effect-recipe', params: { recipe: 'aura' } },
        { id: 'runtime.effect-recipe', params: { recipe: 'sway' } }
      ]
    });

    expect(compileRuntimeEffectRecipes(plan).map((recipe) => recipe.recipe)).toEqual(['aura', 'sway']);
  });

  it('compiles the new scene-level runtime modules', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [
        {
          id: 'runtime.color-grade',
          params: {
            recipe: 'misty',
            temperature: -0.2,
            contrast: 0.82,
            saturation: 0.7,
            shadowLift: 0.12
          }
        },
        {
          id: 'runtime.water-style',
          params: {
            recipe: 'calm-lake',
            opacity: 0.82,
            shallowColor: '#9bdbe0',
            depthColor: '#16354a',
            foamColor: '#fff4d6',
            waveStrength: 0.2,
            waveSpeed: 0.45,
            waveScale: 2.4,
            waveDirection: 135,
            waveSharpness: 3.1,
            foamStrength: 0.3,
            shoreFoamWidth: 0.12,
            shoreWaveRange: 0.72,
            shoreWaveFrequency: 10,
            shoreWaveWidth: 0.32,
            shoreWaveBreakup: 0.55,
            environmentReflectionStrength: 0.24,
            environmentReflectionExposure: 0.5
          }
        },
        {
          id: 'runtime.grass-style',
          params: {
            rootColor: '#284f22', tipColor: '#a4df72', paletteVariation: 0.2,
            bands: '2', bladeHeight: 1.1, bladeWidth: 0.21,
            windStrength: 0.4, windAngle: 90, groundTint: 'off'
          }
        },
        { id: 'runtime.light-rig', params: { recipe: 'soft-morning', strength: 0.8 } },
        {
          id: 'runtime.post-quality',
          params: { bloom: 'soft', ssao: 'soft', depthOfField: 'off' }
        }
      ]
    });

    expect(compileRuntimeColorGrade(plan)).toMatchObject({ recipe: 'misty', contrast: 0.82 });
    expect(compileRuntimeWaterStyles(plan)[0]).toMatchObject({
      recipe: 'calm-lake',
      opacity: 0.82,
      shallowColor: '#9bdbe0',
      depthColor: '#16354a',
      foamColor: '#fff4d6',
      waveSpeed: 0.45,
      waveScale: 2.4,
      waveDirection: 135,
      waveSharpness: 3.1,
      shoreFoamWidth: 0.12,
      shoreWaveRange: 0.72,
      shoreWaveFrequency: 10,
      shoreWaveWidth: 0.32,
      shoreWaveBreakup: 0.55,
      environmentReflectionStrength: 0.24,
      environmentReflectionExposure: 0.5
    });
    expect(compileRuntimeGrassStyle(plan)).toMatchObject({
      rootColor: '#284f22', tipColor: '#a4df72', paletteVariation: 0.2,
      bands: 2, bladeHeight: 1.1, bladeWidth: 0.21,
      windStrength: 0.4, groundTint: false
    });
    expect(compileRuntimeGrassStyle(plan).windDirection[0]).toBeCloseTo(0, 5);
    expect(compileRuntimeGrassStyle(plan).windDirection[1]).toBeCloseTo(1, 5);
    expect(compileRuntimeLightRig(plan)).toMatchObject({ recipe: 'soft-morning', strength: 0.8 });
    expect(compileRuntimePostQuality(plan)).toEqual({
      bloom: 'soft',
      bloomStrength: undefined,
      ssao: 'soft',
      depthOfField: 'off'
    });
  });

  it('compiles an HDRI sky for developers and blocks the AI from picking a texture', () => {
    const params = {
      texture: 'sunset_meadow.hdr',
      rotation: 120,
      exposure: 1.3,
      saturation: 0.9,
      intensity: 1.1,
      backgroundVisibility: 'hidden',
      environmentIntensity: 0.62,
      tint: '#ffe9d0',
      tintStrength: 0.25,
      useAsEnvironment: 'on'
    };
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{ id: 'environment.hdri', params }]
    }, ['render-natural-day'], undefined, 'developer');

    expect(compileRuntimeHdriSky(plan)).toEqual({
      texture: 'sunset_meadow.hdr',
      rotation: 120,
      exposure: 1.3,
      saturation: 0.9,
      intensity: 1.1,
      backgroundVisibility: 'hidden',
      environmentIntensity: 0.62,
      tint: '#ffe9d0',
      tintStrength: 0.25,
      useAsEnvironment: true
    });

    // The texture list is local to the machine, so the AI must not name files.
    expect(() => normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{ id: 'environment.hdri', params }]
    }, ['render-natural-day'], undefined, 'ai')).toThrow('invalid_render_code:environment.hdri.texture');
  });

  it('falls back to no HDRI when the plan does not declare one', () => {
    const plan = normalizeRenderPlan({ version: 2, baseSchemeId: 'render-natural-day', modules: [] });

    expect(compileRuntimeHdriSky(plan)).toMatchObject({
      texture: '',
      rotation: 0,
      exposure: 1,
      backgroundVisibility: 'visible',
      environmentIntensity: 1,
      useAsEnvironment: true
    });
  });

  it('compiles the three indoor light recipes', () => {
    for (const recipe of ['interior-daylight', 'interior-warm', 'interior-night'] as const) {
      const plan = normalizeRenderPlan({
        version: 2,
        baseSchemeId: 'render-indoor-neutral',
        modules: [{ id: 'runtime.light-rig', params: { recipe } }]
      });
      expect(compileRuntimeLightRig(plan).recipe).toBe(recipe);
    }
  });

  it('compiles semantic fog visibility before the legacy density control', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{
        id: 'atmosphere.fog',
        params: { visibilityDistance: 300, density: 0.04 }
      }]
    });

    expect(compileRenderPlan(plan).fogDensity).toBeCloseTo(fogDensityForVisibilityDistance(300), 8);
    expect(compileRenderPlan(plan).fogDensity).toBeLessThan(0.006);
  });

  it('enforces each scheme policy for AI plans while retaining developer ranges', () => {
    const defaults = createDefaultRenderAccessPolicy();
    expect(defaults.parameters.find((entry) => (
      entry.moduleId === 'runtime.grass-style' && entry.parameter === 'normalFlatten'
    ))?.ai.enabled).toBe(false);
    expect(defaults.parameters.find((entry) => (
      entry.moduleId === 'runtime.outline-style' && entry.parameter === 'fadeEnd'
    ))?.ai.enabled).toBe(false);
    expect(defaults.parameters.find((entry) => (
      entry.moduleId === 'runtime.water-style' && entry.parameter === 'opacity'
    ))).toMatchObject({ ai: { max: 0.78 }, developer: { max: 1 } });
    expect(defaults.parameters.find((entry) => (
      entry.moduleId === 'runtime.water-style' && entry.parameter === 'environmentReflectionStrength'
    ))).toMatchObject({ ai: { max: 0.35 }, developer: { max: 1 } });
    expect(defaults.parameters.find((entry) => (
      entry.moduleId === 'presentation.exposure' && entry.parameter === 'value'
    ))).toMatchObject({ ai: { max: 1.5 }, developer: { max: 3 } });
    const policy = normalizeRenderAccessPolicy({
      version: 1,
      parameters: defaults.parameters.map((entry) => entry.moduleId === 'runtime.color-grade'
        && entry.parameter === 'contrast'
        ? {
            ...entry,
            ai: { enabled: true, min: 0.8, max: 1.1 },
            developer: { enabled: true, min: 0.5, max: 1.5 }
          }
        : entry)
    });

    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{
        id: 'runtime.color-grade',
        params: { contrast: 1.4 }
      }]
    }, ['render-natural-day'], policy, 'ai');

    expect(plan.modules[0]?.params.contrast).toBe(1.1);
    expect(policy.parameters.find((entry) => (
      entry.moduleId === 'runtime.color-grade' && entry.parameter === 'contrast'
    ))?.developer.max).toBe(1.5);
  });

  it('keeps non-blue AI water palettes while clamping opacity and environment reflection', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{
        id: 'runtime.water-style',
        params: {
          color: '#61733c',
          shallowColor: '#91a85e',
          depthColor: '#29351d',
          opacity: 1,
          environmentReflectionStrength: 1
        }
      }]
    }, ['render-natural-day'], createDefaultRenderAccessPolicy(), 'ai');

    expect(plan.modules[0]?.params).toMatchObject({
      color: '#61733c',
      shallowColor: '#91a85e',
      depthColor: '#29351d',
      opacity: 0.78,
      environmentReflectionStrength: 0.35
    });
  });

  it('drops retired planar reflection parameters from stored plans', () => {
    const plan = normalizeRenderPlan({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{
        id: 'runtime.water-style',
        params: {
          environmentReflectionStrength: 0.2,
          reflectionStrength: 0.8,
          reflectionDistortion: 0.06,
          reflectionFresnel: 1.4
        }
      }]
    });

    expect(plan.modules[0]?.params).toEqual({ environmentReflectionStrength: 0.2 });
  });
});
