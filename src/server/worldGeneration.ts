import { Euler, Quaternion } from 'three';
import { createEmptyMap, getObjectWorldTransforms, type EditableMap, type MapAsset } from '../shared/map';
import { calculateModelVisualFrame } from '../shared/modelBounds';
import { applyMapOperations } from '../shared/mapOperations';
import { validateWorldRecipe, createWorldSampler } from '../shared/worldTerrain';
import { validateWorldPlan, validateWorldBundle, type WorldBundle, type WorldPlan } from '../shared/worldPlanning';
import { auditWorldSettlement, generateWorldSettlement, type WorldSettlementOptions } from '../shared/worldSettlement';
import { generateModel, llmChat, type ChatMessage } from './modelApi';
import { generateMapCodeSuggestion } from './mapCodePlanner';
import { createMapAssetGenerator } from './mapAssetGenerator';
import { recordGenerationTrace } from './generationTrace';
import type { MapStore } from './mapStore';

export interface WorldGenerationRequest {
  prompt: string;
  seed: number;
  size: number;
  generateAssets?: boolean;
  reusableAssetIds?: string[];
}
export interface WorldAssetRequest {
  key: string;
  name: string;
  role: 'house' | 'shop' | 'workshop' | 'tree' | 'landmark';
  prompt: string;
  dimensions?: [number, number, number];
  enterable?: boolean;
  strategy?: 'single' | 'assembly';
  existingAssetId?: string;
}
export interface WorldAssetResult {
  id: string;
  name: string;
  role: WorldAssetRequest['role'];
  modelJson: unknown;
  assetId: string;
  provider: 'deepseek' | 'existing';
  strategy: 'single' | 'assembly';
}
export interface WorldDraft {
  plan: WorldPlan;
  settlements: Array<{ townId: string; options: WorldSettlementOptions }>;
  assets: WorldAssetRequest[];
}

