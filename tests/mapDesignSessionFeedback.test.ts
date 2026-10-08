import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {MapStore} from '../src/server/mapStore';
import {MapDesignSessionManager} from '../src/server/mapDesignSessions';
import type {ChatMessage} from '../src/server/modelApi';
import {normalizeSceneAppearancePlan} from '../src/shared/sceneAppearance';
import {BUILTIN_RENDER_SCHEMES} from '../src/shared/renderScheme';
import {observeMapDesign} from '../src/shared/mapDesignObservation';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, {recursive:true,force:true}); });
async function setup() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-session-facts-'));
  directories.push(rootDir);
  const store = new MapStore({rootDir});
  const map = await store.createMap({name:'Fresh map',size:[48,12,48]});
  return {store,map};
}
function results(messages: readonly ChatMessage[]) {
  return messages.flatMap(message => {
    if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith('{')) return [];
    const value = JSON.parse(message.content);
    return value.type === 'tool_result' ? [value] : [];
  });
}

it('returns real in-program observations to the next model turn and reads failed-execution facts after restart', async () => {
  const {store,map} = await setup();
  let call = 0, goodRef = '', failedRef = '';
  const manager = new MapDesignSessionManager(store, {chat: async messages => {
    const last = results(messages).at(-1);
    switch (++call) {
      case 1: return JSON.stringify({action:'execute',code:`function plan(api){
        const p=api.environmentSample([2,3]);api.report('entrance candidate',{x:p.x,z:p.z,height:p.height});
        api.route({id:'entry',points:[[-8,0],[8,0]],width:2});}`});
      case 2:
        expect(last.result.feedback.recordCount).toBe(2);
        expect(last.result.feedback.metadata).toMatchObject({applied:true,draftRevision:1,baseVersion:map.version});
        expect(last.result.feedback.groups.some((g: {tool:string}) => g.tool === 'environmentSample')).toBe(true);
        goodRef=last.result.feedback.ref;
        return JSON.stringify({action:'observe',query:{kind:'feedback',ref:goodRef}});
      case 3:
        expect(last.result.items[0].observation).toMatchObject({tool:'environmentSample',args:[[2,3]],result:{x:2,z:3}});
        expect(last.result.items[1].observation).toMatchObject({tool:'report',args:['entrance candidate']});
        expect(JSON.stringify(messages)).toContain('Keep the river valley');
        return JSON.stringify({action:'execute',code:`function plan(api){api.report('unfinished local measurement',{x:5,z:6,value:12});throw new Error('unfinished_site');}`});
      default:
        expect(last.result).toMatchObject({error:'unfinished_site',draftRetained:true,draftRevision:1});
        expect(last.result.feedback.metadata).toMatchObject({applied:false,draftRevision:1,error:'unfinished_site'});
        failedRef=last.result.feedback.ref;
        return JSON.stringify({action:'finish',summary:'Keep the valid draft; the later site change failed.'});
    }
  }});
  const session = await manager.create(map.id,{requirePlanApproval:false,prompt:'Keep the river valley and define its entrance',expectedVersion:map.version});
  await manager.settled(session.id);
  expect((await manager.get(session.id)).draftRevision).toBe(1);
  expect((await manager.draft(session.id)).map.guides.some(g => g.id === 'entry')).toBe(true);
  let recoveredCalls=0;
  const recovered = new MapDesignSessionManager(new MapStore({rootDir:store.rootDir}), {chat: async messages => {
    if (++recoveredCalls===1) return JSON.stringify({action:'observe',query:{kind:'feedback',ref:failedRef}});
    const stored = results(messages).at(-1).result;
    expect(stored.metadata.applied).toBe(false);
    expect(stored.items[0].observation.result).toEqual({x:5,z:6,value:12});
    expect(JSON.stringify(messages)).toContain(goodRef);
    return JSON.stringify({action:'finish',outcome:'unchanged',summary:'Read the retained measurements.'});
  }});
  await recovered.message(session.id,'Read the earlier failed measurements');
  await recovered.settled(session.id);
  expect(recoveredCalls).toBe(2);
});

it('continues past twelve steps from one request and never calls an empty draft completed', async () => {
  const {store,map}=await setup();
  let calls=0;
  const manager=new MapDesignSessionManager(store,{chat:async messages => {
    calls++;
    if (calls<=13) return JSON.stringify({action:'observe',query:{kind:'assets'}});
    if (calls===14) return JSON.stringify({action:'finish',summary:'I created a town'});
    expect(results(messages).at(-1).result.error).toContain('design_complete_requires_draft');
    return JSON.stringify({action:'finish',outcome:'blocked',summary:'No town has been created.'});
  }});
  const session=await manager.create(map.id,{requirePlanApproval:false,prompt:'Create a town',expectedVersion:map.version});
  await manager.settled(session.id);
  expect(calls).toBe(15);
  expect(await manager.get(session.id)).toMatchObject({status:'paused',outcome:'blocked',draftRevision:0,stepLimit:48,stepsUsed:15});
});

