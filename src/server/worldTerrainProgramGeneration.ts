import {createWorldTerrainEvidence, validateWorldRecipe, type WorldRecipe} from '../shared/worldTerrain';
import {validateWorldBundle} from '../shared/worldPlanning';
import {llmChat} from './modelApi';
import {recordGenerationTrace} from './generationTrace';
import {parseLlmJsonObject} from './llmJson';
import {DRY_TERRAIN_PROMPT, parseWorldDryTerrainDraft} from './worldWhiteboxGeneration';
import {createWorldTerrainGeneratorCalibration} from '../shared/worldTerrain';
import {compileTerrainProgram} from './terrainProgram';
import {TERRAIN_PROGRAM_DEFAULT_RESOLUTION, validateTerrainProgramResolution} from '../shared/terrainProgramField';

export function createTerrainProgramPrompt(resolution = TERRAIN_PROGRAM_DEFAULT_RESOLUTION): string {
  validateTerrainProgramResolution(resolution);
  return `Create the requested natural terrain by writing a deterministic JavaScript program. Return JSON {"program":"function generate(t) { ... }", "constraints":[{"region":"center","biome":"grassland"}]} only. Do not include buildings, vegetation, roads, a render style or asset requests. This is one original response, with no later model repair. You may define your own functions, data structures, masks, coordinate warps, loops and numerical algorithms; helpers are optional, not a list of permitted terrain shapes.
The program runs once to compile a ${resolution}x${resolution} height field covering 500x500 metres, with ${500 / (resolution - 1)} metre sample spacing. Clients bilinearly interpolate this saved field; features narrower than its spacing can be missed. X/Z -250..250; north -Z; Y up; sea level 0; all heights must be finite -500..500m. t.seed, t.size, t.resolution, t.spacing are read-only context; t.spacing = t.size/(t.resolution-1). No imports, process, require, network, filesystem, async or Math.random. Execution time budget 12s, V8 heap limit 128MiB, compiled JSON output limit 8MiB UTF-8. Use ordinary JavaScript arrays; binary buffers, typed arrays and WebAssembly are unavailable to generated code. Avoid quadratic grid algorithms. All Math functions and local arrays are available. Function generate(t) modifies the terrain; it does not return a field.
API:
- t.map((x,z,h)=>newHeight): compose any numeric height function over the field, initially zero. h and t.sample refer to the previous field for the entire pass. An excellent place to build broad massifs, warped multiscale relief, custom ridges and masks; use multiple passes freely.
- t.noise(x,z,wavelengthMetres=50,octaves=1): smooth seeded value noise in -1..1; 1..8 octaves. Coordinate offsets give independent-looking domains. No random calls needed.
- t.sample(x,z): bilinear height query of the current field.
- t.ridge([[x,z,crestElevation,halfFootprintWidth],...],{base:0}): connected ridge with linearly varying height and width. Raises with max(existing,base+(crest-base)*(1-distance/width)^1.6) inside width; leaves outside intact. This joins a shared base and subordinate spurs. It is piecewise linear; use enough nonuniform samples or your own smoothly curved coordinate functions. Avoid seven isolated identical mounds or spoke/ring arrangements unless actually requested.
- t.channel([[x,z,bedElevation,floorWidth],...],{bankSlope:0.7}): cut only. For each path segment, min(existing,interpolatedBed+max(0,distance-floorWidth/2)*bankSlope). bankSlope is rise/run, not degrees. It creates a broad V-shaped valley with a narrow floor, not a constant-depth brush groove. Paths run upstream to downstream; bed elevations decline. Tributaries share the SAME coordinates/elevation at confluences; scale widths and slope to drainage hierarchy. Avoid a low downstream endpoint cutting through an entire ridge: this helper has conical influence beyond endpoints; use your own bounded map/mask if necessary. Put headwaters sufficiently high and channels in low saddles, never arbitrarily over the main divide. Terrain may be drier than its implied historical drainage; no water mesh required.
- t.erode({iterations:8,thermal:0.3,drainage:0.4,talus:35}): optional thermal slope relaxation and drainage-area-dependent stream-power incision from the editor's existing algorithm. iterations 0..40, strengths0..1,talus5..80 degrees. It follows existing downhill flow; it cannot invent a missing main valley or drain closed pits. Not a full geological simulation.
- t.inspect(label,[[x,z],...]): returns {label,min,max,points:[[x,z],...],samples:[height,...],terrainRevision} and records an immutable snapshot. terrainRevision increases only when a height-changing pass actually changes the field, so later changes can make an earlier observation stale. Up to32 reports,256 points/report. Use programmatic queries to check your intended crest/saddle relationships and downstream profiles within the program. These are observations, not hidden automatic aesthetic correction.
Design from large coherent masses and connected divide/valley systems down to secondary forms and restrained small relief. Major/secondary peaks should differ in height, spacing and prominence while sharing shoulders and a base. Drainage subdivides slopes into interlocking spurs and valleys. Channel width, slope and depth respond to tributary hierarchy. Avoid ruler-straight trenches, smooth stamped bowls, regular spacing and isotropic noisy bumps. A few metres of noise do not replace intermediate-scale branching landforms. If making an island, let coast return below sea level BEFORE the rectangular boundary using a smooth, irregular shelf mask; use t.map to construct your own boundary function. Inland landscapes may continue across bounds.
constraints controls only climate/material classification for this program, never the compiled heights. Use 1..9 unique regions west/east/north/south/northwest/northeast/southwest/southeast/center, biomes ocean/grassland/forest/desert/mountains/snow. Think through formation and composition, then provide the complete program, not a predefined demo.`;
}