export const WORLD_GENERATION_PROMPT = `You design a playable continuous world in metres. Return JSON only: {plan,settlements,assets}. GPT owns spatial intent and unique architecture; deterministic tools grow ordinary streets/buildings and stream vegetation. Never enumerate trees or ordinary houses. No final rendering style in the world data.
plan={version:1,id,revision:1,prompt,recipe,ecology,towns,roads}.
recipe={version:1,seed,size,heightScale?:0.02..4,constraints:[{region,biome}],landforms?,terrainBrushes?,waterBodies?}. For playable 500..2000m worlds, prefer heightScale around 0.08..0.15 so coastlines remain traversable; raise exceptional local volcanoes with landforms instead of globally exaggerating relief.
Regions: west/east/north/south/northwest/northeast/southwest/southeast/center; biomes: ocean/grassland/forest/desert/mountains/snow. Constraints blend continuously; they are broad intent, not hard rectangular biomes. Y up, sea=0, north=-Z. landforms=[{center:[x,z],radius:[rx,rz],height}] are smooth elliptical hills/basins.
Brush region: {kind:'circle',center:[x,z],radius} or {kind:'path',points:[[x,z],...],width}. terrainBrushes: {id,mode:'raise'|'lower',region,amount,feather?} or {id,mode:'flatten',region,height,strength?,feather?} or {id,mode:'grade',region:PATH,heights:[one per point],strength?,feather?}. Use bounded local grading for roads, ski trails, quays; never flatten a whole landscape. Keep required cut/fill small, routes connected and downhill snow runs purposeful. Water bodies: {id,type:'lake'|'river',region,levels:[one for circle or one per path point],depth}. Elevated oasis water needs containing terrain. Sea comes from terrain below zero. recipe.biomePatches=[{id,region,biome,feather?}] can define a local oasis grove or a snow-covered run.
towns=[{id,name,prompt,center:[x,z],radius,blend,foundation,terrainMode:'conform',ports:[{id,guideId,position:[localX,localZ],width}]}]. A town core spans +/-radius in local coords. Its ports are exactly on its square boundary, meet world roads at the same world coordinates, and share width. Foundations may be omitted; the compiler samples them. Do not place every settlement on identical pads. Keep towns near enough for interesting traversal, with sparse hinterland and dense streets. Settlement radius normally 50..220 m. Keep core areas non-overlapping. Coast, river, slopes and practical access determine settlement shape. No town on open water.
Before choosing roads and buildings, silently plan each settlement in this order: livelihood, population scale, external logistics, public services, spatial nodes, single-model versus modular architecture, then traffic and housing. Record the specific economy, era and civic program in town.prompt and express only its few authored public buildings through landmarks and matching assets. As a heuristic, consider about one public or landmark building per 10..20 ordinary buildings, adjusted for settlement purpose and size. Libraries, schools, bathhouses, markets, wells, council halls and comparable services belong only where the town's culture, era and population support them; public buildings need not be large. Do not copy one civic checklist into every settlement. Missing services or external connections are reported as preview diagnostics rather than silently filled with generic landmarks.
roads use MapGuide: {id,name,points:[[worldX,worldZ],...],curve:'polyline',closed:false,width,tags:[]}. Secondary lanes 2..3.5m, main streets 4..6m, footpaths >=2m; avoid highway proportions in small settlements. Provide connected overland access between named destinations. Explicitly share coordinates at junctions. No road across deep water or cliffs; route around or author a real crossing. Paths with sharp reversals are invalid.
ecology=[{id,kind:'broadleaf'|'pine'|'shrub'|'rock',biome,density:0..1,spacing:6..100,maxSlope:0..60,scale:[min,max],region?}]. These seeded rules run per fixed chunk; use a region for oasis groves or local woodland. Don't place trees one-by-one.
settlements=[{townId,options:{kind:'city'|'village',pattern:'organic'|'grid',density:0..1,waterfrontBias:0..1,maxRoadSlope?,maxSiteSlope?,waterSetback?,landmarks?}}]. Choose a distinct planning approach appropriate to each place. The same kernel handles cities and villages. landmarks contains only authored significant buildings: {id,x,z,width,depth,height,use,rotation?,assetKey,enterable}. Reserve a sensible dry footprint and accessible entry. Use only a few landmarks; ordinary houses come from the tool.
assets=[{key,name,role:'house'|'shop'|'workshop'|'tree'|'landmark',prompt,dimensions:[width,height,depth],enterable?,strategy:'single'|'assembly',existingAssetId?}], at most 12 reusable families. When the request includes reusableAssets, reuse a suitable listed id through existingAssetId instead of requesting a duplicate; never invent or search for an unlisted id. Asset prompts describe silhouette, dimensions, local +Z entrance, +Y up, openings, joining faces and material identities. Give common houses genuinely distinct silhouettes. Vegetation is clustered by rules. Small ordinary buildings can be single models. Large castles, cathedrals, caravanserais and enterable public buildings use assembly, routed to the existing WorldForge main Scene Code architecture prompt: footprint -> depth -> tiers -> bays, reusable ordinary/corner/entrance modules, preserved passages and courtyard voids. Asset key must match landmark.assetKey. Never generate a large landmark as a solid fake facade when it is meant to be entered.
Limits: <=12 towns, <=8 ecology rules, <=32 world roads, <=16 landforms. Return a new preview, never assume visual acceptance. The compiler reports actual sampled heights/water and validation errors for one repair; use that evidence rather than inventing sampled values.`;

function parseJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}
function record(input: unknown, code: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(code);
  return input as Record<string, unknown>;
}
function exactRecord(input: unknown, allowed: readonly string[], invalid: string, unknown: string): Record<string, unknown> {
  const result = record(input, invalid), extra = Object.keys(result).find(key => !allowed.includes(key));
  if (extra) throw new Error(`${unknown}:${extra}`);
  return result;
}
function largeLandmark(asset: WorldAssetRequest): boolean {
  return asset.role === 'landmark' && !!asset.dimensions && Math.max(asset.dimensions[0], asset.dimensions[2]) >= 18
    && /castle|cathedral|caravanserai|城堡|教堂|驿馆|宫殿|柱廊/i.test(asset.prompt + ' ' + asset.name);
}
export function validateWorldGenerationRequest(input: unknown): WorldGenerationRequest {
  const r = input as WorldGenerationRequest;
  const reusableAssetIds = r?.reusableAssetIds;
  if (!r || typeof r.prompt !== 'string' || !r.prompt.trim() || r.prompt.length > 8000
    || !Number.isInteger(r.seed) || r.seed < 0 || r.seed > 0xffffffff
    || !Number.isFinite(r.size) || r.size < 500 || r.size > 256000
    || (r.generateAssets !== undefined && typeof r.generateAssets !== 'boolean')
    || (reusableAssetIds !== undefined && (!Array.isArray(reusableAssetIds) || reusableAssetIds.length > 64
      || new Set(reusableAssetIds).size !== reusableAssetIds.length
      || reusableAssetIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id))))) {
    throw new Error('invalid_world_generation_request');
  }
  return {prompt:r.prompt.trim(),seed:r.seed,size:r.size,generateAssets:r.generateAssets !== false,
    ...(reusableAssetIds?.length ? {reusableAssetIds:[...reusableAssetIds]} : {})};
}

