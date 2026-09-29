import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { validateWorldBundle, createPlannedWorldSampler, createWorldExclusion, createWorldEcologyDensity } from '../src/shared/worldPlanning';
import { createWorldSampler } from '../src/shared/worldTerrain';
import { generateEcologyChunk, selectEcologyChunks } from '../src/shared/worldEcology';
const bundle=validateWorldBundle(JSON.parse((await fs.readFile('scripts/fixtures/hierarchical-world.json','utf8')).replace(/^\uFEFF/,'')));
const results=[];
for(const size of [16000,64000,256000]){
  const recipe={...bundle.plan.recipe,size},sample=createWorldSampler(recipe);
  const chunks=selectEcologyChunks(size,0,size*.32,800);
  const times:number[]=[];let instances=0,candidates=0;
  for(const chunk of chunks){const start=performance.now(),data=generateEcologyChunk(recipe,bundle.plan.ecology,chunk,{sample});
    times.push(performance.now()-start);instances+=data.instances.length;candidates+=data.candidateCount;}
  times.sort((a,b)=>a-b);
  results.push({sizeKm:size/1000,chunks:chunks.length,instances,candidates,generationP50Ms:times[Math.floor(times.length*.5)],generationP95Ms:times[Math.floor(times.length*.95)]});
}
const options={sample:createPlannedWorldSampler(bundle.plan,bundle.patches),exclusion:createWorldExclusion(bundle.plan,bundle.patches),density:createWorldEcologyDensity(bundle.plan,bundle.patches)};
const densities=[.25,.5,1,2].map(factor=>{
  const rules=bundle.plan.ecology.map(r=>({...r,density:Math.min(1,r.density*factor)}));
  return {factor,instances:generateEcologyChunk(bundle.plan.recipe,rules,{x:-5,z:56},options).instances};
});
let stable=true;
for(let i=1;i<densities.length;i++){const higher=new Map(densities[i].instances.map(p=>[p.id,p]));for(const p of densities[i-1].instances) if(JSON.stringify(higher.get(p.id))!==JSON.stringify(p))stable=false;}
const report={note:'Node CPU timing, not browser/GPU performance. Identical view range; no global plant list.',worlds:results,
  density:densities.map(d=>({factor:d.factor,instances:d.instances.length})),stableSubset:stable,
  townBuildings:bundle.patches.map(p=>({town:p.townId,buildings:p.buildings.length,streets:p.streets.length})),
  budgets:{activeChunks:25,cachedChunks:49,maxTowns:12,maxBuildingsPerTown:128}};
await fs.mkdir('output/terrain-biome-lab',{recursive:true});
await fs.writeFile('output/terrain-biome-lab/planning-benchmark.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));

