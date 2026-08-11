import { describe, expect, it } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { expandStructuredMapPlacement } from '../src/shared/mapPlacement';

const buildingAsset = {
  id: 'asset-house',
  name: 'House',
  prompt: 'small house',
  modelJson: {},
  colliderPlan: {
    version: 1,
    boxes: [{ min: [-1.2, 0, -1], max: [1.2, 3, 1] }],
    sourceMeshCount: 1,
    candidateCount: 1,
    fallbackUsed: false
  },
  footprintRadius: 1.2,
  mode: 'asset',
  createdAt: 1,
  updatedAt: 1
} satisfies MapAsset;

describe('structured map placement', () => {
  it('samples a linear guide by spacing and aligns objects to its tangent', () => {
    const map = createEmptyMap('street', 'map-street');
    map.assets = [buildingAsset];
    const placements = expandStructuredMapPlacement(map, {
      mode: 'linear',
      assetIds: [buildingAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 20 },
      density: 0.04,
      spacing: 4,
      offset: 2,
      direction: 0,
      facing: 'guide',
      avoidWater: 0,
      maxSlope: 20,
      scaleRange: [1, 1],
      seed: 8
    }, [buildingAsset], 6, 'street');

    expect(placements).toHaveLength(6);
    expect(placements.every((placement) => Math.abs(placement.z - 2) < 0.2)).toBe(true);
    expect(placements.every((placement) => Math.abs(placement.rotationY - Math.PI / 2) < 0.0001)).toBe(true);
    const sorted = [...placements].sort((left, right) => left.x - right.x);
    expect(sorted.slice(1).every((placement, index) => placement.x - sorted[index].x > 3.6)).toBe(true);
  });

  it('creates an ordered courtyard whose buildings face the shared center', () => {
    const map = createEmptyMap('courtyard', 'map-courtyard');
    map.assets = [buildingAsset];
    const placements = expandStructuredMapPlacement(map, {
      mode: 'layout',
      pattern: 'courtyard',
      assetIds: [buildingAsset.id],
      region: { kind: 'circle', x: 3, z: -2, r: 18 },
      density: 0.03,
      spacing: 4,
      offset: 0,
      direction: 25,
      facing: 'inward',
      avoidWater: 0,
      maxSlope: 20,
      scaleRange: [1, 1],
      seed: 12
    }, [buildingAsset], 8, 'court');

    expect(placements.length).toBeGreaterThanOrEqual(6);
    for (const placement of placements) {
      const length = Math.hypot(3 - placement.x, -2 - placement.z);
      const toCenter = [(3 - placement.x) / length, (-2 - placement.z) / length];
      const forward = [Math.sin(placement.rotationY), Math.cos(placement.rotationY)];
      expect(forward[0] * toCenter[0] + forward[1] * toCenter[1]).toBeGreaterThan(0.99);
    }
  });

  it('attaches detail objects around explicit targets instead of scattering them globally', () => {
    const map = createEmptyMap('attached', 'map-attached');
    const smallAsset = { ...buildingAsset, id: 'asset-crate', footprintRadius: 0.3 };
    map.assets = [smallAsset];
    const targets = [{ x: -8, z: 4 }, { x: 7, z: -3 }];
    const placements = expandStructuredMapPlacement(map, {
      mode: 'attached',
      assetIds: [smallAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 22 },
      density: 1,
      spacing: 1.5,
      offset: 2,
      direction: 0,
      facing: 'inward',
      avoidWater: 0,
      maxSlope: 30,
      scaleRange: [1, 1],
      seed: 3,
      targets
    }, [smallAsset], 2, 'attached');

    expect(placements).toHaveLength(2);
    expect(placements.every((placement) => (
      Math.min(...targets.map((target) => Math.hypot(placement.x - target.x, placement.z - target.z))) < 2.2
    ))).toBe(true);
  });
});
