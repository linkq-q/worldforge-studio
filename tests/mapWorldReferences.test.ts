import {describe, expect, it} from 'vitest';
import {createEmptyMap, normalizeMap, type EditableMap} from '../src/shared/map';
import {applyMapOperations} from '../src/shared/mapOperations';
import {executeMapDesignProgram} from '../src/server/mapDesignExecution';
import {observeMapDesign} from '../src/shared/mapDesignObservation';
import {validateWorldMapState, worldMapSampler, worldMapTerrainContext} from '../src/shared/worldMapState';
import {worldPlanKey, createTownTasks} from '../src/shared/worldPlanning';
import type {MapDesignToolObservation} from '../src/shared/mapDesignFeedback';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MapStore} from '../src/server/mapStore';
import {MapDesignSessionManager} from '../src/server/mapDesignSessions';
import type {ChatMessage} from '../src/server/modelApi';
import {MapDesignFeedbackCollector, readMapDesignFeedback} from '../src/server/mapDesignFeedback';

const recipe = `{version:1,seed:47,size:500,heightScale:0.1,constraints:[{region:'center',biome:'grassland'}]}`;
const declare = `const world=api.worldRef('world','山海世界');
  const water=api.worldRef('water',{key:'港湾水域',name:'蓝湾'});
  const road=api.worldRef('road','码头大道');const town=api.worldRef('town','滨海小镇');
  const brush=api.worldRef('terrain-brush','山脊');const biome=api.worldRef('biome-patch','秋林');
  const ecology=api.worldRef('ecology','松林');const region=api.worldRef('region','港口区');
  const path=api.worldRef('path','漫步道');const anchor=api.worldRef('anchor','灯塔');
  const settlement=api.worldRef('settlement','居民聚落');const route=api.worldRef('mobility-route','游览线');
  const poi=api.worldRef('poi','灯塔景点');const empty=api.worldRef('intentional-empty','海风草甸');`;
const create = `api.createWorld({id:world,recipe:{...${recipe},
    terrainBrushes:[{id:brush,mode:'raise',region:{kind:'circle',center:[150,-150],radius:30},amount:20}],
    biomePatches:[{id:biome,region:{kind:'circle',center:[-150,-150],radius:40},biome:'forest'}],
    waterBodies:[{id:water,type:'lake',region:{kind:'circle',center:[-100,100],radius:30},levels:[20],depth:4}]},
    ecology:[{id:ecology,kind:'pine',biome:'forest',density:0.2,spacing:20,maxSlope:40,scale:[1,2]}],
    roads:[{id:road,name:'码头大道',points:[[-100,-80],[100,-80]],width:6,closed:false,curve:'polyline',tags:[]}],
    towns:[{id:town,name:'滨海小镇',prompt:'滨海居民区',center:[0,0],radius:50,blend:20,foundation:20,
      terrainMode:'conform',ports:[],targetWaterBodyId:water}],
    featureGraph:{regions:[{id:region,kind:'港口',name:'港口区',center:[0,0],radius:120}],
      paths:[{id:path,kind:'步道',name:'漫步道',points:[[-30,0],[30,0]],width:3}],
      anchors:[{id:anchor,kind:'地标',position:[20,0],regionId:region}],
      relations:[{fromId:anchor,toId:water,kind:'面向水域'}]},
    settlementPlan:{settlements:[{id:settlement,anchorId:anchor,role:'居民聚落'}]},
    mobilityPlan:{routes:[{id:route,pathId:path,mode:'游览',connects:[anchor]}]},
    explorationPlan:{pointsOfInterest:[{id:poi,anchorId:anchor,purpose:'观景'}],sequence:[poi]},
    intentionalEmptyAreas:[{id:empty,regionId:region,purpose:'保留开阔草甸'}]});`;

