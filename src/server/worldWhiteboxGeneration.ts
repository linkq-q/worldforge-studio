import { createWorldSampler, WORLD_BIOMES, WORLD_REGIONS, type WorldSampler } from '../shared/worldTerrain';
import { validateEcologyRules } from '../shared/worldEcology';
import { DEFAULT_WATER_DEPTH } from '../shared/map';
import {
  observeWorldWhitebox, validateWorldPlan,
  type Point, type TownBuilding, type WorldPlan, type WorldWhiteboxExecution
} from '../shared/worldPlanning';
import { llmChat, type ChatMessage } from './modelApi';
import { recordGenerationTrace } from './generationTrace';

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
  assetGenerationLimit: 3;
  repairAttempts: 0;
  reusableAssetIds?: string[];
}

export interface WorldWhiteboxConstructionTown {
  id: string;
  name: string;
  kind: 'city' | 'village';
  pattern: 'organic' | 'grid';
  density: number;
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
Use this WorldPlan schema exactly: plan={version:1,id,revision:1,prompt,whitebox:true,recipe,ecology:[],towns:[],roads:[],concept,featureGraph,settlementPlan,mobilityPlan,explorationPlan,intentionalEmptyAreas}. ecology, towns and roads must be empty arrays. Copy prompt exactly from the request. recipe={version:1,seed,size:500,reliefProfile:'compact',constraints:[{region,biome}], optional heightScale,landforms,terrainBrushes,waterBodies,biomePatches}. Copy seed exactly. For this 500 metre world, usually keep global heightScale around 0.08..0.15 so coasts and buildable slopes remain traversable. A compact island with strong ocean constraints may use about 0.02..0.04. These are creative guidelines, not hard limits: use an intentional exception when the requested world needs it, and express exceptional volcano or mountain relief with local landforms instead of accidentally exaggerating the whole terrain. Valid broad constraint regions: west/east/north/south/northwest/northeast/southwest/southeast/center; biomes: ocean/grassland/forest/desert/mountains/snow. World coordinates are centred: X and Z each -250..250; north is negative Z, south is positive Z, west is negative X; sea level is 0. Ocean is terrain below 0, not an independent circular lake; do not fake a bay or harbour with a round lake. Shape land and coastline with broad constraints and landforms, not with a flat plate. A landform is {center:[x,z],radius:[rx,rz],height}. A local brush is {id,mode:'raise'|'lower',region:{kind:'circle',center:[x,z],radius},amount,feather?}; use only if useful. biomePatches entries are {id,region:{kind:'circle',center:[x,z],radius}|{kind:'path',points:[[x,z],...],width},biome,feather?}; every patch needs a unique id and a bounded shape, never a compass region string. Fresh water bodies may be {id,type:'lake',region:{kind:'circle',center:[x,z],radius},levels:[height],depth,shorelineSmoothness?,shorelineIrregularity?} or {id,type:'river',region:{kind:'path',points:[[x,z],...],width},levels:[one height per path point],widths?:[one width per path point],depth,shorelineSmoothness?,shorelineIrregularity?}; every river must include its complete region, levels and depth. widths is optional and expresses intentional tributary or river-mouth widening; when present it has exactly one positive width per river path point. Trace river centerlines through plausible low ground with bends at the scale of their valleys; a long straight chord across hills reads like a canal. Keep ordinary river reaches at a gentle downstream slope and use compatible levels at confluences. A sharp fall calls for a distinct cascade or waterfall in the world concept, not a continuously tilted river surface. Let a river mouth meet the sea and its shoreline rather than stop at an inland straight cut. Avoid authoring a complete city with individual buildings at this stage.
concept={premise:string,themes:string[],experience:string}. featureGraph={regions:[{id,kind,name,center:[x,z],radius}],paths:[{id,kind,name,points:[[x,z],...],width}],anchors:[{id,kind,position:[x,z],regionId}],relations:[{fromId,toId,kind}]}. Region radius must be 1..250 metres; path width 0.1..256 metres; every path needs at least two distinct numeric points. Use region for large spatial areas, path for an actual route/watercourse/shore movement, anchor for meaningful destinations or a settlement centre, and relation for why features belong together. Every anchor regionId refers to a region. Relation endpoints refer to feature ids. Place harbour and lookout anchors on appropriate dry or shoreline terrain, never underwater. Trace routes over plausible ground; do not let a road cross open or deep water without an intentionally authored crossing. settlementPlan={settlements:[{id,anchorId,role}]}; describe districts and their density transition in roles, with each linked to an anchor. Show the whole inhabited footprint of a requested town, not just its centre: allocate connected, terrain-fitting regions for working, civic, residential and edge uses as appropriate, with streets and paths that allow outward growth. Give a town enough buildable area for ordinary homes and a few public services appropriate to its scale; a village is a sparser settlement, while a camp is only a small stop. Distinct districts should usually occupy distinct regions rather than several roles sharing one small circle. Let the extent respond to the usable coast, valley, slopes, routes and requested population instead of filling the whole map or compressing all life into one marker. mobilityPlan={routes:[{id,pathId,mode,connects:[anchorId,...]}]}; road types and walking trails may differ, and a bridge should be purposeful where water crossings need it. explorationPlan={pointsOfInterest:[{id,anchorId,purpose}],sequence:[poiId,...]}; sequence is a representative player journey, not every possible destination. intentionalEmptyAreas=[{id,regionId,purpose}]. All ids are unique within their respective semantic collection. Every reference must exist. The graph is broad and editable, not a semantic grid or a fixed biome menu. The whitebox renders existing primitives only. Return no screenshots or render instructions.`;

export const WHITEBOX_CONSTRUCTION_PROMPT = `Expand one already-approved WorldForge whitebox into deterministic construction inputs. Return JSON only:
{"towns":[{"id":"existing settlementPlan id","name":"display name","kind":"city|village","pattern":"organic|grid","density":0.0,"waterfrontBias":0.0,"publicBuildings":[]}],"ecology":[],"assets":[]}.
The supplied whitebox is immutable. Never return or rewrite recipe, featureGraph, anchors, paths, concept, settlementPlan, mobilityPlan, explorationPlan or intentionalEmptyAreas. Return exactly one town entry for every supplied settlementPlan id. The server owns town centers, radii, foundations and all road points from the authored anchors, regions and mobility paths. For each settlement, reason from its role and terrain: who lives and works there, which route brings people and goods, where its public entrance belongs, and how its density tapers into adjacent districts. Treat linked waterfront, civic, housing and agricultural districts as one inhabited place rather than one isolated cluster. A village is sparser than a town, not empty. Choose organic or grid structure for a reason rooted in the site's terrain and culture. Give a substantial town a few distinct public services or landmarks appropriate to its livelihood, roughly one per 10–20 ordinary buildings where space and the asset budget allow; avoid repeating the same public program in each district. publicBuildings contain only {id,use,width,depth,height,assetKey,enterable?,siting?}; do not choose coordinates. Every public building assetKey must equal one assets[].key, and its dimensions must match the corresponding asset request. Ordinary homes, shops and workshops are generated by the settlement rules and need no publicBuildings entry. Ecology uses the supplied WorldForge ecology rule schema and seeded streaming placement; do not enumerate plants. Design clustered habitats from moisture, biome, slope, fresh-water distance and human use: for example groves near a suitable water source, a forest on a moist slope, sparse rock or shrubs on exposed ground, and clear routes and building entrances. Use bounded regions only for distinctive local communities; broad biome rules can cover the rest. Assets contain reusable building or ecology families. Every new asset must use strategy:"single", must be non-enterable, and at most three assets may lack existingAssetId. Prefer supplied reusable assets for ordinary roles and ecology families, then spend new generation on the most visually and functionally important gaps. Do not request assembly assets. This is construction expansion, not critique or repair.`;

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
    || value.assetGenerationLimit !== 3 || value.repairAttempts !== 0
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
    assetGenerationLimit: 3, repairAttempts: 0,
    ...(Array.isArray(reusableAssetIds) && reusableAssetIds.length ? { reusableAssetIds: [...reusableAssetIds] as string[] } : {}) };
}

