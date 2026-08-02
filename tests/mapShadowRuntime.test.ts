import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MapShadowRuntime } from '../src/client/mapShadowRuntime';

describe('MapShadowRuntime', () => {
  it('patches model and terrain materials while keeping helpers outside its scope', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 900);
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    const target = new THREE.Object3D();
    sun.target = target;
    sun.position.set(20, 30, 10);
    scene.add(sun, target);

    const contentRoot = new THREE.Group();
    const modelsRoot = new THREE.Group();
    modelsRoot.userData.isModelRoot = true;
    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    terrain.name = 'terrain';
    const model = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const helper = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    helper.userData.isEditorObject = true;
    modelsRoot.add(model);
    contentRoot.add(terrain, modelsRoot);
    scene.add(contentRoot, helper);

    const runtime = new MapShadowRuntime(scene, camera, sun, vi.fn());
    runtime.setSceneRoots(contentRoot, modelsRoot);

    expect(sun.visible).toBe(false);
    expect((model.material as THREE.Material).defines?.USE_CSM).toBeDefined();
    expect((terrain.material as THREE.Material).defines?.USE_CSM).toBeDefined();
    expect((helper.material as THREE.Material).defines?.USE_CSM).toBeUndefined();

    runtime.dispose();

    expect(sun.visible).toBe(true);
    expect((model.material as THREE.Material).defines?.USE_CSM).toBeUndefined();
    expect((terrain.material as THREE.Material).defines?.USE_CSM).toBeUndefined();
  });
});
