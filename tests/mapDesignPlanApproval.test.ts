import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {afterEach, expect, it, vi} from 'vitest';
import {MapStore} from '../src/server/mapStore';
import {MapDesignSessionManager} from '../src/server/mapDesignSessions';
import {BUILTIN_RENDER_SCHEMES} from '../src/shared/renderScheme';
import {calculateModelVisualBounds} from '../src/shared/modelBounds';
import {handleMapHttp} from '../src/server/mapHttp';
import {mapDesignManager} from '../src/server/mapDesignHttp';

const roots: string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

async function setup(){
  const rootDir=await mkdtemp(path.join(os.tmpdir(),'worldforge-plan-approval-'));
  roots.push(rootDir);
  const store=new MapStore({rootDir});
  const map=await store.createMap({name:'Blank',size:[48,12,48],assetGenerationMode:'voxel'});
  return {store,map};
}
const appearance={version:1,intent:'Warm timber and muted green metal',materials:[
  {role:'bench timber',color:'#B88752',notes:'Bench slats'},
  {role:'bench metal',color:'#46524B',notes:'Bench supports'}
],renderPlan:{version:1,baseSchemeId:BUILTIN_RENDER_SCHEMES[0].id,modules:[]}};
const code=`function plan(api){
  api.appearance(${JSON.stringify(appearance)});
  const bench=api.requireAsset({key:'bench',name:'Park bench',prompt:'Voxel park bench. Timber slats #B88752; metal supports #46524B.',dimensions:[2,1,1],role:'functional'});
  api.place({name:'Bench',assetId:api.asset(bench),position:[8,0,4],dimensions:[2,1,1],rotationY:0.4,terrain:false});
}`;

it('returns current failed source in bounded chunks and explains ambiguous edit anchors without altering the draft',async()=>{
  const {store,map}=await setup();
  const actions=[{action:'execute',code:'root=0;root=0'},
    {action:'execute',edits:[{old:'root=0',new:'root=1'}]},
    {action:'observe',query:{kind:'source',limit:6}},
    {action:'observe',query:{kind:'source',source:'complete'}},
    {action:'finish',outcome:'blocked',summary:'Source retained for repair'}];
  const execute=vi.fn().mockRejectedValue(new Error('runtime_contract_failure'));
  const manager=new MapDesignSessionManager(store,{chat:async()=>JSON.stringify(actions.shift()),execute});
  const session=await manager.create(map.id,{prompt:'Repair source',expectedVersion:map.version,requirePlanApproval:false});
  await manager.settled(session.id);
  const result=await manager.get(session.id);
  expect(execute).toHaveBeenCalledTimes(1);
  const tools=result.messages.filter(item=>item.role==='tool').map(item=>JSON.parse(item.content));
  expect(tools.find(item=>item.result.error?.includes('design_edit_anchor_not_unique')).result.error).toContain('matched=2');
  const observations=tools.filter(item=>item.action==='observe');
  expect(observations[0].result).toMatchObject({source:'working',code:'root=0',totalCharacters:13,truncated:true,matchesCompleteDraft:false,next:{offset:6,limit:6}});
  expect(observations[1].result).toMatchObject({source:'complete',code:'',totalCharacters:0,truncated:false});
  expect((await manager.draft(session.id)).map.name).toBe('Blank');
});

