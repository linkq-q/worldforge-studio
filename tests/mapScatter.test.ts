import { describe, expect, it } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import {
  expandMapScatter,
  terrainSlopeDegrees,
  type MapScatterPlan
} from '../src/shared/mapScatter';
import { isNearWater } from '../src/shared/mapWater';

const treeAsset = {
  id: 'asset-tree',
  name: 'Tree',
  prompt: 'low poly tree',
  modelJson: {},
  colliderPlan: {
    version: 1,
    boxes: [{ min: [-0.4, 0, -0.4], max: [0.4, 2, 0.4] }],
    sourceMeshCount: 1,
    candidateCount: 1,
    fallbackUsed: false
  },
  mode: 'asset',
  createdAt: 1,
  updatedAt: 1
} satisfies MapAsset;

describe('deterministic map scatter', () => {
  it('avoids water and steep terrain while preserving spacing and seed stability', () => {
    const map = createEmptyMap('scatter', 'map-scatter');
    map.assets = [treeAsset];
    map.waterBodies = [{
      id: 'lake',
      name: 'Lake',
      type: 'lake',
      level: 0.3,
      depth: 1.5,
      width: 1,
      points: [[-5, -5], [5, -5], [5, 5], [-5, 5]]
    }];
    for (let zIndex = 0; zIndex < map.terrain.resolutionZ; zIndex += 1) {
      for (let xIndex = 0; xIndex < map.terrain.resolutionX; xIndex += 1) {
        const worldX = xIndex / (map.terrain.resolutionX - 1) * map.box.size[0] - map.box.size[0] / 2;
        map.terrain.heights[zIndex * map.terrain.resolutionX + xIndex] = Math.max(0, worldX - 8);
      }
    }
    const plan: MapScatterPlan = {
      assetIds: [treeAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 22 },
      density: 0.08,
      avoidWater: 1.5,
      maxSlope: 20,
      minSpacing: 2.5,
      scaleRange: [0.8, 1.2],
      seed: 17
    };

    const first = expandMapScatter(map, plan, [treeAsset], 100, 'test');
    const second = expandMapScatter(map, plan, [treeAsset], 100, 'test');

    expect(first.length).toBeGreaterThan(10);
    expect(second).toEqual(first);
    for (const placement of first) {
      expect(isNearWater(map, placement.x, placement.z, plan.avoidWater)).toBe(false);
      expect(terrainSlopeDegrees(map, placement.x, placement.z)).toBeLessThanOrEqual(plan.maxSlope);
    }
    for (let index = 0; index < first.length; index += 1) {
      for (let other = index + 1; other < first.length; other += 1) {
        expect(Math.hypot(first[index].x - first[other].x, first[index].z - first[other].z))
          .toBeGreaterThanOrEqual(plan.minSpacing);
      }
    }
  });
});
