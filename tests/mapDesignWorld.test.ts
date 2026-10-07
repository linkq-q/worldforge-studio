import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createEmptyMap, sampleTerrainHeight, type MapAsset} from '../src/shared/map';
import {applyMapOperations} from '../src/shared/mapOperations';
import {executeMapDesignProgram} from '../src/server/mapDesignExecution';
import type {MapDesignToolObservation} from '../src/shared/mapDesignFeedback';
import {compileMapDesignTerrain} from '../src/server/mapDesignWorld';
import {normalizeSceneAppearancePlan} from '../src/shared/sceneAppearance';

const mocks = vi.hoisted(() => ({llmChat:vi.fn()}));
vi.mock('../src/server/modelApi', async original => ({...await original<typeof import('../src/server/modelApi')>(),llmChat:mocks.llmChat}));
const baseMap = () => createEmptyMap('blank', 'blank-world', [48, 32, 48]);
const terrainProgram = {source:'function generate(t){t.map((x,z)=>12+x/100);t.inspect("center",[[0,0]]);}',seed:47,size:1200,resolution:33};
const create = `api.createWorld({recipe:{version:1,seed:47,size:1200,constraints:[{region:'center',biome:'grassland'}],terrainProgram:api.terrainProgram()}});`;
const asset: MapAsset = {id:'standalone-equipment',name:'缆车站',prompt:'cable car station',tags:['equipment'],
  modelJson:{nodes:[]},colliderPlan:{version:1,boxes:[],sourceMeshCount:0,candidateCount:0,fallbackUsed:true},
  mode:'voxel',createdAt:1,updatedAt:1};

