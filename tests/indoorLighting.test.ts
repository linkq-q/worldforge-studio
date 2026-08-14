import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import { evaluateIndoorLightCoverage } from '../src/shared/indoorLighting';

describe('indoor light coverage', () => {
  it('flags an unlit room and recognizes a distributed practical-light grid', () => {
    const map = createEmptyMap('room', 'light-coverage', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    expect(evaluateIndoorLightCoverage(map)).toMatchObject({ ratio: 0, practicalLightCount: 0 });

    const lightAsset: MapAsset = {
      id: 'ceiling-light', name: 'Ceiling light', prompt: 'warm ceiling light', tags: ['ceiling-light', 'lighting'],
      light: { kind: 'point', color: '#ffd8a0', intensity: 3, range: 7, offset: [0, -0.2, 0] },
      modelJson: { nodes: [] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
      mode: 'voxel', createdAt: 1, updatedAt: 1
    };
    map.assets = [lightAsset];
    map.objects = [[-3, -2], [3, -2], [-3, 2], [3, 2]].map(([x, z], index) => {
      const object = createMapObject(`Light ${index + 1}`, lightAsset.id);
      object.transform.position = [x, 3, z];
      object.heightMode = 'fixed';
      return object;
    });

    const result = evaluateIndoorLightCoverage(map);
    expect(result.practicalLightCount).toBe(4);
    expect(result.ratio).toBeGreaterThanOrEqual(0.72);
  });
});
