import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, reassignRegionGenerationOwnersInPlace } from '../src/shared/map';
import { findSafeSpawnPosition, isSpawnPositionSafe } from '../src/shared/mapSpawnSafety';
import {
  createMapEdgeMask,
  findAdjacentMapRegion,
  isPointInsidePlayableArea,
  maxMapRegionCount,
  measureMapLayoutCoverage,
  mergeMapRegions,
  pointInMapRegion,
  splitMapRegion,
  type MapEcologyRegion
} from '../src/shared/mapLayout';

function region(): MapEcologyRegion {
  return {
    id: 'forest',
    name: '森林',
    prompt: '茂密针叶林',
    groupId: 'woodland',
    color: '#4f8a65',
    points: [[-24, -24], [24, -24], [24, 24], [-24, 24]],
    boundaryLocked: false,
    contentLocked: false
  };
}

describe('map ecology layout', () => {
  it('derives the agreed region limits from map size', () => {
    expect(maxMapRegionCount([48, 12, 48])).toBe(2);
    expect(maxMapRegionCount([96, 16, 96])).toBe(4);
    expect(maxMapRegionCount([192, 24, 192])).toBe(8);
    expect(maxMapRegionCount([768, 32, 768])).toBe(32);
  });

  it('splits a polygon into exclusive children and merges them back', () => {
    const parts = splitMapRegion(region(), 'x');
    expect(parts).not.toBeNull();
    const [left, right] = parts!;
    expect(pointInMapRegion(left, -12, 0)).toBe(true);
    expect(pointInMapRegion(right, 12, 0)).toBe(true);
    expect(pointInMapRegion(left, 12, 0)).toBe(false);
    expect(mergeMapRegions(left, right).points).toHaveLength(4);
    expect(findAdjacentMapRegion([left, right], left)?.id).toBe(right.id);
    expect(measureMapLayoutCoverage({
      edgeMask: createMapEdgeMask('none', [48, 12, 48]),
      regions: [left, right]
    }, [48, 12, 48]).valid).toBe(true);
  });

  it('rejects gaps and overlaps instead of accepting mostly covered layouts', () => {
    const size: [number, number, number] = [48, 12, 48];
    const left = { ...region(), id: 'left', points: [[-24, -24], [-1, -24], [-1, 24], [-24, 24]] as Array<[number, number]> };
    const right = { ...region(), id: 'right', points: [[1, -24], [24, -24], [24, 24], [1, 24]] as Array<[number, number]> };
    const gap = measureMapLayoutCoverage({ edgeMask: createMapEdgeMask('none', size), regions: [left, right] }, size);
    right.points = [[-2, -24], [24, -24], [24, 24], [-2, 24]];
    const overlap = measureMapLayoutCoverage({ edgeMask: createMapEdgeMask('none', size), regions: [left, right] }, size);
    expect(gap.valid).toBe(false);
    expect(gap.uncoveredSamples).toBeGreaterThan(0);
    expect(overlap.valid).toBe(false);
    expect(overlap.overlappingSamples).toBeGreaterThan(0);
  });

  it('supports circle, heart and deterministic noise edge masks', () => {
    const size: [number, number, number] = [96, 16, 96];
    const circle = createMapEdgeMask('circle', size);
    const heart = createMapEdgeMask('heart', size);
    const noiseA = createMapEdgeMask('noise', size, 42, 0.3);
    const noiseB = createMapEdgeMask('noise', size, 42, 0.3);
    expect(isPointInsidePlayableArea({ edgeMask: circle }, size, 0, 0)).toBe(true);
    expect(isPointInsidePlayableArea({ edgeMask: circle }, size, 47, 47)).toBe(false);
    expect(heart.points.length).toBeGreaterThan(32);
    expect(noiseB).toEqual(noiseA);
  });

  it('keeps the complete player footprint inside a cropped map', () => {
    const map = createEmptyMap('circle', 'map-circle');
    map.layout.edgeMask = createMapEdgeMask('circle', map.box.size);
    expect(isSpawnPositionSafe(map, 23, 23)).toBe(false);
    const [x, z] = findSafeSpawnPosition(map, 23, 23);
    expect(isSpawnPositionSafe(map, x, z)).toBe(true);
  });

  it('reassigns generated content after a region is split or replaced', () => {
    const map = createEmptyMap('owners', 'map-owners');
    const [left, right] = splitMapRegion(region(), 'x')!;
    map.layout.regions = [left, right];
    const object = createMapObject('tree');
    object.transform.position = [12, 0, 0];
    object.generation = { kind: 'region', id: 'old-region', generationId: 'generation-1' };
    map.objects = [object];
    map.waterBodies = [{
      id: 'pond', name: 'pond', type: 'lake', level: 0, depth: 1, width: 1,
      points: [[-16, -2], [-10, -2], [-10, 2], [-16, 2]],
      generation: { kind: 'region', id: 'old-region', generationId: 'generation-2' }
    }];

    reassignRegionGenerationOwnersInPlace(map);

    expect(map.objects[0].generation?.id).toBe(right.id);
    expect(map.waterBodies[0].generation?.id).toBe(left.id);
  });
});
