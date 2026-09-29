import {mkdir,readFile,writeFile} from 'node:fs/promises';

const from=process.argv.find(arg=>arg.startsWith('--from='))?.slice(7);
const prior=from?JSON.parse(await readFile(from,'utf8')):null;
const planOnly=process.argv.includes('--plan-only');
const prompt=prior?.prompt ?? process.argv[2];
if(!prompt)throw Error('Pass the exact test prompt');
const api=process.env.CITY_TEST_API ?? 'http://127.0.0.1:8797/api/editor';
const directory='output/urban-city-study';
await mkdir(directory,{recursive:true});
const request={prompt,provider:'gpt',assetProvider:'deepseek',sceneAgent:true,codePromptMode:'main',
  codeRevisionMode:'first-pass',codeSpatialPolicy:'diagnose',reuseExistingAssets:false,minNewAssets:0,maxNewAssets:16};
if(planOnly)request.planOnly=true;
if(prior){
  if(prior.status!=='planned')throw Error('Only an uncommitted planning result can be continued');
  request.approvedCode=prior.suggestion.codePlan.code;
}
const created=prior?await fetch(`${api}/maps/${prior.mapId}`):await fetch(`${api}/maps`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({name:`提示词测试 · ${prompt}`,size:[128,40,128],sceneMode:'outdoor',assetGenerationMode:'voxel'})});
if(!created.ok)throw Error(await created.text());
const {map}=await created.json();
const file=`${directory}/prompt-${map.id}${prior?'-generated':''}.json`;
const record={mapId:map.id,prompt,request,baseMap:map,planningFile:from,startedAt:new Date().toISOString(),status:'running'};
const save=()=>writeFile(file,JSON.stringify(record,null,2));
await save();
console.log(JSON.stringify({file,mapId:map.id,prompt}));
const response=await fetch(`${api}/maps/${map.id}/generate`,{method:'POST',
  headers:{'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify(request)});
if(!response.ok)throw Error(await response.text());
let buffer='',lastProgress='';
const decoder=new TextDecoder();
try {
  for await(const chunk of response.body){
    buffer+=decoder.decode(chunk,{stream:true});
    const frames=buffer.split(/\r?\n\r?\n/);buffer=frames.pop();
    for(const frame of frames){
      const event=/^event: (.+)$/m.exec(frame)?.[1];
      const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
      if(!data)continue;
      const payload=JSON.parse(data);
      if(event==='progress'){
        const key=`${payload.phase}:${payload.current ?? ''}:${payload.label}`;
        if(key!==lastProgress){console.log(payload.label);lastProgress=key;}
      } else if(event==='plan'){
        record.planPreview=payload;await save();
      } else if(event==='result'){
        record.suggestion=payload.suggestion;await save();
      } else if(event==='error')throw Error(JSON.stringify(payload));
    }
  }
  if(!record.suggestion)throw Error('No generated suggestion returned');
  record.generationTraceId=record.suggestion.generationTraceId;
  record.status=record.suggestion.blocked?'blocked':'preview';
  await save();
  if(record.suggestion.blocked)throw Error('Generation is blocked; original preview preserved');
  if(planOnly){
    record.status='planned';record.completedAt=new Date().toISOString();await save();
    console.log(JSON.stringify({file,mapId:map.id,functions:record.suggestion.codePlan?.functions,placements:record.suggestion.codePlan?.placementCount,requirements:record.suggestion.codePlan?.assetRequirements?.map(r=>({key:r.key,variants:r.variants}))}));
    process.exit(0);
  }
  const commit=await fetch(`${api}/maps/${map.id}/transactions`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({expectedVersion:map.version,label:`原样提示词测试：${prompt}`,source:'agent',operations:record.suggestion.operations,
      ai:{prompt,codePlan:record.suggestion.codePlan,generatedAssets:record.suggestion.generatedAssets}})});
  if(!commit.ok)throw Error(await commit.text());
  const saved=await commit.json();
  record.status='saved';record.objectCount=saved.map.objects.length;record.assetCount=saved.map.assets?.length ?? 0;
  record.transaction=saved.transaction;record.completedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({file,mapId:map.id,objects:record.objectCount,assets:record.assetCount,functions:record.suggestion.codePlan?.functions,diagnostics:record.suggestion.diagnostics}));
}catch(error){record.status='failed';record.error=String(error);await save();throw error;}
