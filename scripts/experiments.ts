import { readFile } from 'node:fs/promises';
const [command='help', ...args] = process.argv.slice(2);
const endpoint = process.env.WORLDFORGE_API ?? 'http://127.0.0.1:8797';
if (!['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname)) throw new Error('Only a local WorldForge API is allowed');
async function request(route:string, body?:unknown, method='POST') {
  const response=await fetch(endpoint+'/api/editor/'+route,{method:body===undefined?'GET':method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw new Error(value.error??'HTTP '+response.status);
  console.log(JSON.stringify(value,null,2));
}
function required(index:number):string{if(!args[index])throw new Error('Missing argument '+(index+1));return args[index];}
try {
  if(command==='help')console.log('folders | folder-create NAME [PARENT_ID] | move FOLDER_ID MAP_ID... (use unfiled to remove membership)\nlist | create CONFIG.json | show EXPERIMENT_ID | start EXPERIMENT_ID | pause EXPERIMENT_ID\nretry|replay|regenerate|cancel EXPERIMENT_ID RUN_ID\nreview EXPERIMENT_ID RUN_ID human|agent REVIEW.json\nartifact EXPERIMENT_ID RUN_ID plan|result|snapshot\nUse WORLDFORGE_API to select the local service. Creating an experiment never starts model calls.');
  else if(command==='folders')await request('map-folders');
  else if(command==='folder-create')await request('map-folders',{name:required(0),parentId:args[1]??null});
  else if(command==='move')await request('map-folders/move',{folderId:required(0)==='unfiled'?null:args[0],mapIds:args.slice(1)});
  else if(command==='list')await request('experiments');
  else if(command==='create')await request('experiments',JSON.parse(await readFile(required(0),'utf8')));
  else if(command==='show')await request('experiments/'+encodeURIComponent(required(0)));
  else if(['start','pause','retry','replay','regenerate','cancel'].includes(command))await request('experiments/'+encodeURIComponent(required(0))+'/control',{action:command,runId:args[1]});
  else if(command==='review')await request('experiments/'+encodeURIComponent(required(0))+'/runs/'+encodeURIComponent(required(1))+'/reviews/'+encodeURIComponent(required(2)),JSON.parse(await readFile(required(3),'utf8')),'PUT');
  else if(command==='artifact')await request('experiments/'+encodeURIComponent(required(0))+'/runs/'+encodeURIComponent(required(1))+'/artifacts/'+encodeURIComponent(required(2)));
  else throw new Error('Unknown command');
} catch(error){console.error(JSON.stringify({error:error instanceof Error?error.message:String(error)}));process.exitCode=1;}
