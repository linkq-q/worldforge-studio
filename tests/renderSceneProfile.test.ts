import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import { normalizeInteriorArtDirection } from '../src/shared/interiorArtDirection';
import { normalizeMapDesignSemantics } from '../src/shared/mapDesign';
import { createRenderSceneProfile, normalizeRenderSceneProfile } from '../src/shared/renderSceneProfile';

describe('render scene profile', () => {
  it('sends world-space child transforms and normalized district geometry', () => {
    const map = createEmptyMap();
    const host = createMapObject('host');
    host.transform.position = [10, 0, 0];
    host.transform.rotation[1] = Math.PI / 2;
    const child = createMapObject('child');
    child.parentId = host.id;
    child.transform.position = [0, 0, 2];
    map.objects = [host, child];
    map.designSemantics = normalizeMapDesignSemantics({groups:[{id:'work',spatialRole:'urban-fabric',region:{kind:'circle',x:4,z:2,radius:5}}]}, map.box.size);
    const profile = normalizeRenderSceneProfile(createRenderSceneProfile(map))!;
    expect(profile.targets!.objects[1].position[0]).toBeCloseTo(12);
    expect(profile.targets!.objects[1].position[2]).toBeCloseTo(0);
    expect(profile.targets!.objects[1].rotation![1]).toBeCloseTo(Math.PI / 2);
    expect(profile.sceneArtBrief!.groups[0]).toMatchObject({spatialRole:'urban-fabric',region:{kind:'circle',x:4,z:2,radius:5}});
  });

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

  it('carries bounded map composition meaning into the render context without authoring style', () => {
    const map = createEmptyMap('garden');
    const pavilion = createMapObject('主亭');
    pavilion.id = 'pavilion';
    map.objects = [pavilion];
    map.designSemantics = normalizeMapDesignSemantics({
      experienceMode: 'sequential', intent: '先穿过林径，再看主亭',
      groups: [{ id: 'garden', name: '园林', intent: '框景主亭', focusIds: ['main'], guideIds: ['path'] }],
      focuses: [{ id: 'main', groupId: 'garden', name: '主亭', kind: 'primary', objectId: 'pavilion', reveal: 'framed' }],
      viewpoints: [{ id: 'entry', role: 'entry', point: [-8, 0], targetFocusId: 'main' }]
    }, map.box.size);
    map.renderPromptSuggestions = ['雨后石路可见暖色倒影'];

    const profile = normalizeRenderSceneProfile(createRenderSceneProfile(map));
    expect(profile?.sceneArtBrief).toMatchObject({
      intent: '先穿过林径，再看主亭', experienceMode: 'sequential',
      groups: [{ id: 'garden', focusIds: ['main'], guideIds: ['path'] }],
      focuses: [{ id: 'main', objectId: 'pavilion', kind: 'primary', reveal: 'framed' }],
      viewpoints: [{ role: 'entry', targetFocusId: 'main', point: [-8, 0] }],
      renderHints: ['雨后石路可见暖色倒影']
    });
    expect(profile?.sceneArtBrief).not.toHaveProperty('lighting');
  });
});
