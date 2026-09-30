import { createWorldSampler, WORLD_BIOMES, WORLD_REGIONS, type WorldSampler } from '../shared/worldTerrain';
import { DEFAULT_WATER_DEPTH } from '../shared/map';
import {
  observeWorldWhitebox, validateWorldPlan,
  type Point, type WorldPlan, type WorldWhiteboxExecution
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

const INITIAL_PROMPT = `Design one playable 500 x 500 metre world from the user's description. Return a single JSON object {"plan":{...}} and nothing else. The plan is your original creative decision, not a scene template. Plan broad regions, paths, anchors and their relationships before any detail. Let terrain shape settlement, mobility and the exploration sequence; leave deliberate quiet areas. Keep unusual terrain if it makes the world interesting. Do not list individual trees or houses and do not request 3D assets.
Use this WorldPlan schema exactly: plan={version:1,id,revision:1,prompt,whitebox:true,recipe,ecology:[],towns:[],roads:[],concept,featureGraph,settlementPlan,mobilityPlan,explorationPlan,intentionalEmptyAreas}. Copy prompt exactly from the request. recipe={version:1,seed,size:500,reliefProfile:'compact',constraints:[{region,biome}], optional heightScale,landforms,terrainBrushes,waterBodies,biomePatches}. Copy seed exactly. Valid broad constraint regions: west/east/north/south/northwest/northeast/southwest/southeast/center; biomes: ocean/grassland/forest/desert/mountains/snow. World coordinates are centred: X and Z each -250..250; sea level is 0. Terrain can be below sea. Shape the terrain with the existing recipe, not with a flat plate. A landform is {center:[x,z],radius:[rx,rz],height}. A local brush is {id,mode:'raise'|'lower',region:{kind:'circle',center:[x,z],radius},amount,feather?}; use only if useful. Fresh water bodies may be {id,type:'lake',region:{kind:'circle',center:[x,z],radius},levels:[height],depth,shorelineSmoothness?,shorelineIrregularity?} or type:'river' with a path region {kind:'path',points:[[x,z],...],width} and one level per point. Avoid authoring a complete city with individual buildings at this stage.
concept={premise:string,themes:string[],experience:string}. featureGraph={regions:[{id,kind,name,center:[x,z],radius}],paths:[{id,kind,name,points:[[x,z],...],width}],anchors:[{id,kind,position:[x,z],regionId}],relations:[{fromId,toId,kind}]}. Region radius must be 1..250 metres; path width 0.1..256 metres; every path needs at least two distinct numeric points. Use region for large spatial areas, path for an actual route/watercourse/shore movement, anchor for meaningful destinations or a settlement centre, and relation for why features belong together. Every anchor regionId refers to a region. Relation endpoints refer to feature ids. settlementPlan={settlements:[{id,anchorId,role}]}; describe districts and their density transition in roles, with each linked to an anchor. mobilityPlan={routes:[{id,pathId,mode,connects:[anchorId,...]}]}; road types and walking trails may differ, and a bridge should be purposeful where water crossings need it. explorationPlan={pointsOfInterest:[{id,anchorId,purpose}],sequence:[poiId,...]}; sequence is a representative player journey, not every possible destination. intentionalEmptyAreas=[{id,regionId,purpose}]. All ids are unique within their respective semantic collection. Every reference must exist. The graph is broad and editable, not a semantic grid or a fixed biome menu. The whitebox renders existing primitives only. Return no screenshots or render instructions.`;

const ADJUST_PROMPT = `You are the same creator looking at your first whitebox world. You can keep the plan or make one finite creative adjustment. Input contains only the original user prompt, your original plan, deterministic world facts, unrealized plan items, fatal technical issues and remaining budget. There are no screenshots. All low-density, road, terrain and visual findings are diagnostics, not mandatory fixes. Preserve intentional emptiness and unusual useful terrain. Do not optimize a score. Never request assets.
Return exactly {"decision":"keep"} or {"decision":"patch","patch":{...}}. The patch may replace 1 to 4 complete fields from recipe, concept, featureGraph, settlementPlan, mobilityPlan, explorationPlan, intentionalEmptyAreas. It must not change prompt, id, seed, size, whitebox mode, towns, roads or ecology. Include dependent fields together when changing referenced ids. Do not include instructions, code, an entire plan, screenshots or a second round. The server will validate the new plan once and keep the original if the patch is technically invalid; it will not auto-repair aesthetics.`;

const PATCH_FIELDS = new Set(['recipe', 'concept', 'featureGraph', 'settlementPlan', 'mobilityPlan', 'explorationPlan', 'intentionalEmptyAreas']);

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
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
  decision: 'keep' | 'patch';
  patch?: Partial<Pick<WorldPlan, 'recipe' | 'concept' | 'featureGraph' | 'settlementPlan' | 'mobilityPlan' | 'explorationPlan' | 'intentionalEmptyAreas'>>;
  applied: boolean;
  error?: string;
}

