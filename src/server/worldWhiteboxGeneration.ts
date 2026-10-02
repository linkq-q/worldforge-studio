import { isDeepStrictEqual } from 'node:util';
import { createWorldSampler, createWorldTerrainEvidence, validateWorldRecipe, WORLD_BIOMES, WORLD_REGIONS,
  type WorldRecipe, type WorldSampler, type WorldTerrainBrush } from '../shared/worldTerrain';
import { validateEcologyRules } from '../shared/worldEcology';
import { DEFAULT_WATER_DEPTH } from '../shared/map';
import {
  observeWorldWhitebox, validateWorldPlan, worldFeaturePathPolyline,
  type Point, type TownBuilding, type WorldPlan, type WorldWhiteboxExecution
} from '../shared/worldPlanning';
import { llmChat, type ChatMessage } from './modelApi';
import { recordGenerationTrace } from './generationTrace';
import { parseLlmJsonObject } from './llmJson';

export interface WorldWhiteboxRequest {
  mode: 'whitebox';
  prompt: string;
  seed: number;
  size: 500;
  generateAssets?: false;
  repairAttempts?: 0;
}

export interface WorldWhiteboxConstructionRequest {
  mode: 'construct-whitebox';
  whiteboxPlan: WorldPlan;
  generateAssets: boolean;
  assetGenerationLimit: number;
  repairAttempts: 0;
  reusableAssetIds?: string[];
}

export interface WorldWhiteboxConstructionTown {
  id: string;
  name: string;
  kind: 'city' | 'village';
  pattern: 'organic' | 'grid';
  density: number;
  population?: number;
  waterfrontBias?: number;
  publicBuildings: Array<Omit<TownBuilding, 'x' | 'z' | 'rotation'> & {
    siting?: 'central' | 'waterfront' | 'gateway' | 'high-ground';
  }>;
}

export interface WorldWhiteboxConstructionMaterialization {
  plan: WorldPlan;
  towns: WorldWhiteboxConstructionTown[];
  settlements: Array<{ townId: string; options: {
    kind: 'city' | 'village'; pattern: 'organic' | 'grid'; density: number; waterfrontBias?: number
  } }>;
  assets: unknown[];
  diagnostics: Array<{ townId: string; planningIssues: string[] }>;
}

const INITIAL_PROMPT = `Design one playable 500 x 500 metre world from the user's description. Return a single JSON object {"plan":{...}} and nothing else. The plan is your original creative decision, not a scene template. In this one response, plan terrain, coastline, buildable settlement anchors and routes together at the 500 metre scale. Let terrain shape settlement, mobility and the exploration sequence; leave deliberate quiet areas. Keep unusual terrain if it makes the world interesting, while avoiding accidental near-vertical cliffs that make intended routes or settlements unusable. Do not list individual trees or houses and do not request 3D assets.
Use this WorldPlan schema exactly: plan={version:1,id,revision:1,prompt,whitebox:true,recipe,ecology:[],towns:[],roads:[],concept,featureGraph,settlementPlan,mobilityPlan,explorationPlan,intentionalEmptyAreas}. ecology, towns and roads must be empty arrays. Copy prompt exactly from the request. recipe={version:1,seed,size:500,reliefProfile:'compact',constraints:[{region,biome}], optional heightScale,landforms,terrainBrushes,waterBodies,biomePatches}. Copy seed exactly. For this 500 metre world, usually keep global heightScale around 0.08..0.15 so coasts and buildable slopes remain traversable. A compact island with strong ocean constraints may use about 0.02..0.04. These are creative guidelines, not hard limits: use an intentional exception when the requested world needs it, and express exceptional volcano or mountain relief with local landforms instead of accidentally exaggerating the whole terrain. Valid broad constraint regions: west/east/north/south/northwest/northeast/southwest/southeast/center; biomes: ocean/grassland/forest/desert/mountains/snow. World coordinates are centred: X and Z each -250..250; north is negative Z, south is positive Z, west is negative X; sea level is 0. Ocean is terrain below 0, not an independent circular lake; do not fake a bay or harbour with a round lake. Shape land and coastline with broad constraints and landforms, not with a flat plate. A landform is {center:[x,z],radius:[rx,rz],height}. A local brush is {id,mode:'raise'|'lower',region:{kind:'circle',center:[x,z],radius}|{kind:'path',points:[[x,z],...],width},amount,feather?} or {id,mode:'crater',region:{kind:'circle',center:[x,z],radius},depth,rimHeight,feather?}; use only if useful. On rugged hills, a few bounded path lower/raise brushes can form drainage gullies and ridgelines; broad landforms still supply the mountain mass. Use crater, not a circular lower brush, for a volcanic crater on a mound; radius is rim crest, depth lowers central floor below pre-brush sampled rim, rimHeight raises rim. biomePatches entries are {id,region:{kind:'circle',center:[x,z],radius}|{kind:'path',points:[[x,z],...],width},biome,feather?}; every patch needs a unique id and a bounded shape, never a compass region string. Biome-patch feather is a transition distance in world metres, not a 0..1 softness ratio; for this 500m world normally use 8..24m, and use 0 only for an intentionally hard material edge. Fresh water bodies may be {id,type:'lake',region:{kind:'circle',center:[x,z],radius},levels:[height],depth,shorelineSmoothness?,shorelineIrregularity?} or {id,type:'river',surfaceMode:'terrain-fit',region:{kind:'path',points:[[x,z],...],width},widths?:[one width per path point],depth,waterfallAfterPointIndices?:[segment indices],shorelineSmoothness?,shorelineIrregularity?}. Terrain-fit rivers have no levels: the shared terrain sampler derives the water profile and carved bed from the dry banks. For a naturally flowing river in this new plan, use surfaceMode:'terrain-fit' and omit levels. Only explicitly engineered canals or fixed-height waterworks may use surfaceMode:'authored' with one level per path point; never omit surfaceMode for a new river. A terrain-fit path runs upstream to downstream; plan a continuous low valley and an actual shoreline outlet, because a river cannot be fitted across an uphill bank or an implausibly deep cut. Ordinary reaches permit at most 0.08 slope and 4m extra cut; declare a waterfall segment only for an intended sharp drop. Every river needs a complete path and depth. widths is optional and expresses intentional tributary or river-mouth widening; when present it has exactly one positive width per river path point. Trace river centerlines through plausible low ground with bends at the scale of their valleys; a long straight chord across hills reads like a canal. Lowland alluvial rivers should show map-scale meanders with lateral swings of roughly several channel widths, purposeful widening and narrowing, and differing inner and outer banks; artificial canals and steep mountain streams may be straighter exceptions. Keep ordinary river reaches at a gentle downstream slope; for terrain-fit tributaries make their meeting terrain and outlet compatible, and use compatible authored levels only for engineered channels. A sharp fall calls for a distinct cascade or waterfall in the world concept, not a continuously tilted river surface. Let a river mouth meet the sea and its shoreline rather than stop at an inland straight cut. Stop a river centerline at its first shoreline crossing; do not continue through the sea onto an offshore dry island. A natural river needs a dry inland source and dry banks before its first ocean contact; a river entirely inside ocean-constrained terrain, or beneath negative valley landforms without a supporting dry landmass, is a sea trench. In the initial plan, place the river on the raised land and let only its mouth reach sea level. Avoid authoring a complete city with individual buildings at this stage.
concept={premise:string,themes:string[],experience:string}. featureGraph={regions:[{id,kind,name,center:[x,z],radius}],paths:[{id,kind,name,points:[[x,z],...],curve?:'polyline'|'catmull-rom',width}],anchors:[{id,kind,position:[x,z],regionId,site?:{role:'structure'|'vehicle'|'equipment'|'furniture'|'landmark'|'scenery',surface:'land'|'water'|'structure',dimensions:[width,height,depth],rotation?:radians}}],relations:[{fromId,toId,kind}]}. Region radius must be 1..250 metres; path width 0.1..256 metres; every path needs at least two distinct numeric points. A missing curve means polyline for backward compatibility. Choose catmull-rom explicitly for a naturally flowing road or trail, and polyline for deliberately straight engineered segments. Use region for large spatial areas, path for an actual route/watercourse/shore movement, anchor for meaningful destinations or a settlement centre, and relation for why features belong together. Add site only when an anchor is also one concrete visible element whose size and support surface must survive into the whitebox; dimensions are metres and rotation is around +Y. Every anchor regionId refers to a region. Relation endpoints refer to feature ids. Place harbour and lookout anchors on appropriate dry or shoreline terrain, never underwater. For a working harbour, place its settlement anchor on dry low ground several metres inland and keep a connected, gently sloped shore-working terrace at least one public-building footprint deep; avoid a single deep negative bay landform against raised coastal terrain. Represent an authored place at the coarsest scale that still preserves its defining physical relationships. When a visible element depends on terrain, water, access, support, or a neighboring element, keep that relationship explicit in the whitebox; derive the elements from the requested use and observed terrain rather than a fixed checklist. Trace routes over plausible ground; do not let a road cross open or deep water without an intentionally authored crossing. settlementPlan={settlements:[{id,anchorId,role,districts?:[{anchorId,kind:'working'|'civic'|'residential'|'edge',density:0..1}]}]}. The district anchors must reference existing featureGraph anchors whose regions cover the actual working, civic, housing and edge footprint; connect them with internal streets. A settlement is one distinct inhabited destination, never one district: if the user asks for one town, return exactly one settlement for it, linked to one town-centre anchor, and describe its working, civic, residential and edge districts plus density transition together in that settlement's role. Reserve extra settlements for genuinely separate destinations such as another village, hamlet or remote camp. Districts of one town may occupy distinct connected featureGraph regions with supporting anchors and relations, but do not promote them to separate settlementPlan entries. Show the whole inhabited footprint of a requested town, not just its centre: allocate connected, terrain-fitting regions for working, civic, residential and edge uses as appropriate, with streets and paths that allow outward growth. Give a town enough buildable area for ordinary homes and a few public services appropriate to its scale; a village is a sparser settlement, while a camp is only a small stop. Let the extent respond to the usable coast, valley, slopes, routes and requested population instead of filling the whole map or compressing all life into one marker. Leave contiguous dry plots beside, rather than inside, road junctions for civic buildings such as markets and schools; avoid converging several wide through-routes inside one small public-building district. mobilityPlan={routes:[{id,pathId,mode,connects:[anchorId,...],construction?:{terrain:'follow'|'grade',maxGrade?:0.02..0.2}}]}. When terrain is 'follow', omit maxGrade; only 'grade' may specify maxGrade; road types and walking trails may differ. For a dry route that needs modest earthworks, choose grade and a suitable maxGrade (around 0.12 for carts or 0.18 for footpaths); the shared tool keeps cuts/fills within 1.5m and reports infeasible routes without changing the plan. Follow leaves the ground as authored. Do not use grade to cross water: plan an intentional bridge or a dry detour. Keep ordinary routes human-scale relative to nearby buildings: walking trails roughly 1.5–3m, local lanes 3–5m and main roads 5–8m; a wider boulevard needs a clear civic or freight purpose and space for buildings around it. A bridge should be purposeful where water crossings need it. explorationPlan={pointsOfInterest:[{id,anchorId,purpose}],sequence:[poiId,...]}; sequence is a representative player journey, not every possible destination. intentionalEmptyAreas=[{id,regionId,purpose}]. All ids are unique within their respective semantic collection. Every reference must exist. The graph is broad and editable, not a semantic grid or a fixed biome menu. The whitebox renders existing primitives only. Return no screenshots or render instructions.`;

