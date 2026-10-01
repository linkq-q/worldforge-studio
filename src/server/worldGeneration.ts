import { Euler, Quaternion } from 'three';
import { isDeepStrictEqual } from 'node:util';
import { createEmptyMap, getObjectWorldTransforms, type EditableMap, type MapAsset } from '../shared/map';
import { calculateModelVisualFrame } from '../shared/modelBounds';
import { applyMapOperations } from '../shared/mapOperations';
import { validateWorldRecipe, createWorldSampler, createWorldTerrainContext,
  diagnoseWorldRiverSurfaceAboveBank, type WorldRiverSurfaceAboveBankDiagnostic } from '../shared/worldTerrain';
import { WORLD_REGIONS, type WorldRecipe, type WorldRegion, type WorldTerrainBrush } from '../shared/worldTerrain';
import { validateEcologyRules, type EcologyKind, type EcologyRule } from '../shared/worldEcology';
import { findWorldRoute, findWorldSiteCandidates,
  type WorldSiteCandidate, type WorldSiteIntent } from '../shared/worldSiting';
import { validateWorldPlan, validateWorldBundle, worldRoadSampleSpacing, type TownBuilding, type TownIntent, type TownPatch, type WorldBundle, type WorldPlan } from '../shared/worldPlanning';
import { auditWorldSettlement, createWorldSettlementLandmarkLayout, generateWorldSettlement, resolveWorldSettlementLandmarks,
  type WorldLandmarkRequirement, type WorldSettlementKind, type WorldSettlementOptions } from '../shared/worldSettlement';
import { generateModel, llmChat, type ChatMessage } from './modelApi';
import { generateMapCodeSuggestion } from './mapCodePlanner';
import { createMapAssetGenerator } from './mapAssetGenerator';
import { recordGenerationTrace } from './generationTrace';
import { buildWorldArchitecturePrompt, WORLD_ARCHITECTURE_PROMPT_MAX_CHARS } from './worldArchitecturePrompt';
import { generateWorldWhitebox, materializeWorldWhiteboxConstruction, validateWorldWhiteboxConstructionRequest,
  WHITEBOX_CONSTRUCTION_PROMPT, type WorldWhiteboxConstructionRequest,
  type WorldWhiteboxConstructionTown } from './worldWhiteboxGeneration';
import { selectUsedWorldAssetRequests } from './worldAssetScheduling';
import type { MapStore } from './mapStore';

export interface WorldGenerationRequest {
  prompt: string;
  seed: number;
  size: number;
  generateAssets?: boolean;
  reusableAssetIds?: string[];
  repairAttempts?: 0 | 1 | 2 | 3;
}
interface CompleteWorldGenerationRequest extends WorldGenerationRequest {
  mode: 'generate-complete';
  size: 500;
  repairAttempts: 0;
  assetGenerationLimit: number;
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
  ecologyKind?: EcologyKind;
  ecologyRuleId?: string;
}
export interface WorldAssetResult {
  id: string;
  name: string;
  role: WorldAssetRequest['role'];
  modelJson: unknown;
  assetId: string;
  provider: 'deepseek' | 'existing';
  strategy: 'single' | 'assembly';
  ecologyKind?: EcologyKind;
  ecologyRuleId?: string;
}
interface ReusableWorldAsset {
  id: string;
  visualSize: [number, number, number];
  tags: string[];
  libraryMetadata?: MapAsset['libraryMetadata'];
}
export interface WorldDraft {
  plan: WorldPlan;
  settlements: Array<{ townId: string; options: WorldSettlementOptions }>;
  assets: WorldAssetRequest[];
}

interface WorldIntentTown extends WorldSiteIntent {
  name: string;
  prompt: string;
  terrainMode: 'conform';
  kind: WorldSettlementKind;
  pattern: 'organic' | 'grid';
  density: number;
  publicBuildings: WorldLandmarkRequirement[];
  population?: number;
}
interface WorldIntentRoad {
  id: string;
  name: string;
  fromTownId: string;
  toTownId: string;
  width: number;
  tags: string[];
}
interface WorldIntentDraft {
  plan: {
    version: 1;
    id: string;
    revision: number;
    prompt: string;
    recipe: WorldRecipe;
    ecology: EcologyRule[];
    towns: WorldIntentTown[];
    roads: WorldIntentRoad[];
  };
}
interface WorldLayoutChoice {
  towns: Array<{ townId: string; candidateId: string; landmarkLayoutId?: string }>;
  settlements: Array<{ townId: string; options: WorldSettlementOptions }>;
  assets: WorldAssetRequest[];
}
type WorldConstructionDiagnostic =
  | { townId: string; planningIssues: string[]; code?: never }
  | (WorldRiverSurfaceAboveBankDiagnostic & { townId?: never; planningIssues?: never });

const WORLD_INTENT_PROMPT = `You design a playable continuous world in metres. Return complete JSON only, with exactly this nesting: {"plan":{"version":1,"id":"world-id","revision":1,"prompt":"exact request.prompt","recipe":{},"ecology":[],"towns":[],"roads":[]}}. The root has only plan; recipe, ecology, towns and roads are children of plan. Request fields such as size, seed, generateAssets and repairAttempts are not fields of plan (seed and size belong inside plan.recipe). Do not pretty-print or repeat descriptions across fields. Copy request.prompt byte-for-byte into plan.prompt; elaborate only in each town.prompt. When the request states or clearly implies a population, add population as an integer approximate resident count to that town. For any other inhabited town, estimate a plausible resident count from its size and livelihood and record it in population rather than only in prose.
This is terrain intent, not final geometry. World coordinates are centered on (0,0), north is negative Z (for example a northern mountain is near [0,-150]) and west is negative X: every authored landform center, path point, water region and biome patch must lie inside [-size/2,+size/2] on both X and Z (for size 500: -250..250), never 0..size. Keep each feature radius and feather inside that same world extent. plan={version:1,id,revision:1,prompt,recipe,ecology,towns,roads}.
recipe={version:1,seed,size,reliefProfile:'compact',heightScale?:0.02..4,constraints:[{region,biome}],landforms?,terrainBrushes?,waterBodies?,biomePatches?}. Regions: west/east/north/south/northwest/northeast/southwest/southeast/center. Biomes: ocean/grassland/forest/desert/mountains/snow. Assign at most one biome constraint to each broad region; put interior forest and mountain detail in bounded biome patches and landforms instead of duplicating a region. For an inhabited island, every map edge must sample as ocean, but do not blanket all eight outer regions with ocean when four side constraints already keep the sampled boundary wet: excessive corner anchors can drown the interior. Do not assign non-ocean corner constraints on a sea island; they can override the cardinal ocean anchors and reopen the boundary. Put mountain, forest and other corner detail in bounded interior landforms and biome patches. Leave a broad connected dry interior for its stated population, streets and routes: its continuous dry footprint must exceed the combined 2*radius by 2*radius cores of all named towns, and its narrow dimension must exceed the largest town diameter. Build that footprint with a broad low central landform plus overlapping low interior landforms sized for the named cores before sculpting ridges, inlets and beaches; a small decorative mound is not an inhabited island. Strongly ocean-constrained compact islands may use heightScale around 0.02..0.04 and create local mountain relief with authored landforms; otherwise for playable 500..2000m worlds prefer heightScale around 0.08..0.15. A landform alone does not make a sea; a harbor without sampled below-zero sea is invalid. Place steep ridges away from the needed buildable coastal terrace; keep cuts local instead of making a continuous cliff beside the town. Landform center and radius are numeric two-element arrays such as {center:[0,0],radius:[90,70],height:12}, never scalar radii or strings; height is a metre value (for example 35 for a substantial hill, 1 for a low mound).
Brush region is {kind:'circle',center:[x,z],radius} or {kind:'path',points:[[x,z],...],width}. Every path region requires numeric width 1..1000, including grade brushes, rivers, biome patches and ecology regions. terrainBrushes are {id,mode:'raise'|'lower',region,amount,feather?}, {id,mode:'crater',region:CIRCLE,depth,rimHeight,feather?}, {id,mode:'flatten',region,height,strength?,feather?}, or {id,mode:'grade',region:PATH,heights:[one per path point],strength?,feather?}. Use bounded local refinement only. For a volcanic crater on a mound, use crater instead of a circular lower brush: region.radius is the rim-crest radius, depth lowers the central floor below the pre-brush sampled rim height, and rimHeight raises the crest above it. For a harbor, preserve a naturally sloped dry terrace reaching the sea; do not carve a whole bay with one circular lower brush or a long straight trench, which creates a cliff and can disconnect the working street. Do not guess road or settlement grade heights: the server samples and grades their access after choosing sites. waterBodies=[{id,type:'lake'|'river',region,levels:[one for circle or one per path point],depth,shorelineSmoothness?:0..1,shorelineIrregularity?:0..0.4,shorelineProfile?:'steep'|'gentle',seed?:uint32}]. Lakes require circle regions and usually use smoothness 0.7..0.95 and irregularity 0.08..0.28; rivers require path regions, smoothness 0.65..0.9 and irregularity 0. shorelineProfile controls bank width and slope. Sea is terrain below zero. biomePatches=[{id,region,biome,feather?}] use only a valid biome from the list above. Biome-patch feather is a transition distance in world metres, not a 0..1 softness ratio; in a 500m world normally use 8..24m, and use 0 only for an intentionally hard material edge. Omit biomePatches for broad north/south/east/west forest, mountain or coast areas; constraints already express those. A local patch and its feather must remain entirely inside the world bounds. Rocky terrain uses mountains, not a 'rock' biome.
towns=[{id,name,prompt,radius,blend,terrainMode:'conform',region,kind:'city'|'village',pattern:'organic'|'grid',density:0..1,population?:integer,waterfrontBias?,targetWaterBodyId?,publicBuildings:[{id,use,width,depth,height,assetKey,enterable?,siting?:'central'|'waterfront'|'gateway'|'high-ground'}]}]. region is one of ${Object.keys(WORLD_REGIONS).join('|')}. targetWaterBodyId is an authored lake/river id or 'sea'. radius must be >=min(100,size/10), blend >=min(100,size/25); for size 500 these minima are 50m and 20m. Choose pattern from the requested culture and terrain before siting; the server validates that exact pattern. Describe livelihood, population scale, external logistics, public services, spatial nodes and era in prompt. Size and distribute inhabited districts against the usable land and expected population: a major island town needs a shore-working district, civic core, housing and reachable hinterland rather than one tiny isolated knot; smaller villages can remain compact. Estimate one ordinary dwelling per four to six residents and reserve enough dry street frontage for that population; a low-rise town usually needs a radius around 7 to 9 times the square root of its population in metres (250 residents: roughly 110..140m), counting housing districts and civic space rather than only the market square. a service-bearing port town with hundreds of residents should not be labeled or sized as a tiny village. If dry coastal land is constrained, connect smaller inhabited districts along passable shore and inland routes. If the settlement depends on sea trade or fishing, target the sea and provide a shore-access purpose for its waterfront public building. For each named place, consider who uses it, how they reach it, what they exchange there, and which terrain feature shapes its entrance and public space. Choose distinct civic functions appropriate to that life rather than repeating a checklist; for a substantial town, plan roughly one useful public or landmark building per 10..20 ordinary buildings. A village expected to produce about eight ordinary houses gets at most one public landmark unless the user explicitly requests more. Use siting only for a real spatial reason: central gathering, waterfront work, gateway trade, or high-ground lookout. Public buildings declare program, footprint and siting intent only. Before shaping the coast, budget the whole public-building program simultaneously: reserve connected gently sloped dry shore frontage for the combined waterfront footprints plus gaps and access, reserve a separate inland civic block for schools and services, and keep ridges, gullies and bay cuts away from both reserves. Keep the program proportional: use only one or two waterfront work buildings, express promenades/plazas as street or open-space intent in town.prompt rather than as building footprints, and give a substantial town with four civic buildings a larger core than a tiny village. No center, foundation, ports, rotation or landmark coordinates.
Town region is the search area for a dry center, not the location of the water. A harbor targeting the sea may need region:'center' when outer west/east/south regions are ocean; targetWaterBodyId:'sea' still requires reachable sampled shore. On a multi-town island, leave separated dry terraces at least the sum of the town radii apart with a walkable land corridor; a small flatten brush cannot create city-scale dry land.
roads=[{id,name,fromTownId,toTownId,width,tags}]. They express topology and purpose only; the server routes them over sampled terrain. Use 3..5m for rural walking/cart roads; use 6..7m only for a genuinely arterial route whose broad cross-section fits the terrain. Include a separate town for every named inhabited destination such as an outlying farmstead. Roads connect two different town IDs only; if there is only one town, return roads:[] even if it has harbor, housing and farm neighborhoods. Local streets, harbor lanes and trails inside one town are generated by the settlement tool, never expressed as self-loop roads here. No points or invented elevations.
ecology=[{id,kind:'broadleaf'|'pine'|'shrub'|'rock',biome,density:0..1,spacing:6..100,maxSlope:0..60,scale:[min,max],region?,regionFeather?,waterDistance?}]. Ecology region is a circle/path object using the brush region schema, never a compass string; omit it for broad biome coverage. waterDistance is exactly four ascending metre values [outerMin,preferredMin,preferredMax,outerMax] for explicit fresh lakes/rivers only; omit it near the sea or when no fresh water exists.  Never enumerate ordinary buildings or vegetation. Preserve the user's named destinations and relations. Limits: <=12 towns, <=32 roads, <=8 ecology rules, <=16 landforms.`;