export function compileWorldDraft(input: unknown, request: WorldGenerationRequest): {draft:WorldDraft;bundle:WorldBundle} {
  const root = exactRecord(structuredClone(input), ['plan','settlements','assets'], 'invalid_world_draft', 'world_unknown_draft_field');
  const rawPlan = record(root.plan, 'invalid_world_draft'), rawRecipe = record(rawPlan.recipe, 'invalid_world_draft');
  if (rawPlan.prompt !== request.prompt) throw new Error('world_prompt_request_mismatch');
  if (rawRecipe.seed !== request.seed || rawRecipe.size !== request.size) throw new Error('world_recipe_request_mismatch');
  const recipe = validateWorldRecipe(rawRecipe as unknown as WorldPlan['recipe']);
  const sample = createWorldSampler(recipe);
  if (!Array.isArray(rawPlan.towns)) throw new Error('invalid_world_draft');
  const towns = rawPlan.towns.map(townInput => {
    const town = record(townInput, 'invalid_world_draft');
    if (town.terrainMode !== 'conform') throw new Error('world_town_requires_conform');
    if ('foundation' in town) return town;
    if (!Array.isArray(town.center) || town.center.length !== 2 || town.center.some(value => !Number.isFinite(value))) {
      throw new Error('invalid_world_draft');
    }
    return {...town,foundation:sample(town.center[0] as number,town.center[1] as number).height};
  });
  const plan = validateWorldPlan({...rawPlan,recipe,towns});
  if (!Array.isArray(root.settlements) || !Array.isArray(root.assets) || root.assets.length > 12) throw new Error('invalid_world_draft');
  const settlements = root.settlements.map(item => {
    const command = exactRecord(item, ['townId','options'], 'invalid_world_settlement_command', 'world_unknown_settlement_field');
    if (typeof command.townId !== 'string') throw new Error('invalid_world_settlement_command');
    const options = exactRecord(command.options,
      ['kind','pattern','landmarks','seed','density','waterfrontBias','maxRoadSlope','maxSiteSlope','waterSetback'],
      'invalid_world_settlement_options','world_unknown_settlement_option');
    return {townId:command.townId,options:options as unknown as WorldSettlementOptions};
  });
  if (settlements.length !== plan.towns.length || new Set(settlements.map(s=>s.townId)).size !== plan.towns.length
    || settlements.some(s=>!plan.towns.some(t=>t.id===s.townId))) throw new Error('world_settlement_command_mismatch');
  const patches = settlements.map(s=>generateWorldSettlement(plan,s.townId,sample,s.options));
  const keys = new Set<string>();
  const assets = root.assets.map(assetInput => exactRecord(assetInput,
    ['key','name','role','prompt','dimensions','enterable','strategy','existingAssetId'], 'invalid_world_asset_request','world_unknown_asset_field')) as unknown as WorldAssetRequest[];
  for (const asset of assets) {
    if (!asset || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(asset.key) || keys.has(asset.key)
      || !['house','shop','workshop','tree','landmark'].includes(asset.role)
      || typeof asset.name !== 'string' || !asset.name.trim() || asset.name.length>160
      || typeof asset.prompt !== 'string' || !asset.prompt.trim() || asset.prompt.length>6000
      || (asset.strategy!==undefined && !['single','assembly'].includes(asset.strategy))
      || (asset.enterable!==undefined && typeof asset.enterable!=='boolean')
      || (asset.existingAssetId!==undefined && (typeof asset.existingAssetId!=='string'
        || !request.reusableAssetIds?.includes(asset.existingAssetId)))
      || (asset.dimensions!==undefined && (!Array.isArray(asset.dimensions)||asset.dimensions.length!==3
        ||asset.dimensions.some(n=>!Number.isFinite(n)||n<=0||n>300)))) throw new Error('invalid_world_asset_request');
    worldAssetStrategy(asset);
    keys.add(asset.key);
  }
  for (const patch of patches) for (const b of patch.buildings) {
    if (b.assetKey && !keys.has(b.assetKey)) throw new Error('unknown_world_building_asset:'+b.assetKey);
    if (b.enterable && !assets.find(a=>a.key===b.assetKey)?.enterable) throw new Error('world_enterable_asset_required');
  }
  return {draft:{plan,settlements,assets},bundle:validateWorldBundle({plan,patches})};
}