const DRY_TERRAIN_PROMPT = `Author only the dry terrain for one playable 500 x 500 metre world from the user's description. Return one JSON object {"terrain":{...}} and nothing else. This is the first observational planning stage: do not place water bodies, settlements, routes, feature graphs, points of interest, ecology, buildings or assets. Shape coherent land, coasts, valleys, ridges and potential drainage corridors that a later planner can observe instead of guessing elevations.
Use this exact terrain schema: terrain={version:1,seed,size:500,reliefProfile:'compact',constraints:[{region,biome}],optional heightScale,landforms,terrainBrushes,biomePatches}. Copy seed exactly. Never return waterBodies. Valid broad constraint regions are west/east/north/south/northwest/northeast/southwest/southeast/center; biomes are ocean/grassland/forest/desert/mountains/snow. World coordinates are centred: X and Z each -250..250; north is negative Z, south is positive Z, west is negative X; sea level is 0. heightScale is a dimensionless multiplier of the base terrain relief, valid 0.02..4; it is not a height in metres or a percentage. Ocean is dry terrain below 0, not a circular lake. Shape land and coastline with broad constraints and landforms instead of a flat plate. For each named landform, infer its characteristic cross-section, relief, drainage and connection to surrounding water, then make those relationships legible at this map scale. Keep distinctive slopes and valleys where the user asked for them; place usable terraces where settlements need them.
Choose global heightScale from the requested relief and traversability; a low-relief island and a high-relief mainland should not be flattened to the same profile. Use local landforms for exceptional peaks, basins or ridges instead of exaggerating the whole terrain. A landform is {center:[x,z],radius:[rx,rz],height}. A local brush is {id,mode:'raise'|'lower',region:{kind:'circle',center:[x,z],radius}|{kind:'path',points:[[x,z],...],width},amount,feather?}, {id,mode:'crater',region:{kind:'circle',center:[x,z],radius},depth,rimHeight,feather?}, {id,mode:'flatten',region,height,strength?}, or {id,mode:'grade',region:{kind:'path',points:[[x,z],...],width}|{kind:'circle',center:[x,z],radius},heights:[two or more height keyframes],strength?}. Bounded local brushes may refine terrain, but do not pre-grade settlement roads that have not been planned.
Reserve connected dry, gently sloped land for every requested settlement before shaping nearby mountains and water. A named working town needs room for several streets, dozens of ordinary homes, civic buildings and its livelihood at the shore or valley edge; a tiny isolated terrace would turn it into a hamlet. Keep the distinctive terrain elsewhere rather than shrinking the settlement intent. For a seaport, reserve a continuous low coastal shelf directly connected to the main landmass: the working waterfront should descend gently to sea level, with enough dry frontage for streets and public buildings. Do not make the port a raised, isolated 6–10m plateau surrounded by sea or steep sand banks. Terrain brushes execute in listed order. Shape the bay inlet and drainage cuts before any small settlement grading; prefer the naturally buildable terrain and use a broad feathered grade at modest strength only where needed. A full-strength flatten brush over a large settlement erases the coastline and creates abrupt edges.
biomePatches entries are {id,region:{kind:'circle',center:[x,z],radius}|{kind:'path',points:[[x,z],...],width},biome,feather?}. Every patch needs a unique id and a bounded shape. Feather is a transition distance in world metres, normally 8..24m. Return the raw terrain decision once; do not critique, repair or offer alternatives.`;