export function applyWorldWhiteboxAdjustment(plan: WorldPlan, input: unknown): { plan: WorldPlan; adjustment: WorldWhiteboxAdjustment } {
  try {
    const response = object(input, 'invalid_world_whitebox_adjustment');
    if (response.decision === 'keep' && Object.keys(response).length === 1) {
      return { plan, adjustment: { decision: 'keep', applied: false } };
    }
    const patch = object(response.patch, 'invalid_world_whitebox_patch');
    const fields = Object.keys(patch);
    if (response.decision !== 'patch' || Object.keys(response).length !== 2
      || fields.length < 1 || fields.length > 4 || fields.some(key => !PATCH_FIELDS.has(key))
      || JSON.stringify(patch).length > 32_000) throw new Error('invalid_world_whitebox_patch');
    const next = validateWorldPlan({ ...plan, ...patch, revision: plan.revision + 1 });
    if (next.recipe.seed !== plan.recipe.seed || next.recipe.size !== plan.recipe.size) {
      throw new Error('world_whitebox_patch_changed_request');
    }
    return { plan: next, adjustment: { decision: 'patch', patch, applied: true } };
  } catch (error) {
    return { plan, adjustment: { decision: 'keep', applied: false,
      error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function generateWorldWhitebox(input: unknown, signal?: AbortSignal) {
  const request = validateWorldWhiteboxRequest(input);
  recordGenerationTrace('world.whitebox.request', request);
  const initialMessages: ChatMessage[] = [
    { role: 'system', content: INITIAL_PROMPT },
    { role: 'user', content: JSON.stringify({ prompt: request.prompt, seed: request.seed, size: request.size }) }
  ];
  const initialContent = await llmChat(initialMessages, { provider: 'gpt', temperature: 0.55,
    maxTokens: 12_000, traceStage: 'world.whitebox.initial-plan', signal });
  recordGenerationTrace('world.whitebox.initial-raw', { content: initialContent });
  const { rawPlan, plan: initialPlan, technicalNormalizations } = parseWorldWhiteboxInitialPlan(initialContent, request);
  recordGenerationTrace('world.whitebox.initial-plan', initialPlan);
  const first = executeWorldWhitebox(initialPlan);
  const observation = observeWorldWhitebox(initialPlan, first.execution);
  const observed = { ...observation, surfaceFacts: first.surfaceFacts, technicalNormalizations };
  recordGenerationTrace('world.whitebox.observation', observed);
  const adjustmentMessages: ChatMessage[] = [
    { role: 'system', content: ADJUST_PROMPT },
    { role: 'user', content: JSON.stringify({ originalPrompt: request.prompt, originalPlan: initialPlan,
      observation: observed, unrealizedPlans: observation.pointsOfInterest.unrealizedIds,
      fatalTechnicalIssues: [], remainingAdjustmentBudget: 1 }) }
  ];
  let adjustmentResult: ReturnType<typeof applyWorldWhiteboxAdjustment>;
  try {
    const adjustmentContent = await llmChat(adjustmentMessages, { provider: 'gpt', temperature: 0.3,
      maxTokens: 4_000, traceStage: 'world.whitebox.adjustment', signal });
    recordGenerationTrace('world.whitebox.adjustment-raw', { content: adjustmentContent });
    adjustmentResult = applyWorldWhiteboxAdjustment(initialPlan, JSON.parse(adjustmentContent));
  }
  catch (error) { adjustmentResult = { plan: initialPlan,
    adjustment: { decision: 'keep', applied: false, error: error instanceof Error ? error.message : String(error) } }; }
  const { plan: finalPlan, adjustment } = adjustmentResult;
  recordGenerationTrace('world.whitebox.adjustment', adjustment);
  const finalExecution = adjustment.applied ? executeWorldWhitebox(finalPlan) : first;
  const finalObservation = adjustment.applied
    ? { ...observeWorldWhitebox(finalPlan, finalExecution.execution), surfaceFacts: finalExecution.surfaceFacts }
    : observed;
  const bundle = { plan: finalPlan, patches: [] };
  recordGenerationTrace('world.whitebox.final', { plan: finalPlan, observation: finalObservation });
  return { bundle, originalPlan: rawPlan, initialPlan, observation: observed, adjustment,
    finalPlan, finalObservation, draft: { plan: finalPlan, settlements: [], assets: [] }, diagnostics: [],
    assetSources: [], planningProvider: 'gpt', preview: true, mode: 'whitebox' as const };
}
