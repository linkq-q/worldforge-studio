import { readFileSync, writeFileSync } from 'node:fs';
import { MapStore } from '../src/server/mapStore';
import { createRenderSceneProfile } from '../src/shared/renderSceneProfile';
import { createRenderScheme } from '../src/shared/renderScheme';
import { compileRenderPlan, type RenderPlan } from '../src/shared/renderPlan';

// Explicit paid GPT test. It drafts a separate render scheme and never changes map geometry.
const mapId = process.argv[2];
if (!mapId || !/^map-[a-z0-9-]+$/.test(mapId)) throw Error('Pass the map ID to inspect');
const api = process.env.CITY_TEST_API ?? 'http://127.0.0.1:8799/api/editor';
const map = await new MapStore().loadMap(mapId);
const listed = await fetch(`${api}/render-schemes`).then(r => r.json());
const base = listed.renderSchemes[0];
const currentPlan: RenderPlan = {version:1,baseSchemeId:base.id,modules:[
  {id:'environment.palette',params:{background:'#111719',fogColor:'#111719'}},
  {id:'atmosphere.fog',params:{density:0}},
  {id:'lighting.hemisphere',params:{skyColor:'#eaf6ff',groundColor:'#30382f',intensity:1.6}},
  {id:'lighting.sun',params:{color:'#fff0ce',intensity:2.5}},
  {id:'presentation.exposure',params:{value:1}}
]};
const prompt = '只优化这个沿着弯河发展的紧凑城市的道路材质。结合实际建筑，选择协调、克制的道路基色，降低粗糙刺眼的纹理，让路面衬托建筑。请在既有地表材质能力中选择颜色和细节参数，不指定固定调色板。严格保留当前所有光照、背景、曝光模块；不要增加其他模块，不改道路几何、宽度或地图。';
const request = {prompt,provider:'gpt',currentPlan,useHdriSky:false,sceneProfile:createRenderSceneProfile(map)};
let suggestion;
if (process.argv.includes('--replay')) {
  suggestion = JSON.parse(readFileSync('output/urban-city-study/road-style-gpt-response.json','utf8')).suggestion;
} else {
  const response = await fetch(`${api}/render-schemes/refine`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  if (!response.ok) throw Error(await response.text());
  suggestion = (await response.json()).suggestion;
  writeFileSync('output/urban-city-study/road-style-gpt-response.json',JSON.stringify({mapId,request,suggestion},null,2));
}
const untouched = suggestion.plan.modules.filter((m:{id:string}) => m.id !== 'runtime.terrain-materials');
if (JSON.stringify(untouched) !== JSON.stringify(currentPlan.modules)) throw Error('GPT changed unrelated render modules; draft preserved for inspection');
if (!suggestion.plan.modules.some((m:{id:string;params:Record<string,unknown>}) => m.id === 'runtime.terrain-materials' && Object.keys(m.params).some(key => key.endsWith('Color')))) throw Error('No road color was selected');
const roadModule = suggestion.plan.modules.find((m:{id:string}) => m.id === 'runtime.terrain-materials');
// Review the proposal at the requested scope: a road change must not alter soil/sand recipes.
const reviewedPlan = {...currentPlan,modules:[...currentPlan.modules,{...roadModule,
  params:Object.fromEntries(Object.entries(roadModule.params).filter(([key]) => key.endsWith('Color') || key.startsWith('road')))}]};
const scheme = createRenderScheme({...base,name:'弯河城区 · AI 路面配色',description:suggestion.explanation,
  sourcePrompt:prompt,provider:'gpt',renderPlan:reviewedPlan,styleTags:suggestion.styleTags,
  settings:{...base.settings,...compileRenderPlan(currentPlan),...suggestion.settings}});
writeFileSync('output/urban-city-study/road-style-draft.json',JSON.stringify(scheme,null,2));
console.log(JSON.stringify({mapId,explanation:suggestion.explanation,material:suggestion.plan.modules.find((m:{id:string})=>m.id==='runtime.terrain-materials')}));