const STAGED_SPATIAL_PROMPT = `Plan the water and complete editable whitebox semantics for one 500 x 500 metre world after observing its dry terrain. Plan any necessary small terrain refinements alongside water, shores, settlement districts and routes in this same first spatial response. Return valid JSON only: coordinate values must be JSON numbers, never written-out words such as "thirty".
For an explicitly requested port, locate the continuous, buildable sea-level shoreline in terrainEvidence before choosing the settlement centre. Place the working district on that shore and keep the civic and residential districts on connected dry land. The shore must support real waterfront public-building footprints and a land-to-water landing, not merely a harbor label or a distant water view. If a proposed shoreline is too steep or separated from the main landmass, choose another sampled coast; do not create an isolated high terrace with a late flatten or grade brush. A harbor terrace several metres above sea level needs a long, walkable descent and cannot by itself serve as a quay.
terrainEvidence.landmassLabels marks connected dry evidence cells (0 is sea, 1 is the largest island), and landmasses reports each area's approximate size, buildable score and nearest sampled mainland banks. These are coarse observations, not hard rejection gates. Before finalizing a settlement, identify its landmass and how people reach the other destinations. If a busy village is on a detached island across a short sheltered channel, consider a purposeful walkable bridge; across a long exposed gap, consider a ferry and landing, or choose a connected town site. A bridge must be an explicit featureGraph path whose kind contains 'bridge', with a roughly straight polyline from one dry bank to the other and a mobility route using it; ordinary roads must not cross water. Check both bank elevations and reserve approach space, not just the narrowest water gap.
{"plan":{"id":"world-id","terrainRefinements":[],"waterBodies":[],"ecology":[],"concept":{},"featureGraph":{},"settlementPlan":{},"mobilityPlan":{},"explorationPlan":{},"intentionalEmptyAreas":[]}}.
Return those eight required plan fields and optional terrainRefinements and ecology. Do not return recipe, seed, size, constraints, heightScale, landforms, terrainBrushes, biomePatches, towns, roads, buildings or assets. The server preserves the dryTerrain base and appends your terrainRefinements in listed order before placing water and settlements. terrainEvidence is a deterministic 21 x 21 observation of that recipe: rows run north to south, columns west to east, origin and step are metres, and each samples value is [height,slope]. buildingSiteScores uses the same grid: each 0..4 score counts approximate dry, gentle 8m building sites sampled within that cell. terrainEvidence.buildableAreas summarizes connected positive-score cells with bounds, an approximate buildingSiteScore capacity and the nearest sampled ocean pair. Use those areas to reserve enough connected frontage for the stated population (roughly one ordinary building per five residents); do not put a civic, working or housing district over all-zero cells unless terrainRefinements in this same response make that district buildable. These scores are planning evidence, not a rejection gate, and later water or roads may reduce available sites. Multiply height by heightUnit to get metres and slope by slopeUnit to get degrees; heightRange also uses heightUnit. shoreline contains closed interpolated sea-level loops in metres, and boundaryCrossings lists open coast endpoints on the sampled world boundary. Use this evidence to choose actual dry, low-slope anchors and plausible downhill water and route paths. Use this evidence to choose connected sites and to plan only local, bounded earthworks where a river mouth, harbor work area or essential access cannot fit the dry land. terrainRefinements is an optional array of standard terrain brushes: {id,mode:'lower'|'raise',region,amount,feather?}, {id,mode:'flatten',region,height,strength?,feather?}, or {id,mode:'grade',region:{kind:'path',points:[[x,z],...],width}|{kind:'circle',center:[x,z],radius},heights:[two or more scalar height keyframes such as heights:[12,6,2]],strength?,feather?}. heights contains elevations only, never [x,z] coordinate pairs. For a path grade, keyframes interpolate from the first to last point; for a circle grade, they interpolate radially from centre to rim. Keep broad landforms and the chosen coastline recognizable; let a refined river descend into its first sea outlet and keep the harbor terrace above sea level. These are authored parts of your first plan, never automatic post-generation repair. Preserve unusual authored terrain and report one raw plan; do not critique, repair or offer alternatives.
waterBodies may contain lakes {id,type:'lake',region:{kind:'circle',center:[x,z],radius},levels:[height],depth,shorelineSmoothness?,shorelineIrregularity?} or rivers {id,type:'river',surfaceMode:'terrain-fit',region:{kind:'path',points:[[x,z],...],width},widths?:[one width per path point],depth,waterfallAfterPointIndices?:[segment indices],shorelineSmoothness?,shorelineIrregularity?}. Terrain-fit rivers have no levels: the shared sampler derives their surface profile and carved bed from dry banks. Only engineered canals or fixed-height waterworks may use surfaceMode:'authored' with one level per point. A natural river must begin on dry inland terrain, follow a sampled downhill valley with dry banks, and stop at its first sea-level shoreline crossing. Ordinary reaches permit at most 0.08 slope and 4m extra cut; declare a waterfall segment only for an intended sharp drop. Check the entire proposed centerline against terrainEvidence, including the first inland descent: a 25m evidence interval dropping more than about 2m already exceeds an ordinary reach. A mouth-only grade cannot fix an inland drop. Re-route through gentler ground, grade the full short transition from above its break, or intentionally declare a waterfall segment. Trace natural centerlines with bends appropriate to their valleys instead of drawing a straight chord across high ground. A dry world may intentionally have no fresh water.
ecology may contain up to 8 habitat scatter rules: {id,kind:'broadleaf'|'pine'|'shrub'|'rock',biome:'ocean'|'grassland'|'forest'|'desert'|'mountains'|'snow',density:0..1,spacing:6..100,maxSlope:0..60,scale:[min,max],region?,regionFeather?,waterDistance?:[outerMin,preferredMin,preferredMax,outerMax]}. Use broad rules for widespread vegetation and bounded circle or path regions for distinctive groves, reeds or stony areas. Decide habitats from terrain, water, climate and settlement use; each rule is a batch placement intent and requires no 3D asset.
concept={premise:string,themes:string[],experience:string}. featureGraph={regions:[{id,kind,name,center:[x,z],radius}],paths:[{id,kind,name,points:[[x,z],...],curve?:'polyline'|'catmull-rom',width}],anchors:[{id,kind,position:[x,z],regionId,site?:{role:'structure'|'vehicle'|'equipment'|'furniture'|'landmark'|'scenery',surface:'land'|'water'|'structure',dimensions:[width,height,depth],rotation?:radians}}],relations:[{fromId,toId,kind}]}. Region radius is 1..250m. Every path has at least two distinct points. Use catmull-rom for naturally flowing roads or trails and polyline for engineered segments. Every anchor regionId and relation endpoint must exist. Place settlement, harbour and lookout anchors on sampled dry ground with suitable slope. A working harbour settlement anchor belongs on dry low ground inland of the shoreline with a connected shore-working terrace. Add site only when an anchor is also one concrete visible element whose size and support surface must survive into the whitebox; dimensions are [width,height,depth] metres and rotation is around +Y. Site anchors do not all need to be points of interest.
Represent an authored place at the coarsest scale that still preserves its defining physical relationships. When a visible element depends on terrain, water, access, support, or a neighboring element, keep that relationship explicit in the whitebox; derive the elements from the requested use and observed terrain rather than a fixed checklist.
settlementPlan={settlements:[{id,anchorId,role,population?:integer,districts?:[{anchorId,kind:'working'|'civic'|'residential'|'edge',density:0..1}]}]}. One town is one settlement, not one settlement per district. District anchors describe the connected inhabited footprint. Give settlements enough sampled buildable area for homes and public uses without filling the map. Estimate each settlement's resident population now, while placing its districts and local streets against the sampled buildable area; carry that count into construction. A working town with daily public services normally needs dozens of households (roughly 150 or more residents); about 40 people would be a hamlet, unless the user explicitly asks for one. Do not downgrade a named town to fit a tiny chosen region: move or reshape connected districts across the best sampled buildable terrain. Do not stack every district anchor inside one small core while labeling broad overlapping regions as separate neighborhoods. For a service-bearing town of roughly 150–250 residents, let at least one housing or edge anchor reach the outer connected buildable land, with district radii that express distinct usable frontage; keep the streets walkable between them. A village can be smaller and sparser, but still needs connected streets and ordinary homes. Check the full extent of each district region, not just its anchor: keep the town centre far enough from the -250..250 map boundary that its working, civic, residential and edge districts all fit with room for local streets. If a coast-facing district needs more space than one anchor allows, move the centre inland or reshape the districts to follow the sampled dry coast rather than leaving a district outside the map.
mobilityPlan={routes:[{id,pathId,mode,connects:[anchorId,...],construction?:{terrain:'follow'|'grade',maxGrade?:0.02..0.2}}]}. Every walkable featureGraph path that should survive construction, including streets, quays, piers and trails, needs one mobilityPlan route referencing its pathId; an unreferenced path remains observation-only and is not a constructed road. Each route path must pass through every anchor in connects, in travel order; its first and last points should meet the first and last connected anchors, including a deliberate water landing endpoint. When terrain is 'follow', omit maxGrade; only 'grade' may specify maxGrade. Trace routes across sampled terrain; compare slope and shoreline evidence along the whole path. Do not cross open water without an intentional crossing. Grade is only for modest dry-ground earthworks and cannot make an implausible mountain crossing or bridge. Walking trails are roughly 1.5–3m wide, local lanes 3–5m and main roads 5–8m unless a larger route has a clear purpose.
explorationPlan={pointsOfInterest:[{id,anchorId,purpose}],sequence:[poiId,...]}; intentionalEmptyAreas=[{id,regionId,purpose}]. Sequence is a representative journey. Leave deliberate quiet areas. All ids are unique within their semantic collection and every reference must exist.`;

export const WHITEBOX_CONSTRUCTION_PROMPT = `Expand one already-approved WorldForge whitebox into deterministic construction inputs. Return JSON only:
{"towns":[{"id":"existing settlementPlan id","name":"display name","kind":"city|village","pattern":"organic|grid","density":0.0,"population":150,"waterfrontBias":0.0,"publicBuildings":[]}],"ecology":[],"assets":[]}.
The supplied whitebox is immutable. Never return or rewrite recipe, featureGraph, anchors, paths, concept, settlementPlan, mobilityPlan, explorationPlan or intentionalEmptyAreas. Return exactly one town entry for every supplied settlementPlan id. The server owns centers, radii, foundations and roads; do not supply coordinates. For each settlement, infer livelihood, circulation, civic needs and terrain fit. Connected waterfront, civic, housing and farm districts should form one inhabited place; a village is sparser than a town, not empty. Use organic or grid streets for a reason rooted in terrain and culture. Substantial towns need distinct public functions at roughly one per 10–20 ordinary buildings where buildable frontage permits. Keep their whitebox footprints even when the 3D asset budget is exhausted.
environmentEvidence.anchors is sampled from the approved plan and reports ground height, slope, water surface, biome and distance to authored routes. Use these observations to reason about siting and functions; they are context, not a rejection gate or permission to rewrite the whitebox.
Habitat rules already in whiteboxPlan.ecology are preserved. Return ecology only for additional habitats discovered during construction; an empty array must not remove earlier vegetation intent. Ecology rules do not consume 3D asset slots.
Copy each settlement's population into its town entry when the approved whitebox states one. For older whiteboxes without a count, estimate it from the approved settlement extent, livelihood and kind. Population controls the ordinary housing target and is not just descriptive prose. Do not create another settlement or split one place's population among districts.
Exact output contracts; use no extra fields:
towns=[{id,name,kind:'city'|'village',pattern:'organic'|'grid',density:0..1,population?:integer,waterfrontBias?:0..1,publicBuildings:[{id,use,width,depth,height,assetKey?,enterable?:false,siting?:'central'|'waterfront'|'gateway'|'high-ground'}]}]. siting is one of those four literal values, never a prose sentence. A public building may omit assetKey to keep a visible whitebox footprint without spending an asset slot. When assetKey is supplied, it must match an assets[].key and its width,height,depth must match that asset's dimensions [width,height,depth]. List up to 12 distinct public functions only when the settlement scale supports them; ordinary buildings are generated by settlement rules, so do not enumerate those.
ecology=[{id,kind:'broadleaf'|'pine'|'shrub'|'rock',biome:'ocean'|'grassland'|'forest'|'desert'|'mountains'|'snow',density:0..1,spacing:6..100,maxSlope:0..60,scale:[min,max],region?,regionFeather?,waterDistance?:[outerMin,preferredMin,preferredMax,outerMax]}], at most 8 rules. region is a circle {kind:'circle',center:[x,z],radius} or path {kind:'path',points:[[x,z],...],width}; omit for broad biome coverage. Include unbounded rules for extensive suitable habitat and bounded rules for distinctive local groves; a large island should not become nearly bare without a climate or land-use reason. waterDistance refers only to authored fresh rivers/lakes. Design clustered habitat from moisture, slope, biome and human use, leaving roads and entrances clear; never enumerate plants or rocks.
assets=[{key,name,role:'house'|'shop'|'workshop'|'tree'|'landmark',prompt,dimensions?:[width,height,depth],enterable?:false,strategy:'single'|'assembly',existingAssetId?,ecologyKind?,ecologyRuleId?}]. Do not put width, depth, height or use directly on an asset object. Every asset needs a nonempty name, role and prompt, including reused assets. Reuse only supplied reusableAssets IDs and their measured visualSize. Match each reused model to its supplied name, original prompt, tags and visible silhouette; do not rename a biome-specific asset to claim it fits another habitat, such as using an oasis palm as a dense forest broadleaf. Each unique publicBuildings[].assetKey needs a matching assets[] entry with role:'landmark'; if it reuses a library model, include that model's existingAssetId in the matching entry. A library ID in publicBuildings without a matching assets[] entry is unbound. Every role:'tree' asset must name one exact ecologyRuleId and copy that rule's kind into ecologyKind; non-tree assets omit both fields. Ecology rules are independent of asset slots: keep requested habitat in the whitebox even when assetGenerationLimit is zero. If a tree asset is supplied, bind it to one matching ecology rule; unbound ecology rules remain valid planning intent. Include ordinary house/shop/workshop families only when an asset slot or suitable reusable model is available. No more than the supplied assetGenerationLimit (at most three) assets may omit existingAssetId. Choose strategy:'assembly' when an approved building footprint benefits from connected reusable parts; otherwise choose strategy:'single'. Spend new generation on important visual and functional gaps. Choose public-building assets by their actual measured silhouette, footprint, roof and entry composition, not by a landmark role label. A reused house-sized or contextually wrong model cannot make the town's main civic or waterfront landmark visually legible; prioritize a suitable new asset within the supplied limit. This is construction expansion, not critique or repair.`;

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: unknown, allowed: readonly string[], invalid: string, unknown: string): Record<string, unknown> {
  const result = object(value, invalid);
  const extra = Object.keys(result).find(key => !allowed.includes(key));
  if (extra) throw new Error(`${unknown}:${extra}`);
  return result;
}

