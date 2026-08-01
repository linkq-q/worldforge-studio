import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WATER_STATE,
  applyDefaultWaterState
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
});
