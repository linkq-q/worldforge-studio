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
import { PLAYER_GRAVITY, PLAYER_JUMP_SPEED } from '../src/shared/protocol';
import {
  applyTerrainModifierInPlace,
  TERRAIN_CAPABILITIES,
  TERRAIN_SURFACE_RECIPES,
  generateTerrainInPlace,
  refineTerrainInPlace
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
      'modifier.ridge',
      'modifier.valley',
      'modifier.basin',
      'modifier.cliff',
      'modifier.terrace',
      'modifier.dune',
      'modifier.island',
      'surface.sand'
    ]));
    expect(TERRAIN_SURFACE_RECIPES).toEqual([
      'default',
      'compacted-earth',
      'garden-stone',
      'asphalt',
      'concrete',
      'brick-paver',
      'cobblestone',
      'gravel',
      'mud'
    ]);
  });

  it('persists compatible surface material recipes without changing the semantic surface', () => {
    const map = applyMapOperations(createEmptyMap('road materials'), [
      {
        type: 'terrain.surface', surface: 'soil', material: 'compacted-earth',
        region: { kind: 'path', points: [[-8, 0], [8, 0]], width: 2 }, zoneId: 'dirt-path'
      },
      {
        type: 'terrain.surface', surface: 'paving', material: 'garden-stone',
        region: { kind: 'path', points: [[0, -8], [0, 8]], width: 3 }, zoneId: 'garden-path'
      },
      {
        type: 'terrain.surface', surface: 'paving', material: 'concrete',
        region: { kind: 'path', points: [[-8, -4], [8, -4]], width: 3 }, zoneId: 'sidewalk'
      },
      {
        type: 'terrain.surface', surface: 'soil', material: 'gravel',
        region: { kind: 'path', points: [[-8, 4], [8, 4]], width: 2 }, zoneId: 'gravel-path'
      }
    ]);

    expect(map.visualSemantics.zones).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dirt-path', tags: ['soil'], material: 'compacted-earth' }),
      expect.objectContaining({ id: 'garden-path', tags: ['paving', 'settlement'], material: 'garden-stone' }),
      expect.objectContaining({ id: 'sidewalk', tags: ['paving', 'settlement'], material: 'concrete' }),
      expect.objectContaining({ id: 'gravel-path', tags: ['soil'], material: 'gravel' })
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

  it('builds a connected mountain massif with subdued peak variation', () => {
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

    expect(Math.max(...peaks) - Math.min(...peaks)).toBeGreaterThan(0.08);
    expect(Math.min(...shoulders)).toBeGreaterThan(0.4);
    expect(sampleTerrainHeight(map, 0, 11)).toBeLessThan(sampleTerrainHeight(map, 0, 5));
  });

  it('keeps walkable mountains broad relative to their height', () => {
    const map = createEmptyMap('walkable massif', 'terrain-walkable-massif');
    applyTerrainModifierInPlace(map, {
      modifier: 'mountain',
      access: 'walkable',
      region: { kind: 'circle', x: 0, z: 0, radius: 18 },
      amplitude: 10,
      softness: 0.7,
      variation: 0.45,
      seed: 37
    });
    const center = sampleTerrainHeight(map, 0, 0);
    const shoulders = [
      sampleTerrainHeight(map, -8, 0), sampleTerrainHeight(map, 8, 0),
      sampleTerrainHeight(map, 0, -8), sampleTerrainHeight(map, 0, 8)
    ];

    expect(Math.max(...map.terrain.heights)).toBeLessThanOrEqual(36 / 7 + 0.25);
    expect(Math.min(...shoulders)).toBeGreaterThan(center * 0.35);
  });

  it('downgrades an undersized ridge instead of creating a narrow spine', () => {
    const map = createEmptyMap('small ridge', 'terrain-small-ridge');
    applyTerrainModifierInPlace(map, {
      modifier: 'ridge',
      access: 'walkable',
      region: { kind: 'path', points: [[-12, 0], [12, 0]], width: 10 },
      amplitude: 6,
      softness: 0.55,
      variation: 0.4,
      seed: 19
    });

    expect(Math.max(...map.terrain.heights)).toBeLessThanOrEqual(10 / 7 + 0.25);
  });

  it('builds mountain terraces with platform steps below the jump budget', () => {
    const map = createEmptyMap('jump terraces', 'terrain-jump-terraces');
    applyTerrainModifierInPlace(map, {
      modifier: 'mountain',
      access: 'walkable',
      layout: 'terraces',
      region: { kind: 'circle', x: 0, z: 0, radius: 22 },
      amplitude: 7,
      layers: 3,
      softness: 0.08,
      variation: 0.25,
      seed: 43
    });
    const jumpApex = PLAYER_JUMP_SPEED ** 2 / (2 * PLAYER_GRAVITY);

    expect(maximumNeighborDelta(map.terrain.heights, map.terrain.resolutionX, map.terrain.resolutionZ))
      .toBeLessThan(jumpApex * 0.72 + 0.25);
    expect(flatNeighborRatio(map, 22)).toBeGreaterThan(0.25);
  });

  it('gives cliff plateaus a readable shoulder instead of a one-cell AI cut', () => {
    const map = createEmptyMap('natural cliff', 'terrain-natural-cliff');
    generateTerrainInPlace(map, {
      preset: 'cliff-plateau', seed: 24, amplitude: 8, roughness: 0.55, direction: 0
    });
    const samples = Array.from({ length: 49 }, (_, index) => sampleTerrainHeight(map, index - 24, 0));
    const deltas = samples.slice(1).map((height, index) => Math.abs(height - samples[index]));
    const transitionCells = deltas.filter((delta) => delta > 0.2).length;

    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(5);
    expect(transitionCells).toBeGreaterThanOrEqual(6);
    expect(Math.max(...deltas)).toBeLessThan(2.5);
  });

  it('rotates directional valleys, canyons and cliff plateaus from the requested direction', () => {
    const east = createEmptyMap('east cliff', 'terrain-east-cliff');
    const north = createEmptyMap('north cliff', 'terrain-north-cliff');
    generateTerrainInPlace(east, {
      preset: 'cliff-plateau', seed: 24, amplitude: 7, roughness: 0.4, direction: 0
    });
    generateTerrainInPlace(north, {
      preset: 'cliff-plateau', seed: 24, amplitude: 7, roughness: 0.4, direction: 90
    });

    expect(sampleTerrainHeight(east, 12, 0)).toBeGreaterThan(sampleTerrainHeight(east, -12, 0) + 4);
    expect(sampleTerrainHeight(north, 0, 12)).toBeGreaterThan(sampleTerrainHeight(north, 0, -12) + 4);
  });

  it('naturalizes sharp sculpting while preserving the main relief', () => {
    const map = createEmptyMap('refined terrain', 'terrain-refined');
    for (let z = 0; z < map.terrain.resolutionZ; z += 1) {
      for (let x = 0; x < map.terrain.resolutionX; x += 1) {
        map.terrain.heights[z * map.terrain.resolutionX + x] = x < map.terrain.resolutionX / 2 ? 0 : 8;
      }
    }
    const before = maximumNeighborDelta(map.terrain.heights, map.terrain.resolutionX, map.terrain.resolutionZ);

    refineTerrainInPlace(map, { erosion: 0.45, drainage: 0, iterations: 5, talus: 48 });

    const after = maximumNeighborDelta(map.terrain.heights, map.terrain.resolutionX, map.terrain.resolutionZ);
    expect(after).toBeLessThan(before);
    expect(Math.max(...map.terrain.heights) - Math.min(...map.terrain.heights)).toBeGreaterThan(6);
  });

  it('composes ridge, valley and basin primitives without hand-authored brush piles', () => {
    const result = applyMapOperations(createEmptyMap('landforms', 'terrain-landforms'), [
      { type: 'terrain.generate', preset: 'plain', amplitude: 0 },
      {
        type: 'terrain.modify', modifier: 'ridge',
        region: { kind: 'path', points: [[-20, -18], [20, -18]], width: 32 },
        amplitude: 5, softness: 0.55, variation: 0.4
      },
      {
        type: 'terrain.modify', modifier: 'valley',
        region: { kind: 'path', points: [[-20, 5], [20, 5]], width: 10 },
        amplitude: 3, softness: 0.65, variation: 0.3
      },
      {
        type: 'terrain.modify', modifier: 'basin',
        region: { kind: 'circle', x: 12, z: 13, radius: 7 },
        amplitude: 2, softness: 0.7, variation: 0.2
      },
      { type: 'terrain.refine', erosion: 0.2, drainage: 0.06, iterations: 3, talus: 48 }
    ]);

    expect(sampleTerrainHeight(result, 0, -18)).toBeGreaterThan(2.5);
    expect(sampleTerrainHeight(result, 0, 5)).toBeLessThan(-1);
    expect(sampleTerrainHeight(result, 12, 13)).toBeLessThan(-0.8);
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

    const hills = applyMapOperations(island, [
      { type: 'terrain.generate', preset: 'hills', seed: 6, amplitude: 4, roughness: 0.4 }
    ]);
    expect(hills.waterBodies).not.toContainEqual(expect.objectContaining({ id: 'terrain-ocean' }));
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

function maximumNeighborDelta(heights: number[], width: number, depth: number): number {
  let maximum = 0;
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = z * width + x;
      if (x + 1 < width) maximum = Math.max(maximum, Math.abs(heights[index] - heights[index + 1]));
      if (z + 1 < depth) maximum = Math.max(maximum, Math.abs(heights[index] - heights[index + width]));
    }
  }
  return maximum;
}

function flatNeighborRatio(map: ReturnType<typeof createEmptyMap>, radius: number): number {
  let flat = 0;
  let total = 0;
  for (let z = 1; z < map.terrain.resolutionZ - 1; z += 1) {
    for (let x = 1; x < map.terrain.resolutionX - 1; x += 1) {
      const worldX = x / (map.terrain.resolutionX - 1) * map.box.size[0] - map.box.size[0] / 2;
      const worldZ = z / (map.terrain.resolutionZ - 1) * map.box.size[2] - map.box.size[2] / 2;
      if (Math.hypot(worldX, worldZ) > radius) continue;
      const index = z * map.terrain.resolutionX + x;
      total += 2;
      if (Math.abs(map.terrain.heights[index] - map.terrain.heights[index + 1]) < 0.03) flat += 1;
      if (Math.abs(map.terrain.heights[index] - map.terrain.heights[index + map.terrain.resolutionX]) < 0.03) flat += 1;
    }
  }
  return flat / Math.max(1, total);
}
