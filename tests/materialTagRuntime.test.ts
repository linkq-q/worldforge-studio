import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createEffectRuntime } from '@voxel-studio/render-runtime/effects';
import { WorldForgeMaterialTagRuntime } from '../src/client/materialTagRuntimeAdapter';

describe('WorldForge material tag runtime', () => {
  it('compiles inherited Voxel Studio tags onto the matching model mesh', () => {
    const scene = new THREE.Scene();
    const modelsRoot = new THREE.Group();
    const modelRoot = new THREE.Group();
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

    const effectRuntime = createEffectRuntime().runtime;
    const runtime = new WorldForgeMaterialTagRuntime(scene, effectRuntime);
    const result = runtime.apply(modelsRoot);

    expect(result.taggedParts).toBe(1);
    expect(result.appliedParts).toBe(1);
    expect(mesh.userData.effectSlots?.length).toBeGreaterThan(0);

    runtime.clear(modelsRoot);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });
});
