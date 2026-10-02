import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { WaterSurface } from '@voxel-studio/render-runtime/environment';

describe('bounded shallow-water interaction', () => {
  it('allocates lazily, propagates one impulse, recenters, and sleeps after three seconds', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );
    const uniforms = surface.material.uniforms;
    expect(uniforms.uUseShallowWaterHeight.value).toBe(false);
    expect(surface.addShallowWaterImpulse(Number.NaN, 0)).toBe(false);
    expect(surface.addShallowWaterImpulse(2, 3, 0.08, 0.9)).toBe(true);
    expect(uniforms.uUseShallowWaterHeight.value).toBe(true);
    expect(uniforms.uShallowWaterCenter.value.toArray()).toEqual([2, 3]);

    const texture = uniforms.tShallowWaterHeight.value as THREE.DataTexture;
    expect(texture.image.width).toBe(32);
    expect(texture.image.height).toBe(32);
    const activeBefore = Array.from(texture.image.data as Float32Array)
      .filter((value) => Math.abs(value) > 1e-5).length;
    expect(activeBefore).toBeGreaterThan(0);

    const camera = new THREE.PerspectiveCamera();
    for (let step = 0; step < 10; step += 1) surface.update(1 / 30, camera, null);
    const propagated = Array.from(texture.image.data as Float32Array);
    const activeAfter = propagated.filter((value) => Math.abs(value) > 1e-5).length;
    expect(activeAfter).toBeGreaterThan(activeBefore);
    expect(Math.min(...propagated)).toBeLessThan(0);
    expect(Math.max(...propagated)).toBeLessThanOrEqual(0.25);

    expect(surface.addShallowWaterImpulse(20, 20, 0.06, 0.8)).toBe(true);
    expect(uniforms.uShallowWaterCenter.value.toArray()).toEqual([20, 20]);
    surface.update(3.01, camera, null);
    expect(uniforms.uUseShallowWaterHeight.value).toBe(false);

    const disposeTexture = vi.spyOn(texture, 'dispose');
    surface.dispose();
    expect(disposeTexture).toHaveBeenCalledOnce();
  });

  it('caps a long frame at three fixed simulation steps', () => {
    const createSurface = () => new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );
    const longFrame = createSurface();
    const fixedFrames = createSurface();
    const camera = new THREE.PerspectiveCamera();
    longFrame.addShallowWaterImpulse(0, 0, 0.08, 0.9);
    fixedFrames.addShallowWaterImpulse(0, 0, 0.08, 0.9);

    longFrame.update(1, camera, null);
    for (let step = 0; step < 3; step += 1) fixedFrames.update(1 / 30, camera, null);

    const longData = longFrame.material.uniforms.tShallowWaterHeight.value.image.data as Float32Array;
    const fixedData = fixedFrames.material.uniforms.tShallowWaterHeight.value.image.data as Float32Array;
    expect(Array.from(longData)).toEqual(Array.from(fixedData));

    longFrame.dispose();
    fixedFrames.dispose();
  });

  it('keeps simulation textures and lifetimes isolated per water surface', () => {
    const first = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );
    const second = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );
    first.addShallowWaterImpulse(2, 3);
    second.addShallowWaterImpulse(-4, 5);

    const firstUniforms = first.material.uniforms;
    const secondUniforms = second.material.uniforms;
    expect(firstUniforms.tShallowWaterHeight.value).not.toBe(secondUniforms.tShallowWaterHeight.value);
    expect(firstUniforms.uShallowWaterCenter.value.toArray()).toEqual([2, 3]);
    expect(secondUniforms.uShallowWaterCenter.value.toArray()).toEqual([-4, 5]);

    first.dispose();
    expect(secondUniforms.uUseShallowWaterHeight.value).toBe(true);
    second.dispose();
  });
});