it('shows a complete whitebox and color prompts with zero asset requests, then binds the approved program without another GPT turn',async()=>{
  const {store,map}=await setup();
  const chat=vi.fn().mockResolvedValueOnce(JSON.stringify({action:'execute',code,summary:'Bench layout'}))
    .mockResolvedValueOnce(JSON.stringify({action:'finish',summary:'Plan ready'}));
  const createAsset=vi.fn(async request=>store.saveAsset({name:request.name,prompt:request.prompt,tags:[],mode:'voxel',provider:'deepseek',modelJson:{nodes:[
    {id:'seat',mesh:{type:'box',params:{width:4,height:2,depth:2},material:{color:'#B88752'}}}
  ]}}));
  const manager=new MapDesignSessionManager(store,{chat,createAsset});
  const session=await manager.create(map.id,{prompt:'A park bench',expectedVersion:map.version,backendPlanning:true,minNewAssets:1,maxNewAssets:1,maxGenerationCalls:2});
  await manager.settled(session.id);
  expect(await manager.get(session.id)).toMatchObject({stage:'awaiting-plan-approval',status:'paused',assetCalls:0,generationCounts:{planning:1,assets:0}});
  expect(createAsset).not.toHaveBeenCalled();
  const initialPrompt=chat.mock.calls[0][0][0].content;
  expect(initialPrompt).toContain('api.requireAsset IS ALLOWED and REQUIRED');
  expect(initialPrompt).toContain('Zero successfully generated assets is EXPECTED in planning');
  expect(initialPrompt).not.toContain('SUCCESSFULLY GENERATED asset IDs');
  const executeFeedback=(await manager.get(session.id)).messages.filter(item=>item.role==='tool')
    .map(item=>JSON.parse(item.content)).find(item=>item.action==='execute');
  expect(executeFeedback.result.assetWorkflow).toMatchObject({phase:'whitebox-discovery',assetDeclarationsAllowed:true,assetGenerationAllowed:false,declaredVariants:1});
  expect(executeFeedback.result.plannedScale).toMatchObject({units:'metres',mapHorizontalSize:[48,48],assets:[{name:'Park bench',dimensions:[2,1,1],variants:1}]});
  expect(executeFeedback.result.spatialCoverage).toMatchObject({height:{min:0,max:0},spacing:[3,3]});
  const draft=await manager.draft(session.id);
  expect(draft.planPreview!.placements[0]).toMatchObject({position:[8,0,4],size:[2,1,1],rotationY:0.4,pending:true,fitToDimensions:true});
  expect(draft.suggestion!.codePlan!.assetRequirements![0]).toMatchObject({prompt:expect.stringContaining('#B88752'),dimensions:[2,1,1]});
  expect(draft.session.appearancePlan).toMatchObject(appearance);
  await expect(manager.resume(session.id)).rejects.toThrow('design_plan_approval_required');
  await expect(manager.commit(session.id,1,true)).rejects.toThrow('design_plan_approval_required');
  await expect(manager.approvePlan(session.id,0,true)).rejects.toThrow('design_draft_stale');
  await expect(manager.approvePlan(session.id,1,false)).rejects.toThrow('design_approval_required');
  expect(createAsset).not.toHaveBeenCalled();
  await manager.approvePlan(session.id,1,true);
  await manager.settled(session.id);
  expect(chat).toHaveBeenCalledTimes(2);
  expect(createAsset).toHaveBeenCalledTimes(1);
  expect(createAsset.mock.calls[0][0]).toMatchObject({prompt:expect.stringContaining('metal supports #46524B'),appearancePlan:appearance});
  const result=await manager.draft(session.id);
  expect(result.session).toMatchObject({stage:'completed',status:'idle',outcome:'completed',generationCounts:{planning:1,assets:1}});
  expect(result.map.objects[0]).toMatchObject({transform:{position:[8,0,4],rotation:[0,0.4,0]}});
  const bounds=calculateModelVisualBounds(result.map.assets![0].modelJson);
  expect(bounds.max.map((value,axis)=>(value-bounds.min[axis])*result.map.objects[0].transform.size[axis]*result.map.objects[0].transform.scale[axis])).toEqual([2,1,1]);
  expect(result.suggestion!.codePlan!.code).toBe(code);
  expect(result.planPreview).toBeUndefined();
  const committed=await manager.commit(session.id,result.session.draftRevision,true);
  expect(committed.map.objects[0].assetId).toBe(result.map.objects[0].assetId);
});

