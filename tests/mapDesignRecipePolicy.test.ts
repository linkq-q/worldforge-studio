import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createEmptyMap, sampleTerrainHeight} from '../src/shared/map';
import {applyMapOperations} from '../src/shared/mapOperations';
import {validateWorldMapState} from '../src/shared/worldMapState';
import {buildMapDesignExecutionPrompt, executeMapDesignProgram} from '../src/server/mapDesignExecution';
import {executeMapCodePlan} from '../src/server/mapCodePlanner';
import {MapDesignSessionManager} from '../src/server/mapDesignSessions';
import {MapStore} from '../src/server/mapStore';
import {compileTerrainProgram} from '../src/server/terrainProgram';

const field = {version:1 as const,source:'function generate(t){t.map(()=>4)}',resolution:33,
  heights:new Array(33**2).fill(4),observations:[]};
const recipe = {version:1 as const,seed:47,size:500,reliefProfile:'compact' as const,heightScale:0.11,
  constraints:[{region:'center' as const,biome:'grassland' as const}],
  landforms:[{center:[0,0] as [number,number],radius:[90,120] as [number,number],height:12}]};
const createRecipe = `api.createWorld({recipe:${JSON.stringify(recipe)}});`;
const createProgram = `api.createWorld({recipe:${JSON.stringify({...recipe,terrainProgram:field})}});`;
const directories:string[]=[];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
function legacyMap() {
  const map=createEmptyMap('saved legacy world','legacy',[500,512,500]);
  map.world=validateWorldMapState({bundle:{plan:{version:1,id:'legacy',revision:1,prompt:'Saved world',
    recipe:{...recipe,terrainProgram:field},ecology:[],roads:[],towns:[]},patches:[]},assets:[]});
  return map;
}

