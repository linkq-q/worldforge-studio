import { describe, expect, it } from 'vitest';
import { createEmptyMap, normalizeMap, sampleTerrainHeight } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';
import { terrainSemanticSurfaceWeight, terrainVertexColor } from '../src/client/terrainAppearance';
import { grassSurfaceCoverage } from '../src/client/mapGrassRenderer';

describe('snow terrain surfaces', () => {
  it('paints and persists snow regions and ski routes without creating geometry or changing relief', () => {
    const terrain = applyMapOperations(createEmptyMap('snow surface'), [
      { type: 'terrain.generate', preset: 'hills', seed: 42, amplitude: 5 }
    ]);
    const plan = executeMapCodePlan(`function plan(api) {
      api.surface({id:'snowfield',surface:'snow',region:{kind:'polygon',points:[[-20,-20],[-2,-20],[-2,20],[-20,20]]}});
      api.surface({id:'patch',surface:'snow',region:{kind:'circle',center:[10,-12],radius:4}});
      api.route({id:'piste',points:[[5,10],[18,10]],width:4,surface:'snow'});
    }`, terrain, [], { scope: 'scene', promptMode: 'main', spatialPolicy: 'diagnose' });
    const map = normalizeMap(JSON.parse(JSON.stringify(applyMapOperations(terrain, plan.operations))));
    expect(map.terrain.heights).toEqual(terrain.terrain.heights);
    expect(map.objects).toHaveLength(0);
    expect(map.assets ?? []).toHaveLength(0);
    expect(map.guides).toHaveLength(1);
    expect(map.visualSemantics.zones.filter(zone => zone.tags.includes('snow'))).toHaveLength(3);
    for (const [x,z] of [[-10,0],[10,-12],[10,10]]) {
      expect(terrainSemanticSurfaceWeight(map, x, z, ['snow'])).toBeGreaterThan(0.99);
      expect(terrainVertexColor(map, x, sampleTerrainHeight(map,x,z), z).every(value => value > 0.8)).toBe(true);
      expect(grassSurfaceCoverage(map, x, z)).toBe(0);
    }
    expect(terrainSemanticSurfaceWeight(map, 20, -12, ['snow'])).toBe(0);
    expect(grassSurfaceCoverage(map, 20, -12)).toBe(1);
  });

  it('keeps soil paths legible over a snowfield and fades partial snow coverage', () => {
    const base = createEmptyMap();
    const snow = applyMapOperations(base, [{type:'terrain.surface',surface:'snow',
      region:{kind:'circle',x:0,z:0,radius:20},zoneId:'snowfield'}]);
    const road = applyMapOperations(snow, [{type:'terrain.surface',surface:'soil',material:'compacted-earth',
      region:{kind:'path',points:[[-15,0],[15,0]],width:3},zoneId:'road'}]);
    expect(terrainVertexColor(road,0,0,0)[2]).toBeLessThan(terrainVertexColor(snow,0,0,0)[2] * 0.5);
    expect(terrainVertexColor(road,0,0,8)).toEqual(terrainVertexColor(snow,0,0,8));
    const partial = applyMapOperations(base, [{type:'terrain.surface',surface:'snow',
      region:{kind:'circle',x:0,z:0,radius:20},intensity:0.5,zoneId:'partial'}]);
    expect(terrainVertexColor(partial,0,0,0)[2]).toBeLessThan(terrainVertexColor(snow,0,0,0)[2]);
    expect(grassSurfaceCoverage(partial,0,0)).toBeCloseTo(0.5);
  });
});