async function run(code: string, baseMap: EditableMap = createEmptyMap('reference-map')) {
  const observations: MapDesignToolObservation[] = [];
  const suggestion = await executeMapDesignProgram({baseMap,assets:[],maxNewAssets:0,code,
    onToolObservation:item=>observations.push(item)});
  return {map:applyMapOperations(baseMap,suggestion.operations),suggestion,observations};
}

describe('continuous-world semantic references', () => {
  it('compiles Chinese declarations into exact shared IDs, persists names and reports the same references', async () => {
    const {map,observations}=await run(`function plan(api){${declare}${create}
      api.report('references',api.worldEntities());}`);
    const plan=map.world!.bundle.plan;
    expect(plan.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
    expect(plan.recipe.waterBodies![0]).toMatchObject({name:'蓝湾'});
    expect(worldMapTerrainContext(map.world!).waterBodies[0].mapWater.name).toBe('蓝湾');
    expect(plan.towns[0].targetWaterBodyId).toBe(plan.recipe.waterBodies![0].id);
    expect(plan.featureGraph!.relations[0].toId).toBe(plan.recipe.waterBodies![0].id);
    expect(plan.featureGraph!.anchors[0].regionId).toBe(plan.featureGraph!.regions[0].id);
    expect(plan.explorationPlan!.sequence).toEqual([plan.explorationPlan!.pointsOfInterest[0].id]);
    const rows=observations.find(item=>item.tool==='worldEntities')!.result as {items:Array<{kind:string;key:string;name:string;ref:string;id:string}>};
    expect(rows.items).toHaveLength(14);
    expect(rows.items.find(item=>item.kind==='water')).toMatchObject({key:'港湾水域',name:'蓝湾',ref:plan.recipe.waterBodies![0].id});
    expect(rows.items.every(item=>item.ref===item.id)).toBe(true);
    expect(observations.filter(item=>item.tool==='worldRef')).toHaveLength(14);
    const reloaded=normalizeMap(JSON.parse(JSON.stringify(map)));
    expect(reloaded.world!.references).toEqual(map.world!.references);
    const page=observeMapDesign(reloaded,{kind:'world',section:'references',offset:0,limit:2},1) as unknown as {data:{items:unknown[];total:number;nextOffset:number}};
    expect(page.data).toMatchObject({total:14,nextOffset:2});
    expect(page.data.items).toHaveLength(2);
  });

  it('keeps identity, geometry and derived seeds through replay, inserted declarations and display renaming', async () => {
    const base=createEmptyMap('stable-map');
    const first=await run(`function plan(api){${declare}${create}}`,base);
    const replay=await run(`function plan(api){api.worldRef('water','尚未使用的声明');${declare}${create}}`,base);
    expect(replay.map.world).toEqual(first.map.world);
    const water=first.map.world!.bundle.plan.recipe.waterBodies![0];
    const renamed=await run(`function plan(api){const water=api.worldRef('water',{key:'港湾水域',name:'春潮湾'});
      api.editWorld(state=>{state.bundle.plan.recipe.waterBodies.find(item=>item.id===water).name='春潮湾';});
      api.report('water',api.worldEntities('water'));}`,normalizeMap(JSON.parse(JSON.stringify(first.map))));
    expect(renamed.map.world!.bundle.plan.recipe.waterBodies![0]).toEqual({...water,name:'春潮湾'});
    expect(renamed.map.world!.references!.find(item=>item.kind==='water')).toMatchObject({key:'港湾水域',id:water.id,name:'春潮湾'});
    const before=worldMapSampler(first.map.world!),after=worldMapSampler(renamed.map.world!);
    for (const point of [[-100,100],[-80,80],[0,0],[150,-150]] as Array<[number,number]>) {
      expect(after(...point)).toEqual(before(...point));
    }
    expect(renamed.map.world!.bundle.plan.ecology).toEqual(first.map.world!.bundle.plan.ecology);
    expect(createTownTasks(renamed.map.world!.bundle.plan).map(task=>task.seed))
      .toEqual(createTownTasks(first.map.world!.bundle.plan).map(task=>task.seed));
  });

  it('adopts an explicitly observed old ID without changing old terrain, seeds or IDs', async () => {
    const base=createEmptyMap('legacy-map','旧地图',[500,4096,500]);
    base.world=validateWorldMapState({bundle:{plan:{version:1,id:'legacy-world',revision:1,prompt:'旧世界',
      recipe:{version:1,seed:47,size:500,constraints:[{region:'center',biome:'grassland'}],
        waterBodies:[{id:'old-river',type:'river',region:{kind:'path',points:[[-50,100],[50,100]],width:10},levels:[40,35],depth:3}]},
      towns:[],roads:[],ecology:[]},patches:[]},assets:[]});
    const original=structuredClone(base);
    const {map,observations}=await run(`function plan(api){const old=api.worldEntities('water').items[0];
      const ref=api.worldRef('water',{key:'山溪',id:old.ref,name:'山溪'});
      api.editWorld(state=>{state.bundle.plan.recipe.waterBodies[0].name='山溪';});
      api.report('exact',ref);}`,base);
    expect(map.world!.bundle.plan.id).toBe('legacy-world');
    expect(map.world!.bundle.plan.recipe.waterBodies![0]).toEqual({...base.world.bundle.plan.recipe.waterBodies![0],name:'山溪'});
    expect(observations.find(item=>item.tool==='report')?.result).toBe('old-river');
    expect(base).toEqual(original);
  });

  it('keeps the saved-map scope and plan identity when only the world display label changes', async () => {
    const {map}=await run(`function plan(api){${declare}${create}}`);
    const oldPlan=map.world!.bundle.plan, key=worldPlanKey(oldPlan);
    const renamed=await run(`function plan(api){api.worldRef('world',{key:'山海世界',name:'秋日山海'});
      api.editWorld(()=>{});api.report('world',api.worldEntities('world'));}`,map);
    expect(renamed.map.world!.bundle.plan.id).toBe(oldPlan.id);
    expect(worldPlanKey({...renamed.map.world!.bundle.plan,revision:oldPlan.revision})).toBe(key);
    expect(renamed.map.world!.references!.find(item=>item.kind==='world')).toMatchObject({id:oldPlan.id,key:'山海世界',name:'秋日山海'});
    const fresh=await run(`function plan(api){api.worldRef('world',{key:'山海世界',name:'别的显示名'});
      const id=api.worldRef('water','新泉');api.editWorld(state=>{state.bundle.plan.recipe.waterBodies.push({id,type:'lake',
      region:{kind:'circle',center:[100,100],radius:12},levels:[20],depth:2});});}`,map);
    const other=await run(`function plan(api){const id=api.worldRef('water','新泉');api.editWorld(state=>{state.bundle.plan.recipe.waterBodies.push({id,type:'lake',
      region:{kind:'circle',center:[100,100],radius:12},levels:[20],depth:2});});}`,renamed.map);
    expect(fresh.map.world!.references!.find(item=>item.key==='新泉')?.id).toBe(other.map.world!.references!.find(item=>item.key==='新泉')?.id);
    const direct=await run(`function plan(api){api.editWorld(state=>{state.references.find(item=>item.kind==='world').name='秋游地图';});}`,map);
    expect(direct.map.world!.references!.find(item=>item.kind==='world')).toMatchObject({id:oldPlan.id,key:'山海世界',name:'秋游地图'});
  });

  it('rejects ambiguous names, conflicting identity bindings and unknown relationship references', async () => {
    const {map}=await run(`function plan(api){${declare}${create}}`);
    await expect(run(`function plan(api){api.worldRef('water',{key:'港湾水域',id:'other-water'});api.noChange('lookup');}`,map))
      .rejects.toThrow('world_reference_identity_conflict');
    await expect(run(`function plan(api){const a=api.worldRef('water','甲');api.worldRef('water',{key:'乙',id:a});api.noChange('lookup');}`))
      .rejects.toThrow('world_reference_identity_conflict');
    await expect(run(`function plan(api){api.editWorld(state=>{const w=state.bundle.plan.recipe.waterBodies[0];
      state.bundle.plan.recipe.waterBodies.push({...w,id:'other-water'});});api.worldRef('water',{name:'蓝湾'});}`,map))
      .rejects.toThrow('world_reference_ambiguous_name');
    await expect(run(`function plan(api){api.editWorld(state=>{state.bundle.plan.towns[0].targetWaterBodyId='港湾水域';});}`,map))
      .rejects.toThrow('world_invalid_town_water_target');
  });

  it('preserves a literal-ID display name and rejects rebinding a saved key even when its old entity disappears', async () => {
    const {map}=await run(`function plan(api){${declare}${create}}`);
    const id=map.world!.bundle.plan.id;
    const renamed=await run(`function plan(api){api.editWorld(state=>{state.references.find(item=>item.kind==='world').name=${JSON.stringify(id)};});}`,map);
    expect(renamed.map.world!.references!.find(item=>item.kind==='world')?.name).toBe(id);
    await expect(run(`function plan(api){api.editWorld(state=>{state.bundle.plan.id='different-world';
      state.references.find(item=>item.kind==='world').id='different-world';});}`,map))
      .rejects.toThrow('world_reference_identity_conflict');
  });

  it('excludes unused declarations and removes metadata for explicitly deleted entities', async () => {
    const {map}=await run(`function plan(api){${declare}${create}}`);
    const result=await run(`function plan(api){api.worldRef('biome-patch','未创建的果园');
      api.editWorld(state=>{state.bundle.plan.recipe.biomePatches=[];});
      api.report('biomes',api.worldEntities('biome-patch'));}`,map);
    expect(result.map.world!.references!.some(item=>item.kind==='biome-patch')).toBe(false);
    expect(result.observations.find(item=>item.tool==='worldEntities')!.result).toMatchObject({total:0,items:[]});
    expect(()=>validateWorldMapState({...map.world,references:[{kind:'water',key:'不存在',id:'missing',name:'不存在'}]}))
      .toThrow('unknown_world_reference_target');
    await expect(run(`function plan(api){api.editWorld(state=>{state.references.push({kind:'water',key:'不存在',id:'missing',name:'不存在'});});}`,map))
      .rejects.toThrow('unknown_world_reference_target');
    await expect(run(`function plan(api){api.editWorld(state=>{state.references.push({kind:'typo',key:'不存在',id:'missing',name:'不存在'});});}`,map))
      .rejects.toThrow('invalid_world_reference');
  });

  it('returns references to the backend conversation and keeps them through whitebox replay before approval', async () => {
    const rootDir=await mkdtemp(path.join(os.tmpdir(),'worldforge-world-refs-'));
    try {
      const store=new MapStore({rootDir}), base=await store.createMap({name:'港湾规划'});
      const code=`function plan(api){${declare}${create}api.worldEntities('water');api.report('bay-ref',water);}`;
      const toolResult=(messages:readonly ChatMessage[])=>messages.flatMap(message=>{
        if (message.role!=='user' || typeof message.content!=='string' || !message.content.startsWith('{')) return [];
        const value=JSON.parse(message.content);return value.type==='tool_result'?[value]:[];
      }).at(-1).result;
      let calls=0, reference='';
      const manager=new MapDesignSessionManager(store,{chat:async messages=>{
        switch (++calls) {
          case 1:return JSON.stringify({action:'execute',code});
          case 2:{
            const feedback=toolResult(messages).feedback;
            reference=feedback.reports.find((item:{observation:{args:string[]}})=>item.observation.args[0]==='bay-ref').observation.result;
            const group=feedback.groups.find((item:{tool:string})=>item.tool==='worldEntities');
            expect(group.first.observation.result.items[0]).toMatchObject({key:'港湾水域',name:'蓝湾',ref:reference});
            expect(feedback.groups.some((item:{tool:string})=>item.tool==='worldRef')).toBe(true);
            return JSON.stringify({action:'execute',code:code.replace('const world=',"api.worldRef('water','新增未使用的声明');const world=")});
          }
          default:{
            const feedback=toolResult(messages).feedback;
            expect(feedback.reports.find((item:{observation:{args:string[]}})=>item.observation.args[0]==='bay-ref').observation.result).toBe(reference);
            return JSON.stringify({action:'finish',summary:'白盒规划等待用户确认'});
          }
        }
      }});
      const session=await manager.create(base.id,{prompt:'规划山海港湾',expectedVersion:base.version,
        requirePlanApproval:true,minNewAssets:0,maxNewAssets:0});
      await manager.settled(session.id);
      const draft=await manager.draft(session.id);
      expect(calls).toBe(3);
      expect(draft.session).toMatchObject({stage:'awaiting-plan-approval',draftRevision:2,assetCalls:0});
      expect(draft.map.world!.references!.find(item=>item.kind==='water')).toMatchObject({id:reference,key:'港湾水域'});
      expect(draft.map.world!.references!.some(item=>item.key==='新增未使用的声明')).toBe(false);
      expect((await store.loadMap(base.id)).world).toBeUndefined();
    } finally {await rm(rootDir,{recursive:true,force:true});}
  });

  it('pages entity references and retains complete large query results behind explicit feedback reads', async () => {
    const names=Array.from({length:40},(_,index)=>`区域${index}${'连续世界中文名称'.repeat(12)}`);
    const {map,observations}=await run(`function plan(api){const regions=${JSON.stringify(names)}.map((key,index)=>({
      id:api.worldRef('region',key),kind:'林地',name:key,center:[index-20,0],radius:10}));
      api.createWorld({recipe:${recipe},featureGraph:{regions,paths:[],anchors:[],relations:[]}});
      api.worldEntities('region',{offset:0,limit:16});api.worldEntities('region',{offset:16,limit:16});
      api.worldEntities('region',{offset:32,limit:16});}`);
    const reads=observations.filter(item=>item.tool==='worldEntities');
    expect(reads.map(item=>(item.result as {items:unknown[]}).items.length)).toEqual([16,16,8]);
    expect(reads.map(item=>(item.result as {nextOffset:number|null}).nextOffset)).toEqual([16,32,null]);
    const page=observeMapDesign(map,{kind:'world',section:'references',offset:17,limit:16},1) as unknown as {data:{items:unknown[];total:number;nextOffset:number}};
    expect(page.data).toMatchObject({total:41,nextOffset:33});
    expect(page.data.items).toHaveLength(16);
    const rootDir=await mkdtemp(path.join(os.tmpdir(),'worldforge-ref-feedback-'));
    try {
      const collector=new MapDesignFeedbackCollector();for (const observation of reads) collector.record(observation);
      const summary=await collector.save(rootDir,{mapId:map.id,baseVersion:0,draftRevision:1,applied:true});
      expect(summary.summaryTruncated).toBe(true);
      expect(summary.groups[0].first).toMatchObject({truncated:true,read:{recordIndex:0}});
      for (let recordIndex=0;recordIndex<reads.length;recordIndex++) {
        let text='',offset:number|null=0;
        do {
          const chunk=await readMapDesignFeedback(rootDir,{ref:summary.ref,recordIndex,characterOffset:offset,characterLimit:4000});
          if (!('text' in chunk)) throw new Error('missing reference feedback chunk');
          text+=chunk.text;offset=chunk.nextCharacterOffset;
        } while (offset!==null);
        expect(JSON.parse(text)).toEqual(reads[recordIndex]);
      }
    } finally {await rm(rootDir,{recursive:true,force:true});}
  });
});
