import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseWorldDryTerrainDraft} from '../src/server/worldWhiteboxGeneration';
import {validateWorldBundle} from '../src/shared/worldPlanning';
import {compileTerrainProgram} from '../src/server/terrainProgram';

const output = path.resolve('output/playwright/terrain-program-20261003');
const api = 'http://127.0.0.1:8797/api/editor';
const request = JSON.parse(await readFile(path.join(output,'recipe-request.json'),'utf8'));
const raw = await readFile(path.join(output,'recipe-first-call.txt'),'utf8');
const parsed = parseWorldDryTerrainDraft(raw,{mode:'whitebox',prompt:request.prompt,seed:request.seed,size:500});
const baseline = validateWorldBundle({plan:{version:1,id:`terrain-recipe-${request.seed}`,revision:1,prompt:request.prompt,
  recipe:parsed.recipe,ecology:[],towns:[],roads:[]},patches:[]});
await writeFile(path.join(output,'recipe-bundle.json'),JSON.stringify(baseline));
await writeFile(path.join(output,'recipe-load-note.json'),JSON.stringify({
  originalStatus:422,originalError:'invalid_world_landform',
  compatibilityChange:'Allow up to 32 landforms rather than 16; preserve all 17 first-response forms.',
  changedModelCoordinates:false,additionalModelCalls:0,technicalNormalizations:parsed.technicalNormalizations
},null,2));
const program = JSON.parse(await readFile(path.join(output,'program-bundle.json'),'utf8'));
const recompiled = await compileTerrainProgram(program.plan.recipe.terrainProgram.source,{seed:request.seed,size:500});
if (JSON.stringify(recompiled) !== JSON.stringify(program.plan.recipe.terrainProgram)) throw new Error('sandbox_replay_changed_terrain');
async function post(route:string,body:unknown) {
  const response = await fetch(api+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json();
}
for (const [representation,bundle] of [['recipe',baseline],['program',program]] as const) {
  const recordPath = path.join(output,`${representation}-map.json`);
  let record: {mapId:string};
  try {record=JSON.parse(await readFile(recordPath,'utf8'));}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const {map} = await post('/maps',{name:`相连山体与支流峡谷 · ${representation === 'program' ? '程序首轮' : '原配方首轮'}`,size:[96,32,96],assetGenerationMode:'voxel-pro'});
    record={mapId:map.id};
    await writeFile(recordPath,JSON.stringify(record));
  }
  const result = await post(`/maps/${record.mapId}/transactions`,{source:'agent',label:'自然地形自动生成首轮对照',
    operations:[{type:'world.set',world:{bundle,assets:[]}}]});
  const saved = await (await fetch(api+`/maps/${record.mapId}`)).json();
  if (JSON.stringify(saved.map.world.bundle.plan.recipe) !== JSON.stringify(result.map.world.bundle.plan.recipe)) throw new Error('roundtrip_mismatch');
  const transactions = await (await fetch(api+`/maps/${record.mapId}/transactions`)).json();
  const final = {...record,transactionId:result.transaction.id,url:`http://127.0.0.1:5180/?map=${record.mapId}`,transactions};
  await writeFile(recordPath,JSON.stringify(final,null,2));
  console.log(JSON.stringify({representation,mapId:record.mapId,transactionId:result.transaction.id}));
}
