import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import materialTagVocabulary from '@voxel-studio/render-runtime/model/material-tags-v1.json';
import { RuntimeIndex } from '@voxel-studio/render-runtime';
import { compileModelMaterialTags } from '@voxel-studio/render-runtime/effects';
import { WorldForgeMaterialTagRuntime } from '../src/client/materialTagRuntimeAdapter';
import { buildMapPrimitiveBatches } from '../src/client/mapPrimitiveBatching';
import { normalizeMaterialTagPolicy, type MapMaterialTagPolicy } from '../src/shared/materialTagPolicy';
import type { MapAsset } from '../src/shared/map';

describe('WorldForge material tag runtime', () => {
  it('compiles striped and checked plastic fabric into fixed batchable recipes', () => {
    const model = {
      name: 'market-awning',
      parts: [
        { id: 'vertical', isGroup: false, mesh: { type: 'box' }, tags: [{ tag: 'base', value: 'fabric', variant: 'red-white-vertical' }] },
        { id: 'checker', isGroup: false, mesh: { type: 'box' }, tags: [{ tag: 'base', value: 'fabric', variant: 'blue-white-checker' }] }
      ]
    };
    const compiled = compileModelMaterialTags(model, materialTagVocabulary);

    expect(compiled.byPartId.get('vertical')?.baseRecipe).toMatchObject({
      effectPackage: { materialLayers: [expect.objectContaining({ type: 'Triplanar', params: expect.objectContaining({ pattern: 7, plankScale: 0.34 }) })] },
      materialBindings: { surface: expect.objectContaining({ roughness: 0.58 }) }
    });
    expect(compiled.byPartId.get('checker')?.baseRecipe).toMatchObject({
      effectPackage: { materialLayers: [expect.objectContaining({ type: 'Triplanar', params: expect.objectContaining({ pattern: 9, colorLo: [0.08, 0.24, 0.72] }) })] }
    });
  });

  it('compiles inherited Voxel Studio tags onto the matching model mesh', () => {
    const scene = new THREE.Scene();
    const modelsRoot = new THREE.Group();
    const modelRoot = new THREE.Group();
    modelRoot.userData.mapObjectId = 'rock-object';
    modelRoot.userData.materialTagSource = {
      name: 'tagged-rock',
      nodes: [
        { id: 'root', tags: [{ tag: 'base', value: 'stone' }] },
        {
          id: 'rock',
          parent: 'root',
          mesh: { type: 'box' },
          tags: []
        }
      ]
    };
    const group = new THREE.Group();
    group.userData.nodeId = 'root';
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0x888888 })
    );
    mesh.userData.nodeId = 'rock';
    group.add(mesh);
    modelRoot.add(group);
    modelsRoot.add(modelRoot);
    scene.add(modelsRoot);

    const runtime = createRuntime(scene, modelsRoot, new Map([['rock-object', modelRoot]]));
    const result = runtime.apply(modelsRoot);

    expect(result.taggedParts).toBe(1);
    expect(result.appliedParts).toBe(1);
    expect(mesh.userData.effectSlots?.length).toBeGreaterThan(0);

    runtime.dispose();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });

  it('rebinds tag-authored reflective surfaces when the HDRI environment changes', () => {
    const scene = new THREE.Scene();
    const modelsRoot = new THREE.Group();
    const modelRoot = new THREE.Group();
    modelRoot.userData.mapObjectId = 'marble-object';
    modelRoot.userData.materialTagSource = {
      name: 'marble',
      nodes: [{
        id: 'marble',
        mesh: { type: 'box' },
        tags: [{ tag: 'base', value: 'stone', variant: 'marble' }]
      }]
    };
    const material = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.userData.nodeId = 'marble';
    modelRoot.add(mesh);
    modelsRoot.add(modelRoot);
    scene.add(modelsRoot);

    const runtime = createRuntime(scene, modelsRoot, new Map([['marble-object', modelRoot]]));
    runtime.apply(modelsRoot);
    const environment = new THREE.Texture();

    expect(runtime.syncEnvironment(environment)).toBeGreaterThan(0);
    expect(material.envMap).toBe(environment);
    expect(runtime.syncEnvironment(null)).toBeGreaterThan(0);
    expect(material.envMap).toBeNull();

    runtime.dispose();
    environment.dispose();
    mesh.geometry.dispose();
    material.dispose();
  });

  it('keeps the PMREM material environment separate from the water panorama', () => {
    const scene = new THREE.Scene();
    const modelsRoot = new THREE.Group();
    const runtime = createRuntime(scene, modelsRoot, new Map());
    const syncEnvironment = vi.fn(() => 1);
    (runtime as unknown as { waterRuntime: {
      syncEnvironment: typeof syncEnvironment;
      clear: () => void;
      dispose: () => void;
    } }).waterRuntime = {
      syncEnvironment,
      clear: vi.fn(),
      dispose: vi.fn()
    };
    const materialEnvironment = new THREE.Texture();
    const waterPanorama = new THREE.Texture();

    expect(runtime.syncEnvironment(materialEnvironment, waterPanorama)).toBe(1);
    expect(syncEnvironment).toHaveBeenCalledWith(waterPanorama);

    runtime.dispose();
    materialEnvironment.dispose();
    waterPanorama.dispose();
  });

  it('filters disabled tag values before compiling runtime effects', () => {
    const scene = new THREE.Scene();
    const modelsRoot = new THREE.Group();
    const modelRoot = new THREE.Group();
    modelRoot.userData.mapObjectId = 'deer-object';
    modelRoot.userData.materialTagSource = {
      name: 'deer',
      nodes: [{ id: 'body', mesh: { type: 'box' }, tags: [{ tag: 'base', value: 'fur' }] }]
    };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.userData.nodeId = 'body';
    modelRoot.add(mesh);
    modelsRoot.add(modelRoot);
    scene.add(modelsRoot);

    const runtime = createRuntime(
      scene,
      modelsRoot,
      new Map([['deer-object', modelRoot]]),
      normalizeMaterialTagPolicy(undefined)
    );
    const result = runtime.apply(modelsRoot);

    expect(result.taggedParts).toBe(0);
    expect(mesh.userData.effectSlots).toBeUndefined();
    runtime.dispose();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });

  it.each([
    ['gold', 'lerp'],
    ['silver', 'lerp'],
    ['metal', 'tint']
  ])('applies the %s MatCap binding to standalone meshes', (tagValue, mode) => {
    const scene = new THREE.Scene();
    const modelsRoot = new THREE.Group();
    const modelRoot = new THREE.Group();
    modelRoot.userData.mapObjectId = `${tagValue}-object`;
    modelRoot.userData.materialTagSource = {
      name: `${tagValue}-asset`,
      nodes: [{ id: 'part', mesh: { type: 'box' }, tags: [{ tag: 'base', value: tagValue }] }]
    };
    const material = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.userData.nodeId = 'part';
    modelRoot.add(mesh);
    modelsRoot.add(modelRoot);
    scene.add(modelsRoot);

    const runtime = createRuntime(scene, modelsRoot, new Map([[`${tagValue}-object`, modelRoot]]));
    const result = runtime.apply(modelsRoot);

    expect(result.skippedMatcaps).toBe(0);
    expect(result.appliedParts).toBe(1);
    expect(material.userData.worldforgeMaterialMatcapBinding).toMatchObject({
      enabled: true,
      textureName: tagValue,
      mode
    });
    expect(material.userData.shaderPatchChain).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'material-tag:matcap' })
    ]));

    runtime.dispose();
    mesh.geometry.dispose();
    material.dispose();
  });

  it('applies MatCap bindings to instanced batch materials', async () => {
    const scene = new THREE.Scene();
    const modelsRoot = new THREE.Group();
    const objectGroup = new THREE.Group();
    modelsRoot.add(objectGroup);
    scene.add(modelsRoot);
    const now = Date.now();
    const asset: MapAsset = {
      id: 'gold-asset',
      name: 'gold asset',
      prompt: 'gold cube',
      tags: [],
      modelJson: {
        nodes: [{ id: 'part', tags: [{ tag: 'base', value: 'gold' }], mesh: { type: 'box' } }]
      },
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 1, candidateCount: 1, fallbackUsed: false },
      mode: 'voxel',
      createdAt: now,
      updatedAt: now
    };

    const result = await buildMapPrimitiveBatches(
      [{ objectId: 'gold-object', objectGroup, asset, assetTags: [] }],
      { scene, modelsRoot, materialTagPolicy: { disabled: [] } }
    );
    const batch = result.getBatchMeshes().find((object): object is THREE.InstancedMesh => (
      (object as THREE.InstancedMesh).isInstancedMesh
    ));
    const material = Array.isArray(batch?.material) ? batch.material[0] : batch?.material;

    expect(batch).toBeDefined();
    expect(material?.userData.worldforgeMaterialMatcapBinding).toMatchObject({
      enabled: true,
      textureName: 'gold',
      mode: 'lerp'
    });
    expect(material?.userData.shaderPatchChain).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'material-tag:matcap' })
    ]));

    result.dispose();
  });
});

function createRuntime(
  scene: THREE.Scene,
  modelsRoot: THREE.Group,
  objectGroups: Map<string, THREE.Group>,
  materialTagPolicy: MapMaterialTagPolicy = { disabled: [] }
): WorldForgeMaterialTagRuntime {
  const batchParent = new THREE.Group();
  modelsRoot.add(batchParent);
  return new WorldForgeMaterialTagRuntime({
    scene,
    runtimeIndex: new RuntimeIndex(),
    batchParent,
    objectGroups,
    materialTagPolicy,
    effectBatchMinGroupSize: 8
  });
}