it('recovers the approval gate after restart and treats a normal message as planning feedback, never asset approval',async()=>{
  const {store,map}=await setup();
  const first=new MapDesignSessionManager(store,{createAsset:vi.fn().mockRejectedValue(new Error('unexpected_asset_before_approval')),chat:vi.fn().mockResolvedValueOnce(JSON.stringify({action:'execute',code})).mockResolvedValueOnce(JSON.stringify({action:'finish'}))});
  const session=await first.create(map.id,{prompt:'Bench',expectedVersion:map.version,minNewAssets:1,maxNewAssets:1});
  await first.settled(session.id);
  const createAsset=vi.fn();
  const chat=vi.fn().mockResolvedValueOnce(JSON.stringify({action:'execute',edits:[{old:'position:[8,0,4]',new:'position:[10,0,4]'}]})).mockResolvedValueOnce(JSON.stringify({action:'finish'}));
  const recovered=new MapDesignSessionManager(store,{chat,createAsset});
  expect(await recovered.get(session.id)).toMatchObject({stage:'awaiting-plan-approval'});
  await expect(recovered.resume(session.id)).rejects.toThrow('design_plan_approval_required');
  await recovered.message(session.id,'Move the bench east');
  await recovered.settled(session.id);
  expect(await recovered.get(session.id)).toMatchObject({stage:'awaiting-plan-approval',assetCalls:0});
  expect(createAsset).not.toHaveBeenCalled();
  expect((await recovered.draft(session.id)).planPreview!.placements[0].position).toEqual([10,0,4]);
  expect(JSON.stringify(chat.mock.calls[0][0])).toContain('Bench');
});

it('enforces approval over HTTP and sends the confirmed colors to DeepSeek through the real backend adapter',async()=>{
  const {store,map}=await setup();
  const server=http.createServer((req,res)=>{void handleMapHttp(req,res,store);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/editor`;
  const nativeFetch=globalThis.fetch;
  const calls:Array<{url:string;body:Record<string,unknown>}>=[];
  const actions=[{action:'execute',code,summary:'Bench plan'},{action:'finish',summary:'Check the whitebox'}];
  const remote=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const url=String(input);
    if(url.startsWith(base))return nativeFetch(input,init);
    const body=JSON.parse(String(init!.body));calls.push({url,body});
    if(url.endsWith('/api/chat'))return new Response(JSON.stringify({ok:true,content:JSON.stringify(actions.shift())}),{headers:{'Content-Type':'application/json'}});
    if(url.endsWith('/api/generate/model'))return new Response('data: '+JSON.stringify({stage:'result',done:true,modelJson:{nodes:[{id:'seat',mesh:{type:'box',params:{width:2,height:1,depth:1},material:{color:'#B88752'}}}]}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
    throw new Error('unexpected_test_transport:'+url);
  });
  const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let id='';
  try {
    const created=await post(`/maps/${map.id}/design-sessions`,{prompt:'Bench',expectedVersion:map.version,backendPlanning:true,provider:'gpt',assetProvider:'deepseek',minNewAssets:1,maxNewAssets:1});
    expect(created.status).toBe(201);id=(await created.json()).session.id;
    await mapDesignManager(store).settled(id);
    expect(calls).toHaveLength(2);
    expect(calls.every(call=>call.url.endsWith('/api/chat')&&call.body.provider==='gpt')).toBe(true);
    expect((await post(`/design-sessions/${id}/resume`,{})).status).toBe(400);
    expect((await post(`/design-sessions/${id}/approve-plan`,{expectedRevision:0,approved:true})).status).toBe(409);
    expect(calls).toHaveLength(2);
    const approved=await post(`/design-sessions/${id}/approve-plan`,{expectedRevision:1,approved:true});
    expect(approved.status).toBe(200);
    await mapDesignManager(store).settled(id);
    expect(calls).toHaveLength(3);
    expect(calls[2].body).toMatchObject({provider:'deepseek',mode:'voxel',description:expect.stringContaining('Timber slats #B88752; metal supports #46524B')});
    expect(JSON.stringify(calls[2].body)).toContain('Warm timber and muted green metal');
    expect(await mapDesignManager(store).get(id)).toMatchObject({stage:'completed',outcome:'completed',modelCalls:2});
  } finally {
    if(id){await mapDesignManager(store).pause(id).catch(()=>undefined);await mapDesignManager(store).settled(id);}
    remote.mockRestore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
