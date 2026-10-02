import { describe, expect, it } from 'vitest';
import { createEmptyMap, normalizeMap, sampleTerrainHeight, type MapWaterBody } from '../src/shared/map';
import {
  carveWaterBasinInPlace,
  distanceToWater,
  prepareStructuredWaterInPlace,
  riverEdgePairs,
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
      widths: [4, 12, 7],
      shorelineSmoothness: 0.85,
      shorelineIrregularity: 0,
      seed: 9
    };

    const samples = riverPathSamples(river);
    expect(samples.length).toBeGreaterThan(river.points.length);
    expect(samples[0]).toMatchObject({ point: river.points[0], level: 3 });
    expect(samples[0].width).toBe(4);
    expect(samples.at(-1)).toMatchObject({ point: river.points.at(-1), level: 1, width: 7 });
    expect(samples.some(sample => sample.width > 10)).toBe(true);
    expect(samples.every((sample, index) => index === 0 || Math.abs(sample.width - samples[index - 1].width) < 4)).toBe(true);
  });

  it('applies deterministic river irregularity without moving either endpoint', () => {
    const river: MapWaterBody = {
      id: 'natural-river', name: 'Natural river', type: 'river', level: 0, depth: 1.5, width: 12,
      points: [[-60, 0], [0, 0], [60, 0]], levels: [3, 2, 1],
      shorelineSmoothness: 0.8, shorelineIrregularity: 0.35, seed: 17
    };

    const straight = riverPathSamples({ ...river, shorelineIrregularity: 0 });
    const natural = riverPathSamples(river);
    expect(natural).toEqual(riverPathSamples(river));
    expect(natural).not.toEqual(straight);
    expect(straight.every(sample => sample.width === river.width)).toBe(true);
    expect(natural[0]).toEqual(straight[0]);
    expect(natural.at(-1)).toEqual(straight.at(-1));
    expect(riverPathSamples({ ...river, seed: 18 })).not.toEqual(natural);
    expect(Math.max(...natural.map((sample) => Math.abs(sample.point[1])))).toBeGreaterThan(0.25);
    expect(Math.min(...natural.slice(1, -1).map(sample => sample.width))).toBeLessThan(11);
    const moreIrregular = { ...river, shorelineIrregularity: 0.65 };
    expect(riverPathSamples(moreIrregular)).not.toEqual(riverPathSamples({ ...river, shorelineIrregularity: 0.6 }));
    expect(normalizeMap({ ...createEmptyMap('river', 'river-irregularity'), waterBodies: [moreIrregular] })
      .waterBodies[0].shorelineIrregularity).toBe(0.65);

    const straightEdges = riverEdgePairs({ ...river, shorelineIrregularity: 0 });
    const naturalEdges = riverEdgePairs(river);
    expect(naturalEdges.slice(1, -1).some((edge, index) => {
      const straightEdge = straightEdges[index + 1];
      const leftShift = edge.left[1] - straightEdge.left[1];
      const rightShift = edge.right[1] - straightEdge.right[1];
      return Math.abs(leftShift - rightShift) > 0.5;
    })).toBe(true);
  });

  it('carves a deep central bed across part of the river width instead of a single V-shaped line', () => {
    const map = createEmptyMap('deep river', 'deep-river');
    map.terrain.heights.fill(3);
    const river: MapWaterBody = {
      id: 'deep-river', name: 'Deep river', type: 'river', level: 0, depth: 2.2, width: 6,
      points: [[0, -12], [0, 12]], levels: [0, 0],
      shorelineSmoothness: 0.9, shorelineIrregularity: 0, seed: 7
    };

    carveWaterBasinInPlace(map, river);

    expect(sampleTerrainHeight(map, 0, 0)).toBeCloseTo(-2.2, 1);
    expect(sampleTerrainHeight(map, 1, 0)).toBeCloseTo(-2.2, 1);
    expect(sampleTerrainHeight(map, 2.8, 0)).toBeGreaterThan(-0.8);
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

  it('measures habitat distance from the actual water boundary', () => {
    const map = createEmptyMap('lake distance', 'lake-distance');
    map.waterBodies = [{
      id: 'lake', name: 'Lake', type: 'lake', level: 0, depth: 2, width: 1,
      points: [[-3, -3], [3, -3], [3, 3], [-3, 3]],
      shorelineSmoothness: 0,
      shorelineIrregularity: 0
    }];

    expect(distanceToWater(map, 0, 0)).toBe(0);
    expect(distanceToWater(map, 5, 0)).toBeCloseTo(2);
  });
});