describe('continuous design WorldRecipe policy',()=>{
  it.each([null,{source:field.source,size:500,resolution:33}])('rejects the retired outer execute field before execution (%j)',async terrainProgram=>{
    const createAsset=vi.fn();
    await expect(executeMapDesignProgram({baseMap:createEmptyMap(),assets:[],maxNewAssets:1,createAsset,
      ...{terrainProgram},code:`function plan(api){${createRecipe}}`}))
      .rejects.toThrow('design_terrain_program_retired');
    expect(createAsset).not.toHaveBeenCalled();
  });
  it('does not expose the retired compiled-field API',async()=>{
    const result=await executeMapDesignProgram({baseMap:createEmptyMap(),assets:[],maxNewAssets:0,
      code:`function plan(api){if(typeof api.terrainProgram!=='undefined')throw Error('retired API exposed');${createRecipe}}`});
    expect(applyMapOperations(createEmptyMap(),result.operations).world!.bundle.plan.recipe).toEqual(recipe);
    const prompt=buildMapDesignExecutionPrompt(createEmptyMap(),[],0);
    expect(prompt).not.toContain('api.terrainProgram()');
    expect(prompt).not.toContain('terrainProgram?:');
    expect(prompt).not.toContain('t.ridge');
    expect(prompt).toContain('heightScale');
    expect(prompt).toContain('WorldRecipe');
  });
  it('rejects a direct createWorld field before generating requested assets and leaves the base unchanged',async()=>{
    const base=createEmptyMap(), before=structuredClone(base),createAsset=vi.fn();
    await expect(executeMapDesignProgram({baseMap:base,assets:[],maxNewAssets:1,createAsset,
      code:`function plan(api){api.requireAsset({key:'tree',name:'Tree',prompt:'A tree',dimensions:[2,5,2],role:'environment'});${createProgram}}`}))
      .rejects.toThrow('design_terrain_program_retired');
    expect(base).toEqual(before);expect(createAsset).not.toHaveBeenCalled();
  });
  it('rejects inserting a field through editWorld after recipe creation',async()=>{
    await expect(executeMapDesignProgram({baseMap:createEmptyMap(),assets:[],maxNewAssets:0,
      code:`function plan(api){${createRecipe}api.editWorld(w=>{w.bundle.plan.recipe.terrainProgram=${JSON.stringify(field)};});}`}))
      .rejects.toThrow('design_terrain_program_retired');
  });
  it.each([
    'w.bundle.plan.recipe.terrainProgram.heights[0]=9;',
    'w.bundle.plan.recipe.terrainProgram.source="replacement";',
    'w.bundle.plan.recipe.size=640;',
    'w.bundle.plan.recipe.seed=48;'
  ])('rejects replacement or coordinate changes to a retained legacy field: %s',async edit=>{
    const base=legacyMap(), before=structuredClone(base);
    await expect(executeMapDesignProgram({baseMap:base,assets:[],maxNewAssets:0,
      code:`function plan(api){api.editWorld(w=>{${edit}});}`})).rejects.toThrow('design_terrain_program_retired');
    expect(base).toEqual(before);
  });
  it('preserves saved legacy terrain while allowing ordinary world and prop edits',async()=>{
    const base=legacyMap(),before=structuredClone(base);
    const result=await executeMapDesignProgram({baseMap:base,assets:[],maxNewAssets:0,
      code:`function plan(api){api.editWorld(w=>{w.bundle.plan.prompt='A retained world with a trail';
      w.bundle.plan.roads=[{id:'trail',name:'Trail',points:[[-20,0],[20,0]],width:3,curve:'polyline',closed:false,tags:[]}];});
      api.place({name:'Existing-world marker',position:[40,40]});}`});
    const draft=applyMapOperations(base,result.operations);
    expect(draft.world!.bundle.plan.recipe.terrainProgram).toEqual(before.world!.bundle.plan.recipe.terrainProgram);
    expect(sampleTerrainHeight(draft,40,40)).toBe(4);
    expect(draft.world!.bundle.plan.roads).toHaveLength(1);expect(draft.objects).toHaveLength(1);
    expect(base).toEqual(before);
  });
  it('allows explicit field removal and restores the recipe without clearing the rest of the world',async()=>{
    const base=legacyMap();
    const result=await executeMapDesignProgram({baseMap:base,assets:[],maxNewAssets:0,
      code:`function plan(api){api.editWorld(w=>{delete w.bundle.plan.recipe.terrainProgram;
      w.bundle.plan.recipe.size=640;w.bundle.plan.recipe.seed=48;});}`});
    const draft=applyMapOperations(base,result.operations);
    expect(draft.world!.bundle.plan.recipe).toEqual({...recipe,size:640,seed:48});
    expect(draft.world!.bundle.plan.id).toBe('legacy');
    expect(sampleTerrainHeight(draft,0,0)).not.toBe(4);
    expect(base.world!.bundle.plan.recipe.terrainProgram).toEqual(field);
  });
  it('keeps the independent legacy terrain compiler available',async()=>{
    const compiled=await compileTerrainProgram(field.source,{seed:47,size:500,resolution:33});
    expect(compiled.heights).toEqual(field.heights);
  });
  it('pauses a saved retired configuration, preserves its draft/history, rejects old replay/commit, and resumes with a recipe',async()=>{
    const rootDir=await mkdtemp(path.join(os.tmpdir(),'worldforge-recipe-policy-'));directories.push(rootDir);
    const store=new MapStore({rootDir}),map=await store.createMap({name:'Baseline',size:[48,32,48]});
    const initial=new MapDesignSessionManager(store,{chat:async()=>JSON.stringify({action:'finish',outcome:'unchanged',summary:'Inspect only'})});
    const session=await initial.create(map.id,{prompt:'Preserve the approved recipe',expectedVersion:map.version});await initial.settled(session.id);
    const file=path.join(rootDir,'design-sessions',session.id+'.json'),saved=JSON.parse(await readFile(file,'utf8'));
    saved.capabilityVersion=2;saved.terrainProgram={source:field.source,size:500,resolution:33};
    saved.code=`function plan(api){${createProgram}}`;
    saved.suggestion=executeMapCodePlan(saved.code,map,[],{worldEditPolicy:'diagnostic'});
    saved.view.draftRevision=1;saved.view.operationCount=saved.suggestion.operations.length;
    saved.view.outcome='completed';saved.transcript[0].content='OLD terrainProgram TOOL CONTRACT';
    const history=structuredClone(saved.transcript.slice(1));await writeFile(file,JSON.stringify(saved));
    let turn=0;
    const manager=new MapDesignSessionManager(store,{chat:async messages=>{
      const last=JSON.parse(messages.filter(m=>m.role==='user'&&typeof m.content==='string'&&m.content.startsWith('{')).at(-1)!.content as string);
      if(++turn===1){expect(messages[0].content).not.toContain('api.terrainProgram()');return JSON.stringify({action:'finish',summary:'Old draft is done'});}
      if(turn===2){expect(last.result.error).toContain('design_terrain_program_retired');return JSON.stringify({action:'execute',code:saved.code});}
      if(turn===3){expect(last.result.error).toContain('design_terrain_program_retired');return JSON.stringify({action:'execute',code:`function plan(api){${createRecipe}}`});}
      return JSON.stringify({action:'finish',summary:'Recipe draft is ready for review'});
    }});
    const recovered=await manager.get(session.id);
    expect(recovered.status).toBe('paused');expect(recovered.error).toContain('design_terrain_program_retired');
    const before=await manager.draft(session.id);expect(before.suggestion).toEqual(saved.suggestion);
    expect(before.map.world!.bundle.plan.recipe.terrainProgram).toEqual(field);
    const migrated=JSON.parse(await readFile(file,'utf8'));
    expect(migrated.terrainProgram).toBeUndefined();expect(migrated.retiredTerrainProgram).toEqual(saved.terrainProgram);
    expect(migrated.transcript.slice(1,1+history.length)).toEqual(history);
    expect(migrated.view.messages.at(-1).role).toBe('tool');
    await expect(manager.commit(session.id,1,true)).rejects.toThrow('design_terrain_program_retired');
    await manager.resume(session.id);await manager.settled(session.id);
    const final=await manager.draft(session.id);
    expect(final.session).toMatchObject({status:'idle',outcome:'completed',draftRevision:2});
    expect(final.map.world!.bundle.plan.recipe).toEqual(recipe);
    expect((await store.loadMap(map.id)).version).toBe(map.version);
    expect(turn).toBe(4);
  });
});
