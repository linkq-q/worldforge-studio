import { describe, expect, it } from 'vitest';
import { createEmptyMap, sampleTerrainHeight, type MapWaterBody } from '../src/shared/map';
import {
  prepareStructuredWaterInPlace,
  riverPathSamples,
  waterBoundaryPoints,
  waterSurfaceLevelAt
} from '../src/shared/mapWater';

describe('structured water geometry', () => {
  it('turns coarse lake controls into deterministic irregular rounded shoreline arcs', () => {
    const lake: MapWaterBody = {
      id: 'rounded-lake', name: 'Rounded lake', type: 'lake', level: 0.4, depth: 2, width: 1,
      points: [[-6, -4], [6, -4], [6, 4], [-6, 4]],
      shorelineSmoothness: 0.85,
      shorelineIrregularity: 0.18,
      seed: 42
    };

    const first = waterBoundaryPoints(lake);
    const repeated = waterBoundaryPoints(lake);
    const differentSeed = waterBoundaryPoints({ ...lake, seed: 43 });

    expect(first.length).toBeGreaterThan(lake.points.length);
    expect(first).toEqual(repeated);
    expect(differentSeed).not.toEqual(first);
    expect(first.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z))).toBe(true);
  });

  it('smooths a river centerline while preserving its upstream and downstream levels', () => {
    const river: MapWaterBody = {
      id: 'sloped-river', name: 'Sloped river', type: 'river', level: 1, depth: 1.2, width: 3,
      points: [[-10, -5], [0, 4], [10, 0]],
      levels: [3, 2, 1],
      shorelineSmoothness: 0.85,
      shorelineIrregularity: 0,
      seed: 9
    };

    const samples = riverPathSamples(river);
    expect(samples.length).toBeGreaterThan(river.points.length);
    expect(samples[0]).toMatchObject({ point: river.points[0], level: 3 });
    expect(samples.at(-1)).toMatchObject({ point: river.points.at(-1), level: 1 });
  });

  it('upgrades legacy flat rivers in memory and carves their channel on load', () => {
    const map = createEmptyMap('legacy river', 'legacy-river');
    map.terrain.heights.fill(3);
    map.waterBodies = [{
      id: 'old-river', name: 'Old river', type: 'river', level: 0.5, depth: 1.2, width: 3,
      points: [[-8, 0], [0, 2], [8, 0]]
    }];

    prepareStructuredWaterInPlace(map);

    expect(map.waterBodies[0].levels).toHaveLength(3);
    expect(map.waterBodies[0].shorelineSmoothness).toBeGreaterThan(0.7);
    expect(sampleTerrainHeight(map, 0, 2)).toBeLessThan(waterSurfaceLevelAt(map.waterBodies[0], 0, 2));
  });
});
