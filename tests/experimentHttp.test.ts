import http from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect,it,vi } from 'vitest';
import { MapStore } from '../src/server/mapStore';
import { handleMapHttp } from '../src/server/mapHttp';
import { experiments } from '../src/server/experiments';
import type { Experiment } from '../src/shared/experiments';
import { MODEL_API_BASE } from '../src/shared/protocol';

it('runs a paired experiment through HTTP with one planning call, two asset providers, automatic filing and frozen assets',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'worldforge-experiment-http-'));
 const store=new MapStore({rootDir:root});
 const requests:Array<{url:string;body:Record<string,unknown>}>=[];
 const original=globalThis.fetch;
 const code="function plan(api){api.terrain({preset:'plain',amplitude:0});const key=api.requireAsset({key:'house',name:'房屋',prompt:'A house',dimensions:[4,5,4],role:'structure'});api.place({assetId:api.asset(key),position:[0,0],dimensions:[4,5,4]});}";
 const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=String(input);
  if(url.startsWith('http://127.0.0.1:'))return original(input,init);
  if(!url.startsWith(MODEL_API_BASE))throw new Error('Unexpected external request');
  const body=JSON.parse(String(init?.body));requests.push({url,body});
  if(url.endsWith('/api/chat'))return new Response(JSON.stringify({ok:true,content:code}),{headers:{'content-type':'application/json'}});
  if(url.endsWith('/api/generate/model'))return new Response('data: '+JSON.stringify({done:true,modelJson:{nodes:[{id:'body',mesh:{type:'box',params:{width:4,height:5,depth:4},color:0x88aa99}}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
  throw new Error('Unexpected route');
 });
 const server=http.createServer((req,res)=>void handleMapHttp(req,res,store));
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port+'/api/editor/';
  const call=async(route:string,body?:unknown,method='POST')=>{
   const response=await fetch(base+route,{method:body===undefined?'GET':method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
   const data=await response.json();expect(response.ok,JSON.stringify(data)).toBe(true);return data;
  };
  const {folder}=await call('map-folders',{name:'资产对照'});
  const {map:old}=await call('maps',{name:'旧地图'});
  const before=await store.loadMap(old.id);
  await call('map-folders/move',{mapIds:[old.id],folderId:folder.id});
  expect(await store.loadMap(old.id)).toEqual(before);
  const {map:newMap}=await call('maps',{name:'手工新地图',folderId:folder.id});
  const {map:copy}=await call('maps/'+newMap.id+'/duplicate',{});
  const {experiment}=await call('experiments',{
   name:'HTTP 配对',question:'资产变化是否改变装配',folderId:folder.id,template:'assets',
   cases:[{name:'房屋',prompt:'生成房屋',apiProfile:'editor'}],repeats:1,assetRepeats:1,
   provider:'gpt',assetProviders:['gpt','deepseek'],size:[32,20,32],sceneMode:'outdoor',assetGenerationMode:'voxel',
   minNewAssets:0,maxNewAssets:4,promptMode:'standard',revisionMode:'first-pass',spatialPolicy:'diagnose'
  });
  expect(requests).toHaveLength(0);
  await call('experiments/'+experiment.id+'/control',{action:'start'});
  await experiments(store).idle();
  const job=(await call('experiments/'+experiment.id)).experiment as Experiment;
  expect(job.runs.map(run=>run.status)).toEqual(['completed','completed']);
  expect(requests.filter(req=>req.url.endsWith('/api/chat'))).toHaveLength(1);
  const assetRequests=requests.filter(req=>req.url.endsWith('/api/generate/model'));
  expect(assetRequests.map(req=>req.body.provider)).toEqual(['gpt','deepseek']);
  expect(assetRequests[0].body.description).toEqual(assetRequests[1].body.description);
  const catalog=await call('map-folders');
  for(const id of [old.id,newMap.id,copy.id,...job.runs.map(run=>run.mapId!)])expect(catalog.membership[id]).toBe(folder.id);
  const artifact='experiments/'+job.id+'/runs/'+job.runs[0].id+'/artifacts/';
  const snapshot=await call(artifact+'snapshot');
  expect(snapshot.assets).toHaveLength(1);expect(snapshot.objects).toHaveLength(1);
  const asset=snapshot.assets[0];await store.saveAsset({...asset,modelJson:{nodes:[]}});
  expect((await call(artifact+'snapshot')).assets[0].modelJson).toEqual(asset.modelJson);
  await call('experiments/'+job.id+'/runs/'+job.runs[0].id+'/reviews/agent',{prompt:'good',layout:'unknown',assets:'unknown',assembly:'unknown',tags:[],note:'结构检查',evidence:'读取保存的对象和资产数据'},'PUT');
  expect((await call('experiments/'+job.id)).experiment.runs[0].humanReview).toBeUndefined();
 }finally{
  await experiments(store).idle();server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));fetchMock.mockRestore();
  await rm(root,{recursive:true,force:true});
 }
});
