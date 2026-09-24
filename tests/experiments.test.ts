import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MapStore } from '../src/server/mapStore';
import { mapCatalog, writeJsonAtomic } from '../src/server/mapCatalog';
import { ExperimentManager, validateExperimentConfig } from '../src/server/experiments';
import { experimentTrials, type ExperimentConfig, type ExperimentReview } from '../src/shared/experiments';
import type { MapAiSuggestion } from '../src/shared/mapOperations';
import type { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import * as modelApi from '../src/server/modelApi';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const code="function plan(api) { api.terrain({preset:'plain',amplitude:0}); }";
const suggestion=():MapAiSuggestion=>({summary:'测试规划',operations:[{type:'object.add',object:{name:'规划物体',assetId:null}}],renderPromptSuggestions:[],generatedAssets:[],codePlan:{code,placementCount:1,functions:['terrain']}});
const config=(folderId:string):ExperimentConfig=>({
  name:'配对实验',question:'固定规划比较资产',folderId,template:'assets',cases:[{name:'山村',prompt:'生成山村',apiProfile:'editor'}],
  repeats:2,assetRepeats:1,provider:'gpt',assetProviders:['gpt','deepseek'],size:[48,20,48],sceneMode:'outdoor',assetGenerationMode:'voxel',
  minNewAssets:0,maxNewAssets:16,promptMode:'standard',revisionMode:'first-pass',spatialPolicy:'diagnose'
});
async function setup(planner:typeof generateMapCodeSuggestion=vi.fn(async()=>suggestion())){
 const root=await mkdtemp(path.join(os.tmpdir(),'worldforge-experiment-'));roots.push(root);
 const maps=new MapStore({rootDir:root});const folder=await mapCatalog(maps).saveFolder({name:'这批结果'});
 return {root,maps,folder,manager:new ExperimentManager(maps,planner)};
}
async function run(manager:ExperimentManager,id:string){await manager.control(id,'start');await manager.idle();return manager.get(id);}
it('expands paired asset trials with one plan per repeat, and rejects malformed or unbounded configurations',()=>{
 const c=config('folder-x');const trials=experimentTrials(c);
 expect(trials).toHaveLength(4);expect(new Set(trials.map(r=>r.planKey)).size).toBe(2);
 expect(trials[0].planKey).toBe(trials[1].planKey);
 expect(new Set(experimentTrials({...c,template:'repeat'}).map(r=>r.planKey)).size).toBe(4);
 expect(()=>validateExperimentConfig({...c,repeats:50,assetRepeats:20})).toThrow('limit');
 expect(()=>validateExperimentConfig({...c,assetProviders:['invented' as 'gpt']})).toThrow('invalid');
 expect(()=>validateExperimentConfig({...c,cases:[{...c.cases[0],apiProfile:'foundation'}],revisionMode:'repair'})).toThrow('first_pass');
});
it('plans once per pair, auto-files every result, and keeps archive snapshots after maps change',async()=>{
 const planner=vi.fn<typeof generateMapCodeSuggestion>(async()=>suggestion());
 const {manager,maps,folder}=await setup(planner);
 const job=await manager.create(config(folder.id));
 await Promise.all([manager.control(job.id,'start'),manager.control(job.id,'start')]);await manager.idle();
 const completed=await manager.get(job.id);
 expect(completed.runs.map(r=>r.status)).toEqual(['completed','completed','completed','completed']);
 expect(planner.mock.calls.filter(call=>call[3]?.discoveryOnly)).toHaveLength(2);
 expect(planner.mock.calls.filter(call=>!call[3]?.discoveryOnly).every(call=>call[3]?.approvedCode===code)).toBe(true);
 expect(new Set(planner.mock.calls.map(call=>call[1].seed)).size).toBe(1);
 const membership=(await mapCatalog(maps).read()).membership;
 expect(completed.runs.every(r=>membership[r.mapId!]===folder.id)).toBe(true);
 const first=completed.runs[0];const before=await manager.artifact(job.id,first.id,'snapshot');
 await maps.commitTransaction(first.mapId!,{source:'manual',operations:[{type:'object.add',object:{name:'后来修改',assetId:null}}]});
 expect(await manager.artifact(job.id,first.id,'snapshot')).toEqual(before);
});
it('retains a generation result after a save failure and retries saving without another model call',async()=>{
 const planner=vi.fn<typeof generateMapCodeSuggestion>(async()=>suggestion());
 const {manager,maps,folder}=await setup(planner);
 const job=await manager.create({...config(folder.id),repeats:1,assetProviders:['gpt']});
 const commit=vi.spyOn(maps,'commitTransaction').mockRejectedValueOnce(new Error('disk_error'));
 const failed=await run(manager,job.id);
 expect(failed.runs[0].status).toBe('failed');expect(failed.runs[0].stage).toBe('saving');
 const calls=planner.mock.calls.length;
 await manager.control(job.id,'retry',failed.runs[0].id);
 await expect(manager.control(job.id,'retry',failed.runs[0].id)).rejects.toThrow('retry_already_exists');
 const completed=await run(manager,job.id);
 expect(completed.runs.map(r=>r.status)).toEqual(['failed','completed']);
 expect(planner).toHaveBeenCalledTimes(calls);expect(commit).toHaveBeenCalledTimes(2);
 expect((await maps.loadMap(completed.runs[1].mapId!)).objects).toHaveLength(1);
});
it('recovers a crash after commit without applying the transaction twice',async()=>{
 const planner=vi.fn<typeof generateMapCodeSuggestion>(async()=>suggestion());
 const {manager,maps,folder,root}=await setup(planner);
 const job=await manager.create({...config(folder.id),repeats:1,assetProviders:['gpt']});
 const completed=await run(manager,job.id);
 completed.status='running';completed.runs[0].status='running';
 await writeJsonAtomic(path.join(root,'experiments',job.id+'.json'),completed);
 const recovered=new ExperimentManager(maps,planner);
 expect((await recovered.get(job.id)).runs[0].status).toBe('interrupted');
 await recovered.control(job.id,'retry',completed.runs[0].id);
 const calls=planner.mock.calls.length;
 const result=await run(recovered,job.id);
 expect(result.runs[1].status).toBe('completed');expect(planner).toHaveBeenCalledTimes(calls);
 expect((await maps.loadMap(result.runs[1].mapId!)).objects).toHaveLength(1);
});
it('keeps Agent and human reviews independent, validates comparisons and requires Agent evidence',async()=>{
 const {manager,folder}=await setup();const job=await manager.create({...config(folder.id),repeats:1});
 const complete=await run(manager,job.id);
 const review:ExperimentReview={prompt:'good',layout:'fair',assets:'good',assembly:'poor',tags:['连接断裂'],note:'门口不接道路',reviewedAt:0};
 await expect(manager.review(job.id,complete.runs[0].id,'agent',review)).rejects.toThrow('evidence');
 await manager.review(job.id,complete.runs[0].id,'agent',{...review,evidence:'查看了实际地图'});
 const updated=await manager.review(job.id,complete.runs[0].id,'human',{...review,layout:'good',comparedRunId:complete.runs[1].id,preference:'other'});
 expect(updated.runs[0].agentReview?.layout).toBe('fair');expect(updated.runs[0].humanReview?.layout).toBe('good');
 await expect(manager.review(job.id,complete.runs[0].id,'human',{...review,preference:'this'})).rejects.toThrow('invalid_review');
});
it('pauses between runs and cancels the active request while retaining the attempt',async()=>{
 let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>release=resolve);
 const planner=vi.fn<typeof generateMapCodeSuggestion>(async(_p,_m,_a,options)=>{
  if(!options?.discoveryOnly){await gate;options?.signal?.throwIfAborted();}
  return suggestion();
 });
 const {manager,folder}=await setup(planner);const job=await manager.create({...config(folder.id),repeats:1});
 await manager.control(job.id,'start');
 await vi.waitFor(()=>expect(planner.mock.calls.length).toBe(2));
 await manager.control(job.id,'pause');await manager.control(job.id,'cancel',job.runs[0].id);release();await manager.idle();
 const paused=await manager.get(job.id);
 expect(paused.status).toBe('paused');expect(paused.runs.map(r=>r.status)).toEqual(['cancelled','queued']);
});
it('replays saved assets and code without making another asset generation request',async()=>{
 const generate=vi.spyOn(modelApi,'generateModel').mockResolvedValue({meshes:[]});
 const planner=vi.fn<typeof generateMapCodeSuggestion>(async(_p,_m,_a,options)=>{
  const output=suggestion();
  if(!options?.discoveryOnly){
   const asset=await options!.createAsset!({name:'房子',prompt:'房子',mode:'voxel',tags:[]},()=>{});
   output.operations=[{type:'object.add',object:{name:'房子',assetId:asset.id}}];
   output.generatedAssets=[{id:asset.id,name:asset.name}];
  }
  return output;
 });
 const {manager,folder}=await setup(planner);
 const job=await manager.create({...config(folder.id),repeats:1,assetProviders:['gpt'],revisionMode:'repair'});
 const completed=await run(manager,job.id);
 expect(completed.runs[0].status).toBe('completed');
 expect(generate).toHaveBeenCalledTimes(1);
 await manager.control(job.id,'replay',completed.runs[0].id);const replayed=await run(manager,job.id);
 expect(replayed.runs[1].status).toBe('completed');expect(generate).toHaveBeenCalledTimes(1);
 expect(planner.mock.calls.at(-1)?.[3]?.revisionMode).toBe('first-pass');
});

