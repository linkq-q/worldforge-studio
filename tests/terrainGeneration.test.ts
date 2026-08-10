import { describe, expect, it } from 'vitest';
import {
  createEmptyMap,
  createMapObject,
  deriveTerrainCliffSegments,
  getTerrainCliffAabbs,
  normalizeMap,
  sampleTerrainHeight
} from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import {
  applyTerrainModifierInPlace,
  TERRAIN_CAPABILITIES,
  generateTerrainInPlace
} from '../src/shared/terrainGeneration';

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

  it('exposes one shared catalog for base, modifier and surface capabilities', () => {
    expect(TERRAIN_CAPABILITIES.map((item) => item.id)).toEqual(expect.arrayContaining([
      'base.cliff-plateau',
      'base.dune-desert',
      'modifier.mountain',
      'modifier.cliff',
      'modifier.terrace',
      'modifier.dune',
      'modifier.island',
      'surface.sand'
    ]));
  });

  it('composes a base, terrace and cliff without a hard-coded combined preset', () => {
    const map = createEmptyMap('composed', 'terrain-composed');
    const result = applyMapOperations(map, [
      { type: 'terrain.generate', preset: 'hills', seed: 9, amplitude: 5, roughness: 0.35 },
      {
        type: 'terrain.modify',
        modifier: 'terrace',
        region: { kind: 'circle', x: 0, z: 0, radius: 12 },
        amplitude: 3,
        layers: 4,
        softness: 0.15
      },
      {
        type: 'terrain.modify',
        modifier: 'cliff',
        layout: 'coast',
        region: { kind: 'path', points: [[8, -18], [8, 18]], width: 8 },
        amplitude: 7,
        softness: 0
      }
    ]);

    expect(Math.abs(sampleTerrainHeight(result, 10, 0) - sampleTerrainHeight(result, 6, 0))).toBeGreaterThan(4);
    expect(deriveTerrainCliffSegments(result).length).toBeGreaterThan(0);
    expect(getTerrainCliffAabbs(result).length).toBeGreaterThan(0);
  });

  it('builds a soft multi-peak mountain range instead of one uniform ridge', () => {
    const map = createEmptyMap('mountain range', 'terrain-mountain-range');
    applyTerrainModifierInPlace(map, {
      modifier: 'mountain',
      region: { kind: 'path', points: [[-20, 0], [20, 0]], width: 18 },
      amplitude: 8,
      softness: 0.75,
      variation: 0.7,
      seed: 29
    });
    const peaks = [-16, -8, 0, 8, 16].map((x) => sampleTerrainHeight(map, x, 0));
    const shoulders = [-12, 0, 12].map((x) => sampleTerrainHeight(map, x, 5));

    expect(Math.max(...peaks) - Math.min(...peaks)).toBeGreaterThan(1);
    expect(Math.min(...shoulders)).toBeGreaterThan(0.4);
    expect(sampleTerrainHeight(map, 0, 11)).toBeLessThan(sampleTerrainHeight(map, 0, 5));
  });

  it('adds sand semantics for the desert base and an ocean for island bases', () => {
    const desert = applyMapOperations(createEmptyMap('desert'), [
      { type: 'terrain.generate', preset: 'dune-desert', seed: 4, amplitude: 3, roughness: 0.5 }
    ]);
    expect(desert.visualSemantics.zones.some((zone) => zone.tags.includes('sand'))).toBe(true);
    expect(desert.renderPromptSuggestions).toContain('沙地流动与低空飞沙');

    const island = applyMapOperations(createEmptyMap('island'), [
      { type: 'terrain.generate', preset: 'archipelago', seed: 5, amplitude: 6, roughness: 0.5 }
    ]);
    expect(island.waterBodies).toContainEqual(expect.objectContaining({ type: 'ocean', level: 0 }));

    const stampedIsland = applyMapOperations(createEmptyMap('stamped island'), [{
      type: 'terrain.modify', modifier: 'island',
      region: { kind: 'circle', x: 0, z: 0, radius: 10 }, amplitude: 5
    }]);
    expect(stampedIsland.waterBodies).toContainEqual(expect.objectContaining({ type: 'ocean', level: 0 }));
  });

  it('re-grounds terrain-following objects and preserves fixed-height objects', () => {
    const map = createEmptyMap('grounding');
    const grounded = createMapObject('tree', 'asset-tree');
    grounded.transform.position = [0, 0, 0];
    const fixed = createMapObject('platform');
    fixed.heightMode = 'fixed';
    fixed.transform.position = [0, 8, 0];
    map.objects.push(grounded, fixed);

    const result = applyMapOperations(map, [
      { type: 'terrain.generate', preset: 'hills', seed: 3, amplitude: 5, roughness: 0.4 }
    ]);
    expect(result.objects[0].transform.position[1]).toBeCloseTo(sampleTerrainHeight(result, 0, 0));
    expect(result.objects[1].transform.position[1]).toBe(8);
  });
});
