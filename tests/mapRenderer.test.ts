import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditableMapGroup, buildStructuredWaterGroup } from '../src/client/mapRenderer';
import { createEmptyMap } from '../src/shared/map';

describe('structured map water rendering', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => null
      })
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the map as an open terrain plane without enclosure faces', async () => {
    const rendered = await buildEditableMapGroup(createEmptyMap('open-map', 'map-open-plane'));
    const surfaces: string[] = [];
    rendered.group.traverse((object) => {
      if (typeof object.userData.surface === 'string') surfaces.push(object.userData.surface);
    });

    expect(surfaces).toEqual(['terrain']);
    const terrain = rendered.group.getObjectByName('terrain') as THREE.Mesh;
    const material = terrain.material as THREE.MeshStandardMaterial;
    expect(terrain.castShadow).toBe(true);
    expect(terrain.receiveShadow).toBe(true);
    expect(material.emissive.getHex()).toBe(0x000000);
    expect(material.side).toBe(THREE.FrontSide);
    rendered.dispose();
  });

  it('builds tagged lake and river geometry under the model root', async () => {
    const map = createEmptyMap('waters', 'map-render-water');
    map.waterBodies = [
      {
        id: 'lake-1',
        name: '湖泊',
        type: 'lake',
        level: 0.4,
        depth: 1.5,
        width: 1.2,
        points: [[-4, -3], [4, -3], [4, 3], [-4, 3]]
      },
      {
        id: 'river-1',
        name: '河流',
        type: 'river',
        level: 0.5,
        depth: 1.5,
        width: 1.2,
        points: [[-6, -5], [-1, 0], [6, 5]]
      }
    ];

    const waterRoot = buildStructuredWaterGroup(map);
    const lake = waterRoot.getObjectByName('water:lake-1') as THREE.Mesh;
    const river = waterRoot.getObjectByName('water:river-1') as THREE.Mesh;

    expect(lake?.isMesh).toBe(true);
    expect(river?.isMesh).toBe(true);
    expect(lake.position.y).toBeCloseTo(0.4);
    expect(river.position.y).toBeCloseTo(0.5);
    expect(lake.userData.materialTags).toEqual(expect.arrayContaining(['water', 'lake', 'lake-1']));
    expect(river.userData.materialTags).toEqual(expect.arrayContaining(['water', 'river', 'river-1']));
    expect(lake.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(3);
    expect(river.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(6);

    waterRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((material) => material.dispose());
    });
  });
});
