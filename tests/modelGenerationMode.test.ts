import { describe, expect, it } from 'vitest';
import {
  MODEL_GENERATION_MODES,
  normalizeModelGenerationMode
} from '../src/shared/modelGenerationMode';
import { createEmptyMap, normalizeMap } from '../src/shared/map';

describe('model generation modes', () => {
  it('matches every mode exposed by Voxel Studio', () => {
    expect(MODEL_GENERATION_MODES.map((mode) => mode.key)).toEqual([
      'standard', 'lite', 'voxel', 'voxel-pro', 'curve', 'wire', 'math'
    ]);
  });

  it('rejects unknown modes', () => {
    expect(normalizeModelGenerationMode('curve')).toBe('curve');
    expect(normalizeModelGenerationMode('unknown')).toBe('voxel');
  });

  it('stores one mode on the map and gives legacy maps a voxel fallback', () => {
    expect(createEmptyMap('curve map', 'curve-map', [48, 12, 48], 'curve').assetGenerationMode).toBe('curve');
    expect(normalizeMap({ id: 'legacy-map' }).assetGenerationMode).toBe('voxel');
  });
});
