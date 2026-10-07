import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createEmptyMap, createMapObject, type MapAsset} from '../src/shared/map';
import {applyMapOperations} from '../src/shared/mapOperations';
import {validateWorldMapState} from '../src/shared/worldMapState';
import {worldPlanKey} from '../src/shared/worldPlanning';
import {buildMapDesignExecutionPrompt, executeMapDesignProgram} from '../src/server/mapDesignExecution';
import {executeMapCodePlan} from '../src/server/mapCodePlanner';
import type {MapDesignToolObservation} from '../src/shared/mapDesignFeedback';

const mocks = vi.hoisted(() => ({llmChat: vi.fn()}));
vi.mock('../src/server/modelApi', async original => ({...await original<typeof import('../src/server/modelApi')>(), llmChat:mocks.llmChat}));

const asset: MapAsset = {id:'generated-tree',name:'树',prompt:'tree',tags:['tree'],
  modelJson:{nodes:[],_meta:{semanticSnapshot:{v:1,auto:true,text:'G:trunk and canopy'}}},
  colliderPlan:{version:1,boxes:[],sourceMeshCount:0,candidateCount:0,fallbackUsed:true},mode:'voxel',createdAt:1,updatedAt:1};
const worldMap = () => {
  const map = createEmptyMap('world', 'design-world', [500,4096,500]);
  map.world = validateWorldMapState({bundle:{plan:{version:1,id:'world-plan',revision:1,prompt:'forest',
    recipe:{version:1,seed:47,size:500,constraints:[{region:'center',biome:'forest'}]},
    ecology:[{id:'pines',kind:'pine',biome:'forest',density:0.4,spacing:12,maxSlope:40,scale:[1,2]}],towns:[],roads:[]},patches:[]},
    assets:[{key:'existing-pines',assetId:'existing-tree',role:'tree',ecologyKind:'pine'}]});
  return map;
};

