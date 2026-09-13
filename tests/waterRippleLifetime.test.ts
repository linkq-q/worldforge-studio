import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WaterSurface } from '@voxel-studio/render-runtime/environment';

function createSurface() {
  return new WaterSurface(new THREE.Scene(), {} as THREE.WebGLRenderer, new THREE.Group(), { size: 1, segments: 1 }) as WaterSurface & {
    addRippleDecalPoint(x: number, z: number): number;
    setRippleDecalParams(params: Record<string, unknown>): void;
    getRippleDecalParams(): { points: number[][] };
    pinRippleDecalPoint(x: number, z: number): number;
    unpinRippleDecalPoint(id: number): boolean;
    clearRippleDecalPoints(): void;
  };
}

describe('one-shot water ripple lifetime', () => {
  it('uses the water clock after a map load and retires events without growing buffers', () => {
    const surface = createSurface();
    try {
      const u = surface.material.uniforms;
      const points = u.uRippleDecalPoints.value;
      const births = u.uRippleDecalBirthTimes.value;
      const camera = new THREE.PerspectiveCamera();
      u.uTime.value = 40;
      surface.setRippleDecalParams({ enabled: true, lifetime: 1.25 });
      surface.addRippleDecalPoint(1, 2);
      expect(births[0]).toBe(40);
      surface.update(1, camera, null);
      expect(u.uRippleDecalCount.value).toBe(1);
      surface.update(0.26, camera, null);
      expect(u.uRippleDecalCount.value).toBe(0);
      surface.update(10, camera, null);
      expect(u.uRippleDecalCount.value).toBe(0);
      expect(u.uRippleDecalBirthTimes.value).toBe(births);
      expect(u.uRippleDecalPoints.value).toBe(points);
      expect(points).toHaveLength(24);
    } finally { surface.dispose(); }
  });

  it('does not revive or stretch an old event when the next emitter changes lifetime', () => {
    const surface = createSurface();
    try {
      const u = surface.material.uniforms;
      const camera = new THREE.PerspectiveCamera();
      surface.setRippleDecalParams({ lifetime: 0.5 });
      surface.addRippleDecalPoint(1, 2);
      surface.update(0.3, camera, null);
      surface.setRippleDecalParams({ lifetime: 2 });
      surface.addRippleDecalPoint(3, 4);
      surface.update(0.3, camera, null);
      expect(u.uRippleDecalBirthTimes.value[0]).toBeLessThan(-1);
      expect(u.uRippleDecalBirthTimes.value[1]).toBeCloseTo(0.3);
      surface.update(2, camera, null);
      expect(u.uRippleDecalCount.value).toBe(0);
    } finally { surface.dispose(); }
  });

  it('preserves pinned and authored loops but never saves a footstep as a looping source', () => {
    const surface = createSurface();
    try {
      const u = surface.material.uniforms;
      const pin = surface.pinRippleDecalPoint(0, 0);
      surface.setRippleDecalParams({ points: [[2, 3]], lifetime: 1 });
      surface.addRippleDecalPoint(4, 5);
      expect(surface.getRippleDecalParams().points).toEqual([[2, 3]]);
      surface.update(10, new THREE.PerspectiveCamera(), null);
      expect(u.uRippleDecalCount.value).toBe(2);
      expect(Array.from(u.uRippleDecalBirthTimes.value).slice(0, 2)).toEqual([-1, -1]);
      surface.clearRippleDecalPoints();
      expect(u.uRippleDecalCount.value).toBe(1);
      surface.unpinRippleDecalPoint(pin);
      expect(u.uRippleDecalCount.value).toBe(0);
    } finally { surface.dispose(); }
  });

  it('drops excess events at its fixed capacity instead of stealing a live slot', () => {
    const surface = createSurface();
    try {
      const u = surface.material.uniforms;
      for (let i = 0; i < 24; i++) surface.addRippleDecalPoint(i, 0);
      const points = u.uRippleDecalPoints.value.map((p: THREE.Vector2) => p.toArray());
      surface.update(0.2, new THREE.PerspectiveCamera(), null);
      surface.addRippleDecalPoint(99, 99);
      expect(u.uRippleDecalPoints.value.map((p: THREE.Vector2) => p.toArray())).toEqual(points);
      expect(u.uRippleDecalCount.value).toBe(24);
      surface.update(2, new THREE.PerspectiveCamera(), null);
      surface.addRippleDecalPoint(99, 99);
      expect(u.uRippleDecalCount.value).toBe(1);
    } finally { surface.dispose(); }
  });
});
