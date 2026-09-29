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

  it('does not accept a narrow road grade that the 500 metre world validator samples', () => {
    const sample = (x:number) => ({
      height: Math.max(3, 8 - Math.abs(x - 4) * 3), moisture: .5, temperature: .5, continentalness: .5,
      weights: {ocean:0,grassland:1,forest:0,desert:0,mountains:0,snow:0}, waterLevel: null, waterBodyId: null
    });
    expect(findWorldRoute(sample, [0, 0], [16, 0], 4, 2)).toBeNull();
  });

  it('routes around the traced island ridge only when the terminal earthwork stays within budget', () => {
    const recipe: WorldRecipe = {
      version: 1, seed: 6103402, size: 500, reliefProfile: 'compact', heightScale: 0.09,
      constraints: [
        { region: 'center', biome: 'grassland' }, { region: 'south', biome: 'grassland' },
        { region: 'north', biome: 'forest' }, { region: 'northwest', biome: 'mountains' },
        { region: 'west', biome: 'ocean' }, { region: 'east', biome: 'ocean' },
        { region: 'southwest', biome: 'ocean' }, { region: 'southeast', biome: 'ocean' }
      ],
      landforms: [
        { center: [0, 18], radius: [218, 205], height: 9 },
        { center: [-32, -142], radius: [72, 65], height: 28 },
        { center: [42, -165], radius: [47, 42], height: 20 },
        { center: [-92, -151], radius: [46, 38], height: 17 },
        { center: [-108, 95], radius: [34, 51], height: 4 }
      ],
      terrainBrushes: [
        { id: 'north-ridge', mode: 'raise', region: { kind: 'path', points: [[-88, -175], [-54, -151], [-21, -132], [16, -119]], width: 18 }, amount: 10, feather: 18 },
        { id: 'north-gully', mode: 'lower', region: { kind: 'path', points: [[-14, -187], [-8, -159], [8, -137], [27, -116]], width: 10 }, amount: 5, feather: 12 },
        { id: 'bay-shore', mode: 'lower', region: { kind: 'circle', center: [-42, 166], radius: 42 }, amount: 4, feather: 18 },
        { id: 'western-headland', mode: 'raise', region: { kind: 'path', points: [[-184, -58], [-191, -18], [-179, 25]], width: 11 }, amount: 3, feather: 12 }
      ]
    };
    const start: [number, number] = [-12.76, 40], blockedEnd: [number, number] = [66.5, -171];
    const sample = createWorldSampler(recipe);
    expect(findWorldRoute(sample, start, blockedEnd, 5)).toBeNull();
    const end: [number, number] = [71.5, -176];
    const route = findWorldRoute(sample, start, end, 5);
    expect(route).not.toBeNull();
    expect(route!.points.length).toBeGreaterThanOrEqual(3);
    expect(route!.length).toBeGreaterThan(Math.hypot(end[0] - start[0], end[1] - start[1]));
    expect(route!.maxSlope).toBeLessThanOrEqual(0.5);
    for (let segment = 1; segment < route!.points.length; segment++) {
      const a = route!.points[segment - 1], b = route!.points[segment];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.ceil(length / 8));
      const nx = -(b[1] - a[1]) / length, nz = (b[0] - a[0]) / length;
      for (let i = 0; i <= steps; i++) {
        const x = a[0] + (b[0] - a[0]) * i / steps, z = a[1] + (b[1] - a[1]) * i / steps;
        const cross = [-2.5, 0, 2.5].map(offset => sample(x + nx * offset, z + nz * offset));
        expect(cross.every(point => point.waterLevel === null)).toBe(true);
        expect(Math.abs(cross[0].height - cross[1].height)).toBeLessThanOrEqual(1.5);
        expect(Math.abs(cross[2].height - cross[1].height)).toBeLessThanOrEqual(1.5);
      }
    }
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
