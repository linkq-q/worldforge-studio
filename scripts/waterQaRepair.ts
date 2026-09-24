import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MapStore } from '../src/server/mapStore';
import { applyMapOperations, type MapOperation } from '../src/shared/mapOperations';
import { createEmptyMap, sampleTerrainHeight, terrainPointAt } from '../src/shared/map';
import { lintMap } from '../src/shared/mapLint';
import { carveWaterBasinInPlace } from '../src/shared/mapWater';
const store=new MapStore({rootDir:path.resolve('data/water-qa')});
const before=JSON.parse(await readFile('output/water-qa/before.json','utf8'));
if (before.waterBodies.length !== 2 || before.waterBodies.find((w:any)=>w.type==='lake')?.level !== 6.4) {
  throw new Error('This fixture repair expects the supplied hydropower trace (reservoir level 6.4).');
}
const after=await store.importMap({...before,id:'water-qa-after',name:'水电站修复后'});
const lake=after.waterBodies.find(w=>w.type==='lake')!;
const river=after.waterBodies.find(w=>w.type==='river')!;
const spillAsset=after.assets?.find(a=>a.name==='溢洪道白水');
const bankMap=structuredClone(after);
carveWaterBasinInPlace(bankMap,{...lake,shorelineSmoothness:0,shorelineIrregularity:0,bankHeight:0.7,bankWidth:8});
// The concrete dam owns the fourth bank. Retain the existing ground in its footprint and forebay.
for(let z=0;z<bankMap.terrain.resolutionZ;z++)for(let x=0;x<bankMap.terrain.resolutionX;x++){
 const [wx,,wz]=terrainPointAt(bankMap,x,z);
 if(wz>=-3 && Math.abs(wx)<23)bankMap.terrain.heights[z*bankMap.terrain.resolutionX+x]=after.terrain.heights[z*bankMap.terrain.resolutionX+x];
}
const ops:MapOperation[]=[
 {type:'terrain.set',terrain:bankMap.terrain},
 {type:'water.update',waterId:lake.id,patch:{shorelineSmoothness:0,shorelineIrregularity:0}},
 {type:'water.update',waterId:river.id,patch:{points:[[0,7],[0,15],[-3,24],[-7,34],[-9,48]],levels:[0.6,0.6,0.6,0.6,0.6],widths:[14,14,12,9,10],bankHeight:0.5,bankWidth:3}},
 ...after.objects.filter(o=>o.assetId===spillAsset?.id).map(o=>({type:'object.remove',objectId:o.id} as const)),
 ...[-4,0,4].map((x,i)=>({type:'water.add',water:{id:'spillway-'+i,name:'溢洪道 '+(i+1),type:'river',points:[[x,-3],[x,2.8],[x,4],[x,9]],levels:[6.4,6.4,5.8,0.6],widths:[3,3,3,3.8],level:0.6,depth:0.3,carveTerrain:false,shorelineSmoothness:0}} as MapOperation))
];
const shaped=applyMapOperations(after,ops);
for(const o of after.objects){
 const a=after.assets?.find(a=>a.id===o.assetId);
 if(!a?.name.includes('松树'))continue;
 const [x,y,z]=o.transform.position;
 const delta=sampleTerrainHeight(shaped,x,z)-sampleTerrainHeight(after,x,z);
 if(Math.abs(delta)>0.01)ops.push({type:'object.update',objectId:o.id,patch:{transform:{...o.transform,position:[x,y+delta,z]}}});
}
const result=await store.commitTransaction(after.id,{source:'agent',label:'水体围岸与溢洪连接修复',operations:ops});
await writeFile('output/water-qa/after.json',JSON.stringify(result.map));
await writeFile('output/water-qa/repair-operations.json',JSON.stringify(ops,null,2));
console.log(JSON.stringify({mapId:result.map.id,transaction:result.transaction,waterDiagnostics:lintMap(result.map).issues?.filter(i=>i.code.startsWith('water.'))}));
const generic=createEmptyMap('弯河入湖验收','water-qa-river',[48,12,48]);
generic.terrain.heights.fill(2);
const g=await store.importMap(generic);
const r=await store.commitTransaction(g.id,{source:'agent',label:'河湖连接验收',operations:[
{type:'water.add',water:{id:'pond',type:'lake',points:[[-8,2],[8,2],[10,16],[-10,16]],level:0.8,depth:2,shorelineIrregularity:0.1}},
{type:'water.add',water:{id:'stream',type:'river',points:[[-14,-24],[-12,-16],[-3,-10],[1,-4],[0,5]],levels:[1.6,1.4,1.2,0.9,0.8],widths:[3,4,6,4,7],width:4,level:0.8,depth:1.2}}
]});
await writeFile('output/water-qa/river.json',JSON.stringify(r.map));
