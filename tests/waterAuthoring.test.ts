import { describe, expect, it } from 'vitest';
import { createEmptyMap, sampleTerrainHeight, type MapWaterBody } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';
import { carveWaterBasinInPlace, isPointInsideWaterBody, waterBoundaryPoints } from '../src/shared/mapWater';

const river = (): MapWaterBody => ({ id: 'river', name: 'River', type: 'river', points: [[0,-12],[0,12]], level: 1, levels: [3,1], width: 4, widths: [2,10], depth: 1, shorelineSmoothness: 0 });

describe('water authoring contracts', () => {
  it('preserves authored river elevations through Scene Code and transactions', () => {
    const map = createEmptyMap();
    const result = executeMapCodePlan(`function plan(api) { api.water('chute', {type:'river', points:[[0,-8],[0,8]], levels:[6,1], widths:[3,7], level:1, carveTerrain:false}); }`, map, [], { spatialPolicy: 'diagnose' });
    const next = applyMapOperations(map, result.operations);
    expect(next.waterBodies[0].levels).toEqual([6,1]);
    expect(next.waterBodies[0].widths).toEqual([3,7]);
    expect(next.waterBodies[0].carveTerrain).toBe(false);
    expect(next.terrain.heights).toEqual(map.terrain.heights);
  });
  it('uses the same variable width for shoreline, occupancy, and channel carving', () => {
    const map = createEmptyMap();
    map.terrain.heights.fill(5);
    const water = river();
    expect(waterBoundaryPoints(water)[0][0]).toBeCloseTo(-1);
    expect(isPointInsideWaterBody(water, 3.5, 10)).toBe(true);
    expect(isPointInsideWaterBody(water, 3.5, -10)).toBe(false);
    carveWaterBasinInPlace(map, water);
    expect(sampleTerrainHeight(map, 3, 9)).toBeLessThan(2);
  });
  it('creates explicitly requested reservoir banks without changing unrequested terrain, and is idempotent', () => {
    const map = createEmptyMap();
    const lake: MapWaterBody = { id:'lake', name:'Lake', type:'lake', points:[[-8,-8],[8,-8],[8,8],[-8,8]], level:6, depth:3, width:1, shorelineSmoothness:0, bankHeight:0.5, bankWidth:5 };
    carveWaterBasinInPlace(map, lake);
    expect(sampleTerrainHeight(map, 8.5, 0)).toBeGreaterThan(6);
    expect(sampleTerrainHeight(map, 20, 0)).toBe(0);
    const once = [...map.terrain.heights];
    carveWaterBasinInPlace(map, lake);
    expect(map.terrain.heights).toEqual(once);
    const untouched = createEmptyMap();
    carveWaterBasinInPlace(untouched, {...lake, bankHeight:undefined, bankWidth:undefined});
    expect(sampleTerrainHeight(untouched, 8.5, 0)).toBe(0);
  });
  it('rejects mismatched width samples instead of silently losing their alignment', () => {
    expect(() => applyMapOperations(createEmptyMap(), [{type:'water.add',water:{...river(),widths:[2]}}])).toThrow('invalid_water_body');
  });
});