const WORLD_ASSET_FAMILY_LIMIT = 16;

const WORLD_LAYOUT_PROMPT = `Choose only from supplied sampled site candidates. Return JSON only:
{towns:[{townId,candidateId,landmarkLayoutId?}],settlements:[{townId,options}],assets:[]}.
Choose exactly one candidate per town and only the available:true road pairs, which form one jointly validated candidate graph. A town with publicBuildings must choose a supplied landmarkLayoutId for that candidate and matching pattern. Never return recipe, terrain heights, centers, ports, world-road points, landmark coordinates or rotations. The server materializes those from actual samples.
options={kind:'city'|'village',pattern:'organic'|'grid',density:0..1,waterfrontBias?:0..1}. Copy these values from intent exactly; do not add slope, setback, seed or landmark overrides after the server has sampled viable sites. Invalid or unreachable public footprints are omitted from candidates, never faked.
Before local layout consider livelihood, population scale, external logistics, public services, spatial nodes, single-model versus modular architecture, traffic and housing. Use roughly one public or landmark building per 10..20 ordinary buildings when the settlement supports it. assets=[{key,name,role:'house'|'shop'|'workshop'|'tree'|'landmark',prompt,dimensions?:[width,height,depth],enterable?,strategy?:'single'|'assembly',existingAssetId?,ecologyKind?,ecologyRuleId?}], at most ${WORLD_ASSET_FAMILY_LIMIT}. If assets will be generated, include at least one asset family for every ordinary-building role used by the generated settlement: house, shop and/or workshop. Do not substitute a landmark family for ordinary buildings. If enterable:true, use strategy:'assembly' or omit strategy so the server routes to assembly; strategy:'single' is invalid for every enterable asset, including reused ones. For each public building, match its assetKey and authored [width,height,depth] exactly in the landmark asset request. Include one role:'tree' asset binding for every intent.plan.ecology rule, including shrub and rock rules. Every role:'tree' asset must name exactly one intent.plan.ecology rule through ecologyRuleId and copy that rule's kind into ecologyKind; this keeps palms, broadleaf trees, pines, shrubs and rocks attached to their authored habitat. Non-tree assets omit both fields. existingAssetId may reference only an id in reusableAssets, whose visualSize is its authoritative measured [width,height,depth]. Omit existingAssetId when requesting a new asset; not every asset must be reused.
For a requested harbor, the waterfront landmark program and matching asset prompt must show a boat-facing mooring/unloading edge connected to the dry working street; market stalls alone do not constitute a port. Keep the quay structure within its authored footprint and describe how people and cargo reach it. Do not invent a water crossing or place ordinary buildings in water.`;

export const WORLD_GENERATION_PROMPT = `You design a playable continuous world in metres. Return JSON only: {plan,settlements,assets}. GPT owns spatial intent and unique architecture; deterministic tools grow ordinary streets/buildings and stream vegetation. Never enumerate trees or ordinary houses. No final rendering style in the world data.
plan={version:1,id,revision:1,prompt,recipe,ecology,towns,roads}.
recipe={version:1,seed,size,reliefProfile:'compact',heightScale?:0.02..4,constraints:[{region,biome}],landforms?,terrainBrushes?,waterBodies?}. For playable 500..2000m worlds, prefer heightScale around 0.08..0.15 so coastlines remain traversable; raise exceptional local volcanoes with landforms instead of globally exaggerating relief.
Regions: west/east/north/south/northwest/northeast/southwest/southeast/center; biomes: ocean/grassland/forest/desert/mountains/snow. Constraints blend continuously; they are broad intent, not hard rectangular biomes. Y up, sea=0, north=-Z. landforms=[{center:[x,z],radius:[rx,rz],height}] are smooth elliptical hills/basins.
Brush region: {kind:'circle',center:[x,z],radius} or {kind:'path',points:[[x,z],...],width}. terrainBrushes: {id,mode:'raise'|'lower',region,amount,feather?} or {id,mode:'flatten',region,height,strength?,feather?} or {id,mode:'grade',region:PATH,heights:[one per point],strength?,feather?}. Use bounded local grading for roads, ski trails, quays; never flatten a whole landscape. Keep required cut/fill small, routes connected and downhill snow runs purposeful. Water bodies: {id,type:'lake'|'river',region,levels:[one for circle or one per path point],depth,shorelineSmoothness?:0..1,shorelineIrregularity?:0..0.4,shorelineProfile?:'steep'|'gentle',seed?:uint32}. Lakes use circle regions, normally smoothness 0.7..0.95 and irregularity 0.08..0.28; rivers use path regions, smoothness 0.65..0.9 and irregularity 0. shorelineProfile controls bank width and slope. Elevated oasis water needs containing terrain. Sea comes from terrain below zero. recipe.biomePatches=[{id,region,biome,feather?}] can define a local oasis grove or a snow-covered run. Biome-patch feather is a world-metre transition distance, not a 0..1 ratio; normally use 8..24m at this scale and reserve 0 for a deliberate hard edge.
towns=[{id,name,prompt,center:[x,z],radius,blend,foundation,terrainMode:'conform',ports:[{id,guideId,position:[localX,localZ],width}]}]. A town core spans +/-radius in local coords. Its ports are exactly on its square boundary, meet world roads at the same world coordinates, and share width. Foundations may be omitted; the compiler samples them. Do not place every settlement on identical pads. Keep towns near enough for interesting traversal, with sparse hinterland and dense streets. Settlement radius normally 50..220 m. Keep core areas non-overlapping. Coast, river, slopes and practical access determine settlement shape. No town on open water.
Before choosing roads and buildings, silently plan each settlement in this order: livelihood, population scale, external logistics, public services, spatial nodes, single-model versus modular architecture, then traffic and housing. Record the specific economy, era and civic program in town.prompt and express only its few authored public buildings through landmarks and matching assets. As a heuristic, consider about one public or landmark building per 10..20 ordinary buildings, adjusted for settlement purpose and size. Libraries, schools, bathhouses, markets, wells, council halls and comparable services belong only where the town's culture, era and population support them; public buildings need not be large. Do not copy one civic checklist into every settlement. Missing services or external connections are reported as preview diagnostics rather than silently filled with generic landmarks.
roads use MapGuide: {id,name,points:[[worldX,worldZ],...],curve:'polyline',closed:false,width,tags:[]}. Secondary lanes 2..3.5m, main streets 4..6m, footpaths >=2m; avoid highway proportions in small settlements. Provide connected overland access between named destinations. Explicitly share coordinates at junctions. No road across deep water or cliffs; route around or author a real crossing. Paths with sharp reversals are invalid.
ecology=[{id,kind:'broadleaf'|'pine'|'shrub'|'rock',biome,density:0..1,spacing:6..100,maxSlope:0..60,scale:[min,max],region?,regionFeather?,waterDistance?:[outerMin,preferredMin,preferredMax,outerMax]}]. These seeded rules run per fixed chunk; use a region for oasis groves or local woodland. Don't place trees one-by-one. Derive vegetation density from moisture, slope and human use: freshwater shores should support substantial groves where the climate permits, with a gradual transition into dry hinterland. waterDistance measures metres from explicit fresh lakes and rivers, not the sea; use it for water-dependent groves, omit it for rain-fed forests. Leave roads, entrances and occupied building footprints clear.
settlements=[{townId,options:{kind:'city'|'village',pattern:'organic'|'grid',density:0..1,waterfrontBias:0..1,maxRoadSlope?,maxSiteSlope?,waterSetback?,landmarks?}}]. Choose a distinct planning approach appropriate to each place. The same kernel handles cities and villages. landmarks contains only authored significant buildings: {id,x,z,width,depth,height,use,rotation?,assetKey,enterable}. Reserve a sensible dry footprint and accessible entry. Use only a few landmarks; ordinary houses come from the tool.
assets=[{key,name,role:'house'|'shop'|'workshop'|'tree'|'landmark',prompt,dimensions:[width,height,depth],enterable?,strategy:'single'|'assembly',existingAssetId?,ecologyKind?,ecologyRuleId?}], at most ${WORLD_ASSET_FAMILY_LIMIT} reusable families. Every role:'tree' asset names its exact ecology rule and matching kind; non-tree assets omit ecology fields. When the request includes reusableAssets, reuse a suitable listed id through existingAssetId instead of requesting a duplicate; never invent or search for an unlisted id. Asset prompts describe silhouette, dimensions, local +Z entrance, +Y up, openings, joining faces and material identities. Give common houses genuinely distinct silhouettes. Vegetation is clustered by rules. Small ordinary buildings can be single models. Large castles, cathedrals, caravanserais and enterable public buildings use assembly, routed to the existing WorldForge main Scene Code architecture prompt: footprint -> depth -> tiers -> bays, reusable ordinary/corner/entrance modules, preserved passages and courtyard voids. Asset key must match landmark.assetKey. Never generate a large landmark as a solid fake facade when it is meant to be entered.
Limits: <=12 towns, <=8 ecology rules, <=32 world roads, <=16 landforms. Return a new preview, never assume visual acceptance. A failed first output is preserved without retry by default. Only an explicitly enabled repair can provide sampled terrain evidence for one correction; never invent sampled values.`;

function parseJson(text: string): unknown {
  const content = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(content); }
  catch (error) {
    // One missing or surplus final closer changes no field in an otherwise complete object.
    if (content.endsWith('}')) {
      try { return JSON.parse(content.slice(0, -1).trimEnd()); } catch { /* keep the original error */ }
      try { return JSON.parse(content + '}'); } catch { /* keep the original error */ }
    }
    throw error;
  }
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
function requestOwnedPrompt(raw:Record<string,unknown>,request:WorldGenerationRequest,stage:'intent'|'draft'):string {
  if(raw.prompt!==undefined&&raw.prompt!==request.prompt) recordGenerationTrace('world.request-echo-mismatch',{
    stage,field:'prompt',expected:request.prompt,received:raw.prompt
  });
  return request.prompt;
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
    || (r.repairAttempts !== undefined && r.repairAttempts !== 0 && r.repairAttempts !== 1 && r.repairAttempts !== 2 && r.repairAttempts !== 3)
    || (reusableAssetIds !== undefined && (!Array.isArray(reusableAssetIds) || reusableAssetIds.length > 64
      || new Set(reusableAssetIds).size !== reusableAssetIds.length
      || reusableAssetIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id))))) {
    throw new Error('invalid_world_generation_request');
  }
  return {prompt:r.prompt.trim(),seed:r.seed,size:r.size,generateAssets:r.generateAssets !== false,repairAttempts:r.repairAttempts??0,
    ...(reusableAssetIds?.length ? {reusableAssetIds:[...reusableAssetIds]} : {})};
}

function generationId(input: unknown, code: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(input)) throw new Error(code);
  return input;
}
function finite(input: unknown, min: number, max: number, code: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) throw new Error(code);
  return input;
}
function finiteInteger(input: unknown, min: number, max: number, code: string): number {
  const value=finite(input,min,max,code);
  if(!Number.isInteger(value)) throw new Error(code);
  return value;
}