function constructionId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)) throw new Error(code);
  return value;
}

function constructionNumber(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(code);
  return value;
}

function constructionText(value: unknown, max: number, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(code);
  return value;
}

function pointAtRouteDistance(points: Point[], target: number): Point {
  let traversed = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1], b = points[index];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (target <= traversed + length) {
      const t = length ? (target - traversed) / length : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    traversed += length;
  }
  return [...points.at(-1)!] as Point;
}

function distanceToRoute(point: Point, points: Point[]): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1], b = points[index];
    const dx = b[0] - a[0], dz = b[1] - a[1], lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared ? Math.max(0, Math.min(1,
      ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared)) : 0;
    closest = Math.min(closest, Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dz * t)));
  }
  return closest;
}

function nearestRouteBoundaryPoints(points: Point[], center: Point, radius: number): Array<{ point: Point; outside: Point }> {
  const epsilon = 1e-6;
  const hits: Array<{ point: Point; distance: number }> = [];
  let traversed = 0, nearestDistance = 0, nearestDistanceSquared = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1], b = points[index];
    const dx = b[0] - a[0], dz = b[1] - a[1], lengthSquared = dx * dx + dz * dz;
    if (lengthSquared <= epsilon) continue;
    const length = Math.sqrt(lengthSquared);
    const projection = Math.max(0, Math.min(1,
      ((center[0] - a[0]) * dx + (center[1] - a[1]) * dz) / lengthSquared));
    const projectedX = a[0] + dx * projection, projectedZ = a[1] + dz * projection;
    const distanceSquared = (projectedX - center[0]) ** 2 + (projectedZ - center[1]) ** 2;
    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      nearestDistance = traversed + length * projection;
    }
    let enter = 0, exit = 1;
    for (const [start, delta] of [[a[0] - center[0], dx], [a[1] - center[1], dz]] as const) {
      if (Math.abs(delta) <= epsilon) {
        if (Math.abs(start) > radius + epsilon) { enter = 1; exit = 0; break; }
        continue;
      }
      const first = (-radius - start) / delta, second = (radius - start) / delta;
      enter = Math.max(enter, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }
    if (enter <= exit + epsilon) for (const position of new Set([enter, exit])) {
      if (position < -epsilon || position > 1 + epsilon) continue;
      const point: Point = [a[0] + dx * position, a[1] + dz * position];
      const localX = point[0] - center[0], localZ = point[1] - center[1];
      if (Math.abs(Math.max(Math.abs(localX), Math.abs(localZ)) - radius) <= epsilon) {
        hits.push({ point, distance: traversed + length * position });
      }
    }
    traversed += length;
  }
  const unique = hits.sort((a, b) => a.distance - b.distance).filter((hit, index, values) => index === 0
    || Math.hypot(hit.point[0] - values[index - 1].point[0], hit.point[1] - values[index - 1].point[1]) > epsilon);
  const selected: Array<{ point: Point; distance: number }> = [];
  const add = (hit: { point: Point; distance: number } | undefined) => {
    if (hit && !selected.some(value => Math.hypot(value.point[0] - hit.point[0], value.point[1] - hit.point[1]) <= epsilon)) {
      selected.push(hit);
    }
  };
  add([...unique].reverse().find(hit => hit.distance <= nearestDistance + epsilon));
  add(unique.find(hit => hit.distance >= nearestDistance - epsilon));
  return selected.map(hit => {
    const direction = hit.distance < nearestDistance - epsilon ? -1
      : hit.distance > nearestDistance + epsilon ? 1 : hit.distance > epsilon ? -1 : 1;
    return { point: hit.point, outside: pointAtRouteDistance(points,
      Math.max(0, Math.min(traversed, hit.distance + direction))) };
  });
}

const MARITIME_HARBOR_TERM = /\b(?:harbou?r|maritime|port|quays?|docks?)\b|海港|渔港|港口|码头/i;
const RIVER_PORT_TERM = /\b(?:river|inland|fluvial)\b|河港|内河/i;
function diagnoseFeatureSites(plan: WorldPlan, sample: WorldSampler): string[] {
  const graph = plan.featureGraph;
  if (!graph) return [];
  const issues: string[] = [];
  const sites = graph.anchors.filter(anchor => anchor.site);
  for (const anchor of sites) {
    const surface = sample(...anchor.position);
    const wet = surface.waterLevel !== null && surface.waterLevel > surface.height + 0.05;
    if (anchor.site!.surface === 'water' && !wet) issues.push(`site_surface_mismatch:${anchor.id}:expected_water`);
    if (anchor.site!.surface === 'land' && wet) issues.push(`site_surface_mismatch:${anchor.id}:expected_land`);
    if (anchor.site!.surface === 'structure') {
      const support = graph.paths.some(path => /pier|jetty|dock|quay|breakwater|bridge|platform|deck|栈桥|码头|防波堤|桥|平台/i
        .test(`${path.kind} ${path.name}`)
        && distanceToRoute(anchor.position, worldFeaturePathPolyline(path))
          <= path.width / 2 + Math.max(anchor.site!.dimensions[0], anchor.site!.dimensions[2]) / 2);
      if (!support) issues.push(`site_structure_support_missing:${anchor.id}`);
    }
  }
  return issues;
}

export function hasAccessibleOceanShore(sample: WorldSampler, center: Point, radius: number): boolean {
  const origin = sample(center[0], center[1]);
  if (origin.waterLevel !== null && origin.waterLevel > origin.height + 0.05) return false;
  const reach = radius * 0.98;
  const steps = Math.ceil(reach / 8);
  for (let z = -steps; z <= steps; z += 1) {
    for (let x = -steps; x <= steps; x += 1) {
      const surface = sample(center[0] + x * reach / steps, center[1] + z * reach / steps);
      if (surface.waterLevel === null || surface.waterLevel <= surface.height + 0.05) continue;
      if (surface.waterBodyId === null) return true;
      break;
    }
  }
  return false;
}

export function validateWorldWhiteboxRequest(input: unknown): WorldWhiteboxRequest {
  const value = object(input, 'invalid_world_whitebox_request');
  if (Object.keys(value).some(key => !['mode', 'prompt', 'seed', 'size', 'generateAssets', 'repairAttempts'].includes(key))
    || value.mode !== 'whitebox' || typeof value.prompt !== 'string' || !value.prompt.trim()
    || value.prompt.length > 8000 || !Number.isInteger(value.seed) || (value.seed as number) < 0
    || (value.seed as number) > 0xffffffff || value.size !== 500
    || value.generateAssets === true || (value.repairAttempts !== undefined && value.repairAttempts !== 0)) {
    throw new Error('invalid_world_whitebox_request');
  }
  return { mode: 'whitebox', prompt: value.prompt as string, seed: value.seed as number, size: 500,
    generateAssets: false, repairAttempts: 0 };
}

export function validateWorldWhiteboxConstructionRequest(input: unknown): WorldWhiteboxConstructionRequest {
  const value = exact(input, ['mode', 'whiteboxPlan', 'generateAssets', 'assetGenerationLimit', 'repairAttempts', 'reusableAssetIds'],
    'invalid_world_whitebox_construction_request', 'world_unknown_whitebox_construction_request_field');
  const reusableAssetIds = value.reusableAssetIds;
  if (value.mode !== 'construct-whitebox' || typeof value.generateAssets !== 'boolean'
    || !Number.isInteger(value.assetGenerationLimit) || (value.assetGenerationLimit as number) < 0
    || (value.assetGenerationLimit as number) > 3 || value.repairAttempts !== 0
    || reusableAssetIds !== undefined && (!Array.isArray(reusableAssetIds) || reusableAssetIds.length > 64
      || new Set(reusableAssetIds).size !== reusableAssetIds.length
      || reusableAssetIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)))) {
    throw new Error('invalid_world_whitebox_construction_request');
  }
  const whiteboxPlan = validateWorldPlan(value.whiteboxPlan);
  if (!whiteboxPlan.whitebox || whiteboxPlan.towns.length || whiteboxPlan.roads.length || whiteboxPlan.ecology.length
    || !whiteboxPlan.featureGraph || !whiteboxPlan.settlementPlan || !whiteboxPlan.mobilityPlan
    || !whiteboxPlan.explorationPlan || !whiteboxPlan.intentionalEmptyAreas) {
    throw new Error('world_whitebox_plan_required');
  }
  return { mode: 'construct-whitebox', whiteboxPlan, generateAssets: value.generateAssets,
    assetGenerationLimit: value.assetGenerationLimit as number, repairAttempts: 0,
    ...(Array.isArray(reusableAssetIds) && reusableAssetIds.length ? { reusableAssetIds: [...reusableAssetIds] as string[] } : {}) };
}

