import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
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

  it('follows a curved street guide with grouped gaps instead of forming a courtyard ring', () => {
    const map = createEmptyMap('park path', 'map-park-path');
    map.assets = [buildingAsset];
    const placements = expandStructuredMapPlacement(map, {
      mode: 'linear', intent: 'street-edge',
      assetIds: [buildingAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 24 },
      density: 0.08, spacing: 3, offset: 2, direction: 0, facing: 'guide',
      guidePoints: [[-14, -6], [0, -6], [0, 12]],
      maxPerGroup: 3,
      avoidWater: 0, maxSlope: 20, scaleRange: [1, 1], seed: 18
    }, [buildingAsset], 8, 'street-bench');

    expect(placements.length).toBeGreaterThanOrEqual(6);
    expect(placements.every((placement) => (
      Math.abs(placement.z + 4) < 0.3 || Math.abs(placement.x + 2) < 0.3
    ))).toBe(true);
    const nearest = [...placements].sort((left, right) => left.x - right.x);
    expect(nearest.some((placement, index) => index > 0 && (
      Math.hypot(placement.x - nearest[index - 1].x, placement.z - nearest[index - 1].z) > 4
    ))).toBe(true);
  });

  it('creates audience rows with an aisle and consistent focus-facing', () => {
    const map = createEmptyMap('church seating', 'map-audience');
    map.assets = [buildingAsset];
    const placements = expandStructuredMapPlacement(map, {
      mode: 'layout', pattern: 'grid', intent: 'audience',
      assetIds: [buildingAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 18 },
      density: 0.05, spacing: 2.5, offset: 0, direction: 0, facing: 'inward',
      focus: { x: 0, z: 14 }, aisleEvery: 3,
      avoidWater: 0, maxSlope: 20, scaleRange: [1, 1], seed: 22
    }, [buildingAsset], 12, 'audience');

    expect(placements.length).toBeGreaterThanOrEqual(8);
    expect(placements.every((placement) => {
      const toFocus = new THREE.Vector2(-placement.x, 14 - placement.z).normalize();
      const forward = new THREE.Vector2(Math.sin(placement.rotationY), Math.cos(placement.rotationY));
      return forward.dot(toFocus) > 0.98;
    })).toBe(true);
    const xValues = [...new Set(placements.map((placement) => Math.round(placement.x * 10) / 10))].sort((a, b) => a - b);
    expect(Math.max(...xValues.slice(1).map((value, index) => value - xValues[index]))).toBeGreaterThan(3);
  });

  it('limits social furniture to target-local slots and viewpoint seating to a short arc', () => {
    const map = createEmptyMap('furniture groups', 'map-furniture-groups');
    map.assets = [buildingAsset];
    const social = expandStructuredMapPlacement(map, {
      mode: 'attached', intent: 'social',
      assetIds: [buildingAsset.id], region: { kind: 'circle', x: 0, z: 0, r: 20 },
      density: 1, spacing: 2.5, offset: 2.5, direction: 0, facing: 'inward',
      maxPerGroup: 4, targets: [{ x: 3, z: -2, yaw: 0, footprintRadius: 1 }],
      avoidWater: 0, maxSlope: 20, scaleRange: [1, 1], seed: 5
    }, [buildingAsset], 20, 'social');
    const viewpoint = expandStructuredMapPlacement(map, {
      mode: 'layout', pattern: 'arc', intent: 'viewpoint',
      assetIds: [buildingAsset.id], region: { kind: 'circle', x: 0, z: 0, r: 16 },
      density: 1, spacing: 3, offset: 0, direction: 90, facing: 'inward',
      maxPerGroup: 5, arcDegrees: 110,
      avoidWater: 0, maxSlope: 20, scaleRange: [1, 1], seed: 6
    }, [buildingAsset], 20, 'viewpoint');

    expect(social).toHaveLength(4);
    expect(social.every((placement) => Math.abs(Math.hypot(placement.x - 3, placement.z + 2) - 2.5) < 0.3)).toBe(true);
    expect(viewpoint).toHaveLength(5);
    const angles = viewpoint.map((placement) => Math.atan2(placement.z, placement.x));
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(Math.PI);
  });

  it('aligns wall furniture to a room wall while leaving door clearance', () => {
    const map = createEmptyMap('room furniture', 'map-room-furniture', [12, 3.2, 10], 'voxel', 'indoor', [12, 3.2, 10]);
    map.assets = [buildingAsset];
    map.room!.openings = [{ id: 'door-main', kind: 'door', wall: 'north', offset: 0, bottom: 0, width: 1.4, height: 2.2 }];
    const placements = expandStructuredMapPlacement(map, {
      mode: 'linear', intent: 'wall',
      assetIds: [buildingAsset.id], region: { kind: 'circle', x: 0, z: 0, r: 8 },
      density: 0.2, spacing: 2.5, offset: 0.4, direction: 0, facing: 'inward',
      maxPerGroup: 8,
      avoidWater: 0, maxSlope: 20, scaleRange: [0.5, 0.5], seed: 7
    }, [buildingAsset], 8, 'wall');

    expect(placements.length).toBeGreaterThanOrEqual(4);
    expect(placements.every((placement) => placement.z < -4)).toBe(true);
    expect(placements.every((placement) => Math.abs(placement.x) > 1.4)).toBe(true);
    expect(placements.every((placement) => Math.abs(placement.rotationY) < 0.01)).toBe(true);
  });
});
