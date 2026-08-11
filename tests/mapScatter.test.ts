import { describe, expect, it } from 'vitest';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';
import {
  evaluateMapScatterQuality,
  expandMapScatter,
  type MapScatterPlan
} from '../src/shared/mapScatter';
import { terrainFootprintSlopeDegrees, terrainSlopeDegrees } from '../src/shared/mapTerrainAnalysis';
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

const shrubAsset = {
  ...treeAsset,
  id: 'asset-shrub',
  name: 'Shrub',
  colliderPlan: {
    ...treeAsset.colliderPlan,
    boxes: [{ min: [-0.25, 0, -0.25], max: [0.25, 0.8, 0.25] }]
  }
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

  it('supports deterministic clustering, soft edges, and composition exclusion regions', () => {
    const map = createEmptyMap('scatter-v2', 'map-scatter-v2');
    map.assets = [treeAsset];
    const plan: MapScatterPlan = {
      assetIds: [treeAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 20 },
      density: 0.12,
      avoidWater: 0,
      maxSlope: 89,
      minSpacing: 1.8,
      scaleRange: [0.8, 1.2],
      seed: 29,
      edgeFalloff: 0.3,
      clusterStrength: 0.75,
      excludeRegions: [{ kind: 'circle', x: 4, z: -3, r: 5 }]
    };

    const first = expandMapScatter(map, plan, [treeAsset], 120, 'clustered');
    const second = expandMapScatter(map, plan, [treeAsset], 120, 'clustered');

    expect(first.length).toBeGreaterThan(15);
    expect(second).toEqual(first);
    expect(first.every((placement) => Math.hypot(placement.x - 4, placement.z + 3) > 5)).toBe(true);
    expect(first.every((placement) => Math.hypot(placement.x, placement.z) <= 20)).toBe(true);
  });

  it('spreads a small flock across its region instead of filling the first scanned edge', () => {
    const map = createEmptyMap('small flock', 'map-small-flock');
    map.assets = [shrubAsset];
    const plan: MapScatterPlan = {
      assetIds: [shrubAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 20 },
      density: 0.12,
      avoidWater: 0,
      maxSlope: 89,
      minSpacing: 1.8,
      scaleRange: [1, 1],
      seed: 57
    };

    const first = expandMapScatter(map, plan, [shrubAsset], 6, 'flock');
    const second = expandMapScatter(map, plan, [shrubAsset], 6, 'flock');
    const zValues = first.map((placement) => placement.z);

    expect(first).toHaveLength(6);
    expect(second).toEqual(first);
    expect(Math.max(...zValues) - Math.min(...zValues)).toBeGreaterThan(12);
  });

  it('builds deterministic flock cores plus reserved outliers and reports their quality', () => {
    const map = createEmptyMap('grouped flock', 'map-grouped-flock');
    map.assets = [shrubAsset];
    const plan: MapScatterPlan = {
      assetIds: [shrubAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 24 },
      density: 0.16,
      avoidWater: 0,
      maxSlope: 89,
      minSpacing: 1.8,
      scaleRange: [1, 1],
      seed: 71,
      grouping: { groupCount: 2, coreRatio: 0.7, outlierMinDistance: 8 }
    };

    const first = expandMapScatter(map, plan, [shrubAsset], 10, 'flock');
    const second = expandMapScatter(map, plan, [shrubAsset], 10, 'flock');
    const quality = evaluateMapScatterQuality(plan, first, 10);

    expect(second).toEqual(first);
    expect(first.filter((placement) => placement.groupRole === 'core')).toHaveLength(7);
    expect(first.filter((placement) => placement.groupRole === 'outlier')).toHaveLength(3);
    expect(new Set(first.flatMap((placement) => placement.groupIndex ?? [])).size).toBe(2);
    expect(quality.status).toBe('pass');
    expect(quality.coverage).toBeGreaterThan(0.35);
    expect(quality.issues).toEqual([]);
  });

  it('enforces cross-family spacing and terrain habitat bands', () => {
    const map = createEmptyMap('mixed habitat', 'map-mixed-habitat');
    map.assets = [treeAsset, shrubAsset];
    const tree = createMapObject('Tree', treeAsset.id);
    tree.transform.position = [0, 0, 0];
    map.objects = [tree];
    for (let z = 0; z < map.terrain.resolutionZ; z += 1) {
      for (let x = 0; x < map.terrain.resolutionX; x += 1) {
        map.terrain.heights[z * map.terrain.resolutionX + x] = x / (map.terrain.resolutionX - 1) * 6;
      }
    }
    const placements = expandMapScatter(map, {
      assetIds: [shrubAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 20 },
      density: 0.14,
      avoidWater: 0,
      maxSlope: 89,
      minSpacing: 0.8,
      spacingByAssetId: { [treeAsset.id]: 6 },
      habitat: { height: [1.5, 2, 4, 4.5] },
      scaleRange: [0.9, 1.1],
      seed: 41,
      patchSeed: 9001,
      clusterStrength: 0.65
    }, [treeAsset, shrubAsset], 100, 'mixed');

    expect(placements.length).toBeGreaterThan(8);
    expect(placements.every((placement) => Math.hypot(placement.x, placement.z) >= 6)).toBe(true);
    expect(placements.every((placement) => placement.y >= 1.5 && placement.y <= 4.5)).toBe(true);
  });

  it('does not balance large assets on narrow mountain ridges', () => {
    const mountainTree = { ...treeAsset, footprintRadius: 3 } satisfies MapAsset;
    const map = createEmptyMap('mountain ridge', 'map-mountain-ridge');
    map.assets = [mountainTree];
    for (let z = 0; z < map.terrain.resolutionZ; z += 1) {
      for (let x = 0; x < map.terrain.resolutionX; x += 1) {
        const worldX = x / (map.terrain.resolutionX - 1) * map.box.size[0] - map.box.size[0] / 2;
        map.terrain.heights[z * map.terrain.resolutionX + x] = Math.abs(worldX) <= 3 ? 10 : 0;
      }
    }
    const maxSlope = 24;
    const placements = expandMapScatter(map, {
      assetIds: [mountainTree.id],
      region: { kind: 'circle', x: 0, z: 0, r: 10 },
      density: 0.35,
      avoidWater: 0,
      maxSlope,
      minSpacing: 1,
      scaleRange: [1, 1],
      seed: 73
    }, [mountainTree], 80, 'mountain');

    expect(placements.length).toBeGreaterThan(0);
    expect(placements.every((placement) => (
      terrainFootprintSlopeDegrees(map, placement.x, placement.z, mountainTree.footprintRadius) <= maxSlope
    ))).toBe(true);
  });

  it('thins vegetation gradually across steep mountain shoulders', () => {
    const flatMap = createEmptyMap('flat shoulder', 'map-flat-shoulder');
    const slopeMap = createEmptyMap('steep shoulder', 'map-steep-shoulder');
    flatMap.assets = [treeAsset];
    slopeMap.assets = [treeAsset];
    const rise = Math.tan(22 * Math.PI / 180);
    for (let z = 0; z < slopeMap.terrain.resolutionZ; z += 1) {
      for (let x = 0; x < slopeMap.terrain.resolutionX; x += 1) {
        const worldX = x / (slopeMap.terrain.resolutionX - 1) * slopeMap.box.size[0] - slopeMap.box.size[0] / 2;
        slopeMap.terrain.heights[z * slopeMap.terrain.resolutionX + x] = worldX * rise;
      }
    }
    const plan: MapScatterPlan = {
      assetIds: [treeAsset.id],
      region: { kind: 'circle', x: 0, z: 0, r: 18 },
      density: 0.12,
      avoidWater: 0,
      maxSlope: 30,
      minSpacing: 1.5,
      scaleRange: [1, 1],
      seed: 101
    };

    const flat = expandMapScatter(flatMap, plan, [treeAsset], 160, 'flat');
    const steep = expandMapScatter(slopeMap, plan, [treeAsset], 160, 'steep');

    expect(steep.length).toBeGreaterThan(0);
    expect(steep.length).toBeLessThan(flat.length);
  });
});
