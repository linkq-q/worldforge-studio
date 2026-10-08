import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { RenderRuntimeAdapter } from '../src/client/renderRuntimeAdapter';

function createHarness() {
  const scene = new THREE.Scene();
  const modelsRoot = new THREE.Group();
  modelsRoot.position.y = 3;
  scene.add(modelsRoot);
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 1000);
  camera.position.set(0, 12, 20);
  camera.lookAt(0, 4, 0);
  const captures: Array<{ y: number; visible: string[]; width: number; height: number }> = [];
  let target: THREE.WebGLRenderTarget | null = null;
  const renderer = {
    xr: { enabled: false }, shadowMap: { autoUpdate: true }, capabilities: { isWebGL2: false },
    getRenderTarget: () => target,
    setRenderTarget: (next: THREE.WebGLRenderTarget | null) => { target = next; }, clear: vi.fn(),
    getPixelRatio: () => 2,
    getSize: (size: THREE.Vector2) => size.set(1920, 1080),
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(3840, 2160),
    render: (_scene: THREE.Scene, reflected: THREE.Camera) => {
      const visible: string[] = [];
      scene.traverseVisible(object => { if (object.name) visible.push(object.name); });
      captures.push({ y: reflected.position.y, visible, width: target!.width, height: target!.height });
    }
  } as unknown as THREE.WebGLRenderer;
  let scheduled: { render(): void } | null = null;
  const frameCoordinator = { setPlanarReflectionPass: (pass: typeof scheduled) => { scheduled = pass; } };
  const adapter = Object.assign(Object.create(RenderRuntimeAdapter.prototype), {
    renderer, scene, camera, modelsRoot, contentRoot: modelsRoot, frameCoordinator,
    waterBindings: [], waterDetailTexture: null, waterSceneCapture: null, waterReflection: null,
    waterReflectionGroups: [], waterReflectionSurfaces: [], waterReflectionExclusions: [], waterReflectionElapsed: 0,
    waterReflectionFrustum: new THREE.Frustum(), waterReflectionProjection: new THREE.Matrix4(),
    waterEnvironmentMap: null, waterInteractionAt: new Map(), materialBaselines: new Map(),
    effectRuntime: { removeFromObject3D: vi.fn(), updateRuntimeUniforms: vi.fn() },
    underwaterMode: 'off', underwaterBlend: 0, underwaterPassActive: false
  }) as RenderRuntimeAdapter;
  const addWater = (name: string, type: string, level: number, x = 0) => {
    const geometry = new THREE.PlaneGeometry(16, 16);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    mesh.name = name;
    mesh.position.set(x, level, 0);
    mesh.userData = { materialTags: ['water'], waterBodyType: type, isWater: true, excludeFromPlanarReflection: true };
    modelsRoot.add(mesh);
    return mesh;
  };
  const draw = (dt = 0) => { adapter.tick(dt, 1); scheduled?.render(); };
  return { scene, modelsRoot, camera, adapter, addWater, draw, captures, scheduled: () => scheduled };
}

describe('structured water scene reflections', () => {
  it('uses actual world water planes, shares coplanar captures, retains the sky and excludes helpers', () => {
    const h = createHarness();
    const ocean = h.addWater('ocean', 'ocean', 1);
    const lake = h.addWater('lake', 'lake', 1, 5);
    const river = h.addWater('sloped-river', 'river', 2);
    const sky = new THREE.Mesh(); sky.name = 'sky'; sky.userData.isEnvironmentObject = true; h.scene.add(sky);
    const helper = new THREE.Mesh(); helper.name = 'editor-helper'; helper.userData.editorHelper = true; h.modelsRoot.add(helper);
    const shore = new THREE.Mesh(); shore.name = 'shore'; h.modelsRoot.add(shore);
    h.adapter.applyScopedCapabilities([], [], []);
    h.draw();
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0].y).toBeCloseTo(-4); // 2 * world water level 4 - camera height 12.
    expect(h.captures[0].visible).toContain('sky');
    expect(h.captures[0].visible).toContain('shore');
    expect(h.captures[0].visible).not.toContain('editor-helper');
    expect(h.captures[0].visible).not.toContain('ocean');
    expect(h.captures[0].visible).not.toContain('lake');
    expect(h.captures[0].width).toBeLessThanOrEqual(1024);
    const uniforms = (mesh: THREE.Mesh) => (mesh.material as THREE.ShaderMaterial).uniforms;
    expect(uniforms(ocean).uHasPlanarReflection.value).toBe(true);
    expect(uniforms(lake).tPlanarReflection.value).toBe(uniforms(ocean).tPlanarReflection.value);
    expect(uniforms(river).uHasPlanarReflection.value).toBe(false);
    expect(helper.visible).toBe(true);
    h.adapter.resetScopedCapabilities();
    expect(h.scheduled()).toBeNull();
  });

  it('refreshes moving scenes on a bounded cadence, camera movement immediately, and skips hidden or submerged water', () => {
    const h = createHarness();
    const ocean = h.addWater('ocean', 'ocean', 1);
    h.adapter.applyScopedCapabilities([], [], []);
    const uniforms = (ocean.material as unknown as THREE.ShaderMaterial).uniforms;
    h.draw(); h.draw(1 / 60);
    expect(h.captures).toHaveLength(1);
    expect(uniforms.uHasPlanarReflection.value).toBe(true);
    h.draw(0.1);
    expect(h.captures).toHaveLength(2);
    h.camera.position.x += 1;
    h.draw();
    expect(h.captures).toHaveLength(3);
    h.camera.position.y = 2; h.draw(0.1);
    expect(h.captures).toHaveLength(3);
    expect(uniforms.uHasPlanarReflection.value).toBe(false);
    h.camera.position.y = 12; h.draw();
    expect(h.captures).toHaveLength(4);
    expect(uniforms.uHasPlanarReflection.value).toBe(true);
    ocean.visible = false; h.draw(0.1);
    expect(h.captures).toHaveLength(4);
    expect(uniforms.uHasPlanarReflection.value).toBe(false);
    ocean.visible = true; h.draw();
    expect(uniforms.uHasPlanarReflection.value).toBe(true);
    ocean.position.x = 2000; h.draw(0.1);
    expect(h.captures).toHaveLength(5);
    expect(uniforms.uHasPlanarReflection.value).toBe(false);
    ocean.position.x = 0; h.draw();
    expect(uniforms.uHasPlanarReflection.value).toBe(true);
    h.adapter.resetScopedCapabilities();
  });

  it('bounds captures across many visible water levels and rejects a tilted lake', () => {
    const h = createHarness();
    for (let level = 0; level < 6; level++) h.addWater(`lake-${level}`, 'lake', level);
    const tilted = h.addWater('tilted', 'lake', 1);
    tilted.rotation.x = 0.2;
    h.adapter.applyScopedCapabilities([], [], []);
    h.draw();
    expect(h.captures.length).toBeGreaterThan(0);
    expect(h.captures.length).toBeLessThanOrEqual(3);
    expect((tilted.material as unknown as THREE.ShaderMaterial).uniforms.uHasPlanarReflection.value).toBe(false);
    h.adapter.resetScopedCapabilities();
  });
});
