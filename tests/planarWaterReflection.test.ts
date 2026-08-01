import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createPlanarWaterTarget } from '../src/client/planarWaterReflection';

describe('planar water reflection target', () => {
  it('uses the visible map mesh while forwarding reflection data to WaterSurface', () => {
    const mesh = new THREE.Mesh();
    const surface = {
      setPlanarReflectionTexture: vi.fn(),
      setPlanarReflectionMatrix: vi.fn()
    };
    const target = createPlanarWaterTarget({ mesh, surface } as never);
    const texture = new THREE.Texture();
    const matrix = new THREE.Matrix4().makeTranslation(1, 2, 3);

    target.setPlanarReflectionTexture(texture);
    target.setPlanarReflectionMatrix(matrix);

    expect(target.mesh).toBe(mesh);
    expect(surface.setPlanarReflectionTexture).toHaveBeenCalledWith(texture);
    expect(surface.setPlanarReflectionMatrix).toHaveBeenCalledWith(matrix);
    texture.dispose();
  });
});
