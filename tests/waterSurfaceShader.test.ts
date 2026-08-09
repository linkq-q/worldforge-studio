import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WaterSurface } from '@voxel-studio/render-runtime/environment';

describe('WaterSurface shader', () => {
  it('band-limits animated cartoon water details during camera movement', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );

    expect(surface.material.fragmentShader).toContain('fwidth(glint)');
    expect(surface.material.fragmentShader).toContain('fwidth(pn)');
    expect(surface.material.fragmentShader).toContain('fwidth(waveCoord)');
    expect(surface.material.fragmentShader).toContain('patternDetail');
    expect(surface.material.fragmentShader).toContain('sparkleDetail');

    surface.dispose();
  });

  it('reuses the displaced vertex normal instead of rebuilding the wave field per pixel', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );

    expect(surface.material.fragmentShader).toContain('vec3 waveNormal = normalize(vWorldNormal);');
    expect(surface.material.fragmentShader).not.toContain('vec3 waveNormal = computeWaveNormal(vWorldPosition);');

    surface.dispose();
  });

  it('uses the shore field as the depth fallback for structured water', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );

    expect(surface.material.fragmentShader).toContain(': (uUseShoreDistance ? shoreDist : 0.0);');

    surface.dispose();
  });
});
