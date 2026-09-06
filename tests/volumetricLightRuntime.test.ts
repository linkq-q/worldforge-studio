import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { VolumetricLightRuntime } from '../src/client/volumetricLightRuntime';
import { createEmptyMap, createMapObject, createMapObjectLight } from '../src/shared/map';
import { compileRuntimeVolumetricLight } from '../src/shared/renderPlan';

const style = compileRuntimeVolumetricLight({ version: 2, baseSchemeId: 'test', modules: [
  { id: 'runtime.volumetric-light', params: { mode: 'soft' } }
] });

function fixture() {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const modelsRoot = new THREE.Group();
  group.add(modelsRoot);
  scene.add(group);
  const map = createEmptyMap('test', 'test');
  map.objects = [
    ...Array.from({ length: 6 }, (_, i) => {
      const lamp = createMapObject(`吊灯 ${i}`);
      lamp.light = { ...createMapObjectLight('point'), intensity: 10, color: '#ff9924' };
      lamp.transform.position = [i * 3 - 7.5, 6, 0];
      return lamp;
    }),
    Object.assign(createMapObject('灯光｜左后窗边冷光'), {
      light: { ...createMapObjectLight('spot'), intensity: 4.4, color: '#8fb7cc', target: [0, 1, 0] },
    }),
    Object.assign(createMapObject('室内反弹'), { light: { ...createMapObjectLight('point'), role: 'fill' } })
  ];
  map.objects[6].transform.position = [-8, 5, -6];
  const objectGroups = new Map(map.objects.map(object => {
    const anchor = new THREE.Group();
    anchor.position.fromArray(object.transform.position);
    modelsRoot.add(anchor);
    return [object.id, anchor];
  }));
  const runtime = new VolumetricLightRuntime(scene);
  return { runtime, scene, map, rendered: { group, modelsRoot, objectGroups } };
}

describe('localized volumetric light', () => {
  it('includes directed cold light and all pendants, excludes bounce, and keeps four central lamps stronger', () => {
    const { runtime, map, rendered } = fixture();
    const original = JSON.stringify(map);
    runtime.apply(map, rendered, style);
    expect(runtime.group.children).toHaveLength(7);
    const meshes = runtime.group.children as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[];
    expect(meshes.map(mesh => mesh.userData.sourceId)).not.toContain(map.objects[7].id);
    const pendants = meshes.slice(0, 6);
    expect(pendants.filter(mesh => mesh.material.uniforms.uDensity.value > pendants[0].material.uniforms.uDensity.value)).toHaveLength(4);
    const cold = meshes.find(mesh => mesh.userData.sourceId === map.objects[6].id)!;
    expect(cold.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(8, -4, 6).normalize())).toBeLessThan(0.0001);
    expect(cold.material.uniforms.uColor.value.getHexString()).toBe('8fb7cc');
    expect(runtime.group.parent).toBe(rendered.modelsRoot);
    expect(JSON.stringify(map)).toBe(original);
    runtime.dispose();
  });

  it('uses volume integration, shares camera depth, and never pulses the whole beam', () => {
    const { runtime, map, rendered } = fixture();
    runtime.apply(map, rendered, style);
    const mesh = runtime.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(mesh.material.side).toBe(THREE.BackSide);
    expect(mesh.material.depthTest).toBe(false);
    const density = mesh.material.uniforms.uDensity.value;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.copy(mesh.localToWorld(new THREE.Vector3(0, 0, 2)));
    camera.updateMatrixWorld();
    const depth = new THREE.DepthTexture(800, 600);
    runtime.bindDepth(depth, camera, 800, 600);
    expect(mesh.material.uniforms.uDepth.value).toBe(depth);
    expect(mesh.material.uniforms.uCameraLocal.value.distanceTo(new THREE.Vector3(0, 0, 2))).toBeLessThan(0.0001);
    expect(mesh.material.uniforms.uResolution.value.toArray()).toEqual([800, 600]);
    runtime.update(18);
    expect(mesh.material.uniforms.uDensity.value).toBe(density);
    expect(mesh.material.fragmentShader).toContain('opticalDepth');
    expect(mesh.material.fragmentShader).not.toContain('sin(');
    runtime.dispose();
  });

  it('clips scattering behind a large shelf and releases old volumes when disabled', () => {
    const { runtime, map, rendered } = fixture();
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(6, 0.3, 6), new THREE.MeshStandardMaterial());
    shelf.position.set(-7.5, 4, 0);
    rendered.modelsRoot.add(shelf);
    runtime.apply(map, rendered, style);
    const mesh = runtime.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const shadow = mesh.material.uniforms.uLightDepth.value as THREE.DataTexture;
    const values = shadow.image.data as Uint8Array;
    expect(Math.min(...values)).toBeLessThan(200);
    const released = vi.spyOn(shadow, 'dispose');
    runtime.apply(map, rendered, { ...style, mode: 'off' });
    expect(runtime.group.children).toHaveLength(0);
    expect(runtime.group.visible).toBe(false);
    expect(released).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it('does not let a board behind the emitter block forward scattering', () => {
    const { runtime, map, rendered } = fixture();
    const board = new THREE.Mesh(new THREE.BoxGeometry(6, 0.1, 6), new THREE.MeshStandardMaterial());
    board.position.set(-7.5, 6.3, 0);
    rendered.modelsRoot.add(board);
    runtime.apply(map, rendered, style);
    const mesh = runtime.group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const shadow = mesh.material.uniforms.uLightDepth.value as THREE.DataTexture;
    expect(Math.min(...shadow.image.data as Uint8Array)).toBe(255);
    runtime.dispose();
  });

  it('respects rotated offsets under a transformed models root without changing source data', () => {
    const { runtime, map, rendered } = fixture();
    rendered.modelsRoot.position.set(3, 1, -4);
    rendered.modelsRoot.rotation.y = Math.PI / 2;
    map.objects[0].light!.offset = [1, 0, 0];
    const anchor = rendered.objectGroups.get(map.objects[0].id)!;
    const position = anchor.getWorldPosition(new THREE.Vector3());
    const rotation = anchor.getWorldQuaternion(new THREE.Quaternion());
    position.add(new THREE.Vector3(1, 0, 0).applyQuaternion(rotation));
    runtime.apply(map, rendered, style);
    const mesh = runtime.group.children[0];
    expect(mesh.getWorldPosition(new THREE.Vector3()).distanceTo(position)).toBeLessThan(0.0001);
    runtime.dispose();
  });
});
