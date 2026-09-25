import * as THREE from 'three';
import { buildStructuredWaterGroup } from '../src/client/mapRenderer';
import { lintMap } from '../src/shared/mapLint';
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
  it('joins natural lake and river banks to high surrounding terrain without a one-cell wall', () => {
    for (const type of ['lake', 'river'] as const) {
      const map = createEmptyMap('shore profile', 'shore-profile', [96, 64, 96]);
      map.terrain.heights.fill(10);
      const water: MapWaterBody = type === 'lake'
        ? { id: 'lake', name: 'Lake', type, points: [[-10,-10],[10,-10],[10,10],[-10,10]], level: 2, depth: 3, width: 8, shorelineSmoothness: 0 }
        : { id: 'river', name: 'River', type, points: [[0,-30],[0,30]], level: 2, levels: [2,2], depth: 3, width: 8, shorelineSmoothness: 0 };
      carveWaterBasinInPlace(map, water);
      const start = type === 'lake' ? 9 : 4.5;
      const heights = Array.from({ length: 9 }, (_, index) => sampleTerrainHeight(map, start + index * 1.5, 0));
      expect(Math.max(...heights.slice(1).map((height, index) => height - heights[index]))).toBeLessThan(2);
      expect(heights.at(-1)).toBe(10);
      const once = [...map.terrain.heights];
      carveWaterBasinInPlace(map, water);
      expect(map.terrain.heights).toEqual(once);
    }
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
  it('renders the authored width and downstream direction through bends', () => {
    const map = createEmptyMap();
    map.waterBodies = [{...river(),points:[[0,-12],[0,0],[12,0]],widths:[2,6,10],levels:[3,2,1]}];
    const group = buildStructuredWaterGroup(map);
    const mesh = group.children[0] as THREE.Mesh;
    const flow = mesh.geometry.getAttribute('riverFlow');
    const positions = mesh.geometry.getAttribute('position');
    expect(flow.getX(0)).toBeCloseTo(0);
    expect(flow.getY(0)).toBeCloseTo(1);
    expect(flow.getX(flow.count - 1)).toBeCloseTo(1);
    expect(flow.getY(flow.count - 1)).toBeCloseTo(0);
    expect(positions.getX(0)).toBeCloseTo(-1);
    expect(positions.getZ(positions.count - 1)).toBeCloseTo(-5);
    mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); mesh.userData.waterShore.texture.dispose();
  });
  it('raises an explicitly requested river bank without reporting a safe carve for structural water', () => {
    const map = createEmptyMap();
    const water = {...river(),levels:[1,1],width:6,widths:[6,6],bankHeight:0.5,bankWidth:3};
    carveWaterBasinInPlace(map,water);
    expect(sampleTerrainHeight(map,5,0)).toBeGreaterThan(1);
    const once=[...map.terrain.heights]; carveWaterBasinInPlace(map,water);
    expect(map.terrain.heights).toEqual(once);
    map.waterBodies=[{...water,carveTerrain:false,levels:[0.2,0.2],level:0.2}];
    map.terrain.heights.fill(2);
    const lint=lintMap(map);
    expect(lint.issues.find(i=>i.code==='water.exposed-terrain')?.repaired).toBe(false);
    expect(lint.repairOperations.some(o=>o.type==='water.update')).toBe(false);
  });

  it('renders a sloping river and its receiving lake as one surface without transparent overlap', () => {
    const map=createEmptyMap();
    map.waterBodies=[{id:'lake',name:'lake',type:'lake',level:1,depth:2,width:1,points:[[-8,0],[8,0],[8,12],[-8,12]],shorelineSmoothness:0},
      {...river(),points:[[0,-12],[0,4]],levels:[3,1],widths:[3,6]}];
    const group=buildStructuredWaterGroup(map);
    expect(group.children).toHaveLength(1);
    const mesh=group.children[0] as THREE.Mesh;
    expect(mesh.userData.waterBodyIds).toEqual(['lake','river']);
    const p=mesh.geometry.getAttribute('position');
    expect(Math.max(...Array.from({length:p.count},(_,i)=>p.getY(i)))).toBeGreaterThan(1);
    mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();mesh.userData.waterShore.texture.dispose();
  });

  it('keeps one metre of shoreline blending consistent across different lake sizes', () => {
    const distanceAtOneMetre = (halfSize:number) => {
      const map=createEmptyMap();
      map.waterBodies=[{id:'lake',name:'lake',type:'lake',level:1,depth:2,width:1,
        points:[[-halfSize,-halfSize],[halfSize,-halfSize],[halfSize,halfSize],[-halfSize,halfSize]],shorelineSmoothness:0}];
      const mesh=buildStructuredWaterGroup(map).children[0] as THREE.Mesh;
      const shore=mesh.userData.waterShore;
      const pixels=shore.texture.image;
      const col=Math.floor(((halfSize-1-shore.center[0])/shore.size+0.5)*pixels.width);
      const row=Math.floor((0.5+shore.center[1]/shore.size)*pixels.height);
      const distance=pixels.data[row*pixels.width+col]/255*(shore.distanceScale??1);
      mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();shore.texture.dispose();
      return distance;
    };
    expect(Math.abs(distanceAtOneMetre(8)-distanceAtOneMetre(16))).toBeLessThan(0.05);
  });

});
