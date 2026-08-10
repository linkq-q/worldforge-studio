import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, sampleTerrainHeight } from '../src/shared/map';
import { retuneMapStitchSeam, stitchMaps } from '../src/shared/mapStitch';
import { createMapEdgeMask, isPointInsidePlayableArea } from '../src/shared/mapLayout';

describe('map stitching', () => {
  it('creates a new map and blends different source heights through one editable seam', () => {
    const primary = createEmptyMap('平原', 'plain', [48, 12, 48]);
    const secondary = createEmptyMap('高地', 'highland', [48, 12, 48]);
    primary.terrain.heights.fill(0);
    secondary.terrain.heights.fill(10);
    const marker = createMapObject('高地标记');
    marker.transform.position = [0, 10, 0];
    secondary.objects.push(marker);
    const primaryBefore = structuredClone(primary);
    const secondaryBefore = structuredClone(secondary);

    const stitched = stitchMaps(primary, secondary, {
      direction: 'east',
      mode: 'contact',
      width: 24,
      irregularity: 0,
      seed: 7,
      prompt: '碎石缓坡'
    });

    expect(stitched.id).not.toBe(primary.id);
    expect(stitched.box.size[0]).toBe(96);
    expect(sampleTerrainHeight(stitched, -20, 0)).toBeCloseTo(0, 1);
    expect(sampleTerrainHeight(stitched, 0, 0)).toBeCloseTo(5, 1);
    expect(sampleTerrainHeight(stitched, 20, 0)).toBeCloseTo(10, 1);
    expect(stitched.layout.seams).toEqual([
      expect.objectContaining({ width: 24, irregularity: 0, prompt: '碎石缓坡', locked: false })
    ]);
    expect(stitched.objects[0]?.transform.position[0]).toBeCloseTo(24);
    expect(primary).toEqual(primaryBefore);
    expect(secondary).toEqual(secondaryBefore);
  });

  it('adds a finite transition corridor without rotating or scaling either source', () => {
    const first = createEmptyMap('A', 'a', [48, 12, 48]);
    const second = createEmptyMap('B', 'b', [48, 12, 48]);
    first.layout.edgeMask = createMapEdgeMask('circle', first.box.size);
    second.layout.edgeMask = createMapEdgeMask('heart', second.box.size);
    const stitched = stitchMaps(first, second, { direction: 'south', mode: 'corridor', width: 16 });
    expect(stitched.box.size[2]).toBe(112);
    expect(stitched.layout.seams[0]?.mode).toBe('corridor');
    expect(stitched.layout.stitchSources.map((source) => source.mapId)).toEqual(['a', 'b']);
    expect(stitched.layout.edgeMask.kind).toBe('composite');
    expect(stitched.layout.edgeMask.polygons).toHaveLength(3);
    expect(isPointInsidePlayableArea(stitched.layout, stitched.box.size, 0, 0)).toBe(true);
    expect(isPointInsidePlayableArea(stitched.layout, stitched.box.size, 23, 55)).toBe(false);
  });

  it('retunes one seam independently and respects its lock', () => {
    const low = createEmptyMap('低地', 'low', [48, 12, 48]);
    const high = createEmptyMap('高地', 'high', [48, 12, 48]);
    low.terrain.heights.fill(0);
    high.terrain.heights.fill(8);
    const stitched = stitchMaps(low, high, { width: 24, irregularity: 0, seed: 1 });
    const seamId = stitched.layout.seams[0].id;

    const retuned = retuneMapStitchSeam(stitched, low, high, seamId, {
      width: 10,
      irregularity: 0.35,
      seed: 99,
      prompt: '苔藓碎石坡',
      locked: true
    });

    expect(retuned.layout.seams[0]).toEqual(expect.objectContaining({
      width: 10,
      irregularity: 0.35,
      seed: 99,
      prompt: '苔藓碎石坡',
      locked: true
    }));
    expect(() => retuneMapStitchSeam(retuned, low, high, seamId, { width: 20 })).toThrow('stitch_seam_locked');
    expect(retuneMapStitchSeam(retuned, low, high, seamId, { locked: false }).layout.seams[0].locked).toBe(false);
    expect(() => retuneMapStitchSeam(stitched, low, { ...high, version: high.version + 1 }, seamId, { width: 20 }))
      .toThrow('stitch_seam_source_changed');
    expect(() => stitchMaps(stitched, low)).toThrow('duplicate_stitch_source');
  });
});
