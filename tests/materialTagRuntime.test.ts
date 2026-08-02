import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RuntimeIndex } from '@voxel-studio/render-runtime';
import { WorldForgeMaterialTagRuntime } from '../src/client/materialTagRuntimeAdapter';

describe('WorldForge material tag runtime', () => {
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
});

function createRuntime(
  scene: THREE.Scene,
  modelsRoot: THREE.Group,
  objectGroups: Map<string, THREE.Group>
): WorldForgeMaterialTagRuntime {
  const batchParent = new THREE.Group();
  modelsRoot.add(batchParent);
  return new WorldForgeMaterialTagRuntime({
    scene,
    runtimeIndex: new RuntimeIndex(),
    batchParent,
    objectGroups,
    effectBatchMinGroupSize: 8
  });
}
