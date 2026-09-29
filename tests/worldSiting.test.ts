import { describe, expect, it } from 'vitest';
import { findWorldRoute, findWorldSiteCandidates } from '../src/shared/worldSiting';
import { createWorldSampler, type WorldRecipe } from '../src/shared/worldTerrain';
import { generateWorldSettlement } from '../src/shared/worldSettlement';
import type { WorldPlan } from '../src/shared/worldPlanning';

describe('world siting', () => {
  it('scores the circular town footprint without letting an outside corner hill displace it', () => {
    for (const [seed, biome] of [[42, 'grassland'], [2309, 'desert'], [99173, 'forest']] as const) {
      const recipe: WorldRecipe = { version: 1, seed, size: 500, reliefProfile: 'compact', heightScale: 0.035,
        constraints: [{ region: 'center', biome }] };
      const intent = { id: 'town', radius: 55, blend: 20, region: 'center' as const };
      const first = findWorldSiteCandidates(recipe, intent)[0];
      expect(first).toBeDefined();
      const shaped: WorldRecipe = { ...recipe, landforms: [{
        center: [first.center[0] + intent.radius, first.center[1] + intent.radius],
        radius: [12, 12], height: 100
      }] };
      expect(findWorldSiteCandidates(shaped, intent)[0].center).toEqual(first.center);
    }
  });

  it('removes degenerate elbow segments before sampling patched terrain', () => {
    const recipe:WorldRecipe={
      version:1,seed:9012901,size:1000,heightScale:.02,
      constraints:[{region:'center',biome:'grassland'}],
      terrainBrushes:[{id:'route-pad',mode:'flatten',region:{kind:'circle',center:[0,50],radius:180},height:20}],
      biomePatches:[{id:'route-biome',region:{kind:'circle',center:[0,50],radius:200},biome:'grassland'}]
    };
    expect(()=>findWorldRoute(createWorldSampler(recipe),[0,0],[0,100],4)).not.toThrow();
    expect(findWorldRoute(createWorldSampler(recipe),[0,0],[0,100],4)?.points).toEqual([[0,0],[0,100]]);
  });

  it('keeps a sea-targeted town on a dry bank that its waterfront streets can reach', () => {
    const recipe:WorldRecipe={version:1,seed:9012903,size:500,heightScale:.035,constraints:[
      {region:'center',biome:'grassland'},{region:'east',biome:'grassland'},{region:'northeast',biome:'forest'},
      {region:'northwest',biome:'ocean'},{region:'southeast',biome:'grassland'},
      {region:'southwest',biome:'ocean'},{region:'west',biome:'ocean'}],
      landforms:[{center:[140,-170],radius:[75,65],height:8}],
      biomePatches:[{id:'northern-woodland',region:{kind:'circle',center:[135,-175],radius:65},biome:'forest',feather:32}]};
    const intent={id:'bay-town',radius:100,blend:25,region:'center' as const,waterfrontBias:.9,targetWaterBodyId:'sea'};
    const candidates=findWorldSiteCandidates(recipe,intent);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(candidate=>candidate.water?.type==='sea'
      &&candidate.water.distance<=intent.radius*(.4*(Math.abs(candidate.water.direction[0])
        +Math.abs(candidate.water.direction[1]))+.58)&&candidate.dryRatio>=.68)).toBe(true);
    expect(candidates.some(candidate=>candidate.center[0]===112&&candidate.center[1]===112)).toBe(false);
    const site=candidates[0],plan:WorldPlan={version:1,id:'harbor-bank',revision:1,prompt:'A compact harbor',recipe,
      ecology:[],roads:[],towns:[{id:intent.id,name:'Bay Town',prompt:'A fishing town',center:site.center,
        radius:intent.radius,blend:intent.blend,foundation:site.foundation,terrainMode:'conform',ports:[]}]};
    const patch=generateWorldSettlement(plan,intent.id,createWorldSampler(recipe),{
      kind:'city',pattern:'organic',density:.83,waterfrontBias:intent.waterfrontBias
    });
    expect(patch.streets.some(street=>street.tags.includes('waterfront'))).toBe(true);
    expect(patch.buildings.length).toBeGreaterThan(0);
  },15_000);
});
