import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditableMapGroup, buildStructuredWaterGroup } from '../src/client/mapRenderer';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import type { MapAsset } from '../src/shared/map';
import { createGrassLayer, fillGrassLayerInPlace } from '../src/shared/mapGrass';
import { DEFAULT_RUNTIME_GRASS_STYLE } from '../src/shared/renderPlan';
import { MAX_VISIBLE_MAP_LOCAL_LIGHTS } from '../src/client/mapLocalLights';

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => null
    })
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('structured map water rendering', () => {
  it('renders the map as an open terrain plane without enclosure faces', async () => {
    const rendered = await buildEditableMapGroup(createEmptyMap('open-map', 'map-open-plane'));
    const surfaces: string[] = [];
    rendered.group.traverse((object) => {
      if (typeof object.userData.surface === 'string') surfaces.push(object.userData.surface);
    });

    expect(surfaces).toEqual(['terrain']);
    const terrain = rendered.group.getObjectByName('terrain') as THREE.Mesh;
    const material = terrain.material as THREE.MeshStandardMaterial;
    expect(terrain.castShadow).toBe(true);
    expect(terrain.receiveShadow).toBe(true);
    expect(material.emissive.getHex()).toBe(0x000000);
    expect(material.side).toBe(THREE.FrontSide);
    expect(material.vertexColors).toBe(true);
    expect(terrain.geometry.getAttribute('color').count).toBe(terrain.geometry.getAttribute('position').count);
    rendered.dispose();
  });

  it('builds tagged lake and river geometry under the model root', async () => {
    const map = createEmptyMap('waters', 'map-render-water');
    map.waterBodies = [
      {
        id: 'lake-1',
        name: '湖泊',
        type: 'lake',
        level: 0.4,
        depth: 1.5,
        width: 1.2,
        points: [[-4, -3], [4, -3], [4, 3], [-4, 3]]
      },
      {
        id: 'river-1',
        name: '河流',
        type: 'river',
        level: 0.5,
        depth: 1.5,
        width: 1.2,
        points: [[-6, -5], [-1, 0], [6, 5]],
        levels: [1.1, 0.8, 0.5],
        shorelineSmoothness: 0.8
      }
    ];

    const waterRoot = buildStructuredWaterGroup(map);
    const lake = waterRoot.getObjectByName('water:lake-1') as THREE.Mesh;
    const river = waterRoot.getObjectByName('water:river-1') as THREE.Mesh;

    expect(lake?.isMesh).toBe(true);
    expect(river?.isMesh).toBe(true);
    expect(lake.position.y).toBeCloseTo(0.4);
    expect(river.position.y).toBeCloseTo(0.5);
    expect(lake.userData.materialTags).toEqual(expect.arrayContaining(['water', 'lake', 'lake-1']));
    expect(river.userData.materialTags).toEqual(expect.arrayContaining(['water', 'river', 'river-1']));
    expect(lake.userData.excludeFromPlanarReflection).toBe(true);
    expect(river.userData.excludeFromPlanarReflection).toBe(true);
    expect(lake.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(3);
    expect(river.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(6);
    const riverHeights = Array.from(river.geometry.getAttribute('position').array as Float32Array)
      .filter((_, index) => index % 3 === 1);
    expect(Math.max(...riverHeights) - Math.min(...riverHeights)).toBeGreaterThan(0.5);
    for (const water of [lake, river]) {
      const shore = water.userData.waterShore as {
        texture: THREE.DataTexture;
        center: [number, number];
        size: number;
      };
      const pixels = shore.texture.image.data as Uint8Array;
      expect(shore.texture.isDataTexture).toBe(true);
      expect(shore.size).toBeGreaterThan(0);
      expect(pixels).toContain(0);
      expect(Math.max(...pixels)).toBe(255);
    }

    waterRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
      (mesh.userData.waterShore?.texture as THREE.Texture | undefined)?.dispose();
    });
  });

  it('renders overlapping same-level water blocks as one clipped surface', () => {
    const map = createEmptyMap('joined-water', 'map-joined-water');
    map.waterBodies = [
      {
        id: 'left-water', name: '左侧水块', type: 'lake', level: 0.35, depth: 1.8, width: 1.2,
        points: [[-6, -4], [2, -4], [2, 4], [-6, 4]]
      },
      {
        id: 'right-water', name: '右侧水块', type: 'lake', level: 0.35, depth: 1.8, width: 1.2,
        points: [[-2, -4], [6, -4], [6, 4], [-2, 4]]
      },
      {
        id: 'separate-pond', name: '独立池塘', type: 'lake', level: 0.35, depth: 1.2, width: 1.2,
        points: [[20, -2], [24, -2], [24, 2], [20, 2]]
      }
    ];

    const waterRoot = buildStructuredWaterGroup(map);
    const left = waterRoot.getObjectByName('water:left-water') as THREE.Mesh;
    const separate = waterRoot.getObjectByName('water:separate-pond') as THREE.Mesh;
    const leftShore = left.userData.waterShore as {
      texture: THREE.DataTexture;
      center: [number, number];
      size: number;
    };
    const separateShore = separate.userData.waterShore as typeof leftShore;
    const image = leftShore.texture.image as { data: Uint8Array; width: number; height: number };
    const seamColumn = Math.floor((0.5 + (0 - leftShore.center[0]) / leftShore.size) * image.width);
    const seamRow = Math.floor((0.5 - (0 - leftShore.center[1]) / leftShore.size) * image.height);

    expect(waterRoot.children).toHaveLength(2);
    expect(waterRoot.getObjectByName('water:right-water')).toBeUndefined();
    expect(left.userData.waterBodyIds).toEqual(['left-water', 'right-water']);
    expect(left.userData.waterShore.worldSpace).toBe(false);
    expect(left.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect(separateShore.texture).not.toBe(leftShore.texture);
    expect(image.data[seamRow * image.width + seamColumn]).toBeGreaterThan(128);

    const disposed = new Set<THREE.Texture>();
    waterRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
      const texture = mesh.userData.waterShore?.texture as THREE.Texture | undefined;
      if (texture && !disposed.has(texture)) {
        disposed.add(texture);
        texture.dispose();
      }
    });
  });

  it('compiles even two matching asset copies into one scene-level primitive batch', async () => {
    const map = createEmptyMap('instances', 'map-shared-geometry');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-tree',
      name: 'tree',
      prompt: 'tree',
      modelJson: {
        nodes: [{
          id: 'trunk',
          mesh: { type: 'box', params: { width: 1, height: 2, depth: 1 }, color: 0x445522 }
        }]
      },
      colliderPlan: {
        version: 1,
        boxes: [],
        sourceMeshCount: 1,
        candidateCount: 1,
        fallbackUsed: false
      },
      mode: 'test',
      createdAt: now,
      updatedAt: now
    };
    map.assets = [asset];
    map.objects = [
      { ...createTestObject('tree-a', asset.id), transform: { ...createTestObject('tree-a', asset.id).transform, position: [0, 0, 0] } },
      { ...createTestObject('tree-b', asset.id), transform: { ...createTestObject('tree-b', asset.id).transform, position: [4, 0, 0] } }
    ];

    const rendered = await buildEditableMapGroup(map);
    const batch = rendered.modelsRoot.getObjectByProperty('isInstancedMesh', true) as THREE.InstancedMesh;
    expect(batch.count).toBe(2);
    expect(rendered.objectGroups.get('tree-a')?.getObjectByName('trunk')).toBeUndefined();
    expect(rendered.objectGroups.get('tree-b')?.getObjectByName('trunk')).toBeUndefined();
    expect(rendered.pickables).toContain(batch);
    rendered.dispose();
  });

  it('instances four safe copies and keeps editable object transform bindings', async () => {
    const map = createEmptyMap('dense', 'map-instanced-assets');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-shrub',
      name: 'shrub',
      prompt: 'shrub',
      modelJson: {
        nodes: [{
          id: 'leaf',
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0x447733 }
        }]
      },
      colliderPlan: {
        version: 1,
        boxes: [],
        sourceMeshCount: 1,
        candidateCount: 1,
        fallbackUsed: false
      },
      mode: 'voxel',
      createdAt: now,
      updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 4 }, (_, index) => {
      const object = createTestObject(`shrub-${index}`, asset.id);
      object.transform.position = [index * 3, 0, 0];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    const batch = rendered.modelsRoot.getObjectByProperty('isInstancedMesh', true) as THREE.InstancedMesh;
    expect(batch.count).toBe(4);
    expect(batch.userData.resolveMapObjectId({ object: batch, instanceId: 2 })).toBe('shrub-2');
    expect(rendered.pickables).toContain(batch);

    const selected = rendered.objectGroups.get('shrub-2') as THREE.Group;
    selected.position.x = 20;
    rendered.syncObjectTransform('shrub-2');
    const matrix = new THREE.Matrix4();
    batch.getMatrixAt(2, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).x).toBeCloseTo(20);
    rendered.dispose();
  });

  it('batches material-tagged copies when their tag only needs a shared base recipe', async () => {
    const map = createEmptyMap('tagged', 'map-tagged-assets');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-tagged-tree',
      name: 'tagged tree',
      prompt: 'tagged tree',
      modelJson: {
        nodes: [{
          id: 'leaf',
          tags: [{ tag: 'base', value: 'foliage' }],
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0x447733 }
        }]
      },
      colliderPlan: {
        version: 1,
        boxes: [],
        sourceMeshCount: 1,
        candidateCount: 1,
        fallbackUsed: false
      },
      mode: 'voxel',
      createdAt: now,
      updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 4 }, (_, index) => {
      const object = createTestObject(`tagged-${index}`, asset.id);
      object.transform.position = [index * 3, 0, 0];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    const batch = rendered.modelsRoot.getObjectByProperty('isInstancedMesh', true) as THREE.InstancedMesh;
    expect(batch.count).toBe(4);
    expect(rendered.objectGroups.get('tagged-0')?.getObjectByName('leaf')).toBeUndefined();
    rendered.dispose();
  });

  it('keeps tags with per-object runtime effects standalone while below the effect-batch threshold', async () => {
    const map = createEmptyMap('tagged-runtime', 'map-tagged-runtime-assets');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-fire',
      name: 'torch flame',
      prompt: 'torch flame',
      modelJson: {
        nodes: [{
          id: 'flame',
          tags: [{ tag: 'fire', value: 1 }],
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0xff8822 }
        }]
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 2 }, (_, index) => {
      const object = createTestObject(`flame-${index}`, asset.id);
      object.transform.position = [index * 3, 0, 0];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    expect(rendered.modelsRoot.getObjectByProperty('isInstancedMesh', true)).toBeUndefined();
    expect(rendered.objectGroups.get('flame-0')?.getObjectByName('flame')).toBeDefined();
    expect(rendered.getDebugStats()).toMatchObject({
      totalParts: 2,
      effectBatchParts: 0,
      fallbackMeshParts: 2
    });
    rendered.dispose();
  });

  it('keeps animated objects standalone and drives them through the optional motion adapter', async () => {
    const map = createEmptyMap('motion', 'map-motion-adapter');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-gull', name: 'gull', prompt: 'gull', tags: ['bird'],
      modelJson: { nodes: [{ id: 'body', mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'test', createdAt: now, updatedAt: now
    };
    const animated = {
      ...createTestObject('gull-flying', asset.id),
      behavior: {
        kind: 'flock' as const, locomotion: 'air' as const, groupRole: 'outlier' as const,
        animation: { state: 'fly', speed: 1.1, phase: 0.25 }
      }
    };
    map.assets = [asset];
    map.objects = [animated, createTestObject('gull-static', asset.id)];
    const update = vi.fn();
    const dispose = vi.fn();
    const attach = vi.fn(() => ({ update, dispose }));

    const rendered = await buildEditableMapGroup(map, { motionAdapter: { attach } });
    rendered.update(0.25, new THREE.PerspectiveCamera(), 100);

    expect(attach).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({
      object: expect.objectContaining({ id: 'gull-flying' }),
      asset: expect.objectContaining({ id: asset.id }),
      group: rendered.objectGroups.get('gull-flying')
    }));
    expect(rendered.objectGroups.get('gull-flying')?.getObjectByName('body')).toBeDefined();
    expect(update).toHaveBeenCalledWith(0.25, 0.25);

    rendered.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps cliffs in the terrain mesh without detached vertical wall sheets', async () => {
    const map = applyMapOperations(createEmptyMap('cliff', 'map-cliff-render'), [{
      type: 'terrain.modify', modifier: 'cliff', layout: 'wall',
      region: { kind: 'path', points: [[0, -15], [0, 15]], width: 5 },
      amplitude: 7, softness: 0
    }]);
    const rendered = await buildEditableMapGroup(map);
    expect(rendered.group.getObjectByName('terrain-cliff-walls')).toBeUndefined();
    expect((rendered.group.getObjectByName('terrain') as THREE.Mesh).geometry.getAttribute('position').count).toBeGreaterThan(0);
    rendered.dispose();
  });

  it('installs animated sand uniforms for semantic sand regions', async () => {
    const map = applyMapOperations(createEmptyMap('sand', 'map-sand-render'), [{
      type: 'terrain.surface', surface: 'sand',
      region: { kind: 'circle', x: 0, z: 0, radius: 8 }, zoneId: 'sand-zone'
    }]);
    const rendered = await buildEditableMapGroup(map);
    const terrain = rendered.group.getObjectByName('terrain') as THREE.Mesh;
    const sandFlow = terrain.userData.sandFlow as { zones: unknown[] };

    expect(sandFlow.zones).toHaveLength(1);
    expect((terrain.material as THREE.MeshStandardMaterial).onBeforeCompile).toBeTypeOf('function');
    rendered.dispose();
  });

  it('regroups matching material-tag effects and keeps their RuntimeIndex transform binding', async () => {
    const map = createEmptyMap('tagged-effect-batch', 'map-tagged-effect-batch');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-shared-flame',
      name: 'shared flame',
      prompt: 'shared flame',
      modelJson: {
        nodes: [{
          id: 'flame',
          tags: [{ tag: 'fire', value: 1 }],
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0xff8822 }
        }]
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 8 }, (_, index) => {
      const object = createTestObject(`flame-${index}`, asset.id);
      object.transform.position = [index * 3, 0, 0];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    const effectBatch = rendered.getRuntimeBatchMeshes().find(
      (object): object is THREE.InstancedMesh => object.userData.isEffectBatch === true
    );
    expect(effectBatch?.count).toBe(8);
    expect(rendered.getDebugStats()).toMatchObject({
      effectBatchCount: 1,
      effectBatchParts: 8,
      runtimeIndexPartRefs: 8,
      orphanPartRefs: 0,
      orphanInstanceRefs: 0
    });
    expect(rendered.pickables).toContain(effectBatch);
    expect(effectBatch?.userData.resolveMapObjectId({ object: effectBatch, instanceId: 3 })).toBe('flame-3');

    const selected = rendered.objectGroups.get('flame-3') as THREE.Group;
    selected.position.x = 30;
    rendered.syncObjectTransform('flame-3');
    const matrix = new THREE.Matrix4();
    effectBatch?.getMatrixAt(3, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).x).toBeCloseTo(30);
    rendered.dispose();
  });

  it('keeps mixed standalone siblings without mutating the fallback tree during traversal', async () => {
    const map = createEmptyMap('mixed-runtime', 'map-mixed-runtime-assets');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-campfire',
      name: 'campfire',
      prompt: 'campfire',
      modelJson: {
        nodes: [
          { id: 'root' },
          {
            id: 'wood',
            parent: 'root',
            mesh: { type: 'box', params: { width: 1, height: 0.5, depth: 1 }, color: 0x553311 }
          },
          {
            id: 'flame',
            parent: 'root',
            tags: [{ tag: 'fire', value: 1 }],
            mesh: { type: 'box', params: { width: 0.4, height: 0.8, depth: 0.4 }, color: 0xff8822 }
          }
        ]
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 2, candidateCount: 2, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = [createTestObject('campfire-0', asset.id)];

    const rendered = await buildEditableMapGroup(map);
    expect(rendered.objectGroups.get('campfire-0')?.getObjectByName('wood')).toBeUndefined();
    expect(rendered.objectGroups.get('campfire-0')?.getObjectByName('flame')).toBeDefined();
    rendered.dispose();
  });

  it('distance-culls indexed standalone parts and restores them near the camera', async () => {
    const map = createEmptyMap('culling-runtime', 'map-culling-runtime');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-flame',
      name: 'flame',
      prompt: 'flame',
      modelJson: {
        nodes: [{
          id: 'flame',
          tags: [{ tag: 'fire', value: 1 }],
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0xff8822 }
        }]
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    const near = createTestObject('flame-near', asset.id);
    const far = createTestObject('flame-far', asset.id);
    far.transform.position = [100, 0, 0];
    map.assets = [asset];
    map.objects = [near, far];

    const rendered = await buildEditableMapGroup(map);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
    const nearMesh = rendered.objectGroups.get('flame-near')?.getObjectByName('flame') as THREE.Mesh;
    const farMesh = rendered.objectGroups.get('flame-far')?.getObjectByName('flame') as THREE.Mesh;

    rendered.update(0, camera, 20);
    expect(nearMesh.visible).toBe(true);
    expect(farMesh.visible).toBe(false);

    camera.position.x = 100;
    rendered.update(0, camera, 20);
    expect(nearMesh.visible).toBe(false);
    expect(farMesh.visible).toBe(true);
    rendered.dispose();
  });
});

