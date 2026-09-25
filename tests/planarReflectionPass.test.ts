import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PlanarReflectionPass } from '@voxel-studio/render-runtime';

describe('PlanarReflectionPass stability', () => {
  it('captures coplanar pools once while preserving separate planes and camera updates', () => {
    const render = vi.fn();
    const renderer = {
      xr: { enabled: false }, shadowMap: { autoUpdate: true },
      getRenderTarget: () => null, setRenderTarget: vi.fn(), clear: vi.fn(), render
    } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 2, 0.1, 100);
    camera.position.set(0, 5, 10);
    camera.lookAt(0, 0, 0);
    const geometry = new THREE.PlaneGeometry(4, 4);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial();
    const surfaces = Array.from({ length: 35 }, (_, index) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(index * 2, 0.115 + (index % 2) * 1e-16, 0);
      mesh.rotation.y = index;
      mesh.userData.excludeFromPlanarReflection = true;
      scene.add(mesh);
      return { mesh, setPlanarReflectionTexture: vi.fn(), setPlanarReflectionMatrix: vi.fn() };
    });
    const pass = new PlanarReflectionPass({ renderer, scene, camera, width: 64, height: 32 });
    pass.setWaterSurfaces(surfaces);
    pass.render();
    expect(render).toHaveBeenCalledTimes(1);
    const texture = surfaces[0].setPlanarReflectionTexture.mock.lastCall?.[0];
    for (const surface of surfaces) expect(surface.setPlanarReflectionTexture).toHaveBeenLastCalledWith(texture);
    pass.render();
    expect(render).toHaveBeenCalledTimes(1);
    camera.position.x += 1;
    pass.render();
    expect(render).toHaveBeenCalledTimes(2);

    // A pool moving to a different level needs its own up-to-date capture.
    surfaces[1].mesh.position.y += 2;
    pass.render();
    expect(render).toHaveBeenCalledTimes(3);
    expect(surfaces[1].setPlanarReflectionTexture.mock.lastCall?.[0]).not.toBe(texture);
    pass.forceUpdate();
    pass.render();
    expect(render).toHaveBeenCalledTimes(5);

    // Matching height alone is insufficient when a surface is tilted.
    surfaces[2].mesh.rotation.x = 0.2;
    pass.render();
    expect(render).toHaveBeenCalledTimes(6);
    pass.dispose();
    geometry.dispose();
    material.dispose();
  });

  it('does not recapture or change projection matrices for a still camera and water plane', () => {
    const render = vi.fn();
    const renderer = {
      xr: { enabled: false },
      shadowMap: { autoUpdate: true },
      getRenderTarget: () => null,
      setRenderTarget: vi.fn(),
      clear: vi.fn(),
      render,
      getPixelRatio: () => 1,
      getDrawingBufferSize: (target: THREE.Vector2) => target.set(512, 256),
      getSize: (target: THREE.Vector2) => target.set(512, 256),
      capabilities: { isWebGL2: false }
    } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 2, 0.1, 100);
    camera.position.set(0, 5, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4));
    mesh.rotateX(-Math.PI / 2);
    mesh.updateMatrixWorld(true);
    scene.add(mesh);
    const reflectionMatrix = new THREE.Matrix4();
    const surface = {
      mesh,
      setPlanarReflectionTexture: vi.fn(),
      setPlanarReflectionMatrix: (matrix: THREE.Matrix4) => reflectionMatrix.copy(matrix)
    };
    const pass = new PlanarReflectionPass({ renderer, scene, camera, width: 64, height: 32 });
    pass.setWaterSurfaces([surface]);

    pass.render();
    const firstMatrix = reflectionMatrix.clone();
    pass.render();

    expect(render).toHaveBeenCalledOnce();
    expect(reflectionMatrix.equals(firstMatrix)).toBe(true);

    pass.dispose();
    mesh.geometry.dispose();
  });
});
