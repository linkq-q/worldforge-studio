import {getMapBounds, type EditableMap, type MapAsset} from '../shared/map';
import type {MapAiSuggestion} from '../shared/mapOperations';
import {buildMapCodePlannerSystemPrompt, generateMapCodeSuggestion, type MapCodePlannerOptions} from './mapCodePlanner';
import {compileMapDesignTerrain, MAP_DESIGN_TERRAIN_REFERENCE, type MapDesignTerrainProgram} from './mapDesignWorld';

export interface MapDesignExecutionInput {
  code: string;
  baseMap: EditableMap;
  assets: MapAsset[];
  maxNewAssets: number;
  createAsset?: MapCodePlannerOptions['createAsset'];
  signal?: AbortSignal;
  onProgress?: MapCodePlannerOptions['onProgress'];
  onToolObservation?: MapCodePlannerOptions['onToolObservation'];
  onAssetReady?: MapCodePlannerOptions['onAssetReady'];
  terrainProgram?: MapDesignTerrainProgram | null;
  appearancePlan?: MapCodePlannerOptions['appearancePlan'];
}

/** Every candidate is a complete program over the session's immutable base, never the previous draft. */
export async function executeMapDesignProgram(input: MapDesignExecutionInput): Promise<MapAiSuggestion> {
  input.signal?.throwIfAborted();
  const compiledTerrain = input.terrainProgram
    ? await compileMapDesignTerrain(input.terrainProgram, input.baseMap.seed, input.signal) : undefined;
  return generateMapCodeSuggestion('Execute the current design-session program.', input.baseMap, input.assets, {
    approvedCode: input.code,
    mode: 'refine',
    scope: 'general',
    promptMode: 'standard',
    revisionMode: 'first-pass',
    spatialPolicy: 'diagnose',
    worldEditPolicy: 'diagnostic',
    spatialObservationApis: true,
    compiledTerrain,
    appearancePlan: input.appearancePlan,
    onToolObservation: input.onToolObservation,
    onAssetReady: input.onAssetReady,
    stablePlacementIds: true,
    minNewAssets: 0,
    maxNewAssets: input.maxNewAssets,
    createAsset: input.createAsset,
    signal: input.signal,
    onProgress: input.onProgress
  });
}

/** Capability reference only: the caller owns the conversation's observe/execute/finish response protocol. */
export function buildMapDesignExecutionPrompt(map: EditableMap, assets: MapAsset[], maxNewAssets: number): string {
  const legacy = buildMapCodePlannerSystemPrompt(map, assets, 0, maxNewAssets, 'scene', 'generate', '', [], 'main');
  const reference = map.sceneMode === 'indoor'
    ? legacy.slice(legacy.indexOf('## Indoor structural contract'), legacy.indexOf('## Final self-check'))
    : legacy.slice(legacy.indexOf('- Data:'), legacy.lastIndexOf('Declare '));
  const catalog = assets.slice(0, 96).map(asset => ({id:asset.id, name:asset.name, tags:asset.tags}));
  return `Execution tool reference. This section describes code inside an execute action, not the outer response format.
Write a complete synchronous function plan(api) { ... }. It runs from the original session base on every execute: revise the complete program rather than append a delta to the previous draft. Keep prior intended edits in that program. Existing base-map content remains unless you explicitly change it. Preserve existing terrain unless the user requests terrain changes.
Use bounded ordinary JavaScript functions, arrays, loops, branches and Math; no imports, files, network, async, timers or eval. Math.random is seeded. Y is up; distances are metres, rotationY radians; x/z bounds=${JSON.stringify(getMapBounds(map))}, seed=${map.seed}.
${reference}
Refinement of existing base objects: api.move({objectId,position?,rotationY?,scale?}) uses degrees for its rotationY; api.removeObject(objectId), api.updateWater({waterId,...patch}), api.removeWater(id), api.noChange(reason). Locked base objects cannot be moved or removed. Object IDs of new placements are stable for the same base and declaration order; reorder/add earlier placements and query again before reusing an observed reference. Change newly authored objects by editing their declaration, not by treating them as base objects.
Environment reads guide local calculation and return through execution feedback with their phase and order. api.report(label,value) explicitly reports a bounded JSON calculation; nonfinite numbers, functions and cycles are errors. Use observe to examine the latest complete materialized draft. No hidden model repair or asset-adaptation call runs inside execution. Asset generation may return incomplete results; observe actual asset bounds/supports before deciding whether to adjust the program. Up to ${maxNewAssets} new asset tasks; each variant consumes one task, cached repeats consume none.
Local spatial queries: api.assetSpace(assetId) returns actual asset-local parts and support/interior evidence, or unknown when unavailable; api.sightline({from:[x,y,z],to:[x,y,z],ignoreIds?}); api.passage({points:[[x,z] or [x,y,z],...],width?,height?,ignoreIds?}); api.connectionGap({a:objectReferenceOrId,b:objectReferenceOrId,tolerance?}). Read their coverage.checkedSources/uncheckedSources. Asset space does not measure placed transforms, terrain contact or neighbors. The other three query manual map objects and current-program placements using collider AABBs; terrain, water, streamed town buildings, ecology, bridges and harbor quays are not tested as blockers. clear:true only means no obstruction in the checked sources, never all-world clearance or actual movement simulation. Use observe objects/region/path to inspect world structures and terrain separately. An obstruction may be intended gameplay. Use the requested movement, jumps, climbs, transport or obstacles to interpret results; do not automatically flatten terrain or require every path to be walkable.
${map.sceneMode === 'outdoor' ? `${worldReference}\n${MAP_DESIGN_TERRAIN_REFERENCE}` : ''}
Reusable asset IDs (use exactly): ${JSON.stringify(catalog)}`;
}