export function parseWorldWhiteboxInitialPlan(content: string, request: WorldWhiteboxRequest): {
  rawPlan: unknown; plan: WorldPlan; technicalNormalizations: string[]
} {
  const response = parseLlmJsonObject(content, 'invalid_world_whitebox_response');
  if (Object.keys(response).length !== 1 || !('plan' in response)) throw new Error('invalid_world_whitebox_response');
  const raw = object(response.plan, 'invalid_world_whitebox_plan');
  if (raw.whitebox !== true || raw.revision !== 1) throw new Error('invalid_world_whitebox_plan');
  const recipe = object(raw.recipe, 'invalid_world_whitebox_recipe');
  if (recipe.seed !== request.seed || recipe.size !== request.size) throw new Error('world_whitebox_request_mismatch');
  const technicalNormalizations = raw.prompt === request.prompt ? [] : ['request_prompt_echo'];
  if (Array.isArray(recipe.landforms)) recipe.landforms.forEach((value, index) => {
    if (value && typeof value === 'object' && typeof (value as { radius?: unknown }).radius === 'number') {
      technicalNormalizations.push(`landforms[${index}].scalar_radius_to_pair`);
    }
  });
  if (raw.prompt !== request.prompt) recordGenerationTrace('world.whitebox.request-echo-normalized', {
    received: raw.prompt, expected: request.prompt
  });
  const normalizedRecipe: Record<string, unknown> = { ...recipe };
  if (Array.isArray(recipe.waterBodies)) normalizedRecipe.waterBodies = recipe.waterBodies.map((value, index) => {
    const water = object(value, 'invalid_world_water_body');
    const normalized = { ...water };
    if (normalized.region === undefined && normalized.path !== undefined) {
      normalized.region = normalized.path;
      delete normalized.path;
      technicalNormalizations.push(`waterBodies[${index}].path_to_region`);
    }
    if (normalized.depth === undefined) {
      normalized.depth = DEFAULT_WATER_DEPTH;
      technicalNormalizations.push(`waterBodies[${index}].depth_default_${DEFAULT_WATER_DEPTH}`);
    }
    return normalized;
  });
  if (Array.isArray(recipe.biomePatches)) {
    const broadPatches = recipe.biomePatches.filter(value => {
      const patch = object(value, 'invalid_world_biome_patch');
      return typeof patch.region === 'string' && Object.hasOwn(WORLD_REGIONS, patch.region);
    });
    if (broadPatches.length) {
      const constraints = Array.isArray(recipe.constraints) ? recipe.constraints.map(value => ({ ...object(value, 'invalid_world_constraint') })) : [];
      for (const value of broadPatches) {
        const patch = object(value, 'invalid_world_biome_patch');
        const biome = patch.biome === 'scree' ? 'mountains' : patch.biome;
        if (!WORLD_BIOMES.includes(biome as typeof WORLD_BIOMES[number])) throw new Error('invalid_world_biome_patch');
        const existing = constraints.find(item => item.region === patch.region);
        if (existing && existing.biome !== biome) throw new Error('world_whitebox_conflicting_broad_biome');
        if (!existing) constraints.push({ region: patch.region, biome });
        technicalNormalizations.push(`biomePatches.${patch.region}_to_constraint_${biome}`);
      }
      normalizedRecipe.constraints = constraints;
      normalizedRecipe.biomePatches = recipe.biomePatches.filter(value => !broadPatches.includes(value));
    }
  }
  // A whitebox executes only the semantic graph. Some models also echo descriptive
  // town/road/ecology notes into the later construction fields; retain them in rawPlan.
  const planFields: Record<string, unknown> = { ...raw, prompt: request.prompt, recipe: normalizedRecipe };
  for (const field of ['ecology', 'towns', 'roads']) {
    if (Array.isArray(raw[field]) && raw[field].length) {
      planFields[field] = [];
      technicalNormalizations.push(`${field}_semantic_notes_only`);
    }
  }
  const plan = validateWorldPlan(planFields);
  if (!plan.featureGraph || !plan.concept || !plan.settlementPlan || !plan.mobilityPlan
    || !plan.explorationPlan || !plan.intentionalEmptyAreas) throw new Error('world_whitebox_missing_semantic_plan');
  if (plan.towns.length || plan.roads.length || plan.ecology.length) throw new Error('world_whitebox_requires_semantic_graph');
  return { rawPlan: response.plan, plan, technicalNormalizations };
}

export function parseWorldDryTerrainDraft(content: string, request: WorldWhiteboxRequest): {
  rawTerrain: unknown; recipe: WorldRecipe; technicalNormalizations: string[]
} {
  const response = exact(parseLlmJsonObject(content, 'invalid_world_dry_terrain_response'), ['terrain'], 'invalid_world_dry_terrain_response',
    'world_unknown_dry_terrain_response_field');
  const rawTerrain = exact(response.terrain,
    ['version', 'seed', 'size', 'reliefProfile', 'heightScale', 'constraints', 'landforms', 'terrainBrushes', 'biomePatches'],
    'invalid_world_dry_terrain', 'world_unknown_dry_terrain_field');
  const technicalNormalizations: string[] = [];
  const heightScale = rawTerrain.heightScale;
  const normalizedHeightScale = typeof heightScale === 'number' && Number.isFinite(heightScale)
    && heightScale > 4 && heightScale <= 100 ? heightScale / 100 : heightScale;
  if (normalizedHeightScale !== heightScale) technicalNormalizations.push('heightScale.percent_to_multiplier');
  const normalizedTerrain = { ...rawTerrain, heightScale: normalizedHeightScale, terrainBrushes: Array.isArray(rawTerrain.terrainBrushes)
    ? rawTerrain.terrainBrushes.map((brush, index) => normalizeModelTerrainBrush(
      brush, `terrainBrushes[${index}]`, technicalNormalizations))
    : rawTerrain.terrainBrushes };
  const recipe = validateWorldRecipe(normalizedTerrain as WorldRecipe);
  if (recipe.seed !== request.seed || recipe.size !== request.size || recipe.waterBodies !== undefined) {
    throw new Error('world_dry_terrain_request_mismatch');
  }
  const regions = recipe.constraints.map(item => item.region);
  recipe.constraints.sort((a, b) => a.region.localeCompare(b.region));
  if (regions.some((region, index) => region !== recipe.constraints[index].region)) {
    technicalNormalizations.push('constraint_order');
  }
  if (Array.isArray(rawTerrain.landforms)) rawTerrain.landforms.forEach((value, index) => {
    if (value && typeof value === 'object' && typeof (value as { radius?: unknown }).radius === 'number') {
      technicalNormalizations.push(`landforms[${index}].scalar_radius_to_pair`);
    }
  });
  return { rawTerrain: response.terrain, recipe, technicalNormalizations };
}

function normalizeModelTerrainBrush(value: unknown, path: string, notes: string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const brush = value as Record<string, unknown>;
  let normalized = brush;
  if (brush.mode === 'lower' && typeof brush.amount === 'number'
    && Number.isFinite(brush.amount) && brush.amount < 0 && brush.amount >= -1000) {
    normalized = { ...normalized, amount: -brush.amount };
    notes.push(`${path}.negative_lower_amount_to_magnitude`);
  }
  if (brush.mode === 'grade' && Array.isArray(brush.heights)
    && brush.heights.length >= 2 && brush.heights.length <= 64) {
    const keyframes = (brush.heights as unknown[]).map(value => Array.isArray(value) && value.length === 2
      ? { position: value[0], height: value[1] }
      : value) as Array<{ position?: unknown; height?: unknown }>;
    const valid = keyframes.every((keyframe, index) => keyframe && typeof keyframe === 'object'
      && !Array.isArray(keyframe) && Object.keys(keyframe).every(key => key === 'position' || key === 'height')
      && typeof keyframe.position === 'number' && Number.isFinite(keyframe.position)
      && typeof keyframe.height === 'number' && Number.isFinite(keyframe.height)
      && keyframe.height >= -1000 && keyframe.height <= 5000
      && (index === 0 || keyframe.position > (keyframes[index - 1].position as number)));
    if (valid && keyframes[0].position === 0 && keyframes.at(-1)?.position === 1) {
      const heights = Array.from({ length: 64 }, (_, index) => {
        const t = index / 63;
        const end = keyframes.findIndex(keyframe => (keyframe.position as number) >= t);
        if (end <= 0) return keyframes[0].height as number;
        const a = keyframes[end - 1], b = keyframes[end];
        const weight = (t - (a.position as number)) / ((b.position as number) - (a.position as number));
        return (a.height as number) * (1 - weight) + (b.height as number) * weight;
      });
      normalized = { ...normalized, heights };
      notes.push(`${path}.positioned_grade_keyframes_to_samples`);
    }
  }
  return normalized;
}

