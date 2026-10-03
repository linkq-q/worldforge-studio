import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  advanceUnderwaterBlend,
  bindUnderwaterDepth,
  cameraWaterSurfaceLevel,
  sampleUnderwaterWaveOffset,
  underwaterSurfaceLevel,
  type UnderwaterWaveProfile
} from '../src/client/underwaterRuntime';
import { createEmptyMap, type MapWaterBody } from '../src/shared/map';
import type { WorldMapState } from '../src/shared/worldMapState';
import { RenderRuntimeAdapter } from '../src/client/renderRuntimeAdapter';

const lake = (id: string, level: number, size = 6): MapWaterBody => ({
  id,
  name: id,
  type: 'lake',
  level,
  depth: 2,
  width: size,
  points: [[-size, -size], [size, -size], [size, size], [-size, size]]
});

const waveProfile: UnderwaterWaveProfile = {
  amplitude: 0.2,
  scale: 1.1,
  speed: 0.8,
  primaryDirection: [1, 0],
  secondaryDirection: [0, 1],
  foamColor: '#ffffff',
  edgeStrength: 0.8
};

describe('underwater runtime state', () => {
  it('selects the highest structured-water surface containing the camera', () => {
    const map = createEmptyMap('overlapping lakes', 'overlapping-lakes', [40, 10, 40]);
    map.waterBodies = [lake('low', 1), lake('high', 3, 3)];

    expect(cameraWaterSurfaceLevel(map, 0, 0)).toBe(3);
    expect(cameraWaterSurfaceLevel(map, 5, 0)).toBe(1);
    expect(cameraWaterSurfaceLevel(map, 12, 0)).toBeNull();
  });

  it('samples a sloped river surface instead of using its terminal level', () => {
    const map = createEmptyMap('sloped river', 'sloped-river', [40, 10, 40]);
    map.waterBodies = [{
      id: 'river', name: 'river', type: 'river', level: 0, levels: [4, 0], depth: 1, width: 4,
      points: [[-10, 0], [10, 0]]
    }];

    expect(cameraWaterSurfaceLevel(map, 0, 0)).toBeCloseTo(2, 5);
  });

  it('uses the render-derived ocean continuation beyond the authored terrain edge', () => {
    const map = createEmptyMap('ocean continuation', 'ocean-continuation', [48, 16, 48]);
    map.terrain.heights.fill(2);
    map.waterBodies = [{
      id: 'ocean', name: 'ocean', type: 'ocean', level: 0, depth: 8, width: 1,
      points: [[-24, -24], [24, -24], [24, 24], [-24, 24]]
    }];

    expect(cameraWaterSurfaceLevel(map, 0, 0)).toBeNull();
    expect(cameraWaterSurfaceLevel(map, 30, 0)).toBe(0);
  });

  it('uses the persisted world sampler when a world map has no local water bodies', () => {
    const map = createEmptyMap('world lake', 'world-lake-map', [500, 20, 500]);
    map.world = worldWithLake();

    expect(map.waterBodies).toEqual([]);
    expect(cameraWaterSurfaceLevel(map, 0, 0)).not.toBeNull();
    expect(cameraWaterSurfaceLevel(map, 200, 200)).toBeNull();
  });

  it('smooths the crossing band instead of flipping at a single height', () => {
    const entering = advanceUnderwaterBlend(0, 0, -0.04, 1 / 60);
    const leaving = advanceUnderwaterBlend(1, 0, 0.04, 1 / 60);

    expect(entering).toBeGreaterThan(0);
    expect(entering).toBeLessThan(1);
    expect(leaving).toBeGreaterThan(0);
    expect(leaving).toBeLessThan(1);
    expect(advanceUnderwaterBlend(entering, null, 0, 1)).toBeCloseTo(0, 4);
  });

  it('moves the camera crossing height with the same bounded directional wave field', () => {
    const atStart = sampleUnderwaterWaveOffset(2, -3, 0, waveProfile);
    const later = sampleUnderwaterWaveOffset(2, -3, 1.5, waveProfile);

    expect(later).not.toBeCloseTo(atStart, 5);
    expect(Math.abs(atStart)).toBeLessThanOrEqual(waveProfile.amplitude);
    expect(Math.abs(later)).toBeLessThanOrEqual(waveProfile.amplitude);
    expect(underwaterSurfaceLevel(4, 2, -3, 1.5, waveProfile)).toBeCloseTo(4 + later, 6);
  });

  it('snaps zero-duration still frames to the current side of the waterline', () => {
    expect(advanceUnderwaterBlend(0, 0, -1, 0)).toBe(1);
    expect(advanceUnderwaterBlend(1, 0, 1, 0)).toBe(0);
  });

  it('clears stale blend and water level when a map or water footprint is left', () => {
    const setPassEnabled = vi.fn();
    const adapter = Object.assign(Object.create(RenderRuntimeAdapter.prototype), {
      underwaterMode: 'clear',
      underwaterBlend: 0.75,
      underwaterWaterLevel: 4,
      underwaterPassActive: true,
      frameCoordinator: { setPassEnabled },
      camera: { position: { y: -1 } },
      modelsRoot: null
    }) as RenderRuntimeAdapter;

    adapter.tick(1 / 60, 0, null);

    expect(adapter.isUnderwaterEnabled()).toBe(true);
    expect(adapter).toMatchObject({ underwaterBlend: 0, underwaterWaterLevel: 0, underwaterPassActive: false });
    expect(setPassEnabled).toHaveBeenCalledWith('underwater', false);

    adapter.tick(0, 0, 0);
    expect(adapter).toMatchObject({ underwaterBlend: 1, underwaterPassActive: true });
    adapter.tick(1 / 60, 1 / 60, null);
    expect(adapter).toMatchObject({ underwaterBlend: 0, underwaterWaterLevel: 0, underwaterPassActive: false });
  });

  it('binds the shared scene depth and current camera matrices', () => {
    const depth = new THREE.DepthTexture(4, 4);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.2, 800);
    camera.position.set(2, -1, 5);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const pass = {
      uniforms: {
        tDepth: { value: null as THREE.DepthTexture | null },
        uProjectionMatrixInverse: { value: new THREE.Matrix4() },
        uCameraMatrixWorld: { value: new THREE.Matrix4() },
        uCameraPosition: { value: new THREE.Vector3() },
        uCameraFar: { value: 0 },
        uWaterLevel: { value: 0 },
        uSubmersion: { value: 0 },
        uTime: { value: 0 },
        uWaveHeight: { value: 0 },
        uWaveScale: { value: 0 },
        uWaveSpeed: { value: 0 },
        uPrimaryWaveDirection: { value: new THREE.Vector2() },
        uSecondaryWaveDirection: { value: new THREE.Vector2() },
        uWaterlineColor: { value: new THREE.Color() },
        uWaterlineStrength: { value: 0 }
      }
    };

    bindUnderwaterDepth(pass, depth, camera, 1.5, 0.75, 2.25, waveProfile);

    expect(pass.uniforms.tDepth.value).toBe(depth);
    expect(pass.uniforms.uCameraFar.value).toBe(800);
    expect(pass.uniforms.uCameraPosition.value).toEqual(camera.position);
    expect(pass.uniforms.uWaterLevel.value).toBe(1.5);
    expect(pass.uniforms.uSubmersion.value).toBe(0.75);
    expect(pass.uniforms.uTime.value).toBe(2.25);
    expect(pass.uniforms.uWaveHeight.value).toBe(0.2);
    expect(pass.uniforms.uWaveScale.value).toBe(1.1);
    expect(pass.uniforms.uWaveSpeed.value).toBe(0.8);
    expect(pass.uniforms.uPrimaryWaveDirection.value).toEqual(new THREE.Vector2(1, 0));
    expect(pass.uniforms.uSecondaryWaveDirection.value).toEqual(new THREE.Vector2(0, 1));
    expect((pass.uniforms.uWaterlineColor.value as THREE.Color).getHexString()).toBe('ffffff');
    expect(pass.uniforms.uWaterlineStrength.value).toBe(0.8);
    expect(pass.uniforms.uProjectionMatrixInverse.value.equals(camera.projectionMatrixInverse)).toBe(true);
    expect(pass.uniforms.uCameraMatrixWorld.value.equals(camera.matrixWorld)).toBe(true);
    depth.dispose();
  });
});

function worldWithLake(): WorldMapState {
  return {
    bundle: {
      plan: {
        version: 1,
        id: 'underwater-world',
        revision: 1,
        prompt: 'A world lake used for underwater detection',
        recipe: {
          version: 1,
          seed: 2309,
          size: 500,
          heightScale: 0.1,
          constraints: [{ region: 'center', biome: 'grassland' }],
          waterBodies: [{
            id: 'world-lake',
            type: 'lake',
            region: { kind: 'circle', center: [0, 0], radius: 40 },
            levels: [20],
            depth: 2
          }]
        },
        towns: [],
        roads: [],
        ecology: []
      },
      patches: []
    },
    assets: []
  };
}
