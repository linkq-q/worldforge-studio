import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WaterSurface } from '@voxel-studio/render-runtime/environment';

describe('WaterSurface shader', () => {
  it('keeps the canonical animated cartoon contours and shore bands visible', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );

    expect(surface.material.fragmentShader).toContain('fwidth(glint)');
    expect(surface.material.fragmentShader).not.toContain('fwidth(pn)');
    expect(surface.material.fragmentShader).not.toContain('fwidth(waveCoord)');
    expect(surface.material.fragmentShader).toContain(
      'float isoBand = step(0.5 - uToonPatternWidth, pn) * step(pn, 0.5 + uToonPatternWidth);'
    );
    expect(surface.material.fragmentShader).toContain(
      'waveLine = 1.0 - smoothstep(uShoreWaveWidth * 0.85, uShoreWaveWidth, stripe);'
    );
    expect(surface.material.fragmentShader).not.toContain('patternDetail');
    expect(surface.material.fragmentShader).toContain('sparkleDetail');

    surface.dispose();
  });

  it('clips the submerged model-water body with the same shore mask as its top', () => {
    const source = readFileSync(
      new URL('../vendor/voxel-render-runtime/src/environment/water/ModelWaterInstances.js', import.meta.url),
      'utf8'
    );

    expect(source).toContain('uniform sampler2D tShoreDistance;');
    expect(source).toContain('vec2 bodyMaskUv = vec2(');
    expect(source).toContain('if (bodyShoreDist < uShoreClipThreshold) discard;');
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

  it('keeps reflections stable on a still camera while preserving local ripple distortion', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );

    expect(surface.material.vertexShader).toContain('vReflectionWorldPosition = reflectionWorldPos.xyz;');
    expect(surface.material.fragmentShader).toContain(
      'uPlanarReflectionMatrix * vec4(vReflectionWorldPosition, 1.0)'
    );
    expect(surface.material.fragmentShader).toContain(
      'vec2 planarSlope = uWaterMode < 0.5 ? rippleSlope : finalWaterNormal.xz;'
    );
    expect(surface.material.fragmentShader).toContain(
      'baseNormal + vec3(rippleSlope.x, 0.0, rippleSlope.y) * uWaterReflectionNormalInfluence'
    );

    surface.dispose();
  });
});