it('keeps a model-owned appearance across commit and subsequent same-session execution', async () => {
  const {store,map}=await setup();
  const appearance=normalizeSceneAppearancePlan({version:1,intent:'Warm stone and cool leaves',
    materials:[{role:'stone',color:'#bb9966',notes:'wall stone'}],
    renderPlan:{version:1,baseSchemeId:BUILTIN_RENDER_SCHEMES[0].id,modules:[]}});
  const actions=[{action:'execute',code:`function plan(api){api.appearance(${JSON.stringify(appearance)});api.route({id:'entry',points:[[-8,0],[8,0]],width:2});}`},
    {action:'finish'}, {action:'observe',query:{kind:'appearance'}},
    {action:'execute',code:'function plan(api){api.route({id:"second",points:[[-8,5],[8,5]],width:2});}'}, {action:'finish'}];
  const manager=new MapDesignSessionManager(store,{chat:async()=>JSON.stringify(actions.shift())});
  const session=await manager.create(map.id,{requirePlanApproval:false,prompt:'A coordinated town',expectedVersion:map.version});
  await manager.settled(session.id);
  const committed=await manager.commit(session.id,1,true);
  expect(committed.session.appearancePlan).toEqual(appearance);
  await manager.message(session.id,'Continue with a second entrance');
  await manager.settled(session.id);
  const draft=await manager.draft(session.id);
  expect(draft.suggestion?.appearancePlan).toEqual(appearance);
  expect(draft.session.appearancePlan).toEqual(appearance);
  expect(draft.session.messages.some(m => m.role==='tool' && m.content.includes('session-planned-appearance'))).toBe(true);
});

it('retains a procedural recipe through code edits without starting another planner', async () => {
  const {store,map}=await setup();
  const code=`function plan(api){api.createWorld({recipe:{version:1,seed:api.seed,size:500,reliefProfile:'compact',heightScale:0.11,
    constraints:[{region:'center',biome:'grassland'}],landforms:[{center:[30,20],radius:[80,100],height:18}]}});}`;
  let call=0;
  const manager=new MapDesignSessionManager(store,{chat:async messages => {
    switch (++call) {
      case 1:return JSON.stringify({action:'execute',code});
      case 2:
        expect(results(messages).at(-1).result.terrainProgram).toBeUndefined();
        return JSON.stringify({action:'execute',edits:[{old:"biome:'grassland'",new:"biome:'forest'"}]});
      default:return JSON.stringify({action:'finish',summary:'The recipe and its revised classification are retained.'});
    }
  }});
  const session=await manager.create(map.id,{requirePlanApproval:false,prompt:'Create a large world',expectedVersion:map.version});
  await manager.settled(session.id);
  const draft=await manager.draft(session.id);
  expect(call).toBe(3);
  expect(draft.map.world?.bundle.plan.recipe.terrainProgram).toBeUndefined();
  expect(draft.map.world?.bundle.plan.recipe.landforms).toEqual([{center:[30,20],radius:[80,100],height:18}]);
  expect(draft.map.world?.bundle.plan.recipe.constraints[0].biome).toBe('forest');
  expect(draft.session.draftRevision).toBe(2);
},20000);

it('upgrades saved tool instructions without replacing the user and tool conversation', async () => {
  const {store,map}=await setup();
  const original=new MapDesignSessionManager(store,{chat:async()=>JSON.stringify({action:'finish',outcome:'unchanged',summary:'Inspection only'})});
  const session=await original.create(map.id,{requirePlanApproval:false,prompt:'Keep my broad mountain shape',expectedVersion:map.version});
  await original.settled(session.id);
  const file=path.join(store.rootDir,'design-sessions',`${session.id}.json`);
  const saved=JSON.parse(await readFile(file,'utf8'));
  delete saved.capabilityVersion;delete saved.view.stepLimit;delete saved.view.stepsUsed;
  saved.transcript[0].content='OLD TOOL CONTRACT: 12 steps, no new world';
  await writeFile(file,JSON.stringify(saved),'utf8');
  const recovered=new MapDesignSessionManager(store,{chat:async messages=>{
    expect(messages[0].content).toContain('48 model actions');
    expect(messages[0].content).toContain('api.createWorld');
    expect(messages[0].content).toContain('api.worldRef');
    expect(messages[0].content).toContain('api.worldEntities');
    expect(messages[0].content).toContain("kind:'feedback'");
    expect(JSON.stringify(messages)).toContain('Keep my broad mountain shape');
    expect(JSON.stringify(messages)).not.toContain('OLD TOOL CONTRACT');
    return JSON.stringify({action:'finish',outcome:'unchanged',summary:'Read updated tools'});
  }});
  expect((await recovered.get(session.id)).updatedAt).toBe(saved.view.updatedAt);
  await recovered.message(session.id,'Inspect with the updated tools');
  await recovered.settled(session.id);
  const upgraded=JSON.parse(await readFile(file,'utf8'));
  expect(upgraded.instructionHistory[0].content).toContain('OLD TOOL CONTRACT');
  expect(upgraded.capabilityVersion).toBe(12);
});

