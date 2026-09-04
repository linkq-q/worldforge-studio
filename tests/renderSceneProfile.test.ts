import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import { normalizeInteriorArtDirection } from '../src/shared/interiorArtDirection';
import { createRenderSceneProfile, normalizeRenderSceneProfile } from '../src/shared/renderSceneProfile';

describe('render scene profile', () => {
  it('summarizes the current indoor room without sending the whole map', () => {
    const map = createEmptyMap('office', 'office', [12, 3.2, 9], 'voxel', 'indoor', [12, 3.2, 9]);
    map.room!.openings = [
      { id: 'window', kind: 'window', wall: 'north', offset: 0, bottom: 1, width: 2.4, height: 1.4 },
      { id: 'door', kind: 'door', wall: 'south', offset: 0, bottom: 0, width: 1.1, height: 2.2 }
    ];
    map.interiorArtDirection = normalizeInteriorArtDirection({
      summary: 'quiet modern office',
      palette: ['#e8e1d4', '#8b735c'],
      materialKeywords: ['oak', 'plaster']
    }, map.seed);
    const light: MapAsset = {
      id: 'ceiling-light', name: 'ceiling light', prompt: 'warm ceiling light', tags: ['lighting'],
      light: { kind: 'point', color: '#ffd8a0', intensity: 3, range: 7, offset: [0, -0.2, 0] },
      modelJson: { nodes: [] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: false },
      mode: 'voxel', createdAt: 1, updatedAt: 1
    };
    const object = createMapObject('light', light.id);
    object.visible = true;
    map.assets = [light];
    map.objects = [object];

    expect(createRenderSceneProfile(map)).toMatchObject({
      sceneMode: 'indoor',
      size: [12, 3.2, 9],
      room: { windowCount: 1, doorCount: 1, windowArea: 3.36 },
      interior: {
        summary: 'quiet modern office',
        palette: ['#e8e1d4', '#8b735c'],
        materialKeywords: ['oak', 'plaster']
      },
      lighting: { practicalLightCount: 1 },
      content: { hasWater: false, hasGrass: false, hasEmissive: true }
    });
  });

  it('rejects an invalid scene mode at the HTTP boundary', () => {
    expect(normalizeRenderSceneProfile({ sceneMode: 'space' })).toBeUndefined();
  });
});
