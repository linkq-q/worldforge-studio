import {isDeepStrictEqual} from 'node:util';
import type {WorldRecipe} from '../shared/worldTerrain';
import type {MapOperation} from '../shared/mapOperations';

export const RETIRED_DESIGN_TERRAIN_ERROR = 'design_terrain_program_retired:continuous design uses WorldRecipe; remove the execute terrainProgram field and author recipe parameters instead';

export function rejectDesignTerrainProgram(input: object): void {
  if ('terrainProgram' in input) throw new Error(RETIRED_DESIGN_TERRAIN_ERROR);
}

/** Existing persisted fields may be retained, or explicitly removed, but never authored here. */
export function assertDesignRecipeTerrain(recipe: WorldRecipe, base?: WorldRecipe): void {
  if (recipe.terrainProgram === undefined) return;
  if (!base?.terrainProgram || recipe.size !== base.size || recipe.seed !== base.seed
    || !isDeepStrictEqual(structuredClone(recipe.terrainProgram), structuredClone(base.terrainProgram))) {
    throw new Error(RETIRED_DESIGN_TERRAIN_ERROR);
  }
}

export function assertDesignRecipeOperations(operations: readonly MapOperation[], base?: WorldRecipe): void {
  for (const operation of operations) {
    if (operation.type === 'world.set') assertDesignRecipeTerrain(operation.world.bundle.plan.recipe, base);
  }
}

export const MAP_DESIGN_RECIPE_REFERENCE = `Continuous-world terrain uses the existing procedural WorldRecipe. Its compact profile combines broad relief, warped detail and landform drainage; generated JavaScript can calculate recipe parameters, control points and local refinements. Use api.environmentSample and api.report to retain actual measurements. A terrain program or a new sampled-height field cannot be supplied in this session. Saved legacy fields remain readable and may be preserved during other edits, or explicitly removed to restore their recipe; while retaining a field, preserve its data, source, size and seed.
Recipe contract (all distances/elevations in metres, X/Z centered on the world, north -Z, Y up, sea level 0): {version:1,seed:uint32,size:500..256000,reliefProfile?:'compact'|'legacy',heightScale?:0.02..4,constraints:[{region,biome}],landforms?,terrainBrushes?,waterBodies?,biomePatches?}. Select reliefProfile:'compact' explicitly for compact-world relief; omission retains the historical legacy profile. heightScale scales procedural relief, not the metre-valued landform/brush heights. It defaults to1, not a small-map calibration; inspect resulting heights before deciding scale. constraints contains1..9 unique regions west/east/north/south/northwest/northeast/southwest/southeast/center; biomes ocean/grassland/forest/desert/mountains/snow. A forest biome selects terrain/climate/material weights, not tree assets. Sea comes from sampled terrain below zero.
landforms:[{center:[x,z],radius:[radiusX,radiusZ],height}] has at most32 entries; centers lie inside +/-size/2, radii10..size, height -500..500. These are smooth overlapping elliptical contributions on the procedural terrain; centers/radii/heights are your design, not a fixed scene template.
The shared bounded region shape is {kind:'circle',center:[x,z],radius:1..size} or {kind:'path',points:[[x,z],...],width:1..1000}. Paths have2..64 points; centers/control points lie inside the world. feather is a transition distance0..2000 metres, not a 0..1 ratio. Every brush, water body and biome patch needs a unique id across those three collections, matching /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.
terrainBrushes has at most32 entries, applied in order: {id,mode:'raise'|'lower',region,amount:>0..1000,feather?}; {id,mode:'crater',region:CIRCLE,depth:>0..1000,rimHeight:>0..1000,feather?}; {id,mode:'flatten',region,height:-1000..5000,strength?:0..1,feather?}; {id,mode:'grade',region:PATH,heights:[one per path point],strength?:0..1,feather?}. grade heights are absolute elevations -1000..5000. Flatten and grade replace local elevations toward their target, so large full-strength regions remove underlying relief. Use measured local refinements when preserving coarse mountains; do not assume a wide flatten region only affects buildings.
waterBodies has at most32 entries: {id,type:'lake',region:CIRCLE,levels:[surfaceElevation],depth:0.1..500,...} or {id,type:'river',region:PATH,levels:[one surfaceElevation per point],depth:0.1..500,widths?:[one width1..1000 per point],...}. Authored levels are -1000..5000; optional river surfaceMode:'authored' is equivalent to omission. Alternatively a river may use surfaceMode:'terrain-fit' with no levels; its points run upstream to downstream and the shared sampler computes surface levels. terrain-fit alone allows waterfallAfterPointIndices:[unique segment indices], at most16. Water options: shorelineSmoothness?:0..1,shorelineIrregularity?:0..1,shorelineProfile?:'steep'|'gentle',seed?:uint32. Water changes the river/lake bed and banks as well as the visible surface; sample actual terrain and water after editing.
biomePatches:[{id,region,biome,feather?}] has at most32 entries, using the same biome enum and metre-valued transition distance. It changes local biome blending, not the actual contents of a functional area. Realize those uses with surfaces, routes, town patches and ordinary assets. Choose your own shape, scale, routes and purpose; this contract does not require a village, river or island.`;
