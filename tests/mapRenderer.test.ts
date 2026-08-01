import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditableMapGroup, buildStructuredWaterGroup } from '../src/client/mapRenderer';
import { createEmptyMap } from '../src/shared/map';
import type { MapAsset } from '../src/shared/map';

describe('structured map water rendering', () => {
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
        points: [[-6, -5], [-1, 0], [6, 5]]
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
    expect(lake.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(3);
    expect(river.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(6);

    waterRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
    });
  });

  it('builds one asset template, shares geometry, and keeps per-instance materials isolated', async () => {
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
    const first = rendered.objectGroups.get('tree-a')?.getObjectByName('trunk') as THREE.Mesh;
    const second = rendered.objectGroups.get('tree-b')?.getObjectByName('trunk') as THREE.Mesh;
    expect(first.geometry).toBe(second.geometry);
    expect(first.material).not.toBe(second.material);
    expect(first.userData.mapObjectId).toBe('tree-a');
    expect(second.userData.mapObjectId).toBe('tree-b');

    let geometryDisposals = 0;
    first.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });
    rendered.dispose();
    expect(geometryDisposals).toBe(1);
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
    expect(batch.userData.instanceObjectIds).toEqual(['shrub-0', 'shrub-1', 'shrub-2', 'shrub-3']);
    expect(rendered.pickables).toContain(batch);

    const selected = rendered.objectGroups.get('shrub-2') as THREE.Group;
    selected.position.x = 20;
    rendered.syncObjectTransform('shrub-2');
    const matrix = new THREE.Matrix4();
    batch.getMatrixAt(2, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).x).toBeCloseTo(20);
    rendered.dispose();
  });

  it('keeps material-tagged copies on the isolated material path', async () => {
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
    expect(rendered.modelsRoot.getObjectByProperty('isInstancedMesh', true)).toBeUndefined();

    const materials = map.objects.map((object) => (
      rendered.objectGroups.get(object.id)?.getObjectByName('leaf') as THREE.Mesh
    ).material);
    expect(new Set(materials).size).toBe(4);
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
