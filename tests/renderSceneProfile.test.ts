import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import { normalizeInteriorArtDirection } from '../src/shared/interiorArtDirection';
import { normalizeMapDesignSemantics } from '../src/shared/mapDesign';
import { createRenderSceneProfile, normalizeRenderSceneProfile } from '../src/shared/renderSceneProfile';

describe('render scene profile', () => {
  it('exposes the actual asset-id batch selector for an untagged referenced asset', () => {
    const map = createEmptyMap();
    map.assets = [{ id: 'asset-old-tree', name: 'old tree', prompt: 'tree', modelJson: { nodes: [] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: false }, mode: 'voxel', createdAt: 1, updatedAt: 1 }];
    map.objects = [createMapObject('tree 1', 'asset-old-tree'), createMapObject('tree 2', 'asset-old-tree')];
    const asset = normalizeRenderSceneProfile(createRenderSceneProfile(map))!.colorContext!.assets[0];
    expect(asset).toMatchObject({ assetId: 'asset-old-tree', tags: ['asset-old-tree'], manualObjectCount: 2 });
    expect(asset.materials).toEqual([]);
    expect(map.assets[0].tags).toBeUndefined();
  });

  it('includes world-only asset bindings, authored ecology, water and regional intent', () => {
    const map = createEmptyMap();
    map.world = {
      bundle: { plan: {
        version: 1, id: 'world', revision: 1, prompt: 'A coastal forest settlement',
        recipe: { version: 1, seed: 1, size: 1600, constraints: [{ region: 'west', biome: 'ocean' }],
          biomePatches: [{ id: 'grove', biome: 'forest', region: { kind: 'circle', center: [10, 20], radius: 80 } }],
          waterBodies: [{ id: 'lake', type: 'lake', region: { kind: 'circle', center: [40, 20], radius: 10 }, depth: 2, levels: [0] }] },
        ecology: [{ id: 'grove-oaks', kind: 'broadleaf', biome: 'forest', density: 0.6, spacing: 18, maxSlope: 25, scale: [0.8, 1.2] }],
        featureGraph: { regions: [{ id: 'harbor', name: 'Harbor', kind: 'working', center: [20, 30], radius: 100 }], paths: [], anchors: [], relations: [] },
        towns: [], roads: [{ id: 'harbor-road', name: 'Harbor road', points: [[0, 0], [10, 0]], curve: 'polyline', closed: false, width: 4, tags: ['working-waterfront'] }]
      }, patches: [] },
      assets: [{ key: 'oak', assetId: 'oak', role: 'tree', ecologyKind: 'broadleaf', ecologyRuleId: 'grove-oaks' }]
    };
    map.assets = [{ id: 'oak', name: 'oak', prompt: 'oak', tags: ['tree'], modelJson: {
      nodes: [{ id: 'leaves', tags: [{ tag: 'foliage', value: 'leaf' }], mesh: { material: { color: '#df284a' } } }]
    }, colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 0, fallbackUsed: false }, mode: 'voxel', createdAt: 1, updatedAt: 1 }];
    const profile = normalizeRenderSceneProfile(createRenderSceneProfile(map))!;
    expect(profile.colorContext?.world).toMatchObject({
      intent: 'A coastal forest settlement',
      regions: [{ id: 'harbor', kind: 'working', name: 'Harbor', center: [20, 30], radius: 100 }],
      biomes: [{ id: 'west', biome: 'ocean' }, { id: 'grove', biome: 'forest' }],
      ecology: [{ id: 'grove-oaks', kind: 'broadleaf', biome: 'forest', density: 0.6 }],
      waterBodies: [{ id: 'lake', type: 'lake' }],
      paths: [{ id: 'harbor-road', tags: ['working-waterfront'] }]
    });
    expect(profile.colorContext?.assets).toEqual([expect.objectContaining({
      assetId: 'oak', tags: ['oak', 'tree'], manualObjectCount: 0, worldBindingCount: 1,
      roles: ['tree'], ecologyKinds: ['broadleaf'], materials: [{ partId: 'leaves', color: '#df284a', tags: ['foliage:leaf'], count: 1 }]
    })]);
    expect(profile.content).toMatchObject({ hasWater: true });
    expect(profile.targets?.objects).toEqual([]);
  });

  it('keeps source colors with effective material tags and excludes geometry and image payloads', () => {
    const map = createEmptyMap();
    const asset: MapAsset = { id: 'building', name: 'violet building', prompt: 'building', tags: ['building'], modelJson: {
      image: 'data:image/png;base64,PRIVATE_IMAGE',
      nodes: [
        { id: 'group', tags: [{ tag: 'base', value: 'wood', variant: 'bark' }, { tag: 'emissive', value: 1 }] },
        { id: 'wall', parent: 'group', mesh: { material: { color: '#b38844' }, vertices: ['PRIVATE_GEOMETRY'] } },
        { id: 'leaf', parent: 'group', tags: [{ tag: 'foliage', value: 'leaf' }], mesh: { color: 0xcc2255 } },
        { id: 'roof', mesh: { material: { color: [0.2, 0.4, 0.6] } } }
      ]
    }, colliderPlan: { version: 1, boxes: [], sourceMeshCount: 3, candidateCount: 0, fallbackUsed: false }, mode: 'voxel', createdAt: 1, updatedAt: 1 };
    map.assets = [asset]; map.objects = [createMapObject('building', asset.id)];
    const before = JSON.stringify(map);
    const profile = normalizeRenderSceneProfile(createRenderSceneProfile(map))!;
    expect(profile.colorContext?.assets[0].materials).toEqual([
      { partId: 'wall', color: '#b38844', tags: ['base:wood', 'variant:bark'], count: 1 },
      { partId: 'leaf', color: '#cc2255', tags: ['foliage:leaf'], count: 1 },
      { partId: 'roof', color: '#336699', tags: [], count: 1 }
    ]);
    expect(JSON.stringify(profile)).not.toMatch(/PRIVATE_|modelJson|vertices|base64/);
    expect(profile.targets?.objects[0].parts).toContainEqual({ id: 'roof', tags: [] });
    expect(JSON.stringify(map)).toBe(before);
  });

  it('bounds representative asset colors and aggregates repeated world bindings', () => {
    const map = createEmptyMap();
    map.world = { bundle: { plan: { version: 1, id: 'world', revision: 1, prompt: 'forest',
      recipe: { version: 1, seed: 1, size: 1600, constraints: [] }, towns: [], roads: [], ecology: [] }, patches: [] },
      assets: Array.from({ length: 64 }, (_, i) => ({ key: `oak-${i}`, assetId: 'oak', role: 'tree' })) };
    map.assets = [{ id: 'oak', name: 'oak', prompt: 'oak', modelJson: { nodes: Array.from({ length: 100 }, (_, i) => ({
      id: `part-${i}`, mesh: { material: { color: `#${i.toString(16).padStart(6, '0')}` } }
    })) }, colliderPlan: { version: 1, boxes: [], sourceMeshCount: 100, candidateCount: 0, fallbackUsed: false }, mode: 'voxel', createdAt: 1, updatedAt: 1 }];
    const context = normalizeRenderSceneProfile(createRenderSceneProfile(map))!.colorContext!;
    expect(context.assets).toHaveLength(1);
    expect(context.assets[0]).toMatchObject({ worldBindingCount: 64, sourceMaterialCount: 100 });
    expect(context.assets[0].materials).toHaveLength(16);
    expect(JSON.stringify(context).length).toBeLessThan(4000);
  });

  it('normalizes untrusted color evidence to bounded selected fields', () => {
    const source = { sceneMode: 'outdoor', colorContext: { intent: 'x'.repeat(1200), modelJson: { image: 'PRIVATE_IMAGE' },
      assets: Array.from({ length: 100 }, () => ({ assetId: 'asset', roles: ['tree'], manualObjectCount: Infinity, worldBindingCount: -5,
        tags: ['tree'], materials: Array.from({ length: 100 }, () => ({ partId: 'part', color: '#aa11ff', tags: ['base:wood'], count: 5, image: 'PRIVATE_IMAGE' })) })) } };
    const context = normalizeRenderSceneProfile(source)!.colorContext!;
    expect(context.intent).toHaveLength(500);
    expect(context.assets).toHaveLength(32);
    expect(context.assets[0]).toMatchObject({ roles: ['tree'], manualObjectCount: 0, worldBindingCount: 0 });
    expect(context.assets[0].materials).toHaveLength(16);
    expect(context.assets[0].materials[0]).toEqual({ partId: 'part', color: '#aa11ff', tags: ['base:wood'], count: 5 });
    expect(JSON.stringify(context)).not.toMatch(/PRIVATE_|modelJson|image/);
  });

  it('lets the render planner distinguish paving recipes without embedding finish colors in map data', () => {
    const map = createEmptyMap();
    map.visualSemantics.zones = [
      { id:'historic-street', tags:['paving'], center:[0,0], radius:20, intensity:1, material:'cobblestone' },
      { id:'new-road', tags:['paving'], center:[20,0], radius:15, intensity:1, material:'asphalt' }
    ];
    const profile = normalizeRenderSceneProfile(createRenderSceneProfile(map))!;
    expect(profile.targets?.zones.map(zone => zone.material)).toEqual(['cobblestone','asphalt']);
    const invalid = structuredClone(profile);
    Object.assign(invalid.targets!.zones[0], {material:'invented-road',color:'#ff0000'});
    expect(normalizeRenderSceneProfile(invalid)?.targets?.zones[0]).toEqual({
      id:'historic-street',tags:['paving'],center:[0,0],radius:20
    });
  });
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

  it('exposes up to thirty-two tagged glass parts to the render planner', () => {
    const map = createEmptyMap('glass hall');
    const asset: MapAsset = {
      id: 'glass-wall', name: 'glass wall', prompt: 'glass wall', tags: [],
      modelJson: {
        nodes: Array.from({ length: 40 }, (_, index) => ({
          id: `pane-${index}`,
          tags: [{ tag: 'base', value: 'glass' }],
          mesh: { type: 'box' }
        }))
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 40, candidateCount: 0, fallbackUsed: false },
      mode: 'voxel', createdAt: 1, updatedAt: 1
    };
    map.assets = [asset];
    map.objects = [createMapObject('glass wall', asset.id)];

    const profile = normalizeRenderSceneProfile(createRenderSceneProfile(map));

    expect(profile?.targets?.objects[0].parts).toHaveLength(32);
    expect(profile?.targets?.objects[0].parts.at(-1)).toEqual({ id: 'pane-31', tags: ['base:glass'] });
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
