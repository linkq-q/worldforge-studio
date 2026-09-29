import { describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { isPointInsideWaterBody, riverPathSamples, sampleRiverProfile } from '../src/shared/mapWater';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';

describe('waterfront layout in Scene Code', () => {
  it.each(['main', 'standard'] as const)('derives %s roads and buildings from the river declared earlier in the same plan', promptMode => {
    const map = createEmptyMap('river city', 'river-city', [160, 32, 160]);
    const code = `function plan(api) {
      api.terrain('plain');
      const river = api.water('bend',{type:'river',points:[[-16,-75],[12,-30],[-12,28],[20,75]],width:10,depth:2,level:0});
      const town = api.urbanLayout({pattern:'waterfront',waterId:river,bankSide:'both',bankDepth:30,
        waterSetback:4,roadWidth:3,parcelWidth:7,parcelDepth:7,setback:1,seed:api.seed});
      for (const road of town.roads) api.route({...road,surface:'paving',material:'asphalt'});
      for (const p of town.parcels) api.place({name:p.id,position:p.center,rotationY:p.rotationY,
        dimensions:[p.width,5,p.depth],role:'structure'});
    }`;
    const result = executeMapCodePlan(code, map, [], {scope:'scene',promptMode,spatialPolicy:'diagnose'});
    const saved = applyMapOperations(map, result.operations);
    const water = saved.waterBodies[0];
    const profile = riverPathSamples(water);
    expect(saved.guides.length).toBeGreaterThanOrEqual(2);
    expect(saved.objects.length).toBeGreaterThan(16);
    let left = 0, right = 0;
    for (const object of saved.objects) {
      const [x,,z] = object.transform.position;
      expect(isPointInsideWaterBody(water, x, z, saved)).toBe(false);
      const nearest = sampleRiverProfile(x, z, profile);
      const cross = nearest.direction[0] * (z - nearest.point[1]) - nearest.direction[1] * (x - nearest.point[0]);
      if (cross > 0) left++; else right++;
    }
    expect(Math.min(left, right)).toBeGreaterThan(8);
    const headings = new Set(saved.objects.map(object => Math.round(object.transform.rotation[1] * 10)));
    expect(headings.size).toBeGreaterThan(6);
    const replay = applyMapOperations(map, executeMapCodePlan(code, map, [], {scope:'scene',promptMode,spatialPolicy:'diagnose'}).operations);
    expect(replay.guides).toEqual(saved.guides);
    expect(replay.objects.map(object => object.transform)).toEqual(saved.objects.map(object => object.transform));
  });

  it('retains dense fitted frontage through the actual Shanghai terrain and water API path', () => {
    const map=createEmptyMap('Shanghai waterfront','shanghai-waterfront',[128,32,128]);
    map.seed=1965915200;
    const code=`function plan(api) {
      api.terrain('plain',{amplitude:0,roughness:0,seed:api.seed});
      const river=api.water('huangpu',{type:'river',points:[[-4,-64],[-6,-44],[-2,-23],[4,0],[8,23],[5,44],[1,64]],width:19,depth:4,level:0});
      const town=api.urbanLayout({id:'shanghai-waterfront',pattern:'waterfront',waterId:river,bankSide:'both',
        bankDepth:43,waterSetback:4,roadWidth:3,arterialWidth:5,blockSize:[23,25],
        parcelWidth:8,parcelDepth:9,setback:0.45,irregularity:0.32,seed:api.seed+17});
      for(const road of town.roads)api.route({...road,surface:'paving',material:'asphalt'});
      for(const p of town.parcels)api.place({name:p.id,position:p.center,rotationY:p.rotationY,
        dimensions:[p.width,6,p.depth],role:'structure'});
    }`;
    const run=(target: typeof map)=>applyMapOperations(target,executeMapCodePlan(code,target,[],{
      scope:'scene',promptMode:'main',spatialPolicy:'diagnose'
    }).operations);
    const saved=run(map);
    expect(saved.objects.length).toBeGreaterThanOrEqual(58);
    expect(saved.guides.length).toBe(28);
    expect(saved.objects.map(object=>object.transform)).toEqual(run(map).objects.map(object=>object.transform));
    expect(run({...map,seed:map.seed+1}).objects.map(object=>object.transform)).not.toEqual(saved.objects.map(object=>object.transform));
    for(const object of saved.objects){
      const [x,,z]=object.transform.position;
      expect(isPointInsideWaterBody(saved.waterBodies[0],x,z,saved)).toBe(false);
    }
  });

  it('fails clearly when the requested river does not exist', () => {
    expect(() => executeMapCodePlan(`function plan(api) {
      api.urbanLayout({pattern:'waterfront',waterId:'missing'});
    }`, createEmptyMap(), [], {scope:'scene',promptMode:'main'})).toThrow(/unknown_map_code_water/);
  });
});
