import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import { normalizeInteriorArtDirection } from '../src/shared/interiorArtDirection';
import { normalizeMapDesignSemantics } from '../src/shared/mapDesign';
import { createRenderSceneProfile, normalizeRenderSceneProfile } from '../src/shared/renderSceneProfile';

describe('render scene profile', () => {
  it('retains later focal buildings, lights and walk-up props when scenery exhausts the context budget', () => {
    const map = createEmptyMap();
    map.objects = Array.from({ length: 140 }, (_, index) => {
      const object = createMapObject(`background-${index}`);
      object.transform.position = [-20, 0, -20];
      return object;
    });
    const focus = createMapObject('workshop'); focus.id = 'workshop'; focus.transform.position = [10, 0, 10];
    focus.designGroupId = 'work';
    const lamp = createMapObject('task lamp'); lamp.id = 'lamp';
    lamp.light = { kind: 'point', color: '#ffcc88', intensity: 3, range: 5, offset: [0, 1, 0], enabled: true, role: 'practical', castShadow: false, shadowMapSize: 1024, shadowBias: 0, shadowNormalBias: 0, shadowRadius: 1 };
    const bench = createMapObject('workbench'); bench.id = 'bench'; bench.parentId = focus.id;
    const routeProp = createMapObject('route prop'); routeProp.id = 'route-prop'; routeProp.transform.position = [9, 0, 10];
    map.objects.push(focus, lamp, bench, routeProp);
    map.designSemantics = normalizeMapDesignSemantics({
      groups: [{ id: 'work', name: 'work', focusIds: ['primary'] }],
      focuses: [{ id: 'primary', groupId: 'work', objectId: focus.id, kind: 'primary' }],
      viewpoints: [{ id: 'walk', role: 'node', point: [9, 10], targetFocusId: 'primary' }]
    }, map.box.size);
    const profile = normalizeRenderSceneProfile(createRenderSceneProfile(map))!;
    const targets = profile.targets!.objects;
    expect(targets).toHaveLength(128);
    expect(targets.slice(0, 4).map(object => object.id)).toEqual(['workshop', 'lamp', 'bench', 'route-prop']);
    expect(targets[0].groupId).toBe('work');
    expect(targets[1].light).toMatchObject({ kind: 'point', color: '#ffcc88', range: 5, offset: [0, 1, 0] });
    expect(map.objects[0].name).toBe('background-0');
  });

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
    expect(normalizeRenderSceneProfile(createRenderSceneProfile(map))?.targets?.objects[0]).toMatchObject({
      tags: ['lighting'], light: { kind: 'point', intensity: 3, range: 7 }
    });
    object.light = null;
    expect(createRenderSceneProfile(map).targets?.objects[0].light).toBeUndefined();
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
