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

  it('supports terrain-driven ocean swash, foam edge, and splash droplets', () => {
    const scene = new THREE.Scene();
    const surface = new WaterSurface(
      scene,
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );
    const terrain = new THREE.DataTexture(
      new Float32Array([0, 0, 0, 0]),
      2,
      2,
      THREE.RedFormat,
      THREE.FloatType
    );

    expect(surface.setOceanTerrainTexture(terrain, {
      terrainSize: [2, 2],
      mapSize: [96, 96],
      center: [0, 0],
      level: 0,
      apronWidth: 18,
      sinkTarget: -3
    })).toBe(true);
    expect(surface.material.uniforms.uUseOceanTerrain.value).toBe(true);
    expect(surface.material.uniforms.uOceanTerrainApronWidth.value).toBe(18);
    expect(surface.material.vertexShader).toContain('uniform float uShoreWaveStrength;');
    expect(surface.material.vertexShader).toContain('return computeOceanSwashHeight(worldBase.xz, waveH);');
    expect(surface.material.fragmentShader).toContain('if (oceanWaterDepth <= 0.025) discard;');
    expect(surface.material.fragmentShader).toContain('shoreFoam = (1.0 - smoothstep(0.025, oceanFoamWidth, oceanWaterDepth))');
    expect(surface.material.fragmentShader).toContain('foamCoverage = mix(shoreFoam, foamCoverage, oceanShoreIsolation);');
    expect(surface.material.fragmentShader).toContain('float oceanDeepOcclusion = smoothstep(0.2, 0.8, oceanDepthFraction);');
    expect(surface.material.fragmentShader).toContain('alpha = mix(alpha, 1.0, oceanDeepOcclusion);');
    // Even a low-opacity scheme must fully hide the cut at 99% sink depth,
    // before either the terrain boundary or far-ocean background can show.
    for (const opacity of [0.05, 0.4, 1]) {
      const transmission = 1 - THREE.MathUtils.lerp(opacity, 1, THREE.MathUtils.smoothstep(0.99, 0.2, 0.8));
      expect(transmission).toBe(0);
    }

    const splash = surface.setOceanShoreSplashPoints([[1, 2], new THREE.Vector2(3, 4)]);
    expect(splash?.name).toBe('OceanShoreSplash');
    expect(splash?.geometry.getAttribute('position').count).toBe(2);
    expect((splash?.material as THREE.ShaderMaterial).uniforms.uTime).toBe(surface.material.uniforms.uTime);

    expect(surface.setOceanTerrainTexture(null)).toBe(false);
    expect(surface.material.uniforms.uUseOceanTerrain.value).toBe(false);
    expect(splash?.parent).toBeNull();
    terrain.dispose();
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
