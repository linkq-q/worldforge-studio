import { describe, expect, it } from 'vitest';
import { normalizeMapAiNewAssetRange, planLimits } from '../src/shared/mapPlanning';

describe('map AI asset range', () => {
  it('clamps both ends and keeps minimum at or below maximum', () => {
    expect(normalizeMapAiNewAssetRange(5, 12)).toEqual({ min: 5, max: 12 });
    expect(normalizeMapAiNewAssetRange(20, 8)).toEqual({ min: 8, max: 8 });
    expect(normalizeMapAiNewAssetRange(-2, 99)).toEqual({ min: 0, max: 32 });
    expect(normalizeMapAiNewAssetRange(undefined, 0)).toEqual({ min: 0, max: 0 });
  });

  it('gives a large indoor room enough deterministic object budget for furniture rows', () => {
    const limits = planLimits({ minX: -10, maxX: 10, minY: 0, maxY: 3, minZ: -10, maxZ: 10 }, 'indoor');

    expect(limits.objectCount).toBeGreaterThanOrEqual(200);
  });
});
