import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import type { MapOperation } from '../src/shared/mapOperations';
import { checkGentleSkiSlope } from '../scripts/checkGentleSkiSlope';

const snowRun: MapOperation = {
  type: 'terrain.surface', surface: 'snow',
  region: { kind: 'path', points: [[0, -40], [0, 40]], width: 9 }
};

describe('gentle ski slope preflight', () => {
  it('accepts broad relief with a long, gradual snow run and rejects a cliff', () => {
    const map = createEmptyMap('ski slope', undefined, [96, 32, 96]);
    const { resolutionX, resolutionZ, heights } = map.terrain;
    for (let z = 0; z < resolutionZ; z++) {
      for (let x = 0; x < resolutionX; x++) heights[z * resolutionX + x] = z / (resolutionZ - 1) * 20;
    }
    expect(checkGentleSkiSlope(map, [snowRun]).valid).toBe(true);
    for (let z = 0; z < resolutionZ; z++) {
      for (let x = 0; x < resolutionX; x++) heights[z * resolutionX + x] = z < resolutionZ / 2 ? 0 : 20;
    }
    expect(checkGentleSkiSlope(map, [snowRun]).valid).toBe(false);
  });
});