describe('design-session scene execution', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([false, true])('executes documented spatial reads and retains their real phases (new asset %s)', async generated => {
    const observations: MapDesignToolObservation[] = [];
    await executeMapDesignProgram({baseMap:generated?worldMap():createEmptyMap(),assets:[],maxNewAssets:generated?1:0,
      createAsset:vi.fn().mockResolvedValue(asset),onToolObservation:value=>observations.push(value),
      code:`function plan(api){
        if(typeof api.gridPoints!=='undefined')throw new Error('unrelated legacy API exposed');
        ${generated?"const key=api.requireAsset({key:'tree',name:'Tree',prompt:'A tree',dimensions:[2,5,2],role:'environment'});api.place({assetId:api.asset(key),position:[12,12]});":''}
        const a=api.place({position:[-8,0]}); const b=api.place({position:[8,0]});
        api.assetSpace(${generated?"api.asset(key)":"'unknown'"});
        api.sightline({from:[0,20,0],to:[2,20,0]});
        api.passage({points:[[-10,-10],[-8,-10]],width:2,height:2});
        api.connectionGap({a,b,tolerance:1});
      }`});
    for(const phase of generated?['discovery','final']:['discovery']) {
      expect(observations.filter(value=>value.phase===phase).map(value=>value.tool))
        .toEqual(['assetSpace','sightline','passage','connectionGap']);
    }
    expect(new Set(observations.map(value=>value.phase))).toEqual(new Set(generated?['discovery','final']:['discovery']));
    for(const observation of observations) {
      const result=observation.result as {coverage:{checkedSources:string[];uncheckedSources:string[]}};
      expect(result.coverage).toBeDefined();
      if(observation.tool==='assetSpace') {
        expect(result.coverage.uncheckedSources).toContain('terrain-contact');
      } else {
        expect(result.coverage.checkedSources).toContain('current-program-placement-collider-aabbs');
        expect(result.coverage.uncheckedSources).toContain('terrain');
        expect(result.coverage.uncheckedSources.includes('streamed-town-buildings')).toBe(generated);
        expect(result.coverage.uncheckedSources.includes('streamed-bridges')).toBe(generated);
      }
    }
    expect(mocks.llmChat).not.toHaveBeenCalled();
  });
  it('replays each complete candidate over the original base, with stable IDs and no hidden model calls', async () => {
    const baseMap = createEmptyMap();
    const baseObject = createMapObject('existing');
    baseObject.id = 'existing'; baseMap.objects.push(baseObject);
    const code = "function plan(api){api.place({name:'new',position:[2,3]});}";
    const input = {code,baseMap,assets:[],maxNewAssets:0};
    const first = await executeMapDesignProgram(input), second = await executeMapDesignProgram(input);
    const a = applyMapOperations(baseMap, first.operations), b = applyMapOperations(baseMap, second.operations);
    expect(a.objects.map(object=>object.id)).toEqual(b.objects.map(object=>object.id));
    expect(a.objects).toHaveLength(2);
    expect(baseMap.objects).toHaveLength(1);
    const changed = await executeMapDesignProgram({...input,code:code.replace('[2,3]','[5,7]')});
    expect(applyMapOperations(baseMap,changed.operations).objects).toHaveLength(2);
    expect(mocks.llmChat).not.toHaveBeenCalled();
  });
  it('avoids base-object ID collisions deterministically and supports base-map refinement', async () => {
    const baseMap=createEmptyMap(), code="function plan(api){api.place({position:[2,3]});}";
    const first=await executeMapDesignProgram({baseMap,code,assets:[],maxNewAssets:0});
    const generated=first.operations.find(operation=>operation.type==='object.add');
    const existing=createMapObject('keep');
    existing.id=generated!.type==='object.add' ? generated!.object.id! : '';
    baseMap.objects.push(existing);
    const next=await executeMapDesignProgram({baseMap,code,assets:[],maxNewAssets:0});
    const objects=applyMapOperations(baseMap,next.operations).objects;
    expect(new Set(objects.map(object=>object.id)).size).toBe(2);
    const moved=await executeMapDesignProgram({baseMap,assets:[],maxNewAssets:0,
      code:`function plan(api){api.move({objectId:${JSON.stringify(existing.id)},position:[4,6]});}`});
    expect(applyMapOperations(baseMap,moved.operations).objects[0].transform.position).toEqual([4,0,6]);
  });
  it('binds actual assets and exposes errors without requesting model repair or asset adaptation', async () => {
    const createAsset = vi.fn().mockResolvedValue(asset);
    const result = await executeMapDesignProgram({baseMap:createEmptyMap(),assets:[],maxNewAssets:1,createAsset,
      code:"function plan(api){const tree=api.requireAsset({key:'tree',name:'树',prompt:'A tree',dimensions:[2,5,2],role:'environment'});api.place({assetId:api.asset(tree),position:[2,3]});}"});
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(result.operations).toEqual(expect.arrayContaining([expect.objectContaining({type:'object.add',object:expect.objectContaining({assetId:asset.id})})]));
    await expect(executeMapDesignProgram({baseMap:createEmptyMap(),assets:[],maxNewAssets:0,
      code:"function plan(api){throw new Error('authored failure')}"})).rejects.toThrow('authored failure');
    expect(mocks.llmChat).not.toHaveBeenCalled();
  });
  it('changes actual world data while preserving the height recipe and unrelated bindings', async () => {
    const baseMap = worldMap(), original = structuredClone(baseMap.world);
    const result = await executeMapDesignProgram({baseMap,assets:[],maxNewAssets:0,
      code:"function plan(api){const before=api.worldState();api.editWorld(state=>{state.bundle.plan.ecology[0].density=before.bundle.plan.ecology[0].density+0.2;});}"});
    expect(result.operations.map(operation=>operation.type)).toEqual(['world.set']);
    const final = applyMapOperations(baseMap,result.operations);
    expect(final.world!.bundle.plan.ecology[0].density).toBeCloseTo(0.6);
    expect(final.world!.bundle.plan.recipe).toEqual(original!.bundle.plan.recipe);
    expect(final.world!.assets).toEqual(original!.assets);
    expect(final.world!.bundle.plan.revision).toBe(2);
    expect(baseMap.world).toEqual(original);
  });
  it('generates an asset used only by streamed ecology, then replays its real binding', async () => {
    const createAsset = vi.fn().mockResolvedValue(asset);
    const result = await executeMapDesignProgram({baseMap:worldMap(),assets:[],maxNewAssets:1,createAsset,
      code:"function plan(api){const key=api.requireAsset({key:'pine',name:'松树',prompt:'A pine tree',dimensions:[3,8,3],role:'environment'});api.editWorld(state=>{state.assets=[{key:'pines',assetId:api.asset(key),role:'tree',ecologyKind:'pine',ecologyRuleId:'pines'}];});api.editWorld(state=>{state.bundle.plan.ecology[0].density=0.5;});}"});
    const world = result.operations.find(operation=>operation.type==='world.set');
    expect(world?.type==='world.set' && world.world.assets[0].assetId).toBe(asset.id);
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(result.diagnostics?.some(issue=>issue.code==='asset.unplaced')).toBe(false);
    expect(mocks.llmChat).not.toHaveBeenCalled();
  });
  it('updates patch identity after a world-plan edit while preserving patch contents', async () => {
    const baseMap=worldMap(), state=baseMap.world!;
    state.bundle.plan.recipe.terrainProgram={version:1,source:'function generate(t){t.map(()=>5)}',resolution:33,
      heights:new Array(33*33).fill(5),observations:[]};
    state.bundle.plan.towns=[{id:'town',name:'Town',prompt:'',center:[0,0],radius:50,blend:20,foundation:5,ports:[]}];
    state.bundle.patches=[{townId:'town',worldKey:worldPlanKey(state.bundle.plan),summary:'existing',streets:[],buildings:[]}];
    baseMap.world=validateWorldMapState(state);
    const result=await executeMapDesignProgram({baseMap,assets:[],maxNewAssets:0,
      code:"function plan(api){api.editWorld(state=>{state.bundle.plan.ecology[0].density=0.5;});}"});
    const draft=applyMapOperations(baseMap,result.operations);
    expect(draft.world!.bundle.patches[0]).toEqual({...baseMap.world.bundle.patches[0],worldKey:worldPlanKey(draft.world!.bundle.plan)});
  });
  it('rejects invalid and asynchronous world edits without mutating the base', async () => {
    const baseMap=worldMap(), original=structuredClone(baseMap.world);
    await expect(executeMapDesignProgram({baseMap,assets:[],maxNewAssets:0,
      code:'function plan(api){api.editWorld(state=>{state.bundle.plan.ecology[0].density=2;});}'})).rejects.toThrow('invalid_ecology_rule');
    await expect(executeMapDesignProgram({baseMap,assets:[],maxNewAssets:0,
      code:'function plan(api){api.editWorld(async state=>{});}'})).rejects.toThrow('async_map_code_world_edit_not_supported');
    expect(baseMap.world).toEqual(original);
  });
  it('keeps patch bounds and linked port endpoints strict while accepting a coordinated town resize', async () => {
    const baseMap=worldMap(), state=baseMap.world!, plan=state.bundle.plan;
    plan.recipe.terrainProgram={version:1,source:'function generate(t){t.map(()=>5)}',resolution:33,
      heights:new Array(33*33).fill(5),observations:[]};
    plan.towns=[{id:'town',name:'Town',prompt:'',center:[20,30],radius:50,blend:20,foundation:5,
      ports:[{id:'east-port',guideId:'east-road',position:[50,0],width:4}]}];
    plan.roads=[{id:'east-road',name:'East',points:[[70,30],[160,30]],curve:'polyline',closed:false,width:4,tags:[]}];
    state.bundle.patches=[{townId:'town',worldKey:worldPlanKey(plan),summary:'',buildings:[],
      streets:[{id:'main-street',name:'Main',points:[[0,0],[50,0]],curve:'polyline',closed:false,width:4,tags:[]}]}];
    baseMap.world=validateWorldMapState(state);
    const execute=(edit:string)=>executeMapDesignProgram({baseMap,assets:[],maxNewAssets:0,
      code:`function plan(api){api.editWorld(state=>{${edit}});}`});
    const resize='state.bundle.plan.towns[0].radius=60;';
    await expect(execute('state.bundle.patches[0].streets[0].points[0]=[-60,0];')).rejects.toThrow('world_guide_outside');
    await expect(execute(resize)).rejects.toThrow('world_port_not_on_core_boundary');
    await expect(execute(resize+'state.bundle.plan.towns[0].ports[0].position=[60,0];')).rejects.toThrow('world_port_endpoint_mismatch');
    const result=await execute(resize+'state.bundle.plan.towns[0].ports[0].position=[60,0];'
      +'state.bundle.plan.roads[0].points[0]=[80,30];state.bundle.patches[0].streets[0].points=[[-60,0],[60,0]];');
    expect(applyMapOperations(baseMap,result.operations).world!.bundle.plan.towns[0].radius).toBe(60);
    expect(baseMap.world.bundle.plan.towns[0].radius).toBe(50);
  });
  it('persists world quality warnings from session execution without repairing geometry or changing legacy execution', async () => {
    const baseMap=worldMap(), resolution=33;
    baseMap.world!.bundle.plan.recipe.terrainProgram={version:1,source:'steep analytic terrain',resolution,observations:[],
      heights:Array.from({length:resolution**2},(_,i)=>200+(i%resolution*500/(resolution-1)-250)*0.6)};
    const before=structuredClone(baseMap.world);
    const road={id:'steep-road',name:'Steep',points:[[-100,0],[100,0]],width:4,curve:'polyline',closed:false,tags:[]};
    const code=`function plan(api){api.editWorld(state=>{state.bundle.plan.roads=[${JSON.stringify(road)}];});}`;
    expect(()=>executeMapCodePlan(code,baseMap,[],{spatialPolicy:'diagnose'})).toThrow('world_road_slope');
    const result=await executeMapDesignProgram({baseMap,assets:[],maxNewAssets:0,code});
    const draft=applyMapOperations(baseMap,result.operations);
    expect(draft.world!.bundle.plan.generationPolicy).toBe('diagnostic');
    expect(draft.world!.bundle.plan.roads).toEqual([road]);
    expect(draft.world!.bundle.plan.recipe).toEqual(before!.bundle.plan.recipe);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:'world_road_slope',severity:'warning',repaired:false})]));
    expect(result.diagnostics!.find(item=>item.code==='world_road_slope')!.message).toContain('steep-road');
    expect(baseMap.world).toEqual(before);
    expect(mocks.llmChat).not.toHaveBeenCalled();
  });
  it('provides an API reference without overriding the outer action response format', () => {
    for(const map of [createEmptyMap(),worldMap(),createEmptyMap('room','room',[12,4,12],'voxel','indoor')]) {
      const prompt=buildMapDesignExecutionPrompt(map,[],2);
      expect(prompt).toContain('outer response format');
      expect(prompt).not.toContain('Return the function only');
      expect(prompt).not.toContain('Do not return Markdown, explanations, JSON');
      expect(prompt).not.toContain('Return only one synchronous');
      if(map.world) {
        expect(prompt).toContain('square core');
        expect(prompt).toContain('world_guide_outside');
        expect(prompt).toContain('world_port_not_on_core_boundary');
        expect(prompt).toContain('localBound');
        expect(prompt).toContain('min(100,recipe.size/10)..1000');
        expect(prompt).toContain('min(100,recipe.size/25)..2000');
        expect(prompt).toContain("field ranges apply even for terrainMode:'conform'");
        expect(prompt).toContain('Two square town cores overlap');
        expect(prompt).toContain("persists generationPolicy:'diagnostic'");
        expect(prompt).toContain('BOTH plan.roads and patch.streets require width:2..64');
      }
    }
  });
});
