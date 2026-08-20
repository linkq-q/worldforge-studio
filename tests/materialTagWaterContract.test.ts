import { describe, expect, it } from 'vitest';
import materialTagVocabulary from '@voxel-studio/render-runtime/model/material-tags-v1.json';

describe('material-tag model water contract', () => {
  it('keeps the canonical 3d-generate pool and fall tuning values', () => {
    const water = (materialTagVocabulary as any).tags.water.runtime;
    expect(water.target).toBe('ModelWaterInstances');
    expect(water.poolTuning).toMatchObject({
      uOpacity: 0.7,
      uWaveHeight: 0.13,
      uWaveSpeed: 0.7,
      uFoamStrength: 1,
      uToonPatternIntensity: 0.81,
      uShoreEdgeAlpha: 0.31,
      uDetailWaveStrength: 0.46,
      uDetailWaveScale: 12.4,
      uDetailWaveSpeed: -3.8,
      uUseDirectionalWaves: 1,
      uRippleDecalEnabled: 1,
      uContactFoamStrength: 2.45,
      uUseWaterEnvReflection: 1,
      uWaterReflectionStrength: 0.55
    });
    expect(water.fallTuning).toEqual({
      uOpacity: 0.7,
      uEdgeAlpha: 0.3,
      uBulge: 0.6,
      uColumnCount: 6,
      uColumnStyle: 1,
      uEdgeWobble: 0.19,
      uEdgeWobbleScale: 1.8,
      uFlowSpeed: -2.3,
      uFallAcceleration: 0,
      uSheetDrift: 0.04,
      uSheetTurbulence: 0.08,
      uFlowWarp: 0.32,
      uStrandBreakup: 0.41
    });
  });
});