export const TERRAIN_PROGRAM_PROMPT = createTerrainProgramPrompt();

export async function generateTerrainOnlyWorld(input: unknown, signal?: AbortSignal) {
  const request = input as {mode?: string; representation?: string; prompt?: string; seed?: number; size?: number; resolution?: number};
  if (!request || request.mode !== 'terrain-only' || !['recipe', 'program'].includes(request.representation ?? '')
    || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 4000
    || !Number.isInteger(request.seed) || request.seed! < 0 || request.seed! > 0xffffffff || request.size !== 500
    || (request.representation === 'recipe' && request.resolution !== undefined)) {
    throw new Error('invalid_terrain_only_request');
  }
  const seed = request.seed!, prompt = request.prompt, representation = request.representation!;
  const resolution = representation === 'program'
    ? validateTerrainProgramResolution(request.resolution === undefined
      ? TERRAIN_PROGRAM_DEFAULT_RESOLUTION : request.resolution) : undefined;
  const content = await llmChat([{role:'system',content:representation === 'program' ? createTerrainProgramPrompt(resolution) : DRY_TERRAIN_PROMPT},
    {role:'user',content:JSON.stringify({prompt,seed,size:500,
      ...(resolution !== undefined ? {resolution,spacing:500 / (resolution - 1)} : {}),
      ...(representation === 'recipe' ? {generatorCalibration:createWorldTerrainGeneratorCalibration(seed,500)} : {})})}],
    {provider:'gpt', temperature:0.55,maxTokens:14000,maxAttempts:1,traceStage:`world.terrain-only.${representation}`,signal});
  recordGenerationTrace('world.terrain-only.raw', {representation,content});
  if (signal?.aborted) throw new Error('terrain_generation_aborted');
  let recipe: WorldRecipe;
  if (representation === 'program') {
    const raw = parseLlmJsonObject(content, 'invalid_terrain_program_response');
    if (Object.keys(raw).some(key => !['program','constraints'].includes(key)) || typeof raw.program !== 'string') {
      throw new Error('invalid_terrain_program_response');
    }
    const terrainProgram = await compileTerrainProgram(raw.program, {seed,size:500,resolution});
    recipe = validateWorldRecipe({version:1,seed,size:500,reliefProfile:'compact',
      constraints:raw.constraints as WorldRecipe['constraints'],terrainProgram});
  } else {
    recipe = parseWorldDryTerrainDraft(content,{mode:'whitebox',prompt,seed,size:500}).recipe;
  }
  const bundle = validateWorldBundle({plan:{version:1,id:`terrain-${representation}-${seed}`,revision:1,prompt,
    recipe,ecology:[],towns:[],roads:[]},patches:[]});
  const terrainEvidence = createWorldTerrainEvidence(recipe);
  recordGenerationTrace('world.terrain-only.compiled', {representation,terrainEvidence});
  return {mode:'terrain-only' as const,representation,bundle,rawResponse:content,terrainEvidence,paidCallCount:1};
}
