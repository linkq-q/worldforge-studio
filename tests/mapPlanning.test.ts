import { describe, expect, it } from 'vitest';
import { normalizeMapAiNewAssetRange } from '../src/shared/mapPlanning';

describe('map AI asset range', () => {
  it('clamps both ends and keeps minimum at or below maximum', () => {
    expect(normalizeMapAiNewAssetRange(5, 12)).toEqual({ min: 5, max: 12 });
    expect(normalizeMapAiNewAssetRange(20, 8)).toEqual({ min: 8, max: 8 });
    expect(normalizeMapAiNewAssetRange(-2, 99)).toEqual({ min: 0, max: 32 });
    expect(normalizeMapAiNewAssetRange(undefined, 0)).toEqual({ min: 0, max: 0 });
  });
});