export function parseWorldWhiteboxSpatialPlan(
  content: string,
  request: WorldWhiteboxRequest,
  dryTerrain: WorldRecipe
): { rawPlan: unknown; plan: WorldPlan; technicalNormalizations: string[] } {
  const recipe = validateWorldRecipe(dryTerrain);
  if (recipe.waterBodies !== undefined) throw new Error('world_staged_spatial_requires_dry_terrain');
  recipe.constraints.sort((a, b) => a.region.localeCompare(b.region));
  const response = exact(parseLlmJsonObject(content, 'invalid_world_staged_spatial_response'), ['plan'], 'invalid_world_staged_spatial_response',
    'world_unknown_staged_spatial_response_field');
  const raw = exact(response.plan,
    ['id', 'terrainRefinements', 'waterBodies', 'ecology', 'concept', 'featureGraph', 'settlementPlan', 'mobilityPlan', 'explorationPlan', 'intentionalEmptyAreas'],
    'invalid_world_staged_spatial_plan', 'world_unknown_staged_spatial_field');
  if (!Array.isArray(raw.waterBodies)) throw new Error('invalid_world_staged_spatial_plan');
  if (raw.terrainRefinements !== undefined && !Array.isArray(raw.terrainRefinements)) {
    throw new Error('invalid_world_staged_spatial_refinements');
  }
  const technicalNormalizations: string[] = [];
  const terrainRefinements: WorldTerrainBrush[] = [];
  let revisedRecipe = recipe;
  for (const [index, brush] of ((raw.terrainRefinements ?? []) as unknown[]).entries()) {
    try {
      const normalizedBrush = normalizeModelTerrainBrush(brush, `terrainRefinements[${index}]`, technicalNormalizations);
      revisedRecipe = validateWorldRecipe({ ...recipe,
        terrainBrushes: [...(recipe.terrainBrushes ?? []), ...terrainRefinements, normalizedBrush as WorldTerrainBrush] });
      terrainRefinements.push(normalizedBrush as WorldTerrainBrush);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!['invalid_world_terrain_brush', 'invalid_world_terrain_region', 'invalid_world_terrain_id']
        .includes(code)) throw error;
      technicalNormalizations.push(`terrainRefinements[${index}].${code}_skipped`);
    }
  }
  const mobility = raw.mobilityPlan && typeof raw.mobilityPlan === 'object' && !Array.isArray(raw.mobilityPlan)
    ? raw.mobilityPlan as Record<string, unknown> : null;
  const mobilityPlan = mobility && Array.isArray(mobility.routes) ? { ...mobility, routes: mobility.routes.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const route = value as Record<string, unknown>;
    if (!route.construction || typeof route.construction !== 'object' || Array.isArray(route.construction)) return value;
    const construction = route.construction as Record<string, unknown>;
    if (construction.terrain !== 'follow' || typeof construction.maxGrade !== 'number'
      || construction.maxGrade < 0.02 || construction.maxGrade > 0.2) return value;
    const { maxGrade: _maxGrade, ...follow } = construction;
    technicalNormalizations.push(`mobilityPlan.routes[${index}].follow_max_grade_ignored`);
    return { ...route, construction: follow };
  }) } : raw.mobilityPlan;
  const plan = validateWorldPlan({
    version: 1, id: raw.id, revision: 1, prompt: request.prompt, whitebox: true,
    recipe: { ...revisedRecipe, waterBodies: raw.waterBodies }, ecology: raw.ecology ?? [], towns: [], roads: [],
    concept: raw.concept, featureGraph: raw.featureGraph, settlementPlan: raw.settlementPlan,
    mobilityPlan, explorationPlan: raw.explorationPlan,
    intentionalEmptyAreas: raw.intentionalEmptyAreas
  });
  if (!plan.featureGraph || !plan.concept || !plan.settlementPlan || !plan.mobilityPlan
    || !plan.explorationPlan || !plan.intentionalEmptyAreas) throw new Error('world_whitebox_missing_semantic_plan');
  const { waterBodies: _waterBodies, ...copiedDryTerrain } = plan.recipe;
  if (terrainRefinements.length) {
    copiedDryTerrain.terrainBrushes = copiedDryTerrain.terrainBrushes?.slice(0, -terrainRefinements.length);
    if (!recipe.terrainBrushes) delete copiedDryTerrain.terrainBrushes;
  }
  if (!isDeepStrictEqual(copiedDryTerrain, recipe)) throw new Error('world_staged_dry_terrain_changed');
  return { rawPlan: response.plan, plan, technicalNormalizations };
}

function constructionSiting(value: unknown): 'central' | 'waterfront' | 'gateway' | 'high-ground' | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 500) throw new Error('invalid_world_whitebox_public_building');
  if (value === 'central' || value === 'waterfront' || value === 'gateway' || value === 'high-ground') return value;
  if (/\b(?:shore|shoreline|waterfront|beach|waterside|seafront|dockside)\b|滨水|海岸|河岸|湖岸|码头/i.test(value)) return 'waterfront';
  if (/\b(?:high ground|hilltop|ridge|summit|upper slope|lookout|cliff|crater rim)\b|高地|山脊|坡上|山顶|悬崖/i.test(value)) return 'high-ground';
  if (/\b(?:gateway|gate|entrance|arrival|trailhead|bridge approach)\b|入口|门口|桥头/i.test(value)) return 'gateway';
  return 'central';
}

function parseConstructionTown(value: unknown, settlementIds: Set<string>, issue: (townId: string, value: string) => void): WorldWhiteboxConstructionTown {
  const town = exact(value, ['id', 'name', 'kind', 'pattern', 'density', 'population', 'waterfrontBias', 'publicBuildings'],
    'invalid_world_whitebox_construction_town', 'world_unknown_whitebox_construction_town_field');
  const id = constructionId(town.id, 'invalid_world_whitebox_construction_town');
  if (!settlementIds.has(id) || town.kind !== 'city' && town.kind !== 'village'
    || town.pattern !== 'organic' && town.pattern !== 'grid' || !Array.isArray(town.publicBuildings)
    || town.publicBuildings.length > 12) throw new Error('invalid_world_whitebox_construction_town');
  const publicBuildings = town.publicBuildings.map(value => {
    const building = exact(value, ['id', 'use', 'width', 'depth', 'height', 'assetKey', 'enterable', 'siting'],
      'invalid_world_whitebox_public_building', 'world_unknown_whitebox_public_building_field');
    if (building.enterable !== undefined && building.enterable !== false) throw new Error('world_whitebox_direct_asset_required');
    const siting = constructionSiting(building.siting);
    if (siting && siting !== building.siting) issue(id,
      `siting_prose_normalized:${String(building.id)}:${siting}`);
    return {
      id: constructionId(building.id, 'invalid_world_whitebox_public_building'),
      use: constructionText(building.use, 120, 'invalid_world_whitebox_public_building'),
      width: constructionNumber(building.width, 1, 300, 'invalid_world_whitebox_public_building'),
      depth: constructionNumber(building.depth, 1, 300, 'invalid_world_whitebox_public_building'),
      height: constructionNumber(building.height, 1, 300, 'invalid_world_whitebox_public_building'),
      ...(building.assetKey === undefined ? {} : {
        assetKey: constructionId(building.assetKey, 'invalid_world_whitebox_public_building')
      }),
      ...(building.enterable === false ? { enterable: false } : {}),
      ...(siting ? { siting } : {})
    };
  });
  const population = town.population === undefined ? undefined
    : constructionNumber(town.population, 1, 1_000_000, 'invalid_world_whitebox_construction_town');
  if (population !== undefined && !Number.isInteger(population)) throw new Error('invalid_world_whitebox_construction_town');
  return { id, name: constructionText(town.name, 160, 'invalid_world_whitebox_construction_town'),
    kind: town.kind, pattern: town.pattern,
    density: constructionNumber(town.density, 0, 1, 'invalid_world_whitebox_construction_town'),
    ...(population === undefined ? {} : { population }),
    ...(town.waterfrontBias === undefined ? {} : {
      waterfrontBias: constructionNumber(town.waterfrontBias, 0, 1, 'invalid_world_whitebox_construction_town')
    }), publicBuildings } as WorldWhiteboxConstructionTown;
}

