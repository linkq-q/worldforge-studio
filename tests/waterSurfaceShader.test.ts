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

  it('retains sloped geometry normals and advects river patterns downstream', () => {
    const surface = new WaterSurface(new THREE.Scene(), {} as THREE.WebGLRenderer, new THREE.Group(), {size:1,segments:1});
    expect(surface.material.uniforms.uUseRiverFlow.value).toBe(false);
    expect(surface.material.vertexShader).toContain(
      'normal + (waveNormal - vec3(0.0, 1.0, 0.0)) * normal.y'
    );
    expect(surface.material.fragmentShader).toContain('uUseRiverFlow ? vRiverFlow : uFlowDirection');
    expect(surface.material.fragmentShader).toContain('uUseRiverFlow ? -1.0 : 1.0');
    surface.dispose();
  });

  it('uses a bounded four-wave Gerstner sum for cheap fluid-like ocean motion', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );
    const shader = surface.material.vertexShader;

    expect(shader).toContain('float angularFrequency = sqrt(9.81 * k);');
    expect(shader).toContain('float scaleMultiplier = max(uWaveScale, 0.05) / 1.3;');
    expect(shader).toContain('uLargeWaveScale * max(uWaveScale, 0.05) / 1.3');
    expect(shader).toContain('return vec3(dir.x * lateral, amplitude * s, dir.y * lateral);');
    expect(shader).toContain('primaryGerstnerPhase(worldXZ)');
    expect(shader).toContain('float foldoverBudget = abs(primaryAmplitude * primaryWaveNumber)');
    expect(shader).toContain('float safeChoppiness = min(choppiness, 0.82 / max(foldoverBudget, 0.001));');
    expect(shader).toContain('uUseDirectionalWaves && !uUseRiverFlow');
    expect(shader).toContain('return max(0.16, uShoreWaveRange * 0.42);');
    expect(shader).toContain('smoothstep(0.025, oceanWaveDepthRange(), waterDepth)');
    expect(shader).toContain('smoothstep(-oceanWaveDepthRange(), -0.025, ground)');
    expect(shader).toContain('waveOffset.xz *= lateralDamp;');
    expect(shader).toContain('texture2D(tShallowWaterHeight');
    expect(shader).toContain('waveOffset *= oceanWaveFade');
    expect(shader).toContain('computeDisplacedPosition(position + vec3(eps, 0.0, 0.0), oceanWaveFade)');
    expect(shader).toContain('secondaryAmplitude *= oceanVertexWaveFilter(secondaryWaveNumber)');
    expect(shader).toContain('return min(waveNumber, 2.4 / uOceanNearVertexSpacing)');
    expect(surface.material.fragmentShader).toContain('bool hasStructuredWaterDepth = hasTerrainDepth || uUseOceanTerrain');
    expect(surface.material.fragmentShader).toContain('min(max(oceanWaterDepth, 0.0), max(uOceanLevel - uOceanTerrainSinkTarget, 0.001))');
    expect(shader).toContain('min(edgeHeight, uOceanTerrainSinkTarget)');
    expect(shader).toContain('shallowWaterHeight * smoothstep(0.025, 0.2, waterDepth)');
    expect(shader).toContain('cross(displacedZ - displaced, displacedX - displaced)');
    expect(shader.match(/displacement \+= gerstnerWave\(/g)).toHaveLength(3);
    expect(shader).not.toContain('float directionalWavePhase(');
    expect(surface.material.fragmentShader).toContain(
      'uTime * sqrt(9.81 * k) * uLargeWaveSpeed * uWaveSpeed * 0.45'
    );
    expect(surface.material.fragmentShader).toContain(
      'computePrimaryCrestProfile(vReflectionWorldPosition.xz, crestPhase)'
    );
    expect(surface.material.fragmentShader).not.toContain('float directionalWavePhase(');
    expect(surface.material.fragmentShader).toContain('vec2 sampleShallowWaterSlope(vec2 worldXZ)');
    expect(surface.material.fragmentShader).toContain(
      'vec3 shallowWaterNormal = vec3(shallowWaterSlope.x, 0.0, shallowWaterSlope.y) * 1.4;'
    );

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

  it('keeps riverbed depth within authored opacity while preserving lake and ocean occlusion', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );

    expect(surface.material.fragmentShader).toContain(': (uUseShoreDistance ? shoreDist : 0.0);');
    expect(surface.material.fragmentShader).toContain(
      'float depthOpacity = uUseRiverFlow ? baseOpacity : 1.0;'
    );
    expect(surface.material.fragmentShader).toContain(
      'float terrainOpacity = mix(shoreOpacity, depthOpacity, 1.0 - transmission);'
    );

    surface.dispose();
  });

  it('applies submerged river-mouth fade to the final transparent and refracted output', () => {
    const surface = new WaterSurface(
      new THREE.Scene(),
      {} as THREE.WebGLRenderer,
      new THREE.Group(),
      { size: 1, segments: 1 }
    );

    expect(surface.material.vertexShader).toContain('attribute vec3 riverFlow;');
    expect(surface.material.vertexShader).toContain('vRiverMouthFade = riverFlow.z;');
    expect(surface.material.fragmentShader).toContain(
      'float riverMouthFade = uUseRiverFlow ? clamp(vRiverMouthFade, 0.0, 1.0) : 1.0;'
    );
    const fade = surface.material.fragmentShader.indexOf('alpha *= riverMouthFade;');
    const refraction = surface.material.fragmentShader.indexOf('if (hasTerrainDepth && uHasWaterSceneColor)');
    const opaqueRefraction = surface.material.fragmentShader.indexOf('alpha = 1.0;', refraction);
    const output = surface.material.fragmentShader.indexOf('gl_FragColor = vec4(finalColor, alpha);');
    expect(fade).toBeGreaterThan(0);
    expect(fade).toBeGreaterThan(opaqueRefraction);
    expect(fade).toBeLessThan(output);

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
    expect(surface.material.vertexShader).toContain(
      'waveOffset.y = computeOceanSwashHeight(worldBase.xz, waveOffset.y)'
    );
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
