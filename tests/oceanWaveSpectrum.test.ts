import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import * as waterRuntime from '@voxel-studio/render-runtime/environment';
import { createUnderwaterPass } from '@voxel-studio/render-runtime/postprocess';
import { bindUnderwaterDepth, sampleUnderwaterWaveOffset, underwaterWaveProfileFromUniforms } from '../src/client/underwaterRuntime';
import { RenderRuntimeAdapter } from '../src/client/renderRuntimeAdapter';

const controls = { strength: 0.35, speed: 0.3, scale: 1.3, foamStrength: 0.8 };
function surface() {
  return new waterRuntime.WaterSurface(new THREE.Scene(), {} as THREE.WebGLRenderer, new THREE.Group(), { size: 1, segments: 1 });
}

describe('ocean sea-state spectrum', () => {
  it('provides distinct long-wave heights and periods with a bounded horizontal folding budget', () => {
    const water = surface();
    expect(water.setOceanSeaState).toBeTypeOf('function');
    const ranges: number[] = [];
    for (const state of ['light', 'moderate', 'large'] as const) {
      water.setOceanSeaState(state, controls);
      const u = water.material.uniforms;
      expect(u.uOceanSpectrumEnabled.value).toBe(true);
      const components = u.uOceanWaveComponents.value as THREE.Vector4[];
      const motions = u.uOceanWaveMotion.value as THREE.Vector4[];
      const budget = components.reduce((sum, wave, i) => sum + Math.abs(wave.z * wave.w * motions[i].z), 0);
      expect(budget).toBeLessThanOrEqual(0.820001);
      expect(2 * Math.PI / components[0].w).toBeCloseTo({ light: 14, moderate: 24, large: 40 }[state]);
      let low = Infinity, high = -Infinity;
      for (let i = 0; i < 600; i++) {
        const [, y] = waterRuntime.sampleOceanWaveDisplacement(u, i * 0.37, i * -0.23, i * 0.11);
        low = Math.min(low, y); high = Math.max(high, y);
      }
      ranges.push(high - low);
      const first = waterRuntime.sampleOceanWaveDisplacement(u, 3, 7, 0);
      const later = waterRuntime.sampleOceanWaveDisplacement(u, 3, 7, 2);
      expect(Math.abs(first[1] - later[1])).toBeGreaterThan(0.01);
    }
    expect(ranges[0]).toBeGreaterThan(0.3);
    expect(ranges[0]).toBeLessThan(0.45);
    expect(ranges[1]).toBeGreaterThan(1.1);
    expect(ranges[1]).toBeLessThan(1.65);
    expect(ranges[2]).toBeGreaterThan(3.0);
    expect(ranges[2]).toBeLessThan(4.1);
    water.setOceanSeaState('large', { ...controls, strength: 1.5, scale: 4, sharpness: 4 });
    const waves = water.material.uniforms.uOceanWaveComponents.value as THREE.Vector4[];
    const motion = water.material.uniforms.uOceanWaveMotion.value as THREE.Vector4[];
    expect(waves.reduce((sum, w, i) => sum + w.z * w.w * motion[i].z, 0)).toBeLessThanOrEqual(0.820001);
    water.dispose();
  });

  it('keeps authored zeros and returns to the unchanged custom water controls', () => {
    const water = surface();
    expect(water.setOceanSeaState).toBeTypeOf('function');
    const before = [water.material.uniforms.uWaveHeight.value, water.material.uniforms.uLargeWaveScale.value];
    water.setOceanSeaState('large', { ...controls, strength: 0 });
    expect(waterRuntime.sampleOceanWaveDisplacement(water.material.uniforms, 4, 7, 3)).toEqual([0, 0, 0]);
    expect(water.material.uniforms.uOceanCrestFoamStrength.value).toBe(0);
    water.setOceanSeaState('large', { ...controls, speed: 0 });
    expect(waterRuntime.sampleOceanWaveDisplacement(water.material.uniforms, 4, 7, 3))
      .toEqual(waterRuntime.sampleOceanWaveDisplacement(water.material.uniforms, 4, 7, 8));
    water.setOceanSeaState('custom', controls);
    expect(water.material.uniforms.uOceanSpectrumEnabled.value).toBe(false);
    expect([water.material.uniforms.uWaveHeight.value, water.material.uniforms.uLargeWaveScale.value]).toEqual(before);
    water.dispose();
  });

  it('uses the displaced macro surface for CPU crossing and binds the same spectrum to the underwater pass', () => {
    const water = surface();
    expect(water.setOceanSeaState).toBeTypeOf('function');
    water.setOceanSeaState('large', controls);
    const u = water.material.uniforms;
    const profile = underwaterWaveProfileFromUniforms(u);
    expect(profile.amplitude).toBeGreaterThan(0.5);
    for (const [x, z, time] of [[0, 0, 0], [3, -5, 1.4], [12, 8, 3.1], [-14, 6, 4.8]]) {
      const [dx, height, dz] = waterRuntime.sampleOceanWaveDisplacement(u, x, z, time);
      expect(sampleUnderwaterWaveOffset(x + dx, z + dz, time, profile)).toBeCloseTo(height, 3);
    }
    const pass = createUnderwaterPass();
    const camera = new THREE.PerspectiveCamera(); camera.updateMatrixWorld();
    const depth = new THREE.DepthTexture(1, 1);
    bindUnderwaterDepth(pass, depth, camera, 2, 1, 3, profile);
    expect(pass.uniforms.uOceanSpectrumEnabled.value).toBe(true);
    expect(pass.uniforms.uOceanWaveComponents.value).toEqual(u.uOceanWaveComponents.value);
    expect(pass.uniforms.uOceanWaveMotion.value).toEqual(u.uOceanWaveMotion.value);
    bindUnderwaterDepth(pass, depth, camera, 2, 1, 3, underwaterWaveProfileFromUniforms(null));
    expect(pass.uniforms.uOceanSpectrumEnabled.value).toBe(false);
    pass.dispose(); depth.dispose(); water.dispose();
  });

  it('keeps shallow large waves above the seabed without folding at the shore or LOD fade', () => {
    const water = surface();
    water.setOceanSeaState('large', controls);
    const u = water.material.uniforms;
    u.uUseOceanTerrain.value = true;
    u.uShoreWaveEnabled.value = true;
    u.uShoreWaveStrength.value = 0.7;
    u.uShoreWaveRange.value = 0.44;
    u.uOceanMapSize.value.set(4, 40);
    u.uOceanMapCenter.value.set(0, 0);
    u.uOceanTerrainSize.value.set(2, 2);
    u.uOceanNearVertexSpacing.value = 4;
    const terrain = new THREE.DataTexture(new Float32Array([-0.3, 0.1, -0.3, 0.1]), 2, 2, THREE.RedFormat, THREE.FloatType);
    u.tOceanTerrain.value = terrain;
    const samples = [[-0.05, -1, 5.25], [-0.75, -3, 5.75], [-1, 2, 4], [-1.9, -4, 8]];
    // A deliberately short requested fade must not introduce lateral folds.
    u.uOceanWaveGeometryFadeStart.value = 10;
    u.uOceanWaveGeometryFadeEnd.value = 11;
    samples.push([10.5, 4, 3], [20, -4, 8], [45, 1, 5]);
    for (const [x, z, time] of samples) {
      const d = waterRuntime.sampleOceanWaveDisplacement(u, x, z, time);
      const dx = waterRuntime.sampleOceanWaveDisplacement(u, x + 0.001, z, time);
      const dz = waterRuntime.sampleOceanWaveDisplacement(u, x, z + 0.001, time);
      const determinant = (1 + (dx[0] - d[0]) / 0.001) * (1 + (dz[2] - d[2]) / 0.001)
        - ((dz[0] - d[0]) / 0.001) * ((dx[2] - d[2]) / 0.001);
      expect(determinant).toBeGreaterThan(0.05);
      expect(waterRuntime.sampleOceanWaveHeight(u, x + d[0], z + d[2], time)).toBeCloseTo(d[1], 3);
      const displacedX = x + d[0];
      if (displacedX >= -2 && displacedX <= 1) expect(d[1]).toBeGreaterThanOrEqual(displacedX * 0.1 - 0.1);
    }
    terrain.dispose(); water.dispose();
  });

  it('keeps the coarse LOD seam flat for extreme long waves without folding inside it', () => {
    const water = surface();
    water.setOceanSeaState('large', { ...controls, scale: 0.25, sharpness: 4 });
    const u = water.material.uniforms;
    u.uUseOceanTerrain.value = true;
    u.uOceanMapSize.value.set(400, 400);
    u.uOceanTerrainSize.value.set(2, 2);
    u.uOceanNearVertexSpacing.value = 4;
    u.uOceanWaveGeometryFadeStart.value = 112;
    u.uOceanWaveGeometryFadeEnd.value = 128;
    const terrain = new THREE.DataTexture(new Float32Array([-10, -10, -10, -10]), 2, 2, THREE.RedFormat, THREE.FloatType);
    u.tOceanTerrain.value = terrain;
    for (const [x, z, time] of [[119.5, -36, 4.5], [114, -42, 5.5], [70, 16, 3]]) {
      const d = waterRuntime.sampleOceanWaveDisplacement(u, x, z, time);
      const dx = waterRuntime.sampleOceanWaveDisplacement(u, x + 0.001, z, time);
      const dz = waterRuntime.sampleOceanWaveDisplacement(u, x, z + 0.001, time);
      const determinant = (1 + (dx[0] - d[0]) / 0.001) * (1 + (dz[2] - d[2]) / 0.001)
        - ((dz[0] - d[0]) / 0.001) * ((dx[2] - d[2]) / 0.001);
      expect(determinant).toBeGreaterThan(0.05);
      expect(waterRuntime.sampleOceanWaveHeight(u, x + d[0], z + d[2], time)).toBeCloseTo(d[1], 3);
    }
    for (const x of [128, 132, 144]) {
      expect(Math.hypot(...waterRuntime.sampleOceanWaveDisplacement(u, x, 7, 2))).toBe(0);
    }
    terrain.dispose(); water.dispose();
  });

  it('keeps CPU crossing and postprocessing on the newly rebuilt surface clock', () => {
    const water = surface();
    water.setOceanSeaState('large', controls);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(2, -1, -4); camera.updateMatrixWorld();
    const runtime = Object.assign(Object.create(RenderRuntimeAdapter.prototype), {
      camera, waterBindings: [{ surface: water, mesh: water.mesh }], pendingDeltaTime: 0.016,
      pendingElapsedSeconds: 180
    }) as { resolveUnderwaterWaveProfile(level: number): ReturnType<typeof underwaterWaveProfileFromUniforms> };
    const profile = runtime.resolveUnderwaterWaveProfile(water.mesh.position.y);
    const nextSurfaceTime = 0.016;
    expect(sampleUnderwaterWaveOffset(2, -4, 180, profile))
      .toBeCloseTo(waterRuntime.sampleOceanWaveHeight(water.material.uniforms, 2, -4, nextSurfaceTime), 8);
    const pass = createUnderwaterPass(), depth = new THREE.DepthTexture(1, 1);
    bindUnderwaterDepth(pass, depth, camera, 0, 1, 180, profile);
    expect(pass.uniforms.uTime.value).toBeCloseTo(nextSurfaceTime, 8);
    pass.dispose(); depth.dispose(); water.dispose();
  });

  it('uses the local lake profile when it overlaps an ocean at the same water level', () => {
    const ocean = surface(), lake = surface();
    ocean.setOceanSeaState('large', controls);
    const oceanMesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), ocean.material);
    const lakeMesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2), lake.material);
    oceanMesh.userData.waterBodyType = 'ocean'; lakeMesh.userData.waterBodyType = 'lake';
    const mask = new THREE.DataTexture(new Uint8Array([
      0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0
    ]), 4, 4, THREE.RedFormat);
    lakeMesh.userData.waterShore = { texture: mask, center: [0, 0], size: 8, worldSpace: false };
    oceanMesh.updateMatrixWorld(); lakeMesh.updateMatrixWorld();
    const camera = new THREE.PerspectiveCamera();
    const runtime = Object.assign(Object.create(RenderRuntimeAdapter.prototype), {
      camera, waterBindings: [{ surface: ocean, mesh: oceanMesh }, { surface: lake, mesh: lakeMesh }],
      pendingDeltaTime: 0, pendingElapsedSeconds: 0
    }) as { resolveUnderwaterWaveProfile(level: number): ReturnType<typeof underwaterWaveProfileFromUniforms> };
    expect(runtime.resolveUnderwaterWaveProfile(0).oceanUniforms).toBeUndefined();
    camera.position.set(3, 0, 3);
    expect(runtime.resolveUnderwaterWaveProfile(0).oceanUniforms === ocean.material.uniforms).toBe(true);
    camera.position.x = 10;
    expect(runtime.resolveUnderwaterWaveProfile(0).oceanUniforms).toBe(ocean.material.uniforms);
    mask.dispose(); oceanMesh.geometry.dispose(); lakeMesh.geometry.dispose(); ocean.dispose(); lake.dispose();
  });
});
