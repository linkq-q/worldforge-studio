import {createHash} from 'node:crypto';
import type {TerrainProgramField} from '../shared/terrainProgramField';
import {TERRAIN_PROGRAM_DEFAULT_RESOLUTION, validateTerrainProgramResolution} from '../shared/terrainProgramField';
import {compileTerrainProgram} from './terrainProgram';

export interface MapDesignTerrainProgram {
  source: string;
  size: number;
  seed?: number;
  resolution?: number;
}

export interface CompiledMapDesignTerrain {
  seed: number;
  size: number;
  field: TerrainProgramField;
}

// A replay needs no model request or second terrain compilation. Bound retained fields,
// including pending workers; restarted sessions simply recompile their saved source.
const terrainCache = new Map<string, Promise<CompiledMapDesignTerrain>>();

export async function compileMapDesignTerrain(input: MapDesignTerrainProgram, fallbackSeed: number,
  signal?: AbortSignal): Promise<CompiledMapDesignTerrain> {
  signal?.throwIfAborted();
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['source', 'size', 'seed', 'resolution'].includes(key))
    || typeof input.source !== 'string' || !input.source.trim() || input.source.length > 60_000
    || !Number.isFinite(input.size) || input.size < 500 || input.size > 256_000) {
    throw new Error('invalid_design_terrain_program');
  }
  const seed = input.seed ?? fallbackSeed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('invalid_design_terrain_seed');
  const resolution = validateTerrainProgramResolution(input.resolution ?? TERRAIN_PROGRAM_DEFAULT_RESOLUTION);
  const key = createHash('sha256').update(JSON.stringify([input.source, seed, input.size, resolution])).digest('hex');
  let pending = terrainCache.get(key);
  if (!pending) {
    pending = compileTerrainProgram(input.source, {seed, size: input.size, resolution})
      .then(field => ({seed, size: input.size, field}));
    terrainCache.set(key, pending);
    while (terrainCache.size > 4) terrainCache.delete(terrainCache.keys().next().value!);
    void pending.catch(() => { if (terrainCache.get(key) === pending) terrainCache.delete(key); });
  }
  const compiled = await pending;
  signal?.throwIfAborted();
  return compiled;
}

export const MAP_DESIGN_TERRAIN_REFERENCE = `Optional execute field terrainProgram:{source:"function generate(t){...}",size:500..256000,seed?:uint32,resolution?:33..513} compiles a model-authored height algorithm before the scene program. Default resolution is 257; spacing=size/(resolution-1), so a larger map needs a conscious precision choice. It is the same conversation, with no extra model call. The current declaration persists across execute actions when omitted; terrainProgram:null clears it. Compiled source/seed/size/resolution is cached for replay. In plan(api), api.terrainProgram() returns the compiled field; assign it explicitly to recipe.terrainProgram, using the same recipe.size and recipe.seed. Large arrays remain local. Omit this field to use a normal WorldRecipe instead.
Terrain source uses generate(t), ordinary JavaScript arrays, functions and Math; no imports/network/files/async/Math.random/binary buffers. t.seed,t.size,t.resolution,t.spacing describe the field. t.map((x,z,previousHeight)=>height) evaluates any algorithm over the grid; t.sample(x,z) reads the previous field during a pass. t.noise(x,z,wavelengthMetres=50,octaves=1) returns seeded smooth noise -1..1. Optional t.ridge([[x,z,crestHeight,halfWidth],...],{base:0}) raises connected ridges; t.channel([[x,z,bedHeight,floorWidth],...],{bankSlope:0.7}) cuts a valley; t.erode({iterations:0..40,thermal:0..1,drainage:0..1,talus:5..80}) relaxes/incises existing relief. These helpers are optional; define your own low/mid/high-frequency forms, warps, masks and bounded algorithms. t.inspect(label,[[x,z],...]) records at most32 observations of up to256 heights. Finite heights -500..500; 12s/128MiB/8MiB limits. Resolution is sampling precision, not mesh LOD or proof of detail. Design traversals and obstacles for the requested movement/play, not a mandatory walking-grade template.`;