function terrainEvidence(input: unknown): unknown {
  try {
    const draft=input as WorldDraft, recipe=validateWorldRecipe(draft.plan.recipe), sample=createWorldSampler(recipe);
    return draft.plan.towns.map(t=>({id:t.id,center:t.center,samples:[[-1,-1],[0,0],[1,1],[-1,1],[1,-1]].map(([x,z])=>{
      const px=t.center[0]+x*t.radius,pz=t.center[1]+z*t.radius,s=sample(px,pz);
      return {x:px,z:pz,height:s.height,waterLevel:s.waterLevel};
    })}));
  } catch { return null; }
}

export function worldAssetStrategy(asset: WorldAssetRequest): 'single'|'assembly' {
  if (asset.strategy === 'single' && (asset.enterable || largeLandmark(asset))) {
    throw new Error('world_asset_strategy_conflict:'+asset.key);
  }
  if (asset.strategy) return asset.strategy;
  return asset.enterable || largeLandmark(asset) ? 'assembly' : 'single';
}

/** Preserve the renderer's per-module local frame when exporting a connected building. */
export function assembleWorldModel(map: EditableMap, assets: readonly MapAsset[]): unknown {
  const transforms=getObjectWorldTransforms(map), nodes:unknown[]=[];
  for(const object of map.objects.filter(o=>o.visible && o.assetId)) {
    const asset=assets.find(a=>a.id===object.assetId), world=transforms.get(object.id)!;
    const source=(asset?.modelJson as {nodes?:Array<Record<string,unknown>>})?.nodes;
    if(!asset||!world||!source?.length) throw new Error('world_assembly_asset_missing');
    const sourceIds=new Set<string>();
    for(const node of source) {
      if(typeof node.id!=='string'||!node.id||sourceIds.has(node.id)) throw new Error('world_assembly_invalid_node');
      sourceIds.add(node.id);
    }
    if(source.some(node=>node.parent!==undefined&&(typeof node.parent!=='string'||!sourceIds.has(node.parent)))) {
      throw new Error('world_assembly_invalid_parent');
    }
    const root=object.id, frame=root+'-frame';
    const rotation=new Quaternion().setFromEuler(new Euler(...world.rotation));
    nodes.push({id:root,transform:{pos:world.position,quat:rotation.toArray(),scale:world.scale}});
    nodes.push({id:frame,parent:root,transform:{pos:calculateModelVisualFrame(asset.modelJson).rootOffset}});
    for(const node of source) nodes.push({...structuredClone(node),id:root+'/'+node.id,parent:node.parent?root+'/'+node.parent:frame});
  }
  if(!nodes.length) throw new Error('world_assembly_empty');
  return {format:2,name:map.name,nodes,_meta:{worldforgeAssembly:true}};
}

export async function generateWorldAssets(requests: WorldAssetRequest[], store: MapStore, signal?:AbortSignal): Promise<WorldAssetResult[]> {
  const results:WorldAssetResult[]=[];
  // Two backend requests at a time keep cost and peak memory bounded.
  for(let i=0;i<requests.length;i+=2) {
    const batch=await Promise.all(requests.slice(i,i+2).map(async request=>{
      const strategy=worldAssetStrategy(request);
      if(request.existingAssetId) {
        const asset=await store.loadAsset(request.existingAssetId);
        return {id:request.key,name:request.name,role:request.role,modelJson:asset.modelJson,
          assetId:asset.id,provider:'existing' as const,strategy};
      }
      let modelJson:unknown;
      if(strategy==='assembly') {
        const [w,h,d]=request.dimensions??[32,16,32];
        const map=createEmptyMap(request.name,undefined,[Math.max(16,w+8),Math.max(16,h+4),Math.max(16,d+8)],'voxel-pro');
        const generated:MapAsset[]=[];
        const createAsset=createMapAssetGenerator(store,map,[],'deepseek',null,signal??new AbortController().signal);
        const suggestion=await generateMapCodeSuggestion(
          request.prompt+`\nBuild ONLY the ${w}m by ${d}m footprint architecture, height ${h}m, centered on origin. Use connected reusable components and actual clear openings >=2m wide. Preserve a walkable ground floor from the +Z entrance through the structure/courtyard. Do not fill the footprint with a solid slab or closed complete-building asset. No external town, water, trees or terrain.`,
          map,[],{provider:'gpt',promptMode:'main',scope:'scene',minNewAssets:2,maxNewAssets:6,spatialPolicy:'diagnose',
            signal,createAsset:async(r,report)=>{const a=await createAsset(r,report);generated.push(a);return a;}});
        const result=applyMapOperations(map,suggestion.operations);
        modelJson=assembleWorldModel(result,generated);
        recordGenerationTrace('world.assembly',{key:request.key,code:suggestion.codePlan,objects:result.objects.length,assets:generated.map(a=>a.id)});
      } else {
        modelJson=await generateModel(request.prompt,{providers:['deepseek'],mode:'voxel-pro',signal});
      }
      const saved=await store.saveAsset({name:request.name,prompt:request.prompt,modelJson,mode:'voxel-pro',provider:'deepseek'});
      return {id:request.key,name:request.name,role:request.role,modelJson,assetId:saved.id,provider:'deepseek' as const,strategy};
    }));
    results.push(...batch);
  }
  return results;
}