describe('new worlds in the ongoing design execution', () => {
  beforeEach(() => vi.clearAllMocks());
  it('creates a larger world from authored terrain, exposes new bounds, and places a standalone facility on it', async () => {
    const observations: MapDesignToolObservation[] = [];
    const map = baseMap();
    const result = await executeMapDesignProgram({baseMap:map,assets:[asset],maxNewAssets:0,terrainProgram,
      onToolObservation:item=>observations.push(item),code:`function plan(api){${create}
      const p=[400,90]; api.report('actual bounds',api.bounds);api.environmentSample(p);
      api.place({assetId:'standalone-equipment',name:'缆车站',position:p,dimensions:[12,9,10]});}`});
    const draft = applyMapOperations(map,result.operations);
    expect(draft.box.size[0]).toBe(1200);
    expect(draft.world!.bundle.plan.generationPolicy).toBe('diagnostic');
    expect(draft.world!.bundle.plan.towns).toEqual([]);
    expect(draft.world!.bundle.plan.ecology).toEqual([]);
    expect(draft.objects).toHaveLength(1);
    expect(draft.objects[0].assetId).toBe(asset.id);
    expect(draft.objects[0].transform.position[0]).toBe(400);
    expect(draft.objects[0].transform.position[1]).toBeCloseTo(16);
    expect(draft.objects[0].transform.position[2]).toBe(90);
    expect(sampleTerrainHeight(draft,400,90)).toBeCloseTo(16);
    expect(map.world).toBeUndefined();
    expect(observations.find(item=>item.tool==='report')?.result).toMatchObject({minX:-600,maxX:600});
    expect(observations.find(item=>item.tool==='terrainProgram')?.result).toMatchObject({terrainRevision:1,
      observations:[{terrainRevision:1,points:[[0,0]]}]});
    expect((observations.find(item=>item.tool==='environmentSample')?.result as {height:number}).height).toBeCloseTo(16);
    expect(mocks.llmChat).not.toHaveBeenCalled();
  });

  it('supports recipe-only creation without injecting a fixed terrain or settlement template', async () => {
    const result = await executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:0,
      code:`function plan(api){api.createWorld({prompt:'A dry mountain traversal',recipe:{version:1,seed:9,size:2400,
      constraints:[{region:'west',biome:'mountains'},{region:'east',biome:'desert'}]},
      concept:{premise:'An exposed divide',themes:['arid'],experience:'Climb and glide'}});}`});
    const draft=applyMapOperations(baseMap(),result.operations);
    expect(draft.world!.bundle.plan.recipe.size).toBe(2400);
    expect(draft.world!.bundle.plan.recipe.terrainProgram).toBeUndefined();
    expect(draft.world!.bundle.plan.roads).toEqual([]);
    expect(draft.world!.bundle.plan.concept?.experience).toBe('Climb and glide');
    expect(mocks.llmChat).not.toHaveBeenCalled();
  });

  it('replays a new world with generated ecology and separate equipment, retaining actual asset bindings', async () => {
    const createAsset=vi.fn().mockResolvedValue(asset), observations:MapDesignToolObservation[]=[];
    const result=await executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:1,createAsset,terrainProgram,
      onToolObservation:item=>observations.push(item),code:`function plan(api){
      const key=api.requireAsset({key:'station',name:'缆车站',prompt:'A standalone cable car station',dimensions:[12,9,10],role:'structure'});
      ${create} api.editWorld(w=>{w.assets=[{key:'station',assetId:api.asset(key),role:'landmark'}];});
      api.place({assetId:api.asset(key),position:[400,90]});api.report('composition',{facility:'cable car station'});}`});
    const draft=applyMapOperations(baseMap(),result.operations);
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(draft.world!.assets[0].assetId).toBe(asset.id);
    expect(draft.objects[0].assetId).toBe(asset.id);
    expect(observations.filter(item=>item.tool==='report').map(item=>item.phase)).toEqual(['discovery','final']);
    expect(mocks.llmChat).not.toHaveBeenCalled();
  });

  it('rejects invalid world replacement and terrain coordinate contexts without losing the base', async () => {
    const initial=await executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:0,terrainProgram,code:`function plan(api){${create}}`});
    const existing=applyMapOperations(baseMap(),initial.operations);
    await expect(executeMapDesignProgram({baseMap:existing,assets:[],maxNewAssets:0,terrainProgram,
      code:`function plan(api){${create}}`})).rejects.toThrow('map_code_world_already_exists');
    await expect(executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:0,terrainProgram,
      code:`function plan(api){${create.replace('size:1200','size:600')}}`})).rejects.toThrow('map_code_terrain_program_context_mismatch');
    expect(existing.world!.bundle.plan.recipe.size).toBe(1200);
  });

  it('snapshots local query results before mutation and retains them when later execution fails', async () => {
    const observations:MapDesignToolObservation[]=[];
    await expect(executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:0,
      onToolObservation:item=>observations.push(item),code:`function plan(api){
      const read=api.environmentSample([0,0]);const decision={height:read.height};api.report('decision',decision);
      decision.height=999;api.report('changed decision',decision);throw new Error('unfinished');
      }`})).rejects.toThrow('unfinished');
    expect(observations[0]).toMatchObject({tool:'environmentSample',phase:'discovery',step:1,result:{height:0}});
    expect(observations[1]).toMatchObject({tool:'report',phase:'discovery',step:2,result:{height:0}});
    expect(observations[2]).toMatchObject({tool:'report',phase:'discovery',step:3,result:{height:999}});
  });

  it.each(['{invalid:NaN}', '{invalid:()=>1}', '(()=>{const x={};x.x=x;return x;})()'])('rejects non-JSON authored reports %s', async value => {
    await expect(executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:0,
      code:`function plan(api){api.report('bad',${value});}`})).rejects.toThrow('invalid_map_code_report_json');
  });

  it('reuses compiled fields across replay and checks cancellation and explicit precision', async () => {
    const first=await compileMapDesignTerrain(terrainProgram,1), second=await compileMapDesignTerrain(terrainProgram,2);
    expect(second).toBe(first);
    expect(first.field.resolution).toBe(33);
    const controller=new AbortController();controller.abort();
    await expect(compileMapDesignTerrain(terrainProgram,1,controller.signal)).rejects.toThrow();
    await expect(compileMapDesignTerrain({...terrainProgram,resolution:514},1)).rejects.toThrow('terrain_program_resolution_out_of_budget');
  });

  it('inherits the same appearance after a commit and lets one explicit declaration replace it for all new assets', async () => {
    const appearance=normalizeSceneAppearancePlan({version:1,intent:'Warm stone',materials:[{role:'stone',color:'#bc9977',notes:'walls'}],
      renderPlan:{version:1,baseSchemeId:'render-runtime-sketch-mist',modules:[]}});
    const createAsset=vi.fn().mockResolvedValue(asset);
    const code="const key=api.requireAsset({key:'station',name:'车站',prompt:'A stone cable car station',dimensions:[12,9,10],role:'structure'});api.place({assetId:api.asset(key),position:[1,2]});";
    const inherited=await executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:1,appearancePlan:appearance,createAsset,
      code:`function plan(api){${code}}`});
    expect(createAsset.mock.calls[0][0].appearancePlan).toEqual(appearance);
    expect(inherited.appearancePlan).toEqual(appearance);
    const replacement={...appearance,intent:'Cool limestone',materials:[{role:'stone',color:'#aabbcc',notes:'new stone'}]};
    const changed=await executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:1,appearancePlan:appearance,createAsset,
      code:`function plan(api){api.appearance(${JSON.stringify(replacement)});${code}}`});
    expect(createAsset.mock.calls[1][0].appearancePlan).toEqual(replacement);
    expect(changed.appearancePlan).toEqual(replacement);
    await expect(executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:0,appearancePlan:appearance,
      code:`function plan(api){api.appearance(${JSON.stringify(replacement)});api.appearance(${JSON.stringify(replacement)});}`}))
      .rejects.toThrow('scene_appearance_declared_twice');
  });

  it('propagates feedback storage/budget errors rather than silently dropping observations', async () => {
    await expect(executeMapDesignProgram({baseMap:baseMap(),assets:[],maxNewAssets:0,
      onToolObservation:()=>{throw new Error('design_feedback_budget_exceeded');},
      code:'function plan(api){api.environmentSample([0,0]);}'})).rejects.toThrow('design_feedback_budget_exceeded');
  });
});
