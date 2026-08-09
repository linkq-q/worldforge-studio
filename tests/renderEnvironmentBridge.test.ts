import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  bindDistanceFogDepth,
  configureWaterReflection,
  configureDistanceFogPass,
  distanceAtFogOpacity,
  syncWaterSurfaceEnvironment,
  syncWaterSurfaceShore
} from '../src/client/renderEnvironmentBridge';

function fogPass() {
  return {
    enabled: false,
    uniforms: {
      tDepth: { value: null },
      uCameraNear: { value: 0 },
      uCameraFar: { value: 0 },
      uFogColor: { value: new THREE.Vector3() },
      uFogDensity: { value: 0 },
      uFogStartDistance: { value: 1 },
      uFogExpPow: { value: 1 },
      uFogSkyFade: { value: 1 }
    }
  };
}

describe('render environment bridge', () => {
  it('configures one depth fog pass for custom and standard materials', () => {
    const pass = fogPass();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.25, 900);
    const depth = new THREE.DepthTexture(4, 4);

    configureDistanceFogPass(pass, '#90a0b0', 0.015);
    bindDistanceFogDepth(pass, depth, camera);

    expect(pass.enabled).toBe(true);
    expect(pass.uniforms.uFogDensity.value).toBe(0.015);
    expect(pass.uniforms.uFogSkyFade.value).toBe(0);
    expect(pass.uniforms.tDepth.value).toBe(depth);
    expect(pass.uniforms.uCameraNear.value).toBe(0.25);
    expect(pass.uniforms.uCameraFar.value).toBe(900);
    depth.dispose();
  });

  it('derives a conservative culling distance from the same exponential fog curve', () => {
    expect(distanceAtFogOpacity(0)).toBe(Number.POSITIVE_INFINITY);
    expect(distanceAtFogOpacity(0.018, 0.995)).toBeCloseTo(127.86, 1);
  });

  it('feeds and clears the same HDRI environment on WaterSurface', () => {
    const surface = {
      setWaterEnvMap: vi.fn(),
      setWaterReflectionParams: vi.fn()
    };
    const environment = new THREE.Texture();

    syncWaterSurfaceEnvironment(surface, environment);
    syncWaterSurfaceEnvironment(surface, null);

    expect(surface.setWaterEnvMap).toHaveBeenNthCalledWith(1, environment);
    expect(surface.setWaterEnvMap).toHaveBeenNthCalledWith(2, null);
    expect(surface.setWaterReflectionParams).toHaveBeenCalledWith({ useSceneEnvironment: true });
    environment.dispose();
  });

  it('configures the single HDRI water reflection input', () => {
    const surface = {
      setWaterReflectionParams: vi.fn()
    };

    configureWaterReflection(surface, {
      environmentStrength: 0.28,
      environmentExposure: 0.55
    });

    expect(surface.setWaterReflectionParams).toHaveBeenCalledWith({ strength: 0.28, exposure: 0.55 });
  });

  it('binds the generated shore-distance texture in the same world region as the map water', () => {
    const surface = {
      setShoreDistanceTexture: vi.fn(),
      setShoreWorldRegion: vi.fn()
    };
    const texture = new THREE.DataTexture(new Uint8Array([0, 255, 255, 0]), 2, 2, THREE.RedFormat);

    syncWaterSurfaceShore(surface, { texture, center: [4, -7], size: 18 });

    expect(surface.setShoreDistanceTexture).toHaveBeenCalledWith(texture);
    expect(surface.setShoreWorldRegion).toHaveBeenCalledWith({ x: 4, y: -7 }, 18);
    texture.dispose();
  });
});