export async function generateWorld(input:unknown,store:MapStore,signal?:AbortSignal) {
  const request=validateWorldGenerationRequest(input);
  const reusableAssets=await Promise.all((request.reusableAssetIds??[]).map(async id=>{
    const asset=await store.loadAsset(id).catch(()=>null);
    if(!asset) throw new Error('unknown_reusable_world_asset:'+id);
    return {id:asset.id,name:asset.name,prompt:asset.prompt,tags:asset.tags??[],mode:asset.mode,
      ...(asset.libraryMetadata?{libraryMetadata:asset.libraryMetadata}:{})};
  }));
  const messages:ChatMessage[]=[{role:'system',content:WORLD_GENERATION_PROMPT},
    {role:'user',content:JSON.stringify({...request,...(reusableAssets.length?{reusableAssets}:{})})}];
  let compiled:ReturnType<typeof compileWorldDraft>|undefined;
  for(let attempt=0;attempt<2;attempt++) {
    const content=await llmChat(messages,{provider:'gpt',maxTokens:16000,temperature:0.25,traceStage:attempt?'world.repair':'world.plan',signal});
    let draft:unknown;
    try {draft=parseJson(content);compiled=compileWorldDraft(draft,request);break;}
    catch(error) {
      if(attempt) throw error;
      messages.push({role:'assistant',content},{role:'user',content:JSON.stringify({error:error instanceof Error?error.message:String(error),terrain:terrainEvidence(draft),instruction:'Repair the JSON using actual terrain evidence. Preserve the requested destinations and topology. Return the complete corrected JSON.'})});
    }
  }
  if(!compiled) throw new Error('world_generation_failed');
  const assetSources=request.generateAssets?await generateWorldAssets(compiled.draft.assets,store,signal):undefined;
  const sample=createWorldSampler(compiled.bundle.plan.recipe);
  const diagnostics=compiled.bundle.patches.map(p=>{
    const town=compiled.bundle.plan.towns.find(t=>t.id===p.townId)!;
    const publicBuildings=p.buildings.filter(building=>/civic|market|well|school|library|bath|council|temple|cathedral|clinic|hospital|inn|caravanserai|harbou?r|port|monument/i.test(building.use)).length;
    const ordinaryBuildings=p.buildings.length-publicBuildings;
    const recommendedPublicBuildings:[number,number]=[
      ordinaryBuildings>=10?Math.max(1,Math.floor(ordinaryBuildings/20)):0,
      Math.ceil(ordinaryBuildings/10)
    ];
    const connectedPorts=town.ports.filter(port=>p.streets.some(street=>
      [street.points[0],street.points.at(-1)!].some(point=>Math.hypot(point[0]-port.position[0],point[1]-port.position[1])<1e-6))).length;
    const planningIssues:string[]=[];
    if(publicBuildings<recommendedPublicBuildings[0]) planningIssues.push('missing_public_function');
    if(publicBuildings>recommendedPublicBuildings[1]&&recommendedPublicBuildings[1]>0) planningIssues.push('public_program_overconcentrated');
    if(!town.ports.length) planningIssues.push('missing_external_connection');
    else if(connectedPorts<town.ports.length) planningIssues.push('missing_port_connection');
    return {townId:p.townId,...auditWorldSettlement(p,town,sample),publicBuildings,ordinaryBuildings,
      recommendedPublicBuildings,connectedPorts,portCount:town.ports.length,planningIssues};
  });
  recordGenerationTrace('world.preview',{draft:compiled.draft,diagnostics,assets:assetSources?.map(a=>({id:a.id,assetId:a.assetId,provider:a.provider,strategy:a.strategy}))});
  return {bundle:compiled.bundle,draft:compiled.draft,diagnostics,assetSources,planningProvider:'gpt',assetProvider:'deepseek',preview:true};
}
