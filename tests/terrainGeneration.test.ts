import { describe, expect, it } from 'vitest';
import { createEmptyMap, normalizeMap, sampleTerrainHeight } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { generateTerrainInPlace } from '../src/shared/terrainGeneration';

describe('deterministic terrain generation', () => {
  it('derives a stable global seed for legacy maps', () => {
    const first = normalizeMap({ id: 'legacy-map' });
    const second = normalizeMap({ id: 'legacy-map' });
    const other = normalizeMap({ id: 'other-map' });
    expect(first.seed).toBe(second.seed);
    expect(first.seed).not.toBe(other.seed);
  });

  it('repeats the same height field for the same seed', () => {
    const first = createEmptyMap('first', 'terrain-a');
    const second = createEmptyMap('second', 'terrain-b');
    generateTerrainInPlace(first, { preset: 'hills', seed: 42, amplitude: 5, roughness: 0.6 });
    generateTerrainInPlace(second, { preset: 'hills', seed: 42, amplitude: 5, roughness: 0.6 });
    expect(first.terrain.heights).toEqual(second.terrain.heights);
  });

  it('builds an island with a higher center than its edge', () => {
    const map = createEmptyMap('island', 'terrain-island');
    generateTerrainInPlace(map, { preset: 'island', seed: 7, amplitude: 6, roughness: 0.5 });
    expect(sampleTerrainHeight(map, 0, 0)).toBeGreaterThan(sampleTerrainHeight(map, 23, 23));
  });

  it('applies local brushes after the generated base inside one transaction', () => {
    const map = createEmptyMap('ordered', 'terrain-ordered');
    const base = applyMapOperations(map, [
      { type: 'terrain.generate', preset: 'hills', seed: 3, amplitude: 4, roughness: 0.4 }
    ]);
    const refined = applyMapOperations(map, [
      { type: 'terrain.generate', preset: 'hills', seed: 3, amplitude: 4, roughness: 0.4 },
      { type: 'terrain.brush', mode: 'raise', point: [0, 0, 0], size: 5, strength: 1 }
    ]);
    expect(sampleTerrainHeight(refined, 0, 0)).toBeGreaterThan(sampleTerrainHeight(base, 0, 0));
  });
});
