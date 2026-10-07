import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { configureOutdoorSunLight, configureSunLight } from '../src/client/lighting';
import { createEmptyMap } from '../src/shared/map';

function corners(box: THREE.Box3): THREE.Vector3[] {
  return [box.min.x, box.max.x].flatMap(x => [box.min.y, box.max.y]
    .flatMap(y => [box.min.z, box.max.z].map(z => new THREE.Vector3(x, y, z))));
}

function fixture() {
  const root = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.BoxGeometry(96, 1, 96));
  ground.position.y = -0.5;
  ground.receiveShadow = true;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(8, 48, 8));
  tower.position.set(-18, 24, 14);
  tower.castShadow = true;
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 18, 6), new THREE.MeshStandardMaterial(), 2);
  instances.castShadow = true;
  instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-22, 58, -15));
  instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(25, 9, 30));
  root.add(ground, tower, instances);
  root.rotation.y = 0.23;
  root.position.set(11, 3, -7);
  const light = new THREE.DirectionalLight();
  const target = new THREE.Object3D();
  return { root, light, target, tower, instances };
}

function expectBoundsCovered(light: THREE.DirectionalLight, bounds: THREE.Box3) {
  light.updateMatrixWorld(true);
  light.target.updateMatrixWorld(true);
  light.shadow.updateMatrices(light);
  for (const point of corners(bounds)) {
    const clip = point.project(light.shadow.camera);
    expect(Math.abs(clip.x)).toBeLessThan(1);
    expect(Math.abs(clip.y)).toBeLessThan(1);
    expect(Math.abs(clip.z)).toBeLessThan(1);
  }
}

describe('outdoor sun shadow fit', () => {
  it('halves the v7 shadow texel footprint, respects GPU limits and resizes existing targets when switching back', () => {
    const { root, light, target } = fixture();
    light.shadow.map = new THREE.WebGLRenderTarget(4096, 4096);
    configureOutdoorSunLight(light, target, root, -48, 38, 0.5, 1, 16384);
    const camera = light.shadow.camera;
    const originalProjection = camera.projectionMatrix.clone();
    const oldFootprint = (camera.right - camera.left) / light.shadow.mapSize.x;
    configureOutdoorSunLight(light, target, root, -48, 38, 0.5, 2, 16384);
    expect(light.shadow.mapSize.toArray()).toEqual([8192, 8192]);
    expect([light.shadow.map.width, light.shadow.map.height]).toEqual([8192, 8192]);
    expect((camera.right - camera.left) / light.shadow.mapSize.x).toBeCloseTo(oldFootprint / 2, 12);
    expect(camera.projectionMatrix).toEqual(originalProjection);
    for (const limit of [4096, 2048]) {
      configureOutdoorSunLight(light, target, root, -48, 38, 0.5, 2, limit);
      expect(light.shadow.mapSize.toArray()).toEqual([limit, limit]);
      expect(light.shadow.map.width).toBe(limit);
    }
    configureOutdoorSunLight(light, target, root, -48, 38, 0.5, 1, 16384);
    expect(light.shadow.mapSize.toArray()).toEqual([4096, 4096]);
    expect(light.shadow.map.width).toBe(4096);
    light.shadow.map.dispose();
  });

  it('keeps the accepted bias by default and uses fixed millimetre bias only in the opt-in shadow mode', () => {
    const { root, light, target } = fixture();
    configureOutdoorSunLight(light, target, root, -48, 38, 0.5);
    expect(light.shadow.bias).toBe(-0.00008);
    expect(light.shadow.normalBias).toBe(0.02);
    const originalProjection = light.shadow.camera.projectionMatrix.clone();
    for (const scale of [1, 3]) {
      root.scale.setScalar(scale);
      configureOutdoorSunLight(light, target, root, -48, 38, 0.5, 2);
      const camera = light.shadow.camera;
      expect(light.shadow.bias * (camera.far - camera.near)).toBeCloseTo(-0.002, 12);
      expect(light.shadow.normalBias).toBe(0.003);
      expect(light.shadow.mapSize.toArray()).toEqual([8192, 8192]);
      if (scale === 1) expect(camera.projectionMatrix).toEqual(originalProjection);
    }
    configureOutdoorSunLight(light, target, root, -48, 38, 0.5, 1);
    expect(light.shadow.bias).toBe(-0.00008);
    expect(light.shadow.normalBias).toBe(0.02);
  });

  it('reproduces high architecture crossing the legacy shadow near plane and fits every real bound in the new mode', () => {
    const { root, light, target, tower } = fixture();
    const map = createEmptyMap('cathedral', 'map-shadow-fixture', [96, 16, 96]);
    map.lighting.sunPosition = [-18, 24, 14];
    configureSunLight(light, target, map);
    light.updateMatrixWorld(true);
    light.shadow.updateMatrices(light);
    root.updateMatrixWorld(true);
    expect(corners(new THREE.Box3().setFromObject(tower)).some(point =>
      point.applyMatrix4(light.shadow.camera.matrixWorldInverse).z > -light.shadow.camera.near)).toBe(true);

    expect(configureOutdoorSunLight(light, target, root, 225, 28, 0.65)).toBe(true);
    expectBoundsCovered(light, new THREE.Box3().setFromObject(root));
    expect(light.shadow.mapSize.toArray()).toEqual([4096, 4096]);
    expect(light.shadow.radius).toBeCloseTo(3.6);
  });

  it('refreshes stale instanced bounds and covers low-angle shadows after content changes', () => {
    const { root, light, target, instances } = fixture();
    configureOutdoorSunLight(light, target, root, 70, 8, 0);
    instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-70, 90, -35));
    configureOutdoorSunLight(light, target, root, 70, 8, 1);
    expectBoundsCovered(light, new THREE.Box3().setFromObject(root));
    expect(light.shadow.radius).toBe(5);
    const direction = light.position.clone().sub(target.position).normalize();
    expect(direction.y).toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(8)));
  });

  it('ignores hidden and helper geometry, and preserves existing settings for an empty scene', () => {
    const { root, light, target } = fixture();
    configureOutdoorSunLight(light, target, root, 200, 35, 0.5);
    const originalPosition = light.position.toArray();
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(10000, 10000, 10000));
    hidden.castShadow = true;
    hidden.visible = false;
    const helper = hidden.clone();
    helper.visible = true;
    helper.userData.isHelper = true;
    root.add(hidden, helper);
    configureOutdoorSunLight(light, target, root, 200, 35, 0.5);
    expect(light.position.toArray()).toEqual(originalPosition);
    expect(configureOutdoorSunLight(light, target, new THREE.Group(), 200, 35, 0.5)).toBe(false);
    expect(light.position.toArray()).toEqual(originalPosition);
  });

  it('resizes an allocated shadow target when switching between the optional fit and the legacy default', () => {
    const { root, light, target } = fixture();
    light.shadow.map = new THREE.WebGLRenderTarget(2048, 2048);
    configureOutdoorSunLight(light, target, root, 220, 30, 0.5);
    expect(light.shadow.map.width).toBe(4096);
    configureSunLight(light, target, createEmptyMap());
    expect(light.shadow.mapSize.toArray()).toEqual([2048, 2048]);
    expect(light.shadow.map.width).toBe(2048);
    expect(light.shadow.bias).toBe(-0.00012);
    expect(light.shadow.normalBias).toBe(0.035);
    light.shadow.map.dispose();
  });
});