describe('terrain-only refresh', () => {
  it('rebuilds terrain geometry and surface texture in place, leaving asset batches alone', async () => {
    const map = createEmptyMap('terrain', 'map-terrain-refresh');
    const rendered = await buildEditableMapGroup(map);
    const terrain = rendered.group.getObjectByName('terrain') as THREE.Mesh;
    const material = terrain.material as THREE.MeshStandardMaterial;
    const firstGeometry = terrain.geometry;
    const firstTexture = material.map;
    const firstIndex = rendered.runtimeIndex;

    map.terrain.heights = map.terrain.heights.map(() => 3);
    rendered.refreshTerrain(map);

    // The mesh itself must survive: it is the raycast target for the brushes.
    expect(rendered.group.getObjectByName('terrain')).toBe(terrain);
    expect(terrain.geometry).not.toBe(firstGeometry);
    expect(terrain.geometry.getAttribute('position').getY(0)).toBeCloseTo(3, 5);
    expect(terrain.geometry.getAttribute('color').count).toBe(terrain.geometry.getAttribute('position').count);
    expect(material.map).not.toBe(firstTexture);
    expect(rendered.runtimeIndex).toBe(firstIndex);
    rendered.dispose();
  });
});

describe('derived local lights', () => {
  it('caps visible emissive-object lights at eight', async () => {
    const map = createEmptyMap('local lights', 'map-local-lights');
    const now = Date.now();
    const asset: MapAsset = {
      id: 'asset-lamp', name: 'lamp', prompt: 'glowing lamp',
      modelJson: { nodes: [{ id: 'bulb', tags: [{ tag: 'emissive', value: 1 }], mesh: { type: 'box' } }] },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel', createdAt: now, updatedAt: now
    };
    map.assets = [asset];
    map.objects = Array.from({ length: 12 }, (_, index) => {
      const object = createTestObject(`lamp-${index}`, asset.id);
      object.transform.position = [(index % 4) * 2 - 3, 0, Math.floor(index / 4) * 2 - 2];
      return object;
    });

    const rendered = await buildEditableMapGroup(map);
    const lightRoot = rendered.group.getObjectByName('mapLocalLights') as THREE.Group;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 8, 16);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    rendered.update(0.016, camera, 100);

    expect(lightRoot.children).toHaveLength(MAX_VISIBLE_MAP_LOCAL_LIGHTS);
    expect(lightRoot.children.filter((child) => child.visible)).toHaveLength(MAX_VISIBLE_MAP_LOCAL_LIGHTS);
    rendered.dispose();
  });
});

