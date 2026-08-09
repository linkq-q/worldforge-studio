import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WATER_STATE,
  RENDER_PLAN_WATER_BASE_STATE,
  applyDefaultWaterState,
  applyRenderPlanWaterBaseState
} from '../src/client/defaultWaterState';

describe('default water state', () => {
  it('imports the tuned cartoon water settings from test.json', () => {
    const importState = vi.fn();

    applyDefaultWaterState({ importState });

    expect(importState).toHaveBeenCalledOnce();
    expect(importState).toHaveBeenCalledWith(DEFAULT_WATER_STATE);
    expect(DEFAULT_WATER_STATE).toMatchObject({
      waterMode: 'cartoon',
      uWaterColor: '#349891',
      uFoamStrength: 1.37,
      uWaveHeight: 0.16,
      uWaveSpeed: 1.3,
      highlight: {
        enabled: true,
        intensity: 0.76
      },
      directionalWaves: {
        enabled: true,
        largeStrength: 1.33
      }
    });
  });

  it('starts generated render plans without broad white surface foam', () => {
    const importState = vi.fn();

    applyRenderPlanWaterBaseState({ importState });

    expect(importState).toHaveBeenNthCalledWith(1, DEFAULT_WATER_STATE);
    expect(importState).toHaveBeenNthCalledWith(2, RENDER_PLAN_WATER_BASE_STATE);
    expect(RENDER_PLAN_WATER_BASE_STATE).toEqual({
      uFoamStrength: 0,
      uFoamShadowStrength: 0,
      uContactFoamEnabled: false,
      uWhitecapEnabled: false,
      uToonPatternEnabled: true,
      uRippleDecalEnabled: false
    });
  });
});