export function parseWorldWhiteboxInitialPlan(content: string, request: WorldWhiteboxRequest): {
  rawPlan: unknown; plan: WorldPlan; technicalNormalizations: string[]
} {
  const response = object(JSON.parse(content), 'invalid_world_whitebox_response');
  if (Object.keys(response).length !== 1 || !('plan' in response)) throw new Error('invalid_world_whitebox_response');
  const raw = object(response.plan, 'invalid_world_whitebox_plan');
  if (raw.whitebox !== true || raw.revision !== 1) throw new Error('invalid_world_whitebox_plan');
  const recipe = object(raw.recipe, 'invalid_world_whitebox_recipe');
  if (recipe.seed !== request.seed || recipe.size !== request.size) throw new Error('world_whitebox_request_mismatch');
  const technicalNormalizations = raw.prompt === request.prompt ? [] : ['request_prompt_echo'];
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

function parseConstructionTown(value: unknown, settlementIds: Set<string>): WorldWhiteboxConstructionTown {
  const town = exact(value, ['id', 'name', 'kind', 'pattern', 'density', 'waterfrontBias', 'publicBuildings'],
    'invalid_world_whitebox_construction_town', 'world_unknown_whitebox_construction_town_field');
  const id = constructionId(town.id, 'invalid_world_whitebox_construction_town');
  if (!settlementIds.has(id) || town.kind !== 'city' && town.kind !== 'village'
    || town.pattern !== 'organic' && town.pattern !== 'grid' || !Array.isArray(town.publicBuildings)
    || town.publicBuildings.length > 4) throw new Error('invalid_world_whitebox_construction_town');
  const publicBuildings = town.publicBuildings.map(value => {
    const building = exact(value, ['id', 'use', 'width', 'depth', 'height', 'assetKey', 'enterable', 'siting'],
      'invalid_world_whitebox_public_building', 'world_unknown_whitebox_public_building_field');
    if (building.enterable !== undefined && building.enterable !== false) throw new Error('world_whitebox_direct_asset_required');
    if (building.siting !== undefined && !['central', 'waterfront', 'gateway', 'high-ground'].includes(String(building.siting))) {
      throw new Error('invalid_world_whitebox_public_building');
    }
    return {
      id: constructionId(building.id, 'invalid_world_whitebox_public_building'),
      use: constructionText(building.use, 120, 'invalid_world_whitebox_public_building'),
      width: constructionNumber(building.width, 1, 300, 'invalid_world_whitebox_public_building'),
      depth: constructionNumber(building.depth, 1, 300, 'invalid_world_whitebox_public_building'),
      height: constructionNumber(building.height, 1, 300, 'invalid_world_whitebox_public_building'),
      assetKey: constructionId(building.assetKey, 'invalid_world_whitebox_public_building'),
      ...(building.enterable === false ? { enterable: false } : {}),
      ...(building.siting ? { siting: building.siting as 'central' | 'waterfront' | 'gateway' | 'high-ground' } : {})
    };
  });
  return { id, name: constructionText(town.name, 160, 'invalid_world_whitebox_construction_town'),
    kind: town.kind, pattern: town.pattern,
    density: constructionNumber(town.density, 0, 1, 'invalid_world_whitebox_construction_town'),
    ...(town.waterfrontBias === undefined ? {} : {
      waterfrontBias: constructionNumber(town.waterfrontBias, 0, 1, 'invalid_world_whitebox_construction_town')
    }), publicBuildings } as WorldWhiteboxConstructionTown;
}

export function materializeWorldWhiteboxConstruction(
  content: string,
  request: WorldWhiteboxConstructionRequest
): WorldWhiteboxConstructionMaterialization {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('invalid_world_whitebox_construction_response'); }
  const root = exact(parsed, ['towns', 'ecology', 'assets'], 'invalid_world_whitebox_construction_response',
    'world_unknown_whitebox_construction_field');
  if (!Array.isArray(root.towns) || !Array.isArray(root.assets)) throw new Error('invalid_world_whitebox_construction_response');
  const source = request.whiteboxPlan;
  const settlementIds = new Set(source.settlementPlan!.settlements.map(item => item.id));
  const towns = root.towns.map(value => parseConstructionTown(value, settlementIds));
  if (towns.length !== settlementIds.size || new Set(towns.map(town => town.id)).size !== settlementIds.size
    || [...settlementIds].some(id => !towns.some(town => town.id === id))) {
    throw new Error('world_whitebox_construction_town_mismatch');
  }
  const assets = root.assets.map(value => exact(value,
    ['key', 'name', 'role', 'prompt', 'dimensions', 'enterable', 'strategy', 'existingAssetId', 'ecologyKind', 'ecologyRuleId'],
    'invalid_world_asset_request', 'world_unknown_asset_field'));
  const newAssets = assets.filter(asset => asset.existingAssetId === undefined);
  if (newAssets.length > request.assetGenerationLimit) throw new Error('world_whitebox_asset_generation_limit');
  if (newAssets.some(asset => asset.strategy !== 'single' || asset.enterable === true)) {
    throw new Error('world_whitebox_direct_asset_required');
  }
  if (!request.generateAssets && newAssets.length) throw new Error('world_whitebox_assets_disabled');
  const ecology = validateEcologyRules(root.ecology);
  const graph = source.featureGraph!;
  const anchors = new Map(graph.anchors.map(anchor => [anchor.id, anchor]));
  const regions = new Map(graph.regions.map(region => [region.id, region]));
  const paths = new Map(graph.paths.map(path => [path.id, path]));
  const sample = createWorldSampler(source.recipe);
  const diagnostics = new Map<string, string[]>();
  const issue = (townId: string, value: string) => diagnostics.set(townId, [...diagnostics.get(townId) ?? [], value]);
  const minimumRadius = Math.min(100, source.recipe.size / 10);
  const minimumBlend = Math.min(100, source.recipe.size / 25);
  const bound = source.recipe.size / 2;
  const constructedTowns = source.settlementPlan!.settlements.flatMap(settlement => {
    const authored = towns.find(town => town.id === settlement.id)!;
    const anchor = anchors.get(settlement.anchorId)!;
    const region = regions.get(anchor.regionId)!;
    const maximumRadius = bound - Math.max(Math.abs(anchor.position[0]), Math.abs(anchor.position[1])) - minimumBlend;
    if (maximumRadius < minimumRadius) {
      issue(settlement.id, 'settlement_anchor_has_no_bounded_construction_core');
      return [];
    }
    const radius = Math.min(maximumRadius, Math.max(minimumRadius, region.radius));
    if (radius !== region.radius) issue(settlement.id, 'settlement_radius_bounded_for_schema');
    const terrain = sample(anchor.position[0], anchor.position[1]);
    if (terrain.waterLevel !== null && terrain.waterLevel > terrain.height + 0.05) issue(settlement.id, 'settlement_anchor_on_water');
    return [{ id: settlement.id, name: authored.name, prompt: settlement.role,
      center: [...anchor.position] as Point, radius, blend: minimumBlend, foundation: Math.max(2, terrain.height),
      terrainMode: 'conform' as const, ports: [] }];
  });
  const roads = source.mobilityPlan!.routes.map(route => {
    const path = paths.get(route.pathId)!;
    const width = Math.min(64, Math.max(2, path.width));
    if (width !== path.width) issue('world', `route_width_bounded:${route.id}`);
    return { id: route.id, name: path.name, points: path.points.map(point => [...point] as Point),
      curve: 'polyline' as const, closed: false, width, tags: [...new Set(['world-route', path.kind])] };
  });
  const observed = executeWorldWhitebox(source).surfaceFacts;
  for (const [pathId, wet] of Object.entries(observed.pathWaterSamples)) {
    if (wet > 0) issue('world', `path_water_samples:${pathId}:${wet}`);
  }
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
    let wet = 0;
    for (let i = 1; i < path.points.length; i++) {
      const [ax, az] = path.points[i - 1], [bx, bz] = path.points[i];
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
    return { id: path.id, points: path.points.map(point => [...point] as Point) };
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
