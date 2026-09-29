import { describe,expect,it } from 'vitest';
import { createWorldSampler, parseWorldPrompt, selectWorldTiles, validateWorldRecipe } from '../src/shared/worldTerrain';
import { selectEcologyChunks } from '../src/shared/worldEcology';
describe('500 metre preview scale',()=>{
  it('accepts a 500x500 metre world while preserving the supported bounds',()=>{
    const recipe=parseWorldPrompt('中央是草原',42,500);
    expect(recipe.size).toBe(500);
    expect(recipe.reliefProfile).toBe('compact');
    expect(Number.isFinite(createWorldSampler(recipe)(0,0).height)).toBe(true);
    expect(()=>validateWorldRecipe({...recipe,size:499})).toThrow();
    expect(()=>validateWorldRecipe({...recipe,size:256001})).toThrow();
  });
  it('covers the small map with usable terrain detail and only its four ecology chunks',()=>{
    const tiles=selectWorldTiles(500,0,0,700);
    expect(tiles.reduce((n,t)=>n+t.size*t.size,0)).toBe(500*500);
    expect(tiles.length).toBeGreaterThanOrEqual(64);
    expect(Math.max(...tiles.map(t=>t.size/32))).toBeLessThanOrEqual(2);
    expect(selectEcologyChunks(500,0,0,700)).toHaveLength(4);
  });
});


import { readFileSync } from 'node:fs';
import { validateWorldBundle, createPlannedWorldSampler, createWorldExclusion, createWorldEcologyDensity } from '../src/shared/worldPlanning';
import { generateEcologyChunk } from '../src/shared/worldEcology';
const compact=validateWorldBundle(JSON.parse(readFileSync(new URL('../scripts/fixtures/compact-world.json',import.meta.url),'utf8').replace(/^\uFEFF/,'')));
it('ships four substantial close settlements in the requested physical extent',()=>{
  expect(compact.plan.recipe.size).toBe(500);
  expect(compact.plan.recipe.reliefProfile).toBeUndefined();
  expect(compact.plan.towns).toHaveLength(4);
  expect(compact.patches).toHaveLength(4);
  const buildings=compact.patches.flatMap(p=>p.buildings);
  expect(buildings.length).toBeGreaterThanOrEqual(60);
  expect(new Set(compact.plan.towns.map(t=>t.radius)).size).toBe(4);
  expect(new Set(compact.patches.map(p=>p.buildings.length)).size).toBe(4);
  expect(buildings.filter(b=>Math.abs(Math.sin((b.rotation??0)*2))>.1).length).toBeGreaterThan(buildings.length*.8);
  for(const t of compact.plan.towns){
    const others=compact.plan.towns.filter(o=>o.id!==t.id);
    expect(Math.min(...others.map(o=>Math.hypot(o.center[0]-t.center[0],o.center[1]-t.center[1])))).toBeLessThan(230);
  }
  expect(compact.plan.roads).toHaveLength(5);
  expect(compact.plan.roads.every(r=>r.points.length>2)).toBe(true);
});
it('clips nearby vegetation to the 500m map and keeps it off settlement footprints and roads',()=>{
  const sample=createPlannedWorldSampler(compact.plan,compact.patches),exclusion=createWorldExclusion(compact.plan,compact.patches);
  const density=createWorldEcologyDensity(compact.plan,compact.patches);
  const plants=selectEcologyChunks(500,0,0,700).flatMap(c=>generateEcologyChunk(compact.plan.recipe,compact.plan.ecology,c,{sample,exclusion,density}).instances);
  expect(plants.length).toBeGreaterThan(20);
  for(const town of compact.plan.towns) {
    expect(plants.some(p=>Math.abs(p.x-town.center[0])<town.radius && Math.abs(p.z-town.center[1])<town.radius)).toBe(true);
  }
  for(const p of plants){
    expect(Math.abs(p.x)).toBeLessThanOrEqual(250);expect(Math.abs(p.z)).toBeLessThanOrEqual(250);
    expect(exclusion(p.x,p.z,0)).toBe(false);expect(p.y).toBe(sample(p.x,p.z).height);
  }
});
