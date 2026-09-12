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
});