describe('grass-only refresh', () => {
  it('builds distinct farm and moss silhouettes and keeps flower accents visible', async () => {
    const map = createEmptyMap('grass families', 'map-grass-families');
    const meadow = createGrassLayer(
      { id: 'meadow', seed: 7, preset: 'meadow', height: 0.8 },
      map.terrain.resolutionX,
      map.terrain.resolutionZ
    );
    const farm = createGrassLayer(
      { id: 'farm', seed: 8, preset: 'farm', height: 1.55, mix: { short: 0, tall: 0, flowers: 1 } },
      map.terrain.resolutionX,
      map.terrain.resolutionZ
    );
    const moss = createGrassLayer(
      { id: 'moss', seed: 9, preset: 'alpine-moss', height: 0.45 },
      map.terrain.resolutionX,
      map.terrain.resolutionZ
    );
    map.grassLayers = [meadow, farm, moss];
    map.grassLayers.forEach((layer) => fillGrassLayerInPlace(map, layer.id, 0.55));

    const rendered = await buildEditableMapGroup(map);
    const meadowMesh = rendered.group.getObjectByName('grass:meadow') as THREE.InstancedMesh;
    const farmMesh = rendered.group.getObjectByName('grass:farm') as THREE.InstancedMesh;
    const mossMesh = rendered.group.getObjectByName('grass:moss') as THREE.InstancedMesh;
    const flowers = rendered.group.getObjectByName('grass-flowers:farm') as THREE.InstancedMesh;

    expect(meadowMesh.userData).toMatchObject({ grassPreset: 'meadow', grassHeight: 0.8 });
    expect(farmMesh.userData).toMatchObject({ grassPreset: 'farm', grassHeight: 1.55 });
    expect(mossMesh.userData).toMatchObject({ grassPreset: 'alpine-moss', grassHeight: 0.45 });
    expect(farmMesh.geometry.getAttribute('position').count).toBeGreaterThan(meadowMesh.geometry.getAttribute('position').count);
    expect(mossMesh.geometry.boundingBox?.max.y).toBeLessThan(meadowMesh.geometry.boundingBox?.max.y ?? 0);
    expect(flowers.count).toBeGreaterThan(0);
    expect(flowers.geometry.getAttribute('position').count).toBeGreaterThan(10);
    rendered.dispose();
  });

  it('replaces just the grass field, keeps the applied style and picks up new density', async () => {
    const map = createEmptyMap('grass', 'map-grass-refresh');
    const layer = createGrassLayer({ seed: 3 }, map.terrain.resolutionX, map.terrain.resolutionZ);
    map.grassLayers = [layer];
    fillGrassLayerInPlace(map, layer.id, 0.4);

    const rendered = await buildEditableMapGroup(map);
    const fields = () => rendered.group.children.filter((child) => child.name === 'CartoonGrassField');
    const blades = () => rendered.group.getObjectByName(`grass:${layer.id}`) as THREE.InstancedMesh;
    const bladeHeightOf = (mesh: THREE.InstancedMesh): number => {
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3();
      mesh.getMatrixAt(0, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      return scale.y;
    };
    const first = blades();
    const firstHeight = bladeHeightOf(first);

    rendered.setGrassStyle({ ...DEFAULT_RUNTIME_GRASS_STYLE, bladeHeight: 1.4 });
    rendered.refreshGrass(map);
    const restyled = blades();

    expect(restyled).not.toBe(first);
    expect(fields()).toHaveLength(1);
    expect(bladeHeightOf(restyled) / firstHeight).toBeCloseTo(1.4 / DEFAULT_RUNTIME_GRASS_STYLE.bladeHeight, 5);

    fillGrassLayerInPlace(map, layer.id, 0.95);
    rendered.refreshGrass(map);

    expect(fields()).toHaveLength(1);
    expect(blades().count).toBeGreaterThan(restyled.count);
    rendered.dispose();
  });
});

function createTestObject(id: string, assetId: string) {
  return {
    id,
    name: id,
    parentId: null,
    assetId,
    transform: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      size: [1, 1, 1] as [number, number, number]
    },
    visible: true,
    locked: false
  };
}
