import * as THREE from 'three';
import { WebGLLights } from 'three/src/renderers/webgl/WebGLLights.js';
import { describe, expect, it, vi } from 'vitest';
import { RenderRuntimeAdapter } from '../src/client/renderRuntimeAdapter';

function createHarness(mainLayer = 0) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.layers.set(mainLayer);
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.layers.set(mainLayer);
  root.add(mesh);
  const sun = new THREE.DirectionalLight();
  const ambient = new THREE.HemisphereLight();
  const nested = new THREE.Group();
  const point = new THREE.PointLight();
  for (const light of [sun, ambient, point]) light.layers.set(mainLayer);
  nested.add(point);
  const excluded = new THREE.PointLight();
  excluded.layers.set(29);
  scene.add(root, sun, ambient, nested, excluded);

  const lighting = new WebGLLights({ has: () => false } as never);
  const observed: THREE.Light[][] = [];
  const renderer = {
    shadowMap: { autoUpdate: true },
    getRenderTarget: () => null,
    getClearColor: (target: THREE.Color) => target.set(0x123456),
    getClearAlpha: () => 0.5,
    setRenderTarget: vi.fn(), setClearColor: vi.fn(), clear: vi.fn(),
    render: vi.fn((renderScene: THREE.Scene, renderCamera: THREE.Camera) => {
      const lights: THREE.Light[] = [];
      renderScene.traverseVisible((object) => {
        if ((object as THREE.Light).isLight && object.layers.test(renderCamera.layers)) lights.push(object as THREE.Light);
      });
      observed.push([...lights]);
      lighting.setup(lights);
    })
  };
  // Exercise the real pass without allocating a WebGL context or composer.
  const adapter = Object.assign(Object.create(RenderRuntimeAdapter.prototype), {
    scene, camera, renderer,
    normalTarget: new THREE.WebGLRenderTarget(8, 8),
    normalMaterial: new THREE.MeshNormalMaterial()
  }) as { renderNormalDepth(root: THREE.Object3D): void };
  return { scene, camera, root, mesh, renderer, adapter, lighting, observed, lights: [sun, ambient, point, excluded] };
}

describe('normal/depth pass light-state stability', () => {
  it.each([0, 3])('preserves the main camera light selection on layer %i', (layer) => {
    const h = createHarness(layer);
    h.renderer.render(h.scene, h.camera);
    const expected = new Set(h.observed[0]);
    h.adapter.renderNormalDepth(h.root);
    expect(new Set(h.observed[1])).toEqual(expected);
  });

  it('does not invalidate Three.js lighting version on every prepass/main transition', () => {
    const h = createHarness();
    h.renderer.render(h.scene, h.camera);
    const version = h.lighting.state.version;
    for (let frame = 0; frame < 3; frame += 1) {
      h.adapter.renderNormalDepth(h.root);
      h.renderer.render(h.scene, h.camera);
      expect(h.lighting.state.version).toBe(version);
    }
  });

  it('restores light, mesh and camera masks even when drawing throws', () => {
    const h = createHarness(3);
    const lightMasks = h.lights.map((light) => light.layers.mask);
    const cameraMask = h.camera.layers.mask;
    const meshMask = h.mesh.layers.mask;
    h.renderer.render.mockImplementationOnce(() => { throw new Error('render failed'); });
    expect(() => h.adapter.renderNormalDepth(h.root)).toThrow('render failed');
    expect(h.lights.map((light) => light.layers.mask)).toEqual(lightMasks);
    expect(h.camera.layers.mask).toBe(cameraMask);
    expect(h.mesh.layers.mask).toBe(meshMask);
    expect(h.renderer.shadowMap.autoUpdate).toBe(true);
    expect(h.scene.overrideMaterial).toBeNull();
  });

  it.each([false, true])('keeps each surface depth bias in the normal pass (foliage=%s)', (foliage) => {
    const h = createHarness();
    const wall = h.mesh.material as THREE.Material;
    const panel = new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const layered = new THREE.Mesh(new THREE.BoxGeometry(), [wall, panel]);
    h.root.add(layered);
    const foliageNormal = new THREE.MeshNormalMaterial();
    if (foliage) h.mesh.userData.outdoorNormalMaterial = foliageNormal;
    const originalBeforeRender = layered.onBeforeRender;
    const originals = [h.mesh.material, layered.material];
    const observed: Array<[boolean, number, number]> = [];
    h.renderer.render.mockImplementation(() => {
      // WebGLRenderer only submits geometry groups when the material stays an array.
      expect(Array.isArray(layered.material)).toBe(true);
      for (const [mesh, materialIndex] of [[layered, 1], [h.mesh, 0], [layered, 0]] as const) {
        const material = h.scene.overrideMaterial
          ?? (Array.isArray(mesh.material) ? mesh.material[materialIndex] : mesh.material);
        mesh.onBeforeRender(h.renderer as never, h.scene, h.camera, mesh.geometry, material, { start: 0, count: 6, materialIndex } as never);
        observed.push([material.polygonOffset, material.polygonOffsetFactor, material.polygonOffsetUnits]);
      }
    });
    h.adapter.renderNormalDepth(h.root);
    expect(observed).toEqual([[true, -3, -3], [false, 0, 0], [false, 0, 0]]);
    expect([h.mesh.material, layered.material]).toEqual(originals);
    expect(layered.onBeforeRender).toBe(originalBeforeRender);
    expect([panel.polygonOffset, panel.polygonOffsetFactor, panel.polygonOffsetUnits]).toEqual([true, -3, -3]);
    expect(foliageNormal.polygonOffset).toBe(false);
  });

  it('restores callbacks and shared normal material bias when a layered draw throws', () => {
    const h = createHarness();
    const original = h.mesh.material as THREE.Material;
    original.polygonOffset = true;
    original.polygonOffsetFactor = -2;
    original.polygonOffsetUnits = -2;
    const callback = vi.fn();
    h.mesh.onBeforeRender = callback;
    let normal: THREE.Material | null = null;
    h.renderer.render.mockImplementation(() => {
      normal = h.scene.overrideMaterial;
      h.mesh.onBeforeRender(h.renderer as never, h.scene, h.camera, h.mesh.geometry, normal!, null as never);
      expect(normal!.polygonOffsetUnits).toBe(-2);
      throw new Error('layered draw failed');
    });
    expect(() => h.adapter.renderNormalDepth(h.root)).toThrow('layered draw failed');
    expect(h.mesh.onBeforeRender).toBe(callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(h.mesh.material).toBe(original);
    expect(normal!.polygonOffset).toBe(false);
    expect(normal!.polygonOffsetUnits).toBe(0);
  });
});
