import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  advanceUnderwaterBlend,
  bindUnderwaterDepth,
  cameraWaterSurfaceLevel
} from '../src/client/underwaterRuntime';
import { createEmptyMap, type MapWaterBody } from '../src/shared/map';
import type { WorldMapState } from '../src/shared/worldMapState';

const lake = (id: string, level: number, size = 6): MapWaterBody => ({
  id,
  name: id,
  type: 'lake',
  level,
  depth: 2,
  width: size,
  points: [[-size, -size], [size, -size], [size, size], [-size, size]]
});

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
        uSubmersion: { value: 0 }
      }
    };

    bindUnderwaterDepth(pass, depth, camera, 1.5, 0.75);

    expect(pass.uniforms.tDepth.value).toBe(depth);
    expect(pass.uniforms.uCameraFar.value).toBe(800);
    expect(pass.uniforms.uCameraPosition.value).toEqual(camera.position);
    expect(pass.uniforms.uWaterLevel.value).toBe(1.5);
    expect(pass.uniforms.uSubmersion.value).toBe(0.75);
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
