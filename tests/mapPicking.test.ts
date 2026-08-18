import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { selectableObjectHit } from '../src/client/mapEditor';

function hit(object: THREE.Object3D, distance: number): THREE.Intersection {
  return { object, distance } as THREE.Intersection;
}

describe('map editor picking', () => {
  it('selects indoor content through a room wall', () => {
    const wall = new THREE.Object3D();
    wall.userData.mapObjectId = '__room__:north';
    wall.userData.surface = 'north';
    const chair = new THREE.Object3D();
    chair.userData.mapObjectId = 'chair-a';
    const floor = new THREE.Object3D();
    floor.userData.mapObjectId = '__room__:floor';
    floor.userData.surface = 'floor';

    expect(selectableObjectHit([
      hit(wall, 1), hit(chair, 2), hit(floor, 3)
    ])?.object).toBe(chair);
  });

  it('still selects a room surface when there is no object behind it', () => {
    const wall = new THREE.Object3D();
    wall.userData.mapObjectId = '__room__:north';
    wall.userData.surface = 'north';

    expect(selectableObjectHit([hit(wall, 1)])?.object).toBe(wall);
  });

  it('does not select an outdoor object hidden below terrain', () => {
    const terrain = new THREE.Object3D();
    terrain.userData.surface = 'terrain';
    const hidden = new THREE.Object3D();
    hidden.userData.mapObjectId = 'hidden-a';

    expect(selectableObjectHit([hit(terrain, 1), hit(hidden, 2)])).toBeNull();
  });
});