const worldReference = `Outdoor maps can use ordinary scene APIs or a streamed WorldPlan. If there is no world yet, api.createWorld({recipe,prompt?,id?,ecology?:[],roads?:[],towns?:[],patches?:[],assets?:[],concept?,featureGraph?,settlementPlan?,mobilityPlan?,explorationPlan?,intentionalEmptyAreas?}) initializes one explicitly. recipe is {version:1,seed:uint32,size:500..256000,constraints:[{region,biome}],reliefProfile?:'compact',landforms?,terrainBrushes?,waterBodies?,biomePatches?,terrainProgram?}. constraints contains1..9 unique regions west/east/north/south/northwest/northeast/southwest/southeast/center; biomes ocean/grassland/forest/desert/mountains/snow. No ecology, town or template is added implicitly. Server owns plan.version/revision and patch.worldKey. createWorld requires no existing world, and its full declaration remains in every replay until commit. api.bounds and api.seed then reflect the new world; its box expands to recipe.size. Existing manual objects remain. In a streamed world, edit its terrain heights, streamed ecology, settlements and world roads through api.editWorld. Ordinary api.surface, api.grass and api.route can additionally author localized ground uses, grass layers and surfaced paths in world metres; streamed tiles preserve these overlays. Ordinary terrain/brush/ramp height declarations target the separate small-map heightfield and cannot modify a streamed world. Raw paint strokes are not streamed-world surface tools; use api.surface. A guide alone does not create pavement; api.route authors its ground surface.
api.worldState() returns a detached local copy of {bundle:{plan,patches},assets,review?}. Large height arrays stay inside the execution tool; do not copy them into model messages.
api.editWorld(state => { ... }) edits that world copy synchronously, or may return a replacement state. Preserve unrelated fields. The executor validates the resulting world.set, increments plan.revision and refreshes patch.worldKey; do not invent either. It preserves original terrain data and asset bindings unless your code changes them.
This session persists generationPolicy:'diagnostic' on world edits. Structural contracts (finite values, bounds, quotas, IDs/references, patch identity and declared port endpoints/widths) still reject invalid edits. Terrain slope, water/earthwork, overlapping construction and disconnected street networks return quality warnings with repaired:false; their authored geometry is preserved. Read these diagnostics to decide whether to revise the complete program. This mode does not imply that the draft is playable or visually accepted.
plan contains recipe, ecology, roads, towns and optional featureGraph, settlementPlan, mobilityPlan, explorationPlan and intentionalEmptyAreas. Edit their actual existing IDs after observation. recipe holds biomePatches, terrain/field data, waterBodies and other validated terrain parameters. World roads are {id,name,points:[[x,z],...],curve:'polyline'|'catmull-rom',closed,width,tags}; keep terrain and playable access relationships in mind. Ecology rules are {id,kind:'broadleaf'|'pine'|'shrub'|'rock',biome,density:0..1,spacing:6..100,maxSlope:0..60,scale:[min,max],region?,regionFeather?,waterDistance?,waterSource?}; a region is {kind:'circle',center,radius} or {kind:'path',points,width}.
Town bounds: towns are {id,name,prompt,center:[worldX,worldZ],radius,blend,foundation,ports,terrainMode?,targetWaterBodyId?,population?,districts?}. radius is the half-width of a square core, not a circular distance. radius must be min(100,recipe.size/10)..1000; blend min(100,recipe.size/25)..2000; foundation 2..5000. These field ranges apply even for terrainMode:'conform'. On each axis abs(center)+radius+(terrainMode==='conform'?0:blend) must fit within recipe.size/2. Two square town cores overlap when abs(dx)<radiusA+radiusB AND abs(dz)<radiusA+radiusB; this returns a quality warning in this session. Touching cores and overlapping soft blend collars are allowed. Districts are {anchorId,kind:'working'|'civic'|'residential'|'edge',density:0..1,offset:[localX,localZ],radius:1..recipe.size/2}; anchorId must exist in featureGraph.anchors, and center+offset must be inside the world. Their footprints are circles around those local offsets. Observe summary.settlements for current ports and districts before altering the core.
bundle.patches hold {townId,worldKey,summary,streets,buildings}. Both street control points and building x/z are town-local; world position = town.center + local position. Streets have the same guide shape as world roads; BOTH plan.roads and patch.streets require width:2..64. Their control points must lie within [-localBound,localBound] on both axes, where localBound=Math.max(town.radius,...(town.districts??[]).map(d=>Math.max(Math.abs(d.offset[0])+d.radius,Math.abs(d.offset[1])+d.radius))); otherwise world_guide_outside. The translated control points must also remain inside the world. A route outside this local patch can be authored as a plan.roads route in world coordinates. Buildings use {id,x,z,width,depth,height,use,rotation?,assetKey?,enterable?}; rotated footprint corners must fit in the square core or declared district circles, and buildings must remain inside the world, avoid other buildings and street/road corridors. Do not infer legal building placement from localBound alone.
Ports are {id,guideId,position:[localX,localZ],width:2..64}. Each must stay on the square core boundary: Math.max(Math.abs(position[0]),Math.abs(position[1]))===town.radius (tolerance 1e-6); otherwise world_port_not_on_core_boundary. guideId references an open plan.roads guide whose first or last point equals town.center+port.position and whose width equals port.width (tolerance 1e-6). Every patch must retain an open street with first or last point exactly equal to port.position and matching width. Street junctions need shared vertices, not merely crossing lines. Changing town.center/radius, port.position or width therefore requires coordinated updates to the corresponding world-road endpoint and local-street endpoint/width in the SAME editWorld call. Preserve existing connections when no relocation is intended; enlarging radius alone is invalid when ports already exist.
state.assets binds {key,assetId,role:'house'|'shop'|'workshop'|'tree'|'landmark',ecologyKind?,ecologyRuleId?}. Existing bindings remain usable. A newly required asset can be bound here with api.asset(key); discovery leaves its placeholder unbound and final replay uses the actual generated asset ID. api.place still adds individual manual props on the world terrain.
The binding roles above serve streamed buildings/ecology; they do not restrict the scene's contents. Ordinary api.requireAsset and api.place can create equipment, furniture, play structures, stalls, machinery, crops, transport modules and other requested independent objects anywhere in the new world. Choose useful families and reuse them. A semantic region name does not create any of those objects.
Optional shared semantic fields: concept:{premise,themes:[string],experience}; featureGraph:{regions:[{id,kind,name,center:[x,z],radius}],paths:[{id,kind,name,points:[[x,z],...],curve?,width}],anchors:[{id,kind,position:[x,z],regionId,site?:{role:'structure'|'vehicle'|'equipment'|'furniture'|'landmark'|'scenery',surface:'land'|'water'|'structure',dimensions:[w,h,d],rotation?}}],relations:[{fromId,toId,kind}]}; settlementPlan:{settlements:[{id,anchorId,role,population?,districts?:[{anchorId,kind:'working'|'civic'|'residential'|'edge',density}]}]}; mobilityPlan:{routes:[{id,pathId,mode,connects:[anchorId,...],construction?:{terrain:'follow'|'grade',maxGrade?}}]}; explorationPlan:{pointsOfInterest:[{id,anchorId,purpose}],sequence:[pointOfInterestId,...]}; intentionalEmptyAreas:[{id,regionId,purpose}]. Their referenced IDs must exist. Mode and purpose express the user's play, not a walking-only rule. Named regions/anchors describe intent; realize their physical contents through patches, bindings and placements. Explain purposeful open landscape rather than filling every empty area.
Each ecology rule may declare exclusions:[region,...] (at most 32 circle/path regions). These explicit hard masks prevent candidate stems/rock centers in the declared areas; they do not automatically discover manual objects or measure canopy overlap. For a house clearing, derive the exclusion from its actual footprint plus a canopy allowance in the same program as the placement. Existing rules remain unchanged when exclusions are omitted.
Example: api.editWorld(state => { const forest=state.bundle.plan.ecology.find(rule=>rule.id==='observed-forest-id'); if (!forest) throw new Error('forest not found'); forest.regionFeather=25; }); This is a field edit example, not a required forest design.`;