it('retains partial results but distinguishes missing assets from a complete run',async()=>{
 const planner=vi.fn<typeof generateMapCodeSuggestion>(async(_p,_m,_a,options)=>{
  const output=suggestion();
  if(!options?.discoveryOnly)output.diagnostics=[{code:'asset.generation-degraded',severity:'warning',message:'一个资产失败',repaired:false}];
  return output;
 });
 const {manager,folder}=await setup(planner);
 const job=await manager.create({...config(folder.id),repeats:1,assetProviders:['gpt']});
 const partial=await run(manager,job.id);
 expect(partial.runs[0].status).toBe('partial');expect(partial.runs[0].warnings).toEqual(['一个资产失败']);
 expect(await manager.artifact(job.id,partial.runs[0].id,'snapshot')).toBeTruthy();
});
it('does not commit an outcome blocked by the generation pipeline',async()=>{
 const planner=vi.fn<typeof generateMapCodeSuggestion>(async(_p,_m,_a,options)=>({...suggestion(),blocked:!options?.discoveryOnly}));
 const {manager,folder,maps}=await setup(planner);const commit=vi.spyOn(maps,'commitTransaction');
 const job=await manager.create({...config(folder.id),repeats:1,assetProviders:['gpt']});
 const failed=await run(manager,job.id);expect(failed.runs[0].status).toBe('failed');expect(commit).not.toHaveBeenCalled();
});
