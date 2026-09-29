/** 500 m growth study: authored street skeletons, deterministic roadside plots. */
import fs from 'node:fs/promises';
import { createWorldSampler, WORLD_REGIONS, type WorldRecipe } from '../src/shared/worldTerrain';
import { validateWorldBundle, worldPlanKey, townBuildingBounds, segmentBox, type WorldPlan, type TownPatch, type TownBuilding } from '../src/shared/worldPlanning';
import type { MapGuide } from '../src/shared/mapGuide';

type Point = [number, number];
const recipe: WorldRecipe = {version:1,seed:147,size:500,
  constraints:(Object.keys(WORLD_REGIONS) as (keyof typeof WORLD_REGIONS)[]).map(region=>({region,biome:'grassland'})),
  landforms:[
    {center:[-55,-235],radius:[110,70],height:26},
    {center:[-230,-60],radius:[80,105],height:28},
    {center:[245,20],radius:[80,110],height:6},
    {center:[0,230],radius:[140,65],height:22},
    {center:[0,50],radius:[180,160],height:6}
  ]};
const sample = createWorldSampler(recipe);
const foundation = (center:Point,radius:number) => {
  const heights:number[]=[];
  for(let iz=-2;iz<=2;iz++)for(let ix=-2;ix<=2;ix++)heights.push(sample(center[0]+ix*radius/2,center[1]+iz*radius/2).height);
  return (Math.min(...heights)+Math.max(...heights))/2;
};
const road = (id:string,points:Point[],width=6):MapGuide => ({id,name:id,points,width,curve:'polyline',closed:false,tags:['compact-preview']});
const descriptions = [
  {id:'market',name:'老集市',center:[-70,-65] as Point,radius:80,blend:50,
    prompt:'老街沿商路生长，路口密集，两侧支巷错开，外围留出果树和空院。',
    ports:[['market-craft',[80,-25],6],['market-orchard',[-45,80],5],['market-homes',[80,55],5]] as [string,Point,number][],
    streets:[
      ['old-road',[[80,-25],[53,-21],[26,-8],[6,1],[-22,5],[-50,0],[-77,-9]],6],
      ['garden-road',[[6,1],[2,29],[-17,51],[-45,80]],5],
      ['east-road',[[80,55],[56,46],[30,28],[6,1]],5],
      ['north-lane',[[26,-8],[29,-34],[13,-57],[-8,-71]],3.5],
      ['west-lane',[[-22,5],[-35,-22],[-58,-37],[-74,-34]],3.5],
      ['back-lane',[[-35,-22],[-9,-29],[29,-34]],3]
    ] as [string,Point[],number][], uses:['商住楼','小店','客舍','住宅'], occupancy:.96},
  {id:'workshops',name:'工坊街',center:[105,-135] as Point,radius:55,blend:40,
    prompt:'沿运输路形成一条不规则工坊街，仓房和住居混合，侧面留下作业空地。',
    ports:[['market-craft',[-55,25],6],['craft-homes',[5,55],5.5]] as [string,Point,number][],
    streets:[
      ['haul-road',[[-55,25],[-35,16],[-10,0],[10,-9],[35,-16],[52,-12]],6],
      ['homes-road',[[5,55],[12,28],[10,-9]],5.5],
      ['craft-lane',[[-10,0],[-19,-24],[-38,-44]],4],
      ['yard-lane',[[12,28],[35,35],[49,47]],3.5]
    ] as [string,Point[],number][], uses:['木工作坊','工匠住居','仓房','铁工作坊'],occupancy:.86},
  {id:'orchard',name:'林园住居',center:[-135,120] as Point,radius:60,blend:40,
    prompt:'疏落住居沿弯路和分叉小径延伸，树林穿入建筑之间，路末只有零星房屋。',
    ports:[['market-orchard',[25,-60],5],['homes-orchard',[60,20],5]] as [string,Point,number][],
    streets:[
      ['garden-road',[[25,-60],[9,-37],[-5,-9],[14,7],[37,16],[60,20]],5],
      ['west-path',[[-5,-9],[-25,4],[-38,28],[-49,51]],3],
      ['south-path',[[14,7],[10,31],[25,53]],3],
      ['north-path',[[9,-37],[-12,-38],[-40,-48]],3]
    ] as [string,Point[],number][],uses:['园艺住居','农具房','住宅','社区屋'],occupancy:.65},
  {id:'homes',name:'新街住居',center:[115,90] as Point,radius:65,blend:45,
    prompt:'住宅从两条汇合道路向外蔓延，主路旁较密，背街与绿地相互穿插。',
    ports:[['market-homes',[-65,-55],5],['craft-homes',[-5,-65],5.5],['homes-orchard',[-65,45],5]] as [string,Point,number][],
    streets:[
      ['main-road',[[-65,-55],[-40,-33],[-10,-17],[18,0],[41,12],[61,38]],5],
      ['craft-road',[[-5,-65],[-10,-40],[-10,-17]],5.5],
      ['garden-road',[[-65,45],[-43,34],[-26,14],[-10,-17]],5],
      ['east-lane',[[18,0],[26,-23],[46,-39],[59,-52]],3.5],
      ['south-lane',[[41,12],[32,37],[19,58]],3.5],
      ['back-lane',[[-26,14],[0,27],[32,37]],3]
    ] as [string,Point[],number][], uses:['住宅','住宅','街角小店','社区屋'],occupancy:.88}
];
const plan:WorldPlan = {version:1,id:'compact-four-towns',revision:3,
  prompt:'500×500米自然生长的聚落群：老集市最密，工坊沿商路延伸，住居沿支巷聚集，林园稀疏；道路弯折、错接，树木与空院穿入聚落。',
  recipe,ecology:[
    {id:'meadow-canopy',kind:'broadleaf',biome:'grassland',density:.85,spacing:11,maxSlope:35,scale:[.55,.95]},
    {id:'meadow-pines',kind:'pine',biome:'grassland',density:.25,spacing:15,maxSlope:40,scale:[.55,.85]},
    {id:'meadow-scrub',kind:'shrub',biome:'grassland',density:.3,spacing:9,maxSlope:40,scale:[.5,1]}
  ],
  towns:descriptions.map(t=>({id:t.id,name:t.name,prompt:t.prompt,center:t.center,radius:t.radius,blend:t.blend,
    foundation:foundation(t.center,t.radius),ports:t.ports.map(([guideId,position,width],i)=>({id:t.id+'-port-'+i,guideId,position,width}))})),
  roads:[
    road('market-craft',[[10,-90],[29,-97],[50,-110]],6),
    road('market-orchard',[[-115,15],[-122,37],[-110,60]],5),
    road('market-homes',[[10,-10],[29,9],[50,35]],5),
    road('craft-homes',[[110,-80],[135,-45],[100,-5],[110,25]],5.5),
    road('homes-orchard',[[50,135],[15,150],[-40,128],[-75,140]],5)
  ]
};
const key = worldPlanKey(plan);
const patches:TownPatch[] = descriptions.map((town,index)=>{
  let state = (recipe.seed + index*977) >>> 0;
  const random = () => {state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const streets = town.streets.map(([id,points,width])=>road(town.id+'-'+id,points,width));
  const localRoads = [...streets,...plan.roads.map(r=>({...r,points:r.points.map(([x,z]):Point=>[x-town.center[0],z-town.center[1]])}))];
  const buildings:TownBuilding[] = [];
  // Lots follow the street direction; variable setbacks and skipped plots preserve yards and gaps.
  for(const street of streets) for(let j=1;j<street.points.length;j++){
    const a=street.points[j-1],b=street.points[j],dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);
    for(let along=2+random()*6;along<length;along+=7+random()*7) for(const side of [-1,1]){
      const width=6+random()*5,depth=6+random()*6;
      const angle=-Math.atan2(dz,dx)+(side===1?Math.PI:0);
      const rotation=Math.atan2(Math.sin(angle),Math.cos(angle));
      const shape=townBuildingBounds({id:'candidate',x:0,z:0,width,depth,height:1,use:'',rotation});
      const clearance=(Math.abs(dz)*shape.width+Math.abs(dx)*shape.depth)/length/2;
      const setback=street.width/2+clearance+1+random()*3;
      const x=a[0]+along*dx/length-side*dz/length*setback;
      const z=a[1]+along*dz/length+side*dx/length*setback;
      const fringe=Math.max(Math.abs(x),Math.abs(z))/town.radius;
      if(random()>town.occupancy*(1-.25*fringe*fringe))continue;
      if(Math.abs(x)+shape.width/2>town.radius-2 || Math.abs(z)+shape.depth/2>town.radius-2)continue;
      if(localRoads.some(r=>r.points.slice(1).some((q,i)=>segmentBox(r.points[i],q,{...shape,x,z},r.width/2+.5))))continue;
      if(buildings.map(townBuildingBounds).some(p=>Math.abs(p.x-x)<(p.width+shape.width)/2+.75 && Math.abs(p.z-z)<(p.depth+shape.depth)/2+.75))continue;
      const n=buildings.length;
      buildings.push({id:town.id+'-building-'+n,x,z,width,depth,rotation,
        height:4+random()*5+(index===0 && fringe<.6?3:0),use:town.uses[n%town.uses.length]});
    }
  }
  return {townId:town.id,worldKey:key,summary:town.prompt,streets,buildings};
});
const bundle = validateWorldBundle({plan,patches});
await fs.writeFile('scripts/fixtures/compact-world.json',JSON.stringify(bundle,null,2)+'\n');
console.log(JSON.stringify({size:recipe.size,towns:bundle.patches.map(p=>({id:p.townId,buildings:p.buildings.length,streets:p.streets.length})),
  buildings:bundle.patches.reduce((n,p)=>n+p.buildings.length,0)},null,2));





