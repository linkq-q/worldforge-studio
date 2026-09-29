import { describe, expect, it } from 'vitest';
import { findWorldRoute } from '../src/shared/worldSiting';
import { createWorldSampler, type WorldRecipe } from '../src/shared/worldTerrain';

describe('world siting', () => {
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
});
