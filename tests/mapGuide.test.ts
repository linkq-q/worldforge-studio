import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import {
  createMapStreetGrid,
  createParallelMapGuides,
  mapGuidePolyline,
  normalizeMapGuides,
  sampleMapGuide,
  type MapGuide
} from '../src/shared/mapGuide';

const parkLoop: MapGuide = {
  id: 'park-loop',
  name: 'Park Loop',
  points: [[-12, 0], [-5, 9], [6, 10], [13, 0], [5, -9], [-6, -8]],
  curve: 'catmull-rom',
  closed: true,
  width: 2.4,
  tags: ['park', 'pedestrian']
};

describe('map guide layout kernel', () => {
  it('persists bounded guides through the atomic map operation protocol', () => {
    const map = createEmptyMap('guide map', 'guide-map');
    const next = applyMapOperations(map, [{ type: 'guide.upsert', guide: parkLoop }]);
    expect(next.guides).toEqual([parkLoop]);
    expect(applyMapOperations(next, [{ type: 'guide.remove', guideId: parkLoop.id }]).guides).toEqual([]);
  });

  it('samples a smooth closed park loop by arc distance and supports path-side offsets', () => {
    const center = sampleMapGuide(parkLoop, { spacing: 4 });
    const outside = sampleMapGuide(parkLoop, { spacing: 4, offset: 2 });
    expect(center.length).toBeGreaterThan(14);
    expect(center).toHaveLength(outside.length);
    expect(Math.hypot(center[0].x - center.at(-1)!.x, center[0].z - center.at(-1)!.z)).toBeLessThan(0.01);
    expect(center.some((sample) => Math.abs(sample.tangentX) > 0.2 && Math.abs(sample.tangentZ) > 0.2)).toBe(true);
    expect(outside.some((sample, index) => Math.hypot(sample.x - center[index].x, sample.z - center[index].z) > 1.9)).toBe(true);
    expect(mapGuidePolyline(parkLoop).length).toBeGreaterThan(parkLoop.points.length * 5);
    expect(mapGuidePolyline(parkLoop)).toHaveLength(64);
    expect(mapGuidePolyline(parkLoop).at(-1)).toEqual(mapGuidePolyline(parkLoop)[0]);
  });

  it('creates deterministic parallel farm rows clipped to a non-square field', () => {
    const options = {
      idPrefix: 'orchard-row',
      region: [[-14, -8], [12, -6], [10, 9], [-11, 7]] as Array<[number, number]>,
      direction: 12,
      spacing: 3,
      inset: 1,
      width: 0.8,
      tags: ['farm', 'row']
    };
    const rows = createParallelMapGuides(options);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((guide) => guide.points.length === 2 && guide.tags.includes('farm'))).toBe(true);
    expect(rows.map((guide) => guide.id)).toEqual(createParallelMapGuides(options).map((guide) => guide.id));
  });

  it('derives crossing streets and road-inset buildable blocks from one planning region', () => {
    const grid = createMapStreetGrid({
      idPrefix: 'town',
      region: [[-18, -14], [18, -14], [18, 14], [-18, 14]],
      direction: 0,
      blockWidth: 9,
      blockDepth: 9,
      roadWidth: 3,
      inset: 1
    });

    expect(grid.streets.length).toBeGreaterThanOrEqual(6);
    expect(grid.blocks.length).toBeGreaterThanOrEqual(4);
    expect(grid.blocks.every((block) => block.points.length === 4)).toBe(true);
    expect(grid.blocks[0].points.every(([x, z]) => Math.abs(x) < 18 && Math.abs(z) < 14)).toBe(true);
  });

  it('normalizes external guide data to map bounds and rejects duplicates', () => {
    const guides = normalizeMapGuides([
      { ...parkLoop, points: [[-999, 0], [999, 0]] },
      { ...parkLoop, name: 'duplicate' }
    ], [40, 20, 30]);
    expect(guides).toHaveLength(1);
    expect(guides[0].points).toEqual([[-20, 0], [20, 0]]);
  });
});