it('does not report an already adopted complete draft as unapplied when its observation fails', async () => {
  const {store,map}=await setup();
  let calls=0;
  const manager=new MapDesignSessionManager(store,{
    observe:(current,query,revision)=>{
      if (revision===1) throw new Error('observation_unavailable');
      return observeMapDesign(current,query,revision);
    },
    chat:async messages=>{
      if (++calls===1) return JSON.stringify({action:'execute',code:'function plan(api){api.route({id:"entry",points:[[-8,0],[8,0]],width:2});}'});
      expect(results(messages).at(-1).result).toMatchObject({applied:true,draftRetained:false,draftRevision:1,error:'observation_unavailable'});
      expect(results(messages).at(-1).result.feedback.metadata.applied).toBe(true);
      return JSON.stringify({action:'finish',summary:'Geometry is retained; observation unavailable.'});
    }
  });
  const session=await manager.create(map.id,{requirePlanApproval:false,prompt:'Build an entrance',expectedVersion:map.version});
  await manager.settled(session.id);
  expect((await manager.draft(session.id)).map.guides.some(g=>g.id==='entry')).toBe(true);
});

it('requires a fresh complete execution for a new user change request, not an old draft', async () => {
  const {store,map}=await setup();
  let calls=0;
  const manager=new MapDesignSessionManager(store,{chat:async messages=>{
    if (++calls===1) return JSON.stringify({action:'execute',code:'function plan(api){api.route({id:"entry",points:[[-8,0],[8,0]],width:2});}'});
    if (calls<=3) return JSON.stringify({action:'finish',summary:'Ready'});
    expect(results(messages).at(-1).result.error).toContain('design_complete_requires_draft');
    return JSON.stringify({action:'finish',outcome:'unchanged',summary:'The new shop has not been added.'});
  }});
  const session=await manager.create(map.id,{requirePlanApproval:false,prompt:'Build an entrance',expectedVersion:map.version});
  await manager.settled(session.id);
  await manager.message(session.id,'Add a shop');
  await manager.settled(session.id);
  expect(await manager.get(session.id)).toMatchObject({outcome:'unchanged',draftRevision:1});
});

it('caps actual upstream dispatches across concurrent requests and restores the spent budget after restart', async () => {
  const {store,map}=await setup();
  const upstream=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}'));
  const manager=new MapDesignSessionManager(store,{chat:async(_messages,options)=>{
    const attempts=await Promise.allSettled(Array.from({length:4},()=>options!.fetchImpl!('https://model.example/api/chat')));
    expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(2);
    expect(attempts.filter(x=>x.status==='rejected').map(x=>(x as PromiseRejectedResult).reason.message))
      .toEqual(['design_paid_request_budget_exhausted','design_paid_request_budget_exhausted']);
    return JSON.stringify({action:'finish',outcome:'unchanged',summary:'Request budget test'});
  }});
  const session=await manager.create(map.id,{requirePlanApproval:false,prompt:'Read only',expectedVersion:map.version,maxPaidRequests:2});
  await manager.settled(session.id);
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(await manager.get(session.id)).toMatchObject({paidRequests:2,paidRequestLimit:2,paidRequestCounts:{planning:2,assets:0}});
  const recovered=new MapDesignSessionManager(new MapStore({rootDir:store.rootDir}),{chat:async(_messages,options)=>{
    await expect(options!.fetchImpl!('https://model.example/api/generate/model')).rejects.toThrow('design_paid_request_budget_exhausted');
    return JSON.stringify({action:'finish',outcome:'unchanged',summary:'No extra request was dispatched'});
  }});
  await recovered.message(session.id,'Read the persisted budget');
  await recovered.settled(session.id);
  expect(upstream).toHaveBeenCalledTimes(2);
});
