import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WaterSurface } from '@voxel-studio/render-runtime/environment';

type RippleSurface = WaterSurface & {
  addRippleDecalPoint(x: number, z: number): number;
  setRippleDecalParams(params: Record<string, unknown>): void;
};

describe('WaterSurface transient ripple lifetime', () => {
  it('retires a one-shot interaction instead of reviving it on the global clock', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      null as unknown as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    ) as RippleSurface;
    const uniforms = surface.material.uniforms;

    surface.setRippleDecalParams({ enabled: true, lifetime: 1.2 });
    surface.addRippleDecalPoint(2, 3);
    expect(uniforms.uRippleDecalCount.value).toBe(1);

    surface.update(1.21, new THREE.PerspectiveCamera(), null);
    expect(uniforms.uRippleDecalCount.value).toBe(0);

    surface.update(10, new THREE.PerspectiveCamera(), null);
    expect(uniforms.uRippleDecalCount.value).toBe(0);
    surface.dispose();
  });

  it('keeps authored ripple points looping while transient points expire', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      null as unknown as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    ) as RippleSurface;
    const uniforms = surface.material.uniforms;

    surface.setRippleDecalParams({ enabled: true, lifetime: 1.2, points: [[0, 0]] });
    surface.addRippleDecalPoint(2, 3);
    expect(uniforms.uRippleDecalCount.value).toBe(2);

    surface.update(1.21, new THREE.PerspectiveCamera(), null);
    expect(uniforms.uRippleDecalCount.value).toBe(1);
    surface.dispose();
  });
});