function worldIntentError(error: unknown, input: unknown): Error {
  if (!(error instanceof Error) || error.message !== 'invalid_world_terrain_region') return error as Error;
  const visit = (value: unknown, path: string): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (record.kind === 'path' && (typeof record.width !== 'number' || !Number.isFinite(record.width)
      || record.width < 1 || record.width > 1000)) return `${path}.width`;
    for (const [key, child] of Object.entries(record)) {
      const found = visit(child, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`);
      if (found) return found;
    }
    return undefined;
  };
  const path = visit(input, 'root');
  return path ? new Error(`invalid_world_terrain_region:${path.replace(/^root\./, '')}:required_numeric_width_1_to_1000`) : error;
}

export function parseWorldIntentDraft(input: unknown, request: WorldGenerationRequest): WorldIntentDraft {
  const candidate = structuredClone(input);
  const wrapper = record(candidate, 'invalid_world_intent');
  if (Object.hasOwn(wrapper, 'plan')) {
    const plan = record(wrapper.plan, 'invalid_world_intent');
    const moved: string[] = [];
    for (const field of ['ecology','towns','roads']) {
      if (!Object.hasOwn(wrapper, field)) continue;
      if (!Object.hasOwn(plan, field)) {
        plan[field] = wrapper[field];
        delete wrapper[field];
        moved.push(field);
      } else if (isDeepStrictEqual(wrapper[field], plan[field])
        || (Array.isArray(wrapper[field]) && wrapper[field].length === 0
          && Array.isArray(plan[field]) && plan[field].length > 0)) delete wrapper[field];
    }
    if (moved.length) recordGenerationTrace('world.intent-wrapper-corrected', { moved });
  }
  const root = exactRecord(wrapper, ['plan'], 'invalid_world_intent', 'world_unknown_intent_field');
  const raw = exactRecord(root.plan, ['version','id','revision','prompt','recipe','ecology','towns','roads'],
    'invalid_world_intent','world_unknown_intent_plan_field');
  if (raw.version !== 1) throw new Error('invalid_world_intent');
  const recipeInput=record(raw.recipe,'invalid_world_intent');
  const circularLandforms:number[]=[];
  if(Array.isArray(recipeInput.landforms)) recipeInput.landforms.forEach((form,index)=>{
    if(form&&typeof form==='object'&&!Array.isArray(form)&&typeof form.radius==='number') {
      form.radius=[form.radius,form.radius];
      circularLandforms.push(index);
    }
  });
  let recipe: WorldRecipe;
  try { recipe = validateWorldRecipe({ ...(recipeInput as unknown as WorldRecipe), reliefProfile: 'compact' }); }
  catch (error) { throw worldIntentError(error, root); }
  if(circularLandforms.length) recordGenerationTrace('world.intent-circular-landforms',{indices:circularLandforms});
  if (recipe.seed !== request.seed || recipe.size !== request.size) throw new Error('world_recipe_request_mismatch');
  if (!Array.isArray(raw.towns) || raw.towns.length > 12 || !Array.isArray(raw.roads) || raw.roads.length > 32) {
    throw new Error('invalid_world_intent');
  }
  const townIds = new Set<string>();
  const towns = raw.towns.map(value => {
    const item = exactRecord(value, ['id','name','prompt','radius','blend','terrainMode','region','kind','pattern','density','population','waterfrontBias','targetWaterBodyId','publicBuildings'],
      'invalid_world_intent_town','world_unknown_intent_town_field');
    const id = generationId(item.id, 'invalid_world_intent_town');
    if (townIds.has(id) || typeof item.name !== 'string' || !item.name.trim() || typeof item.prompt !== 'string'
      || item.terrainMode !== 'conform' || typeof item.region !== 'string' || !Object.hasOwn(WORLD_REGIONS,item.region)) {
      throw new Error('invalid_world_intent_town');
    }
    townIds.add(id);
    const targetWaterBodyId = item.targetWaterBodyId;
    if (targetWaterBodyId !== undefined && (typeof targetWaterBodyId !== 'string'
      || (targetWaterBodyId !== 'sea' && !recipe.waterBodies?.some(body => body.id === targetWaterBodyId)))) {
      throw new Error('world_intent_unknown_water_body:'+id);
    }
    const radius=finite(item.radius,Math.min(100,recipe.size/10),1000,'invalid_world_intent_town');
    const kind:WorldSettlementKind=item.kind===undefined?(radius>=120?'city':'village'):item.kind as WorldSettlementKind;
    if(kind!=='city'&&kind!=='village') throw new Error('invalid_world_intent_town');
    const pattern=item.pattern??'organic';
    if(pattern!=='organic'&&pattern!=='grid') throw new Error('invalid_world_intent_town');
    const publicIds=new Set<string>();
    const publicBuildings=item.publicBuildings===undefined?[]:(Array.isArray(item.publicBuildings)?item.publicBuildings:[]).map(value=>{
      const building=exactRecord(value,['id','use','width','depth','height','assetKey','enterable','siting'],
        'invalid_world_public_building','world_unknown_public_building_field');
      const buildingId=generationId(building.id,'invalid_world_public_building'),assetKey=generationId(building.assetKey,'invalid_world_public_building');
      if(publicIds.has(buildingId)||typeof building.use!=='string'||!building.use.trim()||building.use.length>120
        ||(building.enterable!==undefined&&typeof building.enterable!=='boolean')) throw new Error('invalid_world_public_building');
      if(building.siting!==undefined&&!['central','waterfront','gateway','high-ground'].includes(building.siting as string)) {
        throw new Error('invalid_world_public_building_siting');
      }
      publicIds.add(buildingId);
      return {id:buildingId,use:building.use,width:finite(building.width,1,300,'invalid_world_public_building'),
        depth:finite(building.depth,1,300,'invalid_world_public_building'),height:finite(building.height,1,300,'invalid_world_public_building'),
        assetKey,...(building.enterable===undefined?{}:{enterable:building.enterable}),
        ...(building.siting===undefined?{}:{siting:building.siting as 'central'|'waterfront'|'gateway'|'high-ground'})};
    });
    if(item.publicBuildings!==undefined&&!Array.isArray(item.publicBuildings)) throw new Error('invalid_world_public_building');
    return {id,name:item.name,prompt:item.prompt,radius,
      blend:finite(item.blend,Math.min(100,recipe.size/25),2000,'invalid_world_intent_town'),terrainMode:'conform' as const,kind,
      pattern:pattern as 'organic'|'grid',
      density:finite(item.density??(kind==='city'?.82:.38),.05,1,'invalid_world_intent_town'),publicBuildings,
      region:item.region as WorldRegion,
      ...(item.population===undefined?{}:{population:finiteInteger(item.population,1,1_000_000,'invalid_world_intent_town')}),
      ...(item.waterfrontBias===undefined?{}:{waterfrontBias:finite(item.waterfrontBias,0,1,'invalid_world_intent_town')}),
      ...(targetWaterBodyId===undefined?{}:{targetWaterBodyId})};
  });
  const roadIds = new Set<string>();
  const roads = raw.roads.flatMap(value => {
    const item = exactRecord(value,['id','name','fromTownId','toTownId','width','tags'],
      'invalid_world_intent_road','world_unknown_intent_road_field');
    const id=generationId(item.id,'invalid_world_intent_road');
    if(roadIds.has(id)||typeof item.name!=='string'||!item.name.trim()||typeof item.fromTownId!=='string'||typeof item.toTownId!=='string'
      ||!townIds.has(item.fromTownId)||!townIds.has(item.toTownId)
      ||!Array.isArray(item.tags)||item.tags.length>16||item.tags.some(tag=>typeof tag!=='string'||tag.length>64)) {
      throw new Error('invalid_world_intent_road');
    }
    roadIds.add(id);
    const width=finite(item.width,2,64,'invalid_world_intent_road');
    if(item.fromTownId===item.toTownId) {
      recordGenerationTrace('world.intent-local-road-ignored',{id,townId:item.fromTownId});
      return [];
    }
    return [{id,name:item.name,fromTownId:item.fromTownId,toTownId:item.toTownId,width,tags:[...item.tags] as string[]}];
  });
  return {plan:{version:1,id:generationId(raw.id,'invalid_world_intent'),revision:finite(raw.revision,1,Number.MAX_SAFE_INTEGER,'invalid_world_intent'),
    prompt:requestOwnedPrompt(raw,request,'intent'),recipe,ecology:validateEcologyRules(raw.ecology),towns,roads}};
}

export interface WorldSitingEvidence {
  towns: Array<{ id: string; candidates: WorldSiteCandidate[] }>;
  connections: Array<{ roadId: string; fromCandidateId: string; toCandidateId: string; available: boolean; length?: number; maxSlope?: number }>;
  landmarkLayouts: Array<{ id:string; townId:string; candidateId:string; pattern:'organic'|'grid'; landmarks:TownBuilding[] }>;
}

function portToward(from: WorldSiteCandidate, to: WorldSiteCandidate, radius: number): [number,number] {
  const dx=to.center[0]-from.center[0],dz=to.center[1]-from.center[1],length=Math.hypot(dx,dz),desired:[number,number]=[dx/length,dz/length];
  const direction=[...from.accessDirections].sort((a,b)=>b[0]*desired[0]+b[1]*desired[1]-a[0]*desired[0]-a[1]*desired[1])[0]??desired;
  const scale=radius/Math.max(Math.abs(direction[0]),Math.abs(direction[1]));
  return [Math.round(direction[0]*scale*1e6)/1e6,Math.round(direction[1]*scale*1e6)/1e6];
}

function gradeAccess(id:string,points:Array<[number,number]>,width:number,sample:ReturnType<typeof createWorldSampler>):WorldTerrainBrush {
  const dense:Array<[number,number]>=[];
  for(let segment=1;segment<points.length;segment++) {
    const a=points[segment-1],b=points[segment],length=Math.hypot(b[0]-a[0],b[1]-a[1]),steps=Math.max(1,Math.ceil(length/8));
    for(let i=segment===1?0:1;i<=steps;i++) dense.push([a[0]+(b[0]-a[0])*i/steps,a[1]+(b[1]-a[1])*i/steps]);
  }
  return {id,mode:'grade',region:{kind:'path',points:dense,width},heights:dense.map(point=>sample(point[0],point[1]).height),feather:2};
}

function cachedWorldSampler(sample:ReturnType<typeof createWorldSampler>):ReturnType<typeof createWorldSampler> {
  const cache=new Map<string,ReturnType<typeof sample>>();
  return (x,z)=>{
    const key=`${x},${z}`,known=cache.get(key);
    if(known) return known;
    const result=sample(x,z);
    if(cache.size<50_000) cache.set(key,result);
    return result;
  };
}

export function auditWorldSettlementAcceptance<T extends {id:string}>(town: Pick<TownIntent,'id'|'radius'|'targetWaterBodyId'> & {
  publicBuildings: T[]
},
  patch: Pick<TownPatch,'buildings'|'streets'>,
  settings: Pick<WorldSettlementOptions,'kind'|'density'|'waterfrontBias'>): {
    publicBuildings:number;ordinaryBuildings:number;builtExtent:number;planningIssues:string[]
  } {
  const publicIds=new Set(town.publicBuildings.map(building=>building.id));
  const publicBuildings=patch.buildings.filter(building=>publicIds.has(building.id)).length;
  const ordinary=patch.buildings.filter(building=>!publicIds.has(building.id));
  const ordinaryBuildings=ordinary.length;
  const coverage=auditWorldSettlementCoverage(town,{buildings:ordinary,streets:patch.streets},settings,ordinaryBuildings);
  const planningIssues=[...coverage.planningIssues];
  if(publicBuildings>Math.max(1,Math.ceil(ordinaryBuildings/10))) planningIssues.push('public_program_overconcentrated');
  return {publicBuildings,ordinaryBuildings,builtExtent:coverage.builtExtent,planningIssues};
}

export function auditWorldSettlementCoverage(town: Pick<TownIntent,'radius'|'targetWaterBodyId'>,
  patch: Pick<TownPatch,'buildings'|'streets'>,
  settings: Pick<WorldSettlementOptions,'kind'|'density'|'waterfrontBias'>,
  ordinaryBuildings: number): {builtExtent: number; planningIssues: string[]} {
  const x=patch.buildings.map(building=>building.x),z=patch.buildings.map(building=>building.z);
  const builtExtent=x.length?Math.max(Math.max(...x)-Math.min(...x),Math.max(...z)-Math.min(...z))/(2*town.radius):0;
  const ordinaryFloor=settings.kind==='city'?Math.max(24,Math.ceil(town.radius*(settings.density??.82)*.52))
    :Math.max(8,Math.ceil(town.radius*(settings.density??.38)*.32));
  const extentFloor=settings.kind==='city'?.5:.4;
  const planningIssues:string[]=[];
  if(town.radius>=50&&ordinaryBuildings<ordinaryFloor) planningIssues.push('underbuilt_settlement');
  if(town.radius>=50&&builtExtent<extentFloor) planningIssues.push('clustered_settlement');
  if(town.targetWaterBodyId==='sea'&&(settings.waterfrontBias??0)>=.5
    &&!patch.streets.some(street=>street.tags.includes('sea-landing')
      &&street.points.slice(1).reduce((length,point,index)=>length+Math.hypot(
        point[0]-street.points[index][0],point[1]-street.points[index][1]),0)>=Math.max(12,street.width*2))) {
    planningIssues.push('missing_sea_landing');
  }
  return {builtExtent,planningIssues};
}

export function auditWorldWhiteboxSettlementConstruction(
  plan: Pick<WorldPlan,'towns'>,
  towns: Array<Pick<WorldWhiteboxConstructionTown,'id'|'publicBuildings'>>,
  settlements: WorldDraft['settlements'],
  patches: TownPatch[]
): Array<{townId:string;planningIssues:string[]}> {
  const result:Array<{townId:string;planningIssues:string[]}>=[];
  for(const authored of towns) {
    const town=plan.towns.find(item=>item.id===authored.id),patch=patches.find(item=>item.townId===authored.id);
    const settings=settlements.find(item=>item.townId===authored.id)?.options;
    if(!town||!patch||!settings) {
      result.push({townId:authored.id,planningIssues:['settlement_patch_missing']});
      continue;
    }
    const acceptance=auditWorldSettlementAcceptance({...town,publicBuildings:authored.publicBuildings},patch,settings);
    const planningIssues=[...acceptance.planningIssues];
    if(town.population!==undefined&&acceptance.ordinaryBuildings<Math.ceil(town.population/5)) {
      planningIssues.push('population_underbuilt');
    }
    if(planningIssues.length) result.push({townId:authored.id,planningIssues});
  }
  return result;
}

export function auditWorldCandidatePacking(
  towns: Array<Pick<TownIntent,'id'|'radius'>>,
  roads: Array<Pick<WorldIntentRoad,'id'|'fromTownId'|'toTownId'>>,
  candidates: Array<{id:string;candidates:Array<Pick<WorldSiteCandidate,'center'>>}>
): {roadId:string;fromTownId:string;toTownId:string;requiredSeparation:number;bestAxisSeparation:number}|null {
  for(const road of roads) {
    const fromTown=towns.find(town=>town.id===road.fromTownId),toTown=towns.find(town=>town.id===road.toTownId);
    const from=candidates.find(item=>item.id===road.fromTownId)?.candidates??[];
    const to=candidates.find(item=>item.id===road.toTownId)?.candidates??[];
    if(!fromTown||!toTown||!from.length||!to.length) continue;
    const requiredSeparation=fromTown.radius+toTown.radius;
    let bestAxisSeparation=0,hasSeparatedPair=false;
    for(const a of from) for(const b of to) {
      const separation=Math.max(Math.abs(a.center[0]-b.center[0]),Math.abs(a.center[1]-b.center[1]));
      bestAxisSeparation=Math.max(bestAxisSeparation,separation);
      if(separation>=requiredSeparation) hasSeparatedPair=true;
    }
    if(!hasSeparatedPair) return {roadId:road.id,fromTownId:road.fromTownId,toTownId:road.toTownId,
      requiredSeparation,bestAxisSeparation:Math.round(bestAxisSeparation*100)/100};
  }
  return null;
}

export function createWorldSitingEvidence(intent: WorldIntentDraft): WorldSitingEvidence {
  const sample=cachedWorldSampler(createWorldSampler(intent.plan.recipe));
  const towns=intent.plan.towns.map(town=>({id:town.id,candidates:findWorldSiteCandidates(intent.plan.recipe,town)}));
  for(const town of towns) if(!town.candidates.length) throw new Error('world_no_site_candidates:'+town.id);
  const packing=auditWorldCandidatePacking(intent.plan.towns,intent.plan.roads,towns);
  if(packing) throw new Error(`world_candidate_terraces_overlap:${packing.roadId}:${packing.bestAxisSeparation}/${packing.requiredSeparation}`);
  const connections:WorldSitingEvidence['connections']=[],landmarkLayouts:WorldSitingEvidence['landmarkLayouts']=[];
  const connectedTownIds=new Set(intent.plan.roads.flatMap(road=>[road.fromTownId,road.toTownId]));
  for(const town of intent.plan.towns) if(!connectedTownIds.has(town.id)) {
    const evidence=towns.find(item=>item.id===town.id)!,viable:WorldSiteCandidate[]=[];
    const failures:Array<{candidateId:string;reason:string}>=[];
    for(const site of evidence.candidates) {
      const plan:WorldPlan={version:1,id:intent.plan.id,revision:intent.plan.revision,prompt:intent.plan.prompt,
        recipe:intent.plan.recipe,ecology:intent.plan.ecology,roads:[],towns:[{id:town.id,name:town.name,prompt:town.prompt,
          center:site.center,radius:town.radius,blend:town.blend,foundation:site.foundation,terrainMode:'conform',ports:[],
          ...(town.targetWaterBodyId?{targetWaterBodyId:town.targetWaterBodyId}:{}),...(town.population?{population:town.population}:{})}]};
      try {
        let patch=generateWorldSettlement(plan,town.id,sample,{kind:town.kind,pattern:town.pattern,density:town.density,waterfrontBias:town.waterfrontBias??0});
        const layouts:WorldSitingEvidence['landmarkLayouts']=[];
        if(town.publicBuildings.length) {
          const result=createWorldSettlementLandmarkLayout(plan,town.id,sample,
            {kind:town.kind,pattern:town.pattern,density:town.density,waterfrontBias:town.waterfrontBias??0},town.publicBuildings);
          patch=result.patch;
          layouts.push({id:`${town.id}-${site.id}-${town.pattern}-landmarks`,townId:town.id,
            candidateId:site.id,pattern:town.pattern,landmarks:result.landmarks});
        }
        viable.push(site);landmarkLayouts.push(...layouts);
        if(viable.length>=2) break;
      } catch(error) {failures.push({candidateId:site.id,reason:error instanceof Error?error.message:String(error)});}
    }
    if(!viable.length) throw new Error('world_no_settlement_candidates:'+town.id+':'+JSON.stringify(failures));
    evidence.candidates=viable;
  }
  type CandidateRoute={from:WorldSiteCandidate;to:WorldSiteCandidate;fromPort:[number,number];toPort:[number,number];
    fromLocal:NonNullable<ReturnType<typeof findWorldRoute>>;toLocal:NonNullable<ReturnType<typeof findWorldRoute>>;
    route:NonNullable<ReturnType<typeof findWorldRoute>>};
  const candidateRoutes=new Map<string,CandidateRoute|null>(),selected=new Map<string,WorldSiteCandidate>();
  const landmarkCache=new Map<string,TownBuilding[]|null>();
  let routeChecks=0,planChecks=0,lastFailure='world_no_candidate_graph';
  const candidateRoute=(road:WorldIntentRoad,from:WorldSiteCandidate,to:WorldSiteCandidate):CandidateRoute|null=>{
    const key=`${road.id}:${from.id}:${to.id}`;
    if(candidateRoutes.has(key)) return candidateRoutes.get(key)!;
    if(routeChecks++>=64) return null;
    const fromTown=intent.plan.towns.find(t=>t.id===road.fromTownId)!,toTown=intent.plan.towns.find(t=>t.id===road.toTownId)!;
    const fp=portToward(from,to,fromTown.radius),tp=portToward(to,from,toTown.radius);
    const fromPort:[number,number]=[from.center[0]+fp[0],from.center[1]+fp[1]],toPort:[number,number]=[to.center[0]+tp[0],to.center[1]+tp[1]];
    const spacing=worldRoadSampleSpacing(intent.plan.recipe.size);
    const fromLocal=findWorldRoute(sample,from.center,fromPort,road.width,spacing);
    const toLocal=findWorldRoute(sample,to.center,toPort,road.width,spacing);
    const route=fromLocal&&toLocal?findWorldRoute(sample,fromPort,toPort,road.width,spacing):null;
    const result=fromLocal&&toLocal&&route?{from,to,fromPort:fp,toPort:tp,fromLocal,toLocal,route}:null;
    candidateRoutes.set(key,result);return result;
  };
  type ValidatedGraph={plan:WorldPlan;sample:ReturnType<typeof createWorldSampler>;layouts:WorldSitingEvidence['landmarkLayouts']};
  const validateGraph=():ValidatedGraph|null=>{
    if(planChecks++>=16) return null;
    const construction:WorldTerrainBrush[]=[],ports=new Map<string,WorldPlan['towns'][number]['ports']>();
    const pairs=intent.plan.roads.map(road=>{
      const pair=candidateRoute(road,selected.get(road.fromTownId)!,selected.get(road.toTownId)!);
      if(!pair) throw new Error('world_no_route_candidates:'+road.id);
      construction.push(gradeAccess(`access-${road.id}-${road.fromTownId}`,pair.fromLocal.points,road.width,sample),
        gradeAccess(`access-${road.id}-${road.toTownId}`,pair.toLocal.points,road.width,sample));
      ports.set(road.fromTownId,[...(ports.get(road.fromTownId)??[]),{id:`${road.id}-${road.fromTownId}`,guideId:road.id,position:pair.fromPort,width:road.width}]);
      ports.set(road.toTownId,[...(ports.get(road.toTownId)??[]),{id:`${road.id}-${road.toTownId}`,guideId:road.id,position:pair.toPort,width:road.width}]);
      return {road,pair};
    });
    const recipe={...intent.plan.recipe,terrainBrushes:[...(intent.plan.recipe.terrainBrushes??[]),...construction]};
    const planned=cachedWorldSampler(createWorldSampler(recipe));
    const spacing=worldRoadSampleSpacing(recipe.size);
    const roads:WorldPlan['roads']=[];
    for(const {road,pair} of pairs) {
      const fromPort:[number,number]=[pair.from.center[0]+pair.fromPort[0],pair.from.center[1]+pair.fromPort[1]];
      const toPort:[number,number]=[pair.to.center[0]+pair.toPort[0],pair.to.center[1]+pair.toPort[1]];
      const route=findWorldRoute(planned,fromPort,toPort,road.width,spacing);
      if(!route) {lastFailure='world_no_route_candidates:'+road.id;return null;}
      roads.push({id:road.id,name:road.name,points:route.points,curve:'polyline',closed:false,width:road.width,tags:road.tags});
    }
    const plan:WorldPlan={version:1,id:intent.plan.id,revision:intent.plan.revision,prompt:intent.plan.prompt,recipe,
      ecology:intent.plan.ecology,roads,towns:intent.plan.towns.filter(town=>connectedTownIds.has(town.id)).map(town=>{
        const site=selected.get(town.id)!;return {id:town.id,name:town.name,prompt:town.prompt,center:site.center,
          radius:town.radius,blend:town.blend,foundation:site.foundation,terrainMode:'conform',ports:ports.get(town.id)??[],
          ...(town.targetWaterBodyId?{targetWaterBodyId:town.targetWaterBodyId}:{}),...(town.population?{population:town.population}:{})};})};
    const layouts:WorldSitingEvidence['landmarkLayouts']=[];
    try {
      const plannedTowns=intent.plan.towns.filter(item=>connectedTownIds.has(item.id))
        .sort((a,b)=>a.publicBuildings.length-b.publicBuildings.length);
      for(const town of plannedTowns) {
        let patch=generateWorldSettlement(plan,town.id,planned,{kind:town.kind,pattern:town.pattern,density:town.density,waterfrontBias:town.waterfrontBias??0});
        if(!town.publicBuildings.length) continue;
        const site=selected.get(town.id)!,townPlan=plan.towns.find(item=>item.id===town.id)!;
        const key=`${town.id}:${site.id}:${town.pattern}:${townPlan.ports.map(port=>`${port.position[0]},${port.position[1]},${port.width}`).join('|')}`;
        let landmarks=landmarkCache.get(key);
        if(landmarks===undefined&&!landmarkCache.has(key)) {
          try {
            const result=createWorldSettlementLandmarkLayout(plan,town.id,planned,
              {kind:town.kind,pattern:town.pattern,density:town.density,waterfrontBias:town.waterfrontBias??0},town.publicBuildings);
            landmarks=result.landmarks;patch=result.patch;
            landmarkCache.set(key,landmarks);
          } catch {landmarkCache.set(key,null);landmarks=null;}
        } else if(landmarks) {
          patch=generateWorldSettlement(plan,town.id,planned,{kind:town.kind,pattern:town.pattern,density:town.density,
            waterfrontBias:town.waterfrontBias??0,landmarks});
        }
        if(!landmarks) throw new Error('world_no_landmark_layout:'+town.id);
        layouts.push({id:`${town.id}-${site.id}-${town.pattern}-landmarks`,townId:town.id,candidateId:site.id,
          pattern:town.pattern,landmarks});
      }
      return {plan,sample:planned,layouts};
    } catch(error) {lastFailure=error instanceof Error?error.message:String(error);return null;}
  };
  const chooseGraph=(roadIndex:number):ValidatedGraph|null=>{
    if(roadIndex===intent.plan.roads.length) return validateGraph();
    const road=intent.plan.roads[roadIndex],fromExisting=selected.get(road.fromTownId),toExisting=selected.get(road.toTownId);
    const fromCandidates=fromExisting?[fromExisting]:towns.find(t=>t.id===road.fromTownId)!.candidates;
    const toCandidates=toExisting?[toExisting]:towns.find(t=>t.id===road.toTownId)!.candidates;
    const pairs:Array<[WorldSiteCandidate,WorldSiteCandidate]>=[];
    for(let rank=0;rank<fromCandidates.length+toCandidates.length-1;rank++) for(let fromIndex=0;fromIndex<fromCandidates.length;fromIndex++) {
      const toIndex=rank-fromIndex;
      if(toIndex>=0&&toIndex<toCandidates.length) pairs.push([fromCandidates[fromIndex],toCandidates[toIndex]]);
    }
    for(const [from,to] of pairs) {
      const fits=(townId:string,candidate:WorldSiteCandidate)=>{const town=intent.plan.towns.find(item=>item.id===townId)!;return [...selected].every(([otherId,other])=>{
        if(otherId===townId) return true;
        const otherTown=intent.plan.towns.find(item=>item.id===otherId)!;
        return Math.abs(candidate.center[0]-other.center[0])>=town.radius+otherTown.radius
          ||Math.abs(candidate.center[1]-other.center[1])>=town.radius+otherTown.radius;
      });};
      if(!fromExisting&&!fits(road.fromTownId,from)) continue;
      if(!fromExisting) selected.set(road.fromTownId,from);
      if(!toExisting&&!fits(road.toTownId,to)) {if(!fromExisting) selected.delete(road.fromTownId);continue;}
      if(!toExisting) selected.set(road.toTownId,to);
      const result=candidateRoute(road,from,to)?chooseGraph(roadIndex+1):null;
      if(result) return result;
      if(!fromExisting) selected.delete(road.fromTownId);
      if(!toExisting) selected.delete(road.toTownId);
    }
    return null;
  };
  if(intent.plan.roads.length) {
    const graph=chooseGraph(0);
    if(!graph) throw new Error(`${routeChecks>=64||planChecks>=16?'world_siting_search_budget':'world_no_candidate_graph'}:${lastFailure}`);
    landmarkLayouts.push(...graph.layouts);
    for(const town of towns) if(connectedTownIds.has(town.id)) town.candidates=[selected.get(town.id)!];
    for(const road of intent.plan.roads) {
      const pair=candidateRoute(road,selected.get(road.fromTownId)!,selected.get(road.toTownId)!)!;
      connections.push({roadId:road.id,fromCandidateId:pair.from.id,toCandidateId:pair.to.id,available:true,
        length:pair.route.length,maxSlope:pair.route.maxSlope});
    }
  }
  return {towns,connections,landmarkLayouts};
}

export function auditWorldIslandBoundary(prompt:string,recipe:WorldRecipe,
  sample:ReturnType<typeof createWorldSampler> = createWorldSampler(recipe)):
  {samples:number;drySamples:number;dryRatio:number;maxHeight:number}|null {
  if(!/\bisland\b|海岛|岛屿/i.test(prompt)) return null;
  const half=recipe.size/2,points:Array<[number,number]>=[],steps=20;
  for(let index=0;index<=steps;index++) {
    const value=-half+recipe.size*index/steps;
    points.push([-half,value],[half,value],[value,-half],[value,half]);
  }
  const heights=points.map(([x,z])=>sample(x,z).height);
  const drySamples=heights.filter(height=>height>2).length;
  return {samples:heights.length,drySamples,dryRatio:drySamples/heights.length,maxHeight:Math.max(...heights)};
}

export function auditWorldIslandLandmass(prompt:string,recipe:WorldRecipe,
  towns:ReadonlyArray<Pick<WorldIntentTown,'radius'>>,
  sample:ReturnType<typeof createWorldSampler> = createWorldSampler(recipe)):
  {samples:number;drySamples:number;largestDryComponentSamples:number;requiredDrySamples:number;
    minSpan:number;requiredSpan:number;adequate:boolean}|null {
  if(!/\bisland\b|海岛|岛屿/i.test(prompt)||!towns.length) return null;
  const side=17,half=recipe.size/2,step=recipe.size/(side-1),dry:boolean[]=[];
  for(let z=0;z<side;z++) for(let x=0;x<side;x++) {
    const value=sample(-half+x*step,-half+z*step);
    dry.push(value.waterLevel===null&&value.height>2);
  }
  let drySamples=0,largestDryComponentSamples=0,minSpan=0;
  const seen=new Set<number>();
  for(let start=0;start<dry.length;start++) {
    if(!dry[start]||seen.has(start)) continue;
    const pending=[start];seen.add(start);
    let count=0,minX=side,maxX=0,minZ=side,maxZ=0;
    while(pending.length) {
      const index=pending.pop()!,x=index%side,z=Math.floor(index/side);
      count++;drySamples++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minZ=Math.min(minZ,z);maxZ=Math.max(maxZ,z);
      for(const next of [index-1,index+1,index-side,index+side]) {
        if(next<0||next>=dry.length||seen.has(next)||!dry[next]) continue;
        const nextX=next%side,nextZ=Math.floor(next/side);
        if(Math.abs(nextX-x)+Math.abs(nextZ-z)!==1) continue;
        seen.add(next);pending.push(next);
      }
    }
    if(count>largestDryComponentSamples) {
      largestDryComponentSamples=count;
      minSpan=Math.min((maxX-minX+1)*step,(maxZ-minZ+1)*step);
    }
  }
  const requiredArea=towns.reduce((sum,town)=>sum+4*town.radius*town.radius,0);
  const requiredDrySamples=Math.ceil(requiredArea/(step*step));
  const requiredSpan=2*Math.max(...towns.map(town=>town.radius));
  return {samples:dry.length,drySamples,largestDryComponentSamples,requiredDrySamples,minSpan,requiredSpan,
    adequate:largestDryComponentSamples>=requiredDrySamples&&minSpan>=requiredSpan};
}

export function materializeWorldIntent(intent: WorldIntentDraft, evidence: WorldSitingEvidence, input: unknown,
  request: WorldGenerationRequest): ReturnType<typeof compileWorldDraft> {
  const root=exactRecord(structuredClone(input),['towns','settlements','assets'],'invalid_world_layout','world_unknown_layout_field');
  if(!Array.isArray(root.towns)) throw new Error('invalid_world_layout');
  const chosen=new Map<string,WorldSiteCandidate>(),chosenLayouts=new Map<string,WorldSitingEvidence['landmarkLayouts'][number]>();
  for(const value of root.towns) {
    const item=exactRecord(value,['townId','candidateId','landmarkLayoutId'],'invalid_world_layout','world_unknown_layout_town_field');
    if(typeof item.townId!=='string'||typeof item.candidateId!=='string'||chosen.has(item.townId)) throw new Error('invalid_world_layout');
    const candidate=evidence.towns.find(t=>t.id===item.townId)?.candidates.find(c=>c.id===item.candidateId);
    if(!candidate) throw new Error('world_unknown_site_candidate:'+item.townId);
    chosen.set(item.townId,candidate);
    const town=intent.plan.towns.find(candidate=>candidate.id===item.townId)!;
    if(town.publicBuildings.length) {
      if(typeof item.landmarkLayoutId!=='string') throw new Error('world_landmark_layout_required:'+town.id);
      const layout=evidence.landmarkLayouts.find(candidate=>candidate.id===item.landmarkLayoutId
        &&candidate.townId===town.id&&candidate.candidateId===item.candidateId);
      if(!layout) throw new Error('world_unknown_landmark_layout:'+town.id);
      chosenLayouts.set(town.id,layout);
    } else if(item.landmarkLayoutId!==undefined) throw new Error('world_unexpected_landmark_layout:'+town.id);
  }
  if(chosen.size!==intent.plan.towns.length||intent.plan.towns.some(t=>!chosen.has(t.id))) throw new Error('world_site_choice_mismatch');
  const sample=cachedWorldSampler(createWorldSampler(intent.plan.recipe)),ports=new Map<string,Array<{id:string;guideId:string;position:[number,number];width:number}>>(),construction:WorldTerrainBrush[]=[];
  const roadParts=intent.plan.roads.map(road=>{
    const from=chosen.get(road.fromTownId)!,to=chosen.get(road.toTownId)!;
    if(!evidence.connections.some(item=>item.roadId===road.id&&item.fromCandidateId===from.id
      &&item.toCandidateId===to.id&&item.available)) throw new Error('world_incompatible_site_choice:'+road.id);
    const fromTown=intent.plan.towns.find(t=>t.id===road.fromTownId)!,toTown=intent.plan.towns.find(t=>t.id===road.toTownId)!;
    const fp=portToward(from,to,fromTown.radius),tp=portToward(to,from,toTown.radius);
    const fromPort:[number,number]=[from.center[0]+fp[0],from.center[1]+fp[1]],toPort:[number,number]=[to.center[0]+tp[0],to.center[1]+tp[1]];
    const spacing=worldRoadSampleSpacing(intent.plan.recipe.size);
    const fromAccess=findWorldRoute(sample,from.center,fromPort,road.width,spacing);
    const toAccess=findWorldRoute(sample,to.center,toPort,road.width,spacing);
    if(!fromAccess||!toAccess) throw new Error('world_town_access_unreachable:'+road.id);
    construction.push(gradeAccess(`access-${road.id}-${fromTown.id}`,fromAccess.points,road.width,sample),
      gradeAccess(`access-${road.id}-${toTown.id}`,toAccess.points,road.width,sample));
    ports.set(fromTown.id,[...(ports.get(fromTown.id)??[]),{id:`${road.id}-${fromTown.id}`,guideId:road.id,position:fp,width:road.width}]);
    ports.set(toTown.id,[...(ports.get(toTown.id)??[]),{id:`${road.id}-${toTown.id}`,guideId:road.id,position:tp,width:road.width}]);
    return {road,fromPort,toPort};
  });
  const towns=intent.plan.towns.map(town=>{const site=chosen.get(town.id)!;return {id:town.id,name:town.name,prompt:town.prompt,
    center:site.center,radius:town.radius,blend:town.blend,foundation:site.foundation,terrainMode:'conform' as const,ports:ports.get(town.id)??[],
    ...(town.targetWaterBodyId?{targetWaterBodyId:town.targetWaterBodyId}:{}),...(town.population?{population:town.population}:{})};});
  const recipe={...intent.plan.recipe,terrainBrushes:[...(intent.plan.recipe.terrainBrushes??[]),...construction]};
  const planned=cachedWorldSampler(createWorldSampler(recipe)),spacing=worldRoadSampleSpacing(recipe.size);
  const roads=roadParts.map(({road,fromPort,toPort})=>{
    const route=findWorldRoute(planned,fromPort,toPort,road.width,spacing);
    if(!route) throw new Error('world_road_unreachable:'+road.id);
    return {id:road.id,name:road.name,points:route.points,curve:'polyline' as const,closed:false,width:road.width,tags:road.tags};
  });
  const plan={version:1 as const,id:intent.plan.id,revision:intent.plan.revision,prompt:intent.plan.prompt,
    recipe,ecology:intent.plan.ecology,towns,roads};
  if(!Array.isArray(root.settlements)) throw new Error('invalid_world_layout');
  const selectedSettlements=root.settlements.map(value=>{
    const command=record(value,'invalid_world_settlement_command');
    if(typeof command.townId!=='string'||!command.options||typeof command.options!=='object') return command;
    const town=intent.plan.towns.find(item=>item.id===command.townId),layout=chosenLayouts.get(command.townId);
    if(!town) return command;
    const options=record(command.options,'invalid_world_settlement_options');
    if(options.landmarks!==undefined) throw new Error('world_layout_landmark_coordinates_forbidden:'+town.id);
    const unsupported=Object.keys(options).find(key=>!['kind','pattern','density','waterfrontBias'].includes(key));
    if(unsupported) throw new Error('world_layout_unsupported_option:'+town.id+':'+unsupported);
    if(options.kind!==town.kind||options.pattern!==town.pattern||options.density!==town.density
      ||(options.waterfrontBias??0)!==(town.waterfrontBias??0)) throw new Error('world_layout_settlement_intent_mismatch:'+town.id);
    return layout?{...command,options:{...options,landmarks:layout.landmarks}}:command;
  });
  const draftInput={plan,settlements:selectedSettlements,assets:root.assets};
  const validateCompiled=(compiled:ReturnType<typeof compileWorldDraft>)=>{
    for(const town of intent.plan.towns) {
      const patch=compiled.bundle.patches.find(item=>item.townId===town.id);
      if(!patch) throw new Error('world_settlement_missing_patch:'+town.id);
    }
    return compiled;
  };
  try {return validateCompiled(compileWorldDraft(draftInput,request));}
  catch(error) {
    const reason=error instanceof Error?error.message:String(error);
    if(!/^world_settlement_(?:landmark_unreachable|invalid_landmark):/.test(reason)) throw error;
    const checkedPlan=validateWorldPlan(plan),planned=createWorldSampler(checkedPlan.recipe),resolutions:unknown[]=[];
    const settlements=selectedSettlements.map(value=>{
      const command=record(value,'invalid_world_settlement_command');
      if(typeof command.townId!=='string'||!command.options||typeof command.options!=='object') throw error;
      const resolved=resolveWorldSettlementLandmarks(checkedPlan,command.townId,planned,command.options as WorldSettlementOptions);
      resolutions.push(...resolved.resolutions.map(item=>({townId:command.townId,...item})));
      return {...command,options:resolved.options};
    });
    if(resolutions.length) recordGenerationTrace('world.materialized',{landmarks:resolutions});
    return validateCompiled(compileWorldDraft({...draftInput,settlements},request));
  }
}

export function validateWorldAssetRequests(
  input: unknown,
  plan: WorldPlan,
  request: WorldGenerationRequest,
  patches: TownPatch[],
  requireCoverage = request.generateAssets !== false
): WorldAssetRequest[] {
  if (!Array.isArray(input) || input.length > WORLD_ASSET_FAMILY_LIMIT) throw new Error('invalid_world_draft');
  const keys = new Set<string>();
  const assets = input.map(assetInput => exactRecord(assetInput,
    ['key','name','role','prompt','dimensions','enterable','strategy','existingAssetId','ecologyKind','ecologyRuleId'],
    'invalid_world_asset_request','world_unknown_asset_field')) as unknown as WorldAssetRequest[];
  for (const asset of assets) {
    const ecologyRule=asset.ecologyRuleId?plan.ecology.find(rule=>rule.id===asset.ecologyRuleId):undefined;
    if (!asset || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(asset.key) || keys.has(asset.key)
      || !['house','shop','workshop','tree','landmark'].includes(asset.role)
      || typeof asset.name !== 'string' || !asset.name.trim() || asset.name.length>160
      || typeof asset.prompt !== 'string' || !asset.prompt.trim() || asset.prompt.length>6000
      || (asset.strategy!==undefined && !['single','assembly'].includes(asset.strategy))
      || (asset.enterable!==undefined && typeof asset.enterable!=='boolean')
      || (asset.existingAssetId!==undefined && (typeof asset.existingAssetId!=='string'
        || !request.reusableAssetIds?.includes(asset.existingAssetId)))
      || asset.role==='tree' && (!asset.ecologyRuleId || !asset.ecologyKind || !ecologyRule || ecologyRule.kind!==asset.ecologyKind)
      || asset.role!=='tree' && (asset.ecologyRuleId!==undefined || asset.ecologyKind!==undefined)
      || (asset.dimensions!==undefined && (!Array.isArray(asset.dimensions)||asset.dimensions.length!==3
        ||asset.dimensions.some(n=>!Number.isFinite(n)||n<=0||n>300)))) throw new Error('invalid_world_asset_request');
    worldAssetStrategy(asset);
    keys.add(asset.key);
  }
  for (const patch of patches) for (const building of patch.buildings) {
    if (building.assetKey && !keys.has(building.assetKey)) throw new Error('unknown_world_building_asset:'+building.assetKey);
    if (building.enterable && !assets.find(asset=>asset.key===building.assetKey)?.enterable) throw new Error('world_enterable_asset_required');
  }
  if (requireCoverage) {
    const roles=new Set(assets.map(asset=>asset.role));
    const missingRoles=new Set<string>();
    for (const building of patches.flatMap(patch=>patch.buildings).filter(building=>!building.assetKey)) {
      const role=/工|仓|农具|workshop|factory/i.test(building.use)?'workshop'
        :/商|店|客|shop|market|inn/i.test(building.use)?'shop':'house';
      if(!roles.has(role)) missingRoles.add(role);
    }
    if(missingRoles.size) throw new Error('world_missing_asset_roles:'+[...missingRoles].join(','));
    const ecologyRuleIds=new Set(assets.filter(asset=>asset.role==='tree').map(asset=>asset.ecologyRuleId));
    const missingEcology=plan.ecology.filter(rule=>!ecologyRuleIds.has(rule.id)).map(rule=>rule.id);
    if(missingEcology.length) throw new Error('world_missing_ecology_assets:'+missingEcology.join(','));
  }
  return assets;
}

export function compileWorldDraft(input: unknown, request: WorldGenerationRequest): {draft:WorldDraft;bundle:WorldBundle} {
  const root = exactRecord(structuredClone(input), ['plan','settlements','assets'], 'invalid_world_draft', 'world_unknown_draft_field');
  const rawPlan = record(root.plan, 'invalid_world_draft'), rawRecipe = record(rawPlan.recipe, 'invalid_world_draft');
  if (rawRecipe.seed !== request.seed || rawRecipe.size !== request.size) throw new Error('world_recipe_request_mismatch');
  const recipe = validateWorldRecipe(rawRecipe as unknown as WorldPlan['recipe']);
  const sample = cachedWorldSampler(createWorldSampler(recipe));
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
  const plan = validateWorldPlan({...rawPlan,prompt:requestOwnedPrompt(rawPlan,request,'draft'),recipe,towns});
  if (!Array.isArray(root.settlements)) throw new Error('invalid_world_draft');
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
  const assets = validateWorldAssetRequests(root.assets, plan, request, patches);
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

function bindExactReusableAssetKeys(assets: WorldAssetRequest[], reusableAssets: ReusableWorldAsset[]): WorldAssetRequest[] {
  const offered=new Map(reusableAssets.map(asset=>[asset.id,asset]));
  return assets.map(asset=>{
    if(asset.existingAssetId || !offered.has(asset.key)) return asset;
    const reusable=offered.get(asset.key)!,tags=new Set([...(reusable.tags??[]),...(reusable.libraryMetadata?.tags??[])]
      .map(tag=>tag.toLowerCase()));
    if(asset.dimensions?.some((value,index)=>Math.abs(value-reusable.visualSize[index])>Math.max(0.1,value*.1))) {
      throw new Error(`world_reusable_asset_conflict:${asset.key}:dimensions:requested=${asset.dimensions.join('x')}:available=${reusable.visualSize.join('x')}`);
    }
    const taggedRole=(['house','shop','workshop','tree','landmark'] as const).find(role=>tags.has(role));
    if(taggedRole&&taggedRole!==asset.role) {
      throw new Error(`world_reusable_asset_conflict:${asset.key}:role:requested=${asset.role}:available=${taggedRole}`);
    }
    if(asset.enterable===true&&tags.has('non-enterable')) {
      throw new Error(`world_reusable_asset_conflict:${asset.key}:enterability:requested=enterable:available=non-enterable`);
    }
    return {...asset,existingAssetId:asset.key};
  });
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

export async function generateWorldAssets(
  requests: WorldAssetRequest[],
  store: MapStore,
  signal?: AbortSignal,
  options: { directOnly?: boolean; maxNewAssets?: number } = {}
): Promise<WorldAssetResult[]> {
  const newAssetCount=requests.filter(request=>!request.existingAssetId).length;
  if(options.maxNewAssets!==undefined&&newAssetCount>options.maxNewAssets) throw new Error('world_whitebox_asset_generation_limit');
  const results:WorldAssetResult[]=[];
  // Two backend requests at a time keep cost and peak memory bounded.
  for(let i=0;i<requests.length;i+=2) {
    const batch=await Promise.all(requests.slice(i,i+2).map(async request=>{
      const strategy=worldAssetStrategy(request);
      if(options.directOnly&&strategy!=='single') throw new Error('world_whitebox_direct_asset_required');
      if(request.existingAssetId) {
        const asset=await store.loadAsset(request.existingAssetId);
        return {id:request.key,name:request.name,role:request.role,modelJson:asset.modelJson,
          assetId:asset.id,provider:'existing' as const,strategy,
          ...(request.ecologyKind?{ecologyKind:request.ecologyKind}:{}),
          ...(request.ecologyRuleId?{ecologyRuleId:request.ecologyRuleId}:{})};
      }
      let modelJson:unknown;
      if(strategy==='assembly') {
        const [w,h,d]=request.dimensions??[32,16,32];
        const architecturePrompt=buildWorldArchitecturePrompt(request.prompt,request.dimensions);
        const map=createEmptyMap(request.name,undefined,[Math.max(16,w+8),Math.max(16,h+4),Math.max(16,d+8)],'voxel-pro');
        const generated:MapAsset[]=[];
        const createAsset=createMapAssetGenerator(store,map,[],'deepseek',null,signal??new AbortController().signal);
        const suggestion=await generateMapCodeSuggestion(
          architecturePrompt,
          map,[],{provider:'gpt',promptMode:'main',scope:'scene',minNewAssets:2,maxNewAssets:6,spatialPolicy:'diagnose',
            userPromptMaxChars:WORLD_ARCHITECTURE_PROMPT_MAX_CHARS,signal,
            createAsset:async(r,report)=>{const a=await createAsset(r,report);generated.push(a);return a;}});
        const result=applyMapOperations(map,suggestion.operations);
        modelJson=assembleWorldModel(result,generated);
        recordGenerationTrace('world.assembly',{key:request.key,code:suggestion.codePlan,objects:result.objects.length,assets:generated.map(a=>a.id)});
      } else {
        modelJson=await generateModel(request.prompt,{providers:['deepseek'],mode:'voxel-pro',signal});
      }
      const saved=await store.saveAsset({name:request.name,prompt:request.prompt,modelJson,mode:'voxel-pro',provider:'deepseek'});
      return {id:request.key,name:request.name,role:request.role,modelJson,assetId:saved.id,provider:'deepseek' as const,strategy,
        ...(request.ecologyKind?{ecologyKind:request.ecologyKind}:{}),
        ...(request.ecologyRuleId?{ecologyRuleId:request.ecologyRuleId}:{})};
    }));
    results.push(...batch);
  }
  return results;
}

function omitUnboundExplicitBuildings(
  patches: TownPatch[],
  assetKeys: ReadonlySet<string>,
  issue: (townId: string, value: string) => void
): TownPatch[] {
  return patches.map(patch => ({ ...patch, buildings: patch.buildings.filter(building => {
    if (!building.assetKey || assetKeys.has(building.assetKey)) return true;
    issue(patch.townId, `explicit_asset_unbound:${building.id}:${building.assetKey}`);
    return false;
  }) }));
}

async function generateWorldFromWhitebox(input: unknown, store: MapStore, signal?: AbortSignal) {
  const rawPlan=(input as {whiteboxPlan?:unknown})?.whiteboxPlan;
  const request=validateWorldWhiteboxConstructionRequest(input);
  const reusableAssets=await Promise.all((request.reusableAssetIds??[]).map(async id=>{
    const asset=await store.loadAsset(id).catch(()=>null);
    if(!asset) throw new Error('unknown_reusable_world_asset:'+id);
    const bounds=calculateModelVisualFrame(asset.modelJson).bounds;
    return {id:asset.id,name:asset.name,prompt:asset.prompt,tags:asset.tags??[],mode:asset.mode,
      visualSize:[bounds.max[0]-bounds.min[0],bounds.max[1]-bounds.min[1],bounds.max[2]-bounds.min[2]] as [number,number,number],
      ...(asset.libraryMetadata?{libraryMetadata:asset.libraryMetadata}:{})};
  }));
  const content=await llmChat([
    {role:'system',content:WHITEBOX_CONSTRUCTION_PROMPT},
    {role:'user',content:JSON.stringify({whiteboxPlan:request.whiteboxPlan,assetGenerationLimit:request.assetGenerationLimit,
      generateAssets:request.generateAssets,...(reusableAssets.length?{reusableAssets}:{})})}
  ],{provider:'gpt',maxTokens:16000,temperature:.2,maxAttempts:1,traceStage:'world.whitebox.construction',signal});
  recordGenerationTrace('world.whitebox.construction.raw',{content});
  const materialized=materializeWorldWhiteboxConstruction(content,request);
  const diagnostics=new Map(materialized.diagnostics.map(item=>[item.townId,[...item.planningIssues]]));
  const issue=(townId:string,value:string)=>diagnostics.set(townId,[...diagnostics.get(townId)??[],value]);
  const terrain=createWorldTerrainContext(materialized.plan.recipe),sample=terrain.sample,patches:TownPatch[]=[];
  for(const town of materialized.towns) {
    if(!materialized.plan.towns.some(item=>item.id===town.id)) continue;
    const options:Omit<WorldSettlementOptions,'landmarks'>={kind:town.kind,pattern:town.pattern,density:town.density,
      ...(town.waterfrontBias===undefined?{}:{waterfrontBias:town.waterfrontBias})};
    try {
      const patch=town.publicBuildings.length
        ? createWorldSettlementLandmarkLayout(materialized.plan,town.id,sample,options,town.publicBuildings).patch
        : generateWorldSettlement(materialized.plan,town.id,sample,options);
      patches.push(patch);
    } catch(error) {
      const reason=error instanceof Error?error.message:String(error);
      issue(town.id,'construction_unrealized:'+reason);
      if(town.publicBuildings.length) {
        try {
          patches.push(generateWorldSettlement(materialized.plan,town.id,sample,options));
          issue(town.id,'public_buildings_unrealized');
        } catch(baseError) {
          issue(town.id,'base_construction_unrealized:'+(baseError instanceof Error?baseError.message:String(baseError)));
        }
      }
    }
  }
  const validationRequest:WorldGenerationRequest={prompt:materialized.plan.prompt,seed:materialized.plan.recipe.seed,
    size:materialized.plan.recipe.size,generateAssets:false,repairAttempts:0,
    ...(request.reusableAssetIds?.length?{reusableAssetIds:request.reusableAssetIds}:{})};
  let assetRequests=validateWorldAssetRequests(materialized.assets,materialized.plan,validationRequest,[],false);
  assetRequests=bindExactReusableAssetKeys(assetRequests,reusableAssets);
  const requestedPatches=omitUnboundExplicitBuildings(patches,new Set(assetRequests.map(asset=>asset.key)),issue);
  validateWorldAssetRequests(assetRequests,materialized.plan,validationRequest,requestedPatches,false);
  let paidCallCount=1,assetSources:WorldAssetResult[]=[];
  const scheduledAssets=selectUsedWorldAssetRequests(assetRequests,materialized.plan,requestedPatches);
  const generationQueue=request.generateAssets?scheduledAssets:scheduledAssets.filter(asset=>asset.existingAssetId);
  for(const asset of generationQueue) {
    if(!asset.existingAssetId) paidCallCount++;
    try {
      assetSources.push(...await generateWorldAssets([asset],store,signal,{directOnly:true,maxNewAssets:1}));
    } catch(error) {
      issue('world','asset_generation_failed:'+(error instanceof Error?error.message:String(error)));
      recordGenerationTrace('world.whitebox.construction.asset-error',{key:asset.key,error});
      break;
    }
  }
  const visiblePatches=omitUnboundExplicitBuildings(requestedPatches,new Set(assetSources.map(asset=>asset.id)),issue);
  for(const diagnostic of auditWorldWhiteboxSettlementConstruction(materialized.plan,materialized.towns,
    materialized.settlements,visiblePatches)) {
    for(const planningIssue of diagnostic.planningIssues) issue(diagnostic.townId,planningIssue);
  }
  const bundle=validateWorldBundle({plan:materialized.plan,patches:visiblePatches});
  const resultDiagnostics:WorldConstructionDiagnostic[]=[...diagnostics]
    .map(([townId,planningIssues])=>({townId,planningIssues}));
  resultDiagnostics.push(...diagnoseWorldRiverSurfaceAboveBank(terrain));
  const draft:WorldDraft={plan:materialized.plan,settlements:materialized.settlements,assets:assetRequests};
  recordGenerationTrace('world.whitebox.construction.preview',{draft,diagnostics:resultDiagnostics,
    paidCallCount,assets:assetSources.map(asset=>({id:asset.id,assetId:asset.assetId,provider:asset.provider}))});
  return {bundle,draft,diagnostics:resultDiagnostics,assetSources,originalPlan:structuredClone(rawPlan),
    planningProvider:'gpt' as const,assetProvider:'deepseek' as const,paidCallCount,preview:true,
    mode:'construct-whitebox' as const};
}

function validateCompleteWorldGenerationRequest(input: unknown): CompleteWorldGenerationRequest {
  const raw=exactRecord(input,['mode','prompt','seed','size','generateAssets','repairAttempts','reusableAssetIds','assetGenerationLimit'],
    'invalid_complete_world_generation_request','world_unknown_complete_generation_request_field');
  const request=validateWorldGenerationRequest(raw);
  if(raw.mode!=='generate-complete'||request.size!==500||request.repairAttempts!==0
    ||(raw.assetGenerationLimit!==undefined&&(!Number.isInteger(raw.assetGenerationLimit)
      ||(raw.assetGenerationLimit as number)<0||(raw.assetGenerationLimit as number)>3))) {
    throw new Error('invalid_complete_world_generation_request');
  }
  return {...request,mode:'generate-complete',size:500,repairAttempts:0,
    assetGenerationLimit:raw.assetGenerationLimit===undefined?3:raw.assetGenerationLimit as number};
}

async function generateCompleteWorld(input: unknown, store: MapStore, signal?: AbortSignal) {
  const request=validateCompleteWorldGenerationRequest(input);
  const whitebox=await generateWorldWhitebox({mode:'whitebox',prompt:request.prompt,seed:request.seed,size:500,
    generateAssets:false,repairAttempts:0},signal);
  const construction=await generateWorldFromWhitebox({mode:'construct-whitebox',whiteboxPlan:whitebox.finalPlan,
    generateAssets:request.generateAssets!==false,assetGenerationLimit:request.assetGenerationLimit,repairAttempts:0,
    ...(request.reusableAssetIds?.length?{reusableAssetIds:request.reusableAssetIds}:{})},store,signal);
  return {...construction,mode:'generate-complete' as const,
    originalPlan:whitebox.originalPlan,initialPlan:whitebox.initialPlan,observation:whitebox.observation,
    adjustment:whitebox.adjustment,finalPlan:whitebox.finalPlan,finalObservation:whitebox.finalObservation,
    paidCallCount:whitebox.paidCallCount+construction.paidCallCount};
}

export async function generateWorld(input:unknown,store:MapStore,signal?:AbortSignal) {
  if (input && typeof input === 'object' && !Array.isArray(input)
    && (input as Record<string, unknown>).mode === 'generate-complete') return generateCompleteWorld(input,store,signal);
  if (input && typeof input === 'object' && !Array.isArray(input)
    && (input as Record<string, unknown>).mode === 'whitebox') return generateWorldWhitebox(input, signal);
  if (input && typeof input === 'object' && !Array.isArray(input)
    && (input as Record<string, unknown>).mode === 'construct-whitebox') return generateWorldFromWhitebox(input,store,signal);
  const request=validateWorldGenerationRequest(input);
  const reusableAssets=await Promise.all((request.reusableAssetIds??[]).map(async id=>{
    const asset=await store.loadAsset(id).catch(()=>null);
    if(!asset) throw new Error('unknown_reusable_world_asset:'+id);
    const bounds=calculateModelVisualFrame(asset.modelJson).bounds;
    return {id:asset.id,name:asset.name,prompt:asset.prompt,tags:asset.tags??[],mode:asset.mode,
      visualSize:[bounds.max[0]-bounds.min[0],bounds.max[1]-bounds.min[1],bounds.max[2]-bounds.min[2]] as [number,number,number],
      ...(asset.libraryMetadata?{libraryMetadata:asset.libraryMetadata}:{})};
  }));
  const messages:ChatMessage[]=[{role:'system',content:WORLD_INTENT_PROMPT},
    {role:'user',content:JSON.stringify({...request,...(reusableAssets.length?{reusableAssets}:{})})}];
  let compiled:ReturnType<typeof compileWorldDraft>|undefined;
  let intent:WorldIntentDraft|undefined;
  let evidence:WorldSitingEvidence|undefined;
  for(let attempt=0;attempt<=(request.repairAttempts??0);attempt++) {
    const content=await llmChat(messages,{provider:'gpt',maxTokens:16000,temperature:0.25,maxAttempts:1,traceStage:attempt?'world.intent-repair':'world.intent',signal});
    let draft:unknown;
    let proposed:WorldIntentDraft|undefined;
    try {
      draft=parseJson(content);
      proposed=parseWorldIntentDraft(draft,request);
      const sites=createWorldSitingEvidence(proposed);
      intent=proposed;
      evidence=sites;
      break;
    }
    catch(error) {
      recordGenerationTrace('world.rejected',{attempt,draft,error:error instanceof Error?error.message:String(error)});
      if(attempt===(request.repairAttempts??0)) throw error;
      const siteHints=proposed?.plan.towns.map(town=>{
        const sample=createWorldSampler(proposed!.plan.recipe);
        const candidates=findWorldSiteCandidates(proposed!.plan.recipe,town,3).map(site=>{
          const previewPlan:WorldPlan={version:1,id:proposed!.plan.id,revision:proposed!.plan.revision,
            prompt:proposed!.plan.prompt,recipe:proposed!.plan.recipe,ecology:proposed!.plan.ecology,roads:[],
            towns:[{id:town.id,name:town.name,prompt:town.prompt,center:site.center,radius:town.radius,
              blend:town.blend,foundation:site.foundation,terrainMode:'conform',ports:[],
              ...(town.targetWaterBodyId?{targetWaterBodyId:town.targetWaterBodyId}:{}),...(town.population?{population:town.population}:{})}]};
          try {
            let patch=generateWorldSettlement(previewPlan,town.id,sample,{kind:town.kind,pattern:town.pattern,
              density:town.density,waterfrontBias:town.waterfrontBias??0});
            if(town.publicBuildings.length) patch=createWorldSettlementLandmarkLayout(previewPlan,town.id,sample,
              {kind:town.kind,pattern:town.pattern,density:town.density,waterfrontBias:town.waterfrontBias??0},
              town.publicBuildings).patch;
            const quality=auditWorldSettlementAcceptance(town,patch,{
              kind:town.kind,density:town.density,waterfrontBias:town.waterfrontBias
            });
            return {center:site.center.map(value=>Math.round(value)),dryRatio:site.dryRatio,
              estimatedBuildings:patch.buildings.length,ordinaryBuildings:quality.ordinaryBuildings,
              publicBuildings:quality.publicBuildings,builtExtent:quality.builtExtent,planningIssues:quality.planningIssues,
              waterfrontConnected:patch.streets.some(street=>street.tags.includes('waterfront'))};
          } catch(error) {
            return {center:site.center.map(value=>Math.round(value)),dryRatio:site.dryRatio,
              issue:error instanceof Error?error.message:String(error)};
          }
        });
        const issues=candidates.flatMap(candidate=>'issue' in candidate&&typeof candidate.issue==='string'?[candidate.issue]:[]);
        const issueCounts=Object.fromEntries([...new Set(issues)].map(issue=>
          [issue,issues.filter(candidateIssue=>candidateIssue===issue).length]));
        return {townId:town.id,region:town.region,radius:town.radius,candidates,
          candidateUsability:{total:candidates.length,usable:candidates.length-issues.length,rejected:issues.length,
            issueCounts,allCandidatesLackBuildableNetwork:candidates.length>0
              &&issues.length===candidates.length&&issues.every(issue=>issue.includes('world_settlement_no_buildable_network'))}};
      });
      const terrainHint=proposed?(()=>{
        const sampler=createWorldSampler(proposed!.plan.recipe),half=proposed!.plan.recipe.size/2;
        let sea=0,dry=0;
        for(let z=0;z<9;z++) for(let x=0;x<9;x++) {
          const height=sampler(-half+half*x/4,-half+half*z/4).height;
          if(height<=0) sea++;
          if(height>2) dry++;
        }
        return {seaCells:sea,dryCells:dry,sampledCells:81,
          islandBoundary:auditWorldIslandBoundary(proposed!.plan.prompt,proposed!.plan.recipe,sampler),
          islandLandmass:auditWorldIslandLandmass(proposed!.plan.prompt,proposed!.plan.recipe,proposed!.plan.towns,sampler)};
      })():undefined;
      messages.push({role:'assistant',content},{role:'user',content:JSON.stringify({request:{prompt:request.prompt,seed:request.seed,size:request.size},
        error:error instanceof Error?error.message:String(error),
        ...(siteHints?{siteHints}:{}),...(terrainHint?{terrainHint}:{}),
        instruction:'Return one complete JSON object with only a plan key. Put recipe, ecology, towns and roads inside plan. Keep coordinates numeric [x,z] arrays and assign at most one biome constraint to each broad region; use bounded biome patches and landforms for interior forest and mountains. Site hints report sampled centers, ordinary-building capacity before public buildings, whether a safe waterfront street actually reaches the shore, and candidate usability per town; they are diagnostic, not authorized town coordinates. terrainHint counts 81 sampled cells, with sea height <=0 and dry height >2 metres; islandBoundary reports sampled world-edge heights, while islandLandmass reports the largest connected dry component against the combined town-core area and largest town diameter. A substantial port town must have room for its population, public buildings and an actual below-zero sea on a broad, gently sloped shore. Do not carve an abrupt circular harbor basin or a continuous coastal trench with a lower brush; let the ocean constraint form a broad shore and use gentle local cuts only. If sampled siting or the candidate graph failed, revise the terrain recipe and town regions together: create separated dry centers at least the sum of their town radii apart, with a passable route between them. If candidateUsability says allCandidatesLackBuildableNetwork, move that town region away from steep mountain terrain or shape a broad, low, gently sloped buildable terrace around it; keep the mountain terrain purposeful and do not relax settlement or route quality. world_candidate_terraces_overlap means every sampled pair for that road overlaps the square town cores; the error reports best axis separation / required sum of radii. Move or widen connected buildable terraces until at least one candidate pair meets that separation. For an island, keep the sampled world edge wet without blanket ocean constraints drowning the interior; remove non-ocean corner constraints that override cardinal ocean anchors, and put their mountain or forest detail into bounded interior patches; enlarge a broad low central landform with overlapping low interior landforms until the connected dry interior exceeds the combined 2*radius by 2*radius town cores and the largest town diameter. A compact strongly ocean-constrained island may lower global heightScale to about 0.02..0.04 and author mountain relief locally. Do not remove the sea or shrink the named towns to make room. Preserve the stated population, housing districts and public functions. world_settlement_no_landmark_site means that a named public building has no safe frontage; shape a broad, low, gently sloped civic terrace sized for its footprint and short dry street access, placing it inland unless its work truly requires the shore. Adjust public footprints and siting only as needed for plausible access. Preserve named destinations and topology; do not invent road points or settlement centers.'})});
    }
  }
  if(intent&&evidence) {
    recordGenerationTrace('world.intent',{intent});
    recordGenerationTrace('world.siting',{evidence});
    const layoutMessages:ChatMessage[]=[{role:'system',content:WORLD_LAYOUT_PROMPT},{role:'user',content:JSON.stringify({
      intent,evidence,...(reusableAssets.length?{reusableAssets}:{})})}];
    const content=await llmChat(layoutMessages,{provider:'gpt',maxTokens:16000,temperature:0.2,maxAttempts:1,traceStage:'world.layout',signal});
    let layout:unknown;
    try {layout=parseJson(content);recordGenerationTrace('world.layout.raw',{layout});compiled=materializeWorldIntent(intent,evidence,layout,request);}
    catch(error) {
      const reason=error instanceof Error?error.message:String(error);
      recordGenerationTrace('world.rejected',{stage:'layout',layout,error:reason});
      const assetRepair=/^world_missing_(?:asset_roles|ecology_assets):/.test(reason);
      const optionsRepair=/^world_layout_(?:unsupported_option|settlement_intent_mismatch):/.test(reason);
      if(request.repairAttempts===0||!assetRepair&&!optionsRepair||!layout) throw error;
      const first=record(layout,'invalid_world_layout');
      layoutMessages.push({role:'assistant',content},{role:'user',content:JSON.stringify({error:reason,
        instruction:assetRepair
          ? 'Repair only the assets array. Copy towns and settlements exactly from the previous response. Add the missing ordinary-building role family or ecology-rule binding requested by the error while keeping all existing valid landmark assets. Return one complete JSON object with only towns, settlements and assets. Do not change site choices, settlement options, intent, terrain, roads or geography.'
          : 'Repair only the settlements array. Copy towns and assets exactly from the previous response. Each options object must contain only kind, pattern, density and optional waterfrontBias, copied exactly from intent. Do not add slope, setback, seed or landmark overrides. Do not change site choices, assets, intent, terrain, roads or geography.'})});
      const repairedContent=await llmChat(layoutMessages,{provider:'gpt',maxTokens:16000,temperature:0.2,maxAttempts:1,traceStage:'world.layout-repair',signal});
      let repaired:unknown;
      try {
        repaired=parseJson(repairedContent);recordGenerationTrace('world.layout.repair.raw',{layout:repaired});
        const next=record(repaired,'invalid_world_layout');
        if(JSON.stringify(next.towns)!==JSON.stringify(first.towns)
          ||JSON.stringify(assetRepair?next.settlements:next.assets)!==JSON.stringify(assetRepair?first.settlements:first.assets)) {
          throw new Error('world_layout_repair_changed_spatial_choice');
        }
        compiled=materializeWorldIntent(intent,evidence,repaired,request);
      } catch(repairError) {
        recordGenerationTrace('world.rejected',{stage:'layout-repair',layout:repaired,
          error:repairError instanceof Error?repairError.message:String(repairError)});
        throw repairError;
      }
    }
  }
  if(!compiled) throw new Error('world_generation_failed');
  compiled.draft.assets=bindExactReusableAssetKeys(compiled.draft.assets,reusableAssets);
  const terrain=createWorldTerrainContext(compiled.bundle.plan.recipe),sample=terrain.sample;
  const landmarkKeys=new Set(compiled.draft.assets.filter(asset=>asset.role==='landmark').map(asset=>asset.key));
  const diagnostics:WorldConstructionDiagnostic[]=compiled.bundle.patches.map(p=>{
    const town=compiled.bundle.plan.towns.find(t=>t.id===p.townId)!;
    const settings=compiled.draft.settlements.find(item=>item.townId===p.townId)!.options;
    const publicBuildings=p.buildings.filter(building=>landmarkKeys.has(building.assetKey??'') || /civic|market|well|school|library|bath|council|temple|cathedral|clinic|hospital|inn|caravanserai|harbou?r|port|monument|市场|集市|水井|学校|图书馆|浴场|议事|神庙|教堂|诊所|医院|驿馆|港口|纪念/i.test(building.use)).length;
    const ordinaryBuildings=p.buildings.length-publicBuildings;
    const recommendedPublicBuildings:[number,number]=[
      ordinaryBuildings>=10?Math.max(1,Math.floor(ordinaryBuildings/20)):0,
      Math.ceil(ordinaryBuildings/10)
    ];
    const connectedPorts=town.ports.filter(port=>p.streets.some(street=>
      [street.points[0],street.points.at(-1)!].some(point=>Math.hypot(point[0]-port.position[0],point[1]-port.position[1])<1e-6))).length;
    const planningIssues:string[]=[];
    const islandBoundary=auditWorldIslandBoundary(compiled.bundle.plan.prompt,compiled.bundle.plan.recipe,sample);
    const islandLandmass=auditWorldIslandLandmass(compiled.bundle.plan.prompt,compiled.bundle.plan.recipe,
      compiled.bundle.plan.towns,sample);
    if(islandBoundary&&islandBoundary.dryRatio>.2) planningIssues.push('island_boundary_open');
    if(islandLandmass&&!islandLandmass.adequate) planningIssues.push('island_landmass_insufficient');
    if(publicBuildings<recommendedPublicBuildings[0]) planningIssues.push('missing_public_function');
    if(publicBuildings>recommendedPublicBuildings[1]&&recommendedPublicBuildings[1]>0) planningIssues.push('public_program_overconcentrated');
    if(!town.ports.length) planningIssues.push('missing_external_connection');
    else if(connectedPorts<town.ports.length) planningIssues.push('missing_port_connection');
    const coverage=auditWorldSettlementCoverage(town,p,settings,ordinaryBuildings);
    planningIssues.push(...coverage.planningIssues);
    const populationHousingTarget=town.population===undefined?undefined:Math.ceil(town.population/5);
    if(populationHousingTarget!==undefined&&ordinaryBuildings<populationHousingTarget) planningIssues.push('population_underbuilt');
    return {townId:p.townId,...auditWorldSettlement(p,town,sample),publicBuildings,ordinaryBuildings,
      recommendedPublicBuildings,connectedPorts,portCount:town.ports.length,builtExtent:coverage.builtExtent,
      ...(populationHousingTarget===undefined?{}:{population:town.population,populationHousingTarget,
        populationHousingShortfall:Math.max(0,populationHousingTarget-ordinaryBuildings)}),planningIssues};
  });
  diagnostics.push(...diagnoseWorldRiverSurfaceAboveBank(terrain));
  recordGenerationTrace('world.geometry.preview',{draft:compiled.draft,diagnostics});
  const assetSources=request.generateAssets?await generateWorldAssets(compiled.draft.assets,store,signal):undefined;
  recordGenerationTrace('world.preview',{draft:compiled.draft,diagnostics,assets:assetSources?.map(a=>({id:a.id,assetId:a.assetId,provider:a.provider,strategy:a.strategy}))});
  return {bundle:compiled.bundle,draft:compiled.draft,diagnostics,assetSources,planningProvider:'gpt',assetProvider:'deepseek',preview:true};
}
