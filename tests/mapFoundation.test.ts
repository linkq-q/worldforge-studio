import { describe, expect, it } from 'vitest';
import { createEmptyMap, getMapObjectAabbs, normalizeMap } from '../src/shared/map';
import { foundationBoundary, foundationLocalColliderBoxes, foundationTopHeight } from '../src/shared/mapFoundation';
import { applyMapOperations } from '../src/shared/mapOperations';

describe('procedural foundations', () => {
  it('persists a bounded editable rounded foundation through map operations', () => {
    const map = applyMapOperations(createEmptyMap('foundation'), [{
      type: 'object.add',
      object: {
        id: 'foundation-house', name: '住宅地基', heightMode: 'fixed',
        transform: { position: [3, 2, -4], rotation: [0, Math.PI / 2, 0] },
        foundation: {
          shape: 'rounded-rectangle', top: 'level', width: 8, depth: 5,
          thickness: 0.5, maxThickness: 3, cornerRadius: 99, points: [],
          curve: 'polyline', closed: true, slope: 0, slopeDirection: 0,
          stepHeight: 0.25, stepCount: 3, material: 'stone', linkedObjectIds: ['house-1']
        }
      }
    }]);

    expect(map.objects[0].foundation).toMatchObject({
      shape: 'rounded-rectangle', width: 8, depth: 5, cornerRadius: 2.5,
      material: 'stone', linkedObjectIds: ['house-1']
    });
    expect(foundationBoundary(map.objects[0].foundation!)).toHaveLength(20);
    expect(getMapObjectAabbs(map)).toHaveLength(1);
    expect(getMapObjectAabbs(map)[0].max[1]).toBeGreaterThan(2);
  });

  it('supports polygon, sloped, stepped and curved path plans without flattening terrain', () => {
    const source = createEmptyMap('foundation forms');
    source.terrain.heights = source.terrain.heights.map((_, index) => index % 7 / 10);
    const originalTerrain = [...source.terrain.heights];
    const map = normalizeMap({
      ...source,
      objects: [{
        id: 'seawall', name: '曲线海堤', parentId: null, assetId: null,
        transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1] },
        visible: true, locked: false,
        foundation: {
          shape: 'path', top: 'steps', width: 2, depth: 8, thickness: 0.4, maxThickness: 4,
          cornerRadius: 1, points: [[-6, 0], [-2, 3], [3, 2], [6, -1]], curve: 'catmull-rom',
          closed: false, slope: 0.1, slopeDirection: 0, stepHeight: 0.3, stepCount: 5,
          material: 'concrete', linkedObjectIds: []
        }
      }]
    });

    expect(map.terrain.heights).toEqual(originalTerrain);
    expect(foundationBoundary(map.objects[0].foundation!).length).toBeGreaterThan(8);
    expect(foundationTopHeight(map.objects[0].foundation!, 0, 4)).toBeGreaterThan(0);
  });

  it('keeps path collision on the curved strip instead of filling its whole bounds', () => {
    const foundation = normalizeMap({
      ...createEmptyMap('path collision'),
      objects: [{
        id: 'wall', name: '折线海堤', parentId: null, assetId: null,
        transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1] },
        visible: true, locked: false,
        foundation: {
          shape: 'path', top: 'level', width: 1, depth: 10, thickness: 0.4, maxThickness: 3,
          cornerRadius: 0, points: [[-5, -5], [-5, 5], [5, 5]], curve: 'polyline',
          closed: false, slope: 0, slopeDirection: 0, stepHeight: 0.25, stepCount: 3,
          material: 'concrete', linkedObjectIds: []
        }
      }]
    }).objects[0].foundation!;

    const boxes = foundationLocalColliderBoxes(foundation);
    expect(boxes).toHaveLength(2);
    expect(boxes.some((box) => box.min[0] <= 0 && box.max[0] >= 0 && box.min[2] <= 0 && box.max[2] >= 0)).toBe(false);
  });
});
