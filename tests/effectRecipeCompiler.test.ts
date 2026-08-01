import { describe, expect, it } from 'vitest';
import { compileEffectRecipeLayers } from '../src/client/effectRecipeCompiler';

describe('Voxel effect recipe bridge', () => {
  it('compiles AI-safe recipes to public Voxel effect layers', () => {
    expect(compileEffectRecipeLayers({
      key: 'aura',
      scope: { target: 'material-tag', tag: 'emissive' },
      recipe: 'aura',
      intensity: 1.5,
      speed: 0.8,
      color: '#80bfff'
    })).toEqual([expect.objectContaining({ type: 'ChargeAura' })]);

    expect(compileEffectRecipeLayers({
      key: 'sway',
      scope: { target: 'material-tag', tag: 'foliage' },
      recipe: 'sway',
      intensity: 1,
      speed: 0.7
    })).toEqual([expect.objectContaining({
      type: 'VegetationSway',
      params: expect.objectContaining({ amplitude: 0.08, frequency: 0.7 })
    })]);
  });
});