export function materializeWorldWhiteboxConstruction(
  content: string,
  request: WorldWhiteboxConstructionRequest
): WorldWhiteboxConstructionMaterialization {
  const parsed = parseLlmJsonObject(content, 'invalid_world_whitebox_construction_response');
  const root = exact(parsed, ['towns', 'ecology', 'assets'], 'invalid_world_whitebox_construction_response',
    'world_unknown_whitebox_construction_field');
  if (!Array.isArray(root.towns) || !Array.isArray(root.assets)) throw new Error('invalid_world_whitebox_construction_response');
  const source = request.whiteboxPlan;
  const settlementIds = new Set(source.settlementPlan!.settlements.map(item => item.id));
  const diagnostics = new Map<string, string[]>();
  const issue = (townId: string, value: string) => diagnostics.set(townId, [...diagnostics.get(townId) ?? [], value]);
  const towns = root.towns.map(value => parseConstructionTown(value, settlementIds, issue));
  if (towns.length !== settlementIds.size || new Set(towns.map(town => town.id)).size !== settlementIds.size
    || [...settlementIds].some(id => !towns.some(town => town.id === id))) {
    throw new Error('world_whitebox_construction_town_mismatch');
  }
  const assets = root.assets.map(value => exact(value,
    ['key', 'name', 'role', 'prompt', 'dimensions', 'enterable', 'strategy', 'existingAssetId', 'ecologyKind', 'ecologyRuleId'],
    'invalid_world_asset_request', 'world_unknown_asset_field'));
  const newAssets = assets.filter(asset => asset.existingAssetId === undefined);
  if (newAssets.length > request.assetGenerationLimit) throw new Error('world_whitebox_asset_generation_limit');
  if (newAssets.some(asset => asset.strategy !== 'single' && asset.strategy !== 'assembly' || asset.enterable === true)) {
    throw new Error('world_whitebox_direct_asset_required');
  }
  // Keep asset proposals in the whitebox preview so the user can approve their
  // footprint and program before any of the proposed models are generated.
  const addedEcology = validateEcologyRules(root.ecology);
  const spatialEcologyIds = new Set(source.ecology.map(rule => rule.id));
  const ecology = validateEcologyRules([...source.ecology,
    ...addedEcology.filter(rule => !spatialEcologyIds.has(rule.id))]);
  for (const rule of addedEcology) if (spatialEcologyIds.has(rule.id)) {
    issue('world', `ecology_rule_repeated:${rule.id}`);
  }
  const graph = source.featureGraph!;
  const anchors = new Map(graph.anchors.map(anchor => [anchor.id, anchor]));
  const regions = new Map(graph.regions.map(region => [region.id, region]));
  const paths = new Map(graph.paths.map(path => [path.id, path]));
  const settlementAnchorSets = new Map(source.settlementPlan!.settlements.map(settlement => [settlement.id,
    new Set([settlement.anchorId, ...(settlement.districts ?? []).map(district => district.anchorId)])]));
  const internalRouteIds = new Set(source.mobilityPlan!.routes.filter(route =>
    route.connects.length >= 2 && source.settlementPlan!.settlements.some(settlement => {
      if (settlement.districts === undefined) return false;
      const settlementAnchors = settlementAnchorSets.get(settlement.id)!;
      return route.connects.every(anchorId => settlementAnchors.has(anchorId));
    })).map(route => route.id));
  const sample = createWorldSampler(source.recipe);
  const minimumRadius = Math.min(100, source.recipe.size / 10);
  const minimumBlend = Math.min(100, source.recipe.size / 25);
  const bound = source.recipe.size / 2;
  const accessRoads: WorldPlan['roads'] = [];
  const usedIds = new Set([source.id, ...source.ecology.map(item => item.id),
    ...source.settlementPlan!.settlements.map(item => item.id), ...source.mobilityPlan!.routes.map(item => item.id)]);
  const derivedId = (base: string) => {
    let id = base, suffix = 2;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    return id;
  };
  const constructedTowns = source.settlementPlan!.settlements.flatMap((settlement, settlementIndex) => {
    const authored = towns.find(town => town.id === settlement.id)!;
    if (settlement.population !== undefined && authored.population !== undefined
      && settlement.population !== authored.population) issue(settlement.id, 'settlement_population_changed_after_spatial_plan');
    const anchor = anchors.get(settlement.anchorId)!;
    const region = regions.get(anchor.regionId)!;
    const authoredDistricts = (settlement.districts ?? []).map(district => {
      const districtAnchor = anchors.get(district.anchorId)!;
      const districtRegion = regions.get(districtAnchor.regionId)!;
      const available = bound - Math.max(Math.abs(districtRegion.center[0]), Math.abs(districtRegion.center[1]));
      if (available < districtRegion.radius) issue(settlement.id, `settlement_district_world_edge_overlap:${district.anchorId}`);
      return { ...district, position: districtRegion.center, radius: districtRegion.radius };
    });
    const footprints = [{ position: region.center, radius: region.radius },
    ...authoredDistricts.filter(district => district.radius >= 1)];
    const min: Point = [0, 1].map(axis => Math.min(...footprints.map(item => item.position[axis] - item.radius))) as Point;
    const max: Point = [0, 1].map(axis => Math.max(...footprints.map(item => item.position[axis] + item.radius))) as Point;
    const anchoredRadius = Math.max(minimumRadius, ...footprints.map(item => Math.max(
      Math.abs(item.position[0] - anchor.position[0]) + item.radius,
      Math.abs(item.position[1] - anchor.position[1]) + item.radius
    )));
    const anchorCapacity = bound - Math.max(Math.abs(anchor.position[0]), Math.abs(anchor.position[1]));
    const envelopeRadius = Math.max(minimumRadius, (max[0] - min[0]) / 2, (max[1] - min[1]) / 2);
    const envelopeCenter: Point = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
    const radiusLimit = Math.max(minimumRadius * 2, region.radius * 2);
    const envelopeFits = envelopeRadius <= radiusLimit
      && Math.max(Math.abs(envelopeCenter[0]), Math.abs(envelopeCenter[1])) + envelopeRadius <= bound;
    const anchorFits = anchoredRadius <= anchorCapacity && anchoredRadius <= radiusLimit;
    const radius = anchorFits ? anchoredRadius : envelopeFits ? envelopeRadius
      : anchorCapacity >= minimumRadius ? Math.min(anchoredRadius, anchorCapacity, radiusLimit)
        : Math.max(minimumRadius, (Math.min(bound, max[0]) - Math.max(-bound, min[0])) / 2,
          (Math.min(bound, max[1]) - Math.max(-bound, min[1])) / 2);
    const center = anchorFits || !envelopeFits && anchorCapacity >= minimumRadius
      ? [...anchor.position] as Point
      : envelopeFits ? envelopeCenter : [0, 1].map(axis => {
        const clippedMin = Math.max(-bound, min[axis]), clippedMax = Math.min(bound, max[axis]);
        const lower = Math.max(clippedMax - radius, -bound + radius);
        const upper = Math.min(clippedMin + radius, bound - radius);
        return Math.max(lower, Math.min(anchor.position[axis], upper));
      }) as Point;
    if (center[0] !== anchor.position[0] || center[1] !== anchor.position[1]) {
      issue(settlement.id, 'settlement_core_recentered_for_districts');
    }
    const districts = authoredDistricts.filter(district => district.radius >= 1).map(({ position, ...district }) => ({
      ...district, offset: [position[0] - center[0], position[1] - center[1]] as Point
    }));
    if (footprints.some(item => Math.max(
      Math.abs(item.position[0] - center[0]) + item.radius,
      Math.abs(item.position[1] - center[1]) + item.radius
    ) > radius)) issue(settlement.id, 'settlement_districts_extend_beyond_core');
    const terrain = sample(center[0], center[1]);
    if (terrain.waterLevel !== null && terrain.waterLevel > terrain.height + 0.05) issue(settlement.id, 'settlement_anchor_on_water');
    const nearbyHarbor = source.featureGraph!.anchors.find(candidate =>
      MARITIME_HARBOR_TERM.test(candidate.kind)
      && Math.hypot(candidate.position[0] - center[0], candidate.position[1] - center[1]) <= radius);
    const harborDescription = `${anchor.kind} ${settlement.role} ${nearbyHarbor?.kind ?? ''}`;
    const maritimeHarbor = MARITIME_HARBOR_TERM.test(harborDescription);
    const harborRegion = nearbyHarbor ? regions.get(nearbyHarbor.regionId) : undefined;
    const targetWaterBodyId = maritimeHarbor && (
      hasAccessibleOceanShore(sample, center, radius)
      || (nearbyHarbor !== undefined && hasAccessibleOceanShore(sample,
        nearbyHarbor.position, Math.max(radius, harborRegion?.radius ?? 0)))
    ) ? 'sea' : undefined;
    if (maritimeHarbor && !targetWaterBodyId && !RIVER_PORT_TERM.test(harborDescription)) {
      issue(settlement.id, 'maritime_settlement_no_accessible_ocean_shore');
    }
    const ports: WorldPlan['towns'][number]['ports'] = [];
    for (const [routeIndex, route] of source.mobilityPlan!.routes.entries()) {
      const settlementAnchors = settlementAnchorSets.get(settlement.id)!;
      if (!route.connects.some(anchorId => settlementAnchors.has(anchorId))) continue;
      if (internalRouteIds.has(route.id)) continue;
      const path = paths.get(route.pathId)!;
      const boundary = nearestRouteBoundaryPoints(path.points, center, radius);
      if (!boundary.length) {
        if (path.points.every(point => Math.abs(point[0] - center[0]) <= radius
          && Math.abs(point[1] - center[1]) <= radius)) continue;
        issue(settlement.id, `route_settlement_disconnected:${route.id}:${settlement.id}`);
        continue;
      }
      const dry = boundary.filter(candidate => {
        const surface = sample(candidate.point[0], candidate.point[1]);
        return surface.waterLevel === null || surface.waterLevel <= surface.height + 0.05;
      });
      if (dry.length !== boundary.length) issue(settlement.id, `route_settlement_port_on_water:${route.id}:${settlement.id}`);
      const width = Math.min(64, Math.max(2, path.width));
      for (const candidate of dry) {
        if (ports.length >= 16) { issue(settlement.id, 'settlement_port_quota'); break; }
        const index = ports.length + 1;
        const endpoint = [path.points[0], path.points.at(-1)!].some(point =>
          Math.hypot(point[0] - candidate.point[0], point[1] - candidate.point[1]) <= 1e-6);
        let guideId = route.id;
        if (!endpoint) {
          if (source.mobilityPlan!.routes.length + accessRoads.length >= 32) {
            issue(settlement.id, `route_settlement_port_quota:${route.id}:${settlement.id}`);
            continue;
          }
          guideId = derivedId(`whitebox-access-${routeIndex + 1}-${settlementIndex + 1}-${index}`);
          accessRoads.push({ id: guideId, name: `${path.name} access`.slice(0, 160), points: [candidate.point, candidate.outside],
            curve: 'polyline', closed: false, width, tags: [...new Set(['world-route', path.kind, 'town-access'])] });
        }
        ports.push({ id: derivedId(`whitebox-port-${routeIndex + 1}-${settlementIndex + 1}-${index}`), guideId,
          position: [candidate.point[0] - center[0], candidate.point[1] - center[1]], width });
      }
    }
    return [{ id: settlement.id, name: authored.name, prompt: settlement.role,
      center, radius, blend: minimumBlend, foundation: Math.max(2, terrain.height),
      terrainMode: 'conform' as const, ports, ...(targetWaterBodyId ? { targetWaterBodyId } : {}),
      ...((settlement.population ?? authored.population) === undefined ? {}
        : { population: settlement.population ?? authored.population }),
      ...(settlement.districts === undefined ? {} : { districts }) }];
  });
  for (let left = 0; left < constructedTowns.length; left++) for (let right = left + 1; right < constructedTowns.length; right++) {
    const a = constructedTowns[left], b = constructedTowns[right];
    if (Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) < Math.max(a.radius, b.radius)) {
      issue('world', `possible_settlement_district_split:${a.id}:${b.id}`);
    }
  }
  const roads = [...source.mobilityPlan!.routes.map(route => {
    const path = paths.get(route.pathId)!;
    const centerline = worldFeaturePathPolyline(path);
    const anchorTolerance = Math.max(12, Math.min(24, path.width));
    for (const anchorId of route.connects) if (distanceToRoute(anchors.get(anchorId)!.position, centerline) > anchorTolerance) {
      issue('world', `route_anchor_miss:${route.id}:${anchorId}`);
    }
    const width = Math.min(64, Math.max(2, path.width));
    if (width !== path.width) issue('world', `route_width_bounded:${route.id}`);
    return { id: route.id, name: path.name, points: path.points.map(point => [...point] as Point),
      curve: path.curve ?? 'polyline', closed: false, width,
      tags: [...new Set(['world-route', path.kind, ...(internalRouteIds.has(route.id) ? ['town-internal', 'local_street'] : [])])] };
  }), ...accessRoads];
  const observed = executeWorldWhitebox(source).surfaceFacts;
  for (const [pathId, wet] of Object.entries(observed.pathWaterSamples)) {
    if (wet > 0) issue('world', `path_water_samples:${pathId}:${wet}`);
  }
  for (const finding of diagnoseFeatureSites(source, sample)) issue('world', finding);
  const { whitebox: _whitebox, ...sourceFields } = source;
  const plan = validateWorldPlan({ ...structuredClone(sourceFields), generationPolicy: 'raw-first-call',
    ecology, towns: constructedTowns, roads });
  for (const field of ['recipe', 'concept', 'featureGraph', 'settlementPlan', 'mobilityPlan', 'explorationPlan', 'intentionalEmptyAreas'] as const) {
    if (JSON.stringify(plan[field]) !== JSON.stringify(source[field])) throw new Error(`world_whitebox_locked_field_changed:${field}`);
  }
  return { plan, towns, settlements: towns.filter(town => plan.towns.some(item => item.id === town.id)).map(town => ({
    townId: town.id, options: { kind: town.kind, pattern: town.pattern, density: town.density,
      ...(town.waterfrontBias === undefined ? {} : { waterfrontBias: town.waterfrontBias }) }
  })), assets, diagnostics: [...diagnostics].map(([townId, planningIssues]) => ({ townId, planningIssues })) };
}

