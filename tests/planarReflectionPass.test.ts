import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PlanarReflectionPass } from '@voxel-studio/render-runtime';

describe('PlanarReflectionPass stability', () => {
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
