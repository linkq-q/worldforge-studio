import { describe, expect, it } from 'vitest';
import { createEmptyMap, getMapCollisionBake, movePlayerPositionForMap } from '../src/shared/map';
import { MAP_ASSET_COLLIDER_PROFILE, buildModelColliderPlan } from '../src/shared/modelBounds';
import { getMapMeshCollisionWorld } from '../src/client/mapMeshCollision';

const VERTICAL_RING = {
  format: 2,
  nodes: [{
    id: 'ring',
    transform: {
      quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2]
    },
    mesh: {
      type: 'torus',
      params: { radius: 2, tube: 0.25, radialSegments: 12, tubularSegments: 24 }
    }
  }]
};

describe('map mesh collision', () => {
  it('preserves a visible model opening that the legacy AABB bake seals', () => {
    const map = createEmptyMap('mesh opening');
    map.assets = [{
      id: 'ring',
      name: 'ring',
      prompt: '',
      modelJson: VERTICAL_RING,
      colliderPlan: buildModelColliderPlan(VERTICAL_RING, MAP_ASSET_COLLIDER_PROFILE),
      mode: 'voxel',
      createdAt: 1,
      updatedAt: 1
    }];
    map.objects = [{
      id: 'ring-object',
      name: 'ring',
      parentId: null,
      assetId: 'ring',
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        size: [1, 1, 1]
      },
      visible: true,
      locked: false
    }];

    const legacy = movePlayerPositionForMap(
      [0, 0.7, 2],
      [0, 0, -4],
      map,
      getMapCollisionBake(map)
    );
    const mesh = getMapMeshCollisionWorld(map).moveCapsule(
      [0, 0.7, 2],
      [0, 0, -4],
      0.38,
      1.6,
      { groundProbe: 0 }
    );

    expect(legacy[2]).toBeGreaterThan(0);
    expect(mesh.position[2]).toBeCloseTo(-2, 4);
  });

  it('deflects the same capsule when it crosses the ring mesh itself', () => {
    const map = createEmptyMap('mesh surface');
    map.assets = [{
      id: 'ring', name: 'ring', prompt: '', modelJson: VERTICAL_RING,
      colliderPlan: buildModelColliderPlan(VERTICAL_RING, MAP_ASSET_COLLIDER_PROFILE),
      mode: 'voxel', createdAt: 1, updatedAt: 1
    }];
    map.objects = [{
      id: 'ring-object', name: 'ring', parentId: null, assetId: 'ring',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1] },
      visible: true, locked: false
    }];

    const moved = getMapMeshCollisionWorld(map).moveCapsule(
      [2, 0.7, 2],
      [0, 0, -4],
      0.38,
      1.6,
      { groundProbe: 0 }
    );

    expect(moved.position[2]).toBeGreaterThan(-1);
  });

  it('reuses a world across editor map wrappers until collision data changes', () => {
    const map = createEmptyMap('cached mesh world');
    const first = getMapMeshCollisionWorld(map);
    expect(getMapMeshCollisionWorld({ ...map, assets: [...(map.assets ?? [])] })).toBe(first);

    map.version += 1;
    expect(getMapMeshCollisionWorld(map)).not.toBe(first);
  });
});