function samplePoint(sample: WorldSampler, point: Point): [number, number, number] {
  const surface = sample(point[0], point[1]);
  if (!Number.isFinite(surface.height) || surface.waterLevel !== null && !Number.isFinite(surface.waterLevel)) {
    throw new Error('world_whitebox_nonfinite_surface');
  }
  return [point[0], Math.max(surface.height, surface.waterLevel ?? surface.height), point[1]];
}

/** Build whitebox positions from the persisted recipe; no aesthetic correction is applied. */
export function executeWorldWhitebox(plan: WorldPlan): {
  execution: WorldWhiteboxExecution;
  surfaceFacts: { anchorsOnWater: string[]; pathWaterSamples: Record<string, number>; heightRange: [number, number] };
} {
  const checked = validateWorldPlan(plan);
  if (!checked.whitebox || !checked.featureGraph) throw new Error('world_whitebox_plan_required');
  const sample = createWorldSampler(checked.recipe);
  const heights: number[] = [];
  const anchorsOnWater: string[] = [];
  const pointsOfInterest = (checked.explorationPlan?.pointsOfInterest ?? []).map(poi => {
    const anchor = checked.featureGraph!.anchors.find(item => item.id === poi.anchorId)!;
    const terrain = sample(anchor.position[0], anchor.position[1]);
    heights.push(terrain.height);
    if (terrain.waterLevel !== null && terrain.waterLevel > terrain.height + 0.05) anchorsOnWater.push(poi.id);
    return { id: poi.id, position: samplePoint(sample, anchor.position) };
  });
  const pathWaterSamples: Record<string, number> = {};
  const paths = checked.featureGraph.paths.map(path => {
    const centerline = worldFeaturePathPolyline(path);
    let wet = 0;
    for (let i = 1; i < centerline.length; i++) {
      const [ax, az] = centerline[i - 1], [bx, bz] = centerline[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 12));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps, point: Point = [ax + (bx - ax) * t, az + (bz - az) * t];
        const terrain = sample(point[0], point[1]);
        if (!Number.isFinite(terrain.height)) throw new Error('world_whitebox_nonfinite_surface');
        heights.push(terrain.height);
        if (terrain.waterLevel !== null && terrain.waterLevel > terrain.height + 0.05) wet++;
      }
    }
    pathWaterSamples[path.id] = wet;
    return { id: path.id, points: path.points.map(point => [...point] as Point), curve: path.curve ?? 'polyline' };
  });
  return { execution: { pointsOfInterest, paths },
    surfaceFacts: { anchorsOnWater, pathWaterSamples,
      heightRange: heights.length ? [Math.min(...heights), Math.max(...heights)] : [0, 0] } };
}

export interface WorldWhiteboxAdjustment {
  decision: 'keep';
  applied: false;
  skipped: true;
  reason: 'raw_first_call_preserved';
}

/** Terrain-first planning used only by generate-complete. Public whitebox generation remains single-stage. */
export async function generateStagedWorldWhitebox(input: unknown, signal?: AbortSignal) {
  const request = validateWorldWhiteboxRequest(input);
  recordGenerationTrace('world.whitebox.staged.request', request);
  const terrainContent = await llmChat([
    { role: 'system', content: DRY_TERRAIN_PROMPT },
    { role: 'user', content: JSON.stringify({ prompt: request.prompt, seed: request.seed, size: request.size }) }
  ], { provider: 'gpt', temperature: 0.55, maxTokens: 10_000, maxAttempts: 1,
    traceStage: 'world.whitebox.terrain-plan', signal });
  recordGenerationTrace('world.whitebox.terrain-raw', { content: terrainContent });
  return continueStagedWorldWhitebox(request, terrainContent, signal);
}

/** Resume the unchanged first terrain response after a schema/parser failure without paying to replan it. */
export async function continueStagedWorldWhitebox(input: unknown, terrainContent: string, signal?: AbortSignal) {
  const request = validateWorldWhiteboxRequest(input);
  const terrain = parseWorldDryTerrainDraft(terrainContent, request);
  recordGenerationTrace('world.whitebox.terrain-plan', {
    recipe: terrain.recipe, technicalNormalizations: terrain.technicalNormalizations
  });
  const terrainEvidence = createWorldTerrainEvidence(terrain.recipe);
  recordGenerationTrace('world.whitebox.terrain-evidence', terrainEvidence);
  const spatialContent = await llmChat([
    { role: 'system', content: STAGED_SPATIAL_PROMPT },
    { role: 'user', content: JSON.stringify({ prompt: request.prompt, seed: request.seed, size: request.size,
      dryTerrain: terrain.recipe, terrainEvidence }) }
  ], { provider: 'gpt', temperature: 0.45, maxTokens: 20_000, maxAttempts: 1,
    traceStage: 'world.whitebox.spatial-plan', signal });
  recordGenerationTrace('world.whitebox.spatial-raw', { content: spatialContent });
  const spatial = parseWorldWhiteboxSpatialPlan(spatialContent, request, terrain.recipe);
  recordGenerationTrace('world.whitebox.spatial-plan', spatial.plan);
  const first = executeWorldWhitebox(spatial.plan);
  const observation = observeWorldWhitebox(spatial.plan, first.execution);
  const technicalNormalizations = [...terrain.technicalNormalizations, ...spatial.technicalNormalizations];
  const observed = { ...observation, surfaceFacts: first.surfaceFacts, technicalNormalizations };
  recordGenerationTrace('world.whitebox.observation', observed);
  const adjustment: WorldWhiteboxAdjustment = {
    decision: 'keep', applied: false, skipped: true, reason: 'raw_first_call_preserved'
  };
  recordGenerationTrace('world.whitebox.adjustment', adjustment);
  const bundle = { plan: spatial.plan, patches: [] };
  recordGenerationTrace('world.whitebox.final', { plan: spatial.plan, observation: observed });
  return { bundle, originalTerrainDraft: terrain.rawTerrain, terrainDraft: terrain.recipe, terrainEvidence,
    originalPlan: spatial.rawPlan, initialPlan: spatial.plan, observation: observed, adjustment,
    finalPlan: spatial.plan, finalObservation: observed,
    planningDiagnostics: { terrain: terrain.technicalNormalizations, spatial: spatial.technicalNormalizations },
    draft: { plan: spatial.plan, settlements: [], assets: [] }, diagnostics: [], assetSources: [],
    planningProvider: 'gpt', paidCallCount: 2, preview: true, mode: 'whitebox' as const };
}

export async function generateWorldWhitebox(input: unknown, signal?: AbortSignal) {
  const request = validateWorldWhiteboxRequest(input);
  recordGenerationTrace('world.whitebox.request', request);
  const initialMessages: ChatMessage[] = [
    { role: 'system', content: INITIAL_PROMPT },
    { role: 'user', content: JSON.stringify({ prompt: request.prompt, seed: request.seed, size: request.size }) }
  ];
  const initialContent = await llmChat(initialMessages, { provider: 'gpt', temperature: 0.55,
    maxTokens: 20_000, maxAttempts: 1, traceStage: 'world.whitebox.initial-plan', signal });
  recordGenerationTrace('world.whitebox.initial-raw', { content: initialContent });
  const { rawPlan, plan: initialPlan, technicalNormalizations } = parseWorldWhiteboxInitialPlan(initialContent, request);
  recordGenerationTrace('world.whitebox.initial-plan', initialPlan);
  const first = executeWorldWhitebox(initialPlan);
  const observation = observeWorldWhitebox(initialPlan, first.execution);
  const observed = { ...observation, surfaceFacts: first.surfaceFacts, technicalNormalizations };
  recordGenerationTrace('world.whitebox.observation', observed);
  const adjustment: WorldWhiteboxAdjustment = {
    decision: 'keep', applied: false, skipped: true, reason: 'raw_first_call_preserved'
  };
  recordGenerationTrace('world.whitebox.adjustment', adjustment);
  const finalPlan = initialPlan;
  const finalObservation = observed;
  const bundle = { plan: finalPlan, patches: [] };
  recordGenerationTrace('world.whitebox.final', { plan: finalPlan, observation: finalObservation });
  return { bundle, originalPlan: rawPlan, initialPlan, observation: observed, adjustment,
    finalPlan, finalObservation, draft: { plan: finalPlan, settlements: [], assets: [] }, diagnostics: [],
    assetSources: [], planningProvider: 'gpt', paidCallCount: 1, preview: true, mode: 'whitebox' as const };
}
