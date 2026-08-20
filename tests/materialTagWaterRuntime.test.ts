import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  MaterialTagWaterRuntime,
  findPoolContainerBottom,
  resolveModelWaterMaskSource,
  resolveWaterFallRoutes
} from '../src/client/materialTagWaterRuntime';

describe('material-tag water routing', () => {
  it('uses the complete pre-batching model tree for structural water masks', () => {
    const modelRoot = new THREE.Group();
    modelRoot.position.set(4, 2, -3);
    const clipSource = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.BoxGeometry(3, 0.4, 0.3));
    rim.userData.nodeId = 'rim';
    const water = new THREE.Mesh(new THREE.BoxGeometry(2, 0.05, 2));
    water.userData.nodeId = 'water';
    clipSource.add(rim, water);
    modelRoot.userData.materialTagClipSource = clipSource;

    const resolved = resolveModelWaterMaskSource(modelRoot, new Set(['water']));

    expect(resolved.clipObject).toBe(clipSource);
    expect(resolved.objects.get('rim')).toBe(rim);
    expect(resolved.ignoredObjects).toEqual([water]);
    expect(clipSource.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([4, 2, -3]);
  });

  it('syncs the active environment into every generated model-water surface', () => {
    const environmentMap = new THREE.Texture();
    const first = {
      setWaterEnvMap: vi.fn(),
      setWaterReflectionParams: vi.fn()
    };
    const second = {
      setWaterEnvMap: vi.fn(),
      setWaterReflectionParams: vi.fn()
    };
    const runtime = Object.create(MaterialTagWaterRuntime.prototype) as MaterialTagWaterRuntime;
    (runtime as unknown as { waterInstances: { waterSurfaces(): unknown[] } }).waterInstances = {
      waterSurfaces: () => [first, second]
    };

    expect(runtime.syncEnvironment(environmentMap)).toBe(2);
    expect(first.setWaterEnvMap).toHaveBeenCalledWith(environmentMap);
    expect(first.setWaterReflectionParams).toHaveBeenCalledWith({ useSceneEnvironment: true });
    expect(second.setWaterEnvMap).toHaveBeenCalledWith(environmentMap);
  });

  it('renders planar scene reflections for generated model-water surfaces each frame', () => {
    const reflection = {
      setWaterSurfaces: vi.fn(),
      render: vi.fn()
    };
    const runtime = Object.create(MaterialTagWaterRuntime.prototype) as MaterialTagWaterRuntime;
    Object.assign(runtime as unknown as Record<string, unknown>, {
      waterInstances: {
        waterSurfaces: () => [{ mesh: new THREE.Mesh() }],
        update: vi.fn()
      },
      waterfalls: new Map(),
      particleEngine: { update: vi.fn() },
      fountainChain: { tick: vi.fn() },
      planarReflection: reflection,
      reflectionCamera: new THREE.PerspectiveCamera(),
      reflectedSurfaces: [],
      renderer: { domElement: { height: 720 } }
    });

    runtime.update(1 / 60, (runtime as unknown as { reflectionCamera: THREE.Camera }).reflectionCamera);

    expect(reflection.setWaterSurfaces).toHaveBeenCalledOnce();
    expect(reflection.render).toHaveBeenCalledOnce();
  });

  it('restores the model-water material when another runtime replaces the mesh material', () => {
    const ownedMaterial = new THREE.ShaderMaterial();
    const replacedMaterial = new THREE.ShaderMaterial();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), replacedMaterial);
    const surface = { mesh, material: ownedMaterial };
    const runtime = Object.create(MaterialTagWaterRuntime.prototype) as MaterialTagWaterRuntime;
    Object.assign(runtime as unknown as Record<string, unknown>, {
      waterInstances: {
        waterSurfaces: () => [surface],
        update: vi.fn()
      },
      waterfalls: new Map(),
      particleEngine: { update: vi.fn() },
      fountainChain: { tick: vi.fn() },
      planarReflection: { setWaterSurfaces: vi.fn(), render: vi.fn() },
      reflectionCamera: new THREE.PerspectiveCamera(),
      reflectedSurfaces: [],
      renderer: { domElement: { height: 720 } }
    });

    runtime.update(1 / 60, (runtime as unknown as { reflectionCamera: THREE.Camera }).reflectionCamera);

    expect(mesh.material).toBe(ownedMaterial);
    mesh.geometry.dispose();
    ownedMaterial.dispose();
    replacedMaterial.dispose();
  });

  it('detaches planar reflections before disposing model-water materials', () => {
    let waterDisposed = false;
    const reflection = {
      setWaterSurfaces: vi.fn(() => {
        if (waterDisposed) throw new Error('water material was already disposed');
      })
    };
    const runtime = Object.create(MaterialTagWaterRuntime.prototype) as MaterialTagWaterRuntime;
    Object.assign(runtime as unknown as Record<string, unknown>, {
      waterfalls: new Map(),
      planarReflection: reflection,
      reflectedSurfaces: [{}],
      waterInstances: { disposeAll: () => { waterDisposed = true; } },
      hiddenSources: new Set(),
      poolsByModel: new Map(),
      fountainChain: { dispose: vi.fn() },
      particleEngine: { removeGroup: vi.fn() }
    });

    runtime.clear();

    expect(reflection.setWaterSurfaces).toHaveBeenCalledWith([]);
    expect(waterDisposed).toBe(true);
  });

  it('keeps thin sheets as walls and routes volumetric bodies to wrap surfaces', () => {
    const root = new THREE.Group();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2, 1));
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12));
    root.add(wall, body);
    root.updateWorldMatrix(true, true);

    const wallRoute = resolveWaterFallRoutes([{ partId: 'wall', group: root, source: wall }], [])[0];
    const bodyRoute = resolveWaterFallRoutes([{ partId: 'body', group: root, source: body }], [])[0];

    expect(wallRoute.shape).toBe('wall');
    expect(bodyRoute.shape).toBe('wrap');
  });

  it('routes multiple authored fountain guides downward as faucet streams', () => {
    const root = new THREE.Group();
    const first = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 2));
    const second = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 2));
    first.position.x = -1;
    second.position.x = 1;
    first.quaternion.set(0.65, -0.27, 0.65, 0.27).normalize();
    second.quaternion.set(-0.65, -0.27, 0.65, -0.27).normalize();
    root.add(first, second);
    root.updateWorldMatrix(true, true);

    const routes = resolveWaterFallRoutes([
      { partId: 'left', group: root, source: first },
      { partId: 'right', group: root, source: second }
    ], []);

    expect(routes).toHaveLength(2);
    expect(routes.every((route) => route.shape === 'jet')).toBe(true);
    expect(routes.every((route) => route.isFaucet)).toBe(true);
    expect(routes.every((route) => (route.guide?.direction.y ?? 0) < -0.25)).toBe(true);
  });

  it('finds a sibling basin bottom after excluding water placeholder meshes', () => {
    const root = new THREE.Group();
    const basin = new THREE.Group();
    const basinBody = new THREE.Mesh(new THREE.BoxGeometry(3, 0.5, 2.6));
    basinBody.position.y = -0.2;
    basin.add(basinBody);
    const waterGroup = new THREE.Group();
    const water = new THREE.Mesh(new THREE.BoxGeometry(2.75, 0.04, 1.95));
    water.position.y = 0.1;
    waterGroup.add(water);
    root.add(basin, waterGroup);
    root.updateWorldMatrix(true, true);

    expect(findPoolContainerBottom(water, [basin], new Set([water]))).toBeCloseTo(-0.45);
  });

  it('accepts a wider decorative rim around a narrow upper-bowl water surface', () => {
    const root = new THREE.Group();
    const basin = new THREE.Group();
    const basinBody = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.36, 1.7));
    basinBody.position.y = 0.18;
    basin.add(basinBody);
    const water = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.04, 1.15));
    water.position.y = 0.38;
    root.add(basin, water);
    root.updateWorldMatrix(true, true);

    expect(findPoolContainerBottom(water, [basin], new Set([water]))).toBeCloseTo(0);
  });
});
