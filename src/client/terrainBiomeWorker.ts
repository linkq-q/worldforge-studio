import { BIOME_LABELS, WORLD_BIOMES, createWorldSampler, dominantBiome, sampleWorldTile, type WorldRecipe, type WorldTile } from '../shared/worldTerrain';
import { createPlannedWorldSampler, createWorldExclusion, createWorldEcologyDensity, type WorldBundle } from '../shared/worldPlanning';
import { generateEcologyChunk, type EcologyRule, type EcologyChunk } from '../shared/worldEcology';

let recipe: WorldRecipe;
let sample: ReturnType<typeof createWorldSampler>;
let exclude: ((x: number, z: number, radius: number) => boolean) | undefined;
let rules: EcologyRule[] = [];
let density: ((x:number,z:number)=>number) | undefined;
type Request = { kind: 'configure'; recipe: WorldRecipe; bundle?: WorldBundle; rules: EcologyRule[] }
  | { kind: 'tile'; tile: WorldTile; key: string }
  | { kind: 'ecology'; chunk: EcologyChunk; key: string }
  | { kind: 'atlas' };

self.onmessage = (event: MessageEvent<Request>) => {
  const start = performance.now(), request = event.data;
  try {
    if (request.kind === 'configure') {
      recipe = request.recipe;
      sample = request.bundle ? createPlannedWorldSampler(request.bundle.plan, request.bundle.patches) : createWorldSampler(recipe);
      exclude = request.bundle ? createWorldExclusion(request.bundle.plan, request.bundle.patches) : undefined;
      density = request.bundle ? createWorldEcologyDensity(request.bundle.plan, request.bundle.patches) : undefined;
      rules = request.rules;
      return;
    }
    if (!sample) throw new Error('world_worker_not_configured');
    if (request.kind === 'tile') {
      const data = sampleWorldTile(recipe, request.tile, 33, sample);
      self.postMessage({ kind: 'tile', key: request.key, data, ms: performance.now() - start },
        { transfer: [data.heights.buffer, data.normals.buffer, data.weights.buffer] });
      return;
    }
    if (request.kind === 'ecology') {
      const data = generateEcologyChunk(recipe, rules, request.chunk, { sample, exclusion: exclude, density });
      self.postMessage({ kind: 'ecology', key: request.key, data, ms: performance.now() - start });
      return;
    }
    const resolution = 160;
    const heights = new Float32Array(resolution * resolution);
    const weights = new Float32Array(resolution * resolution * WORLD_BIOMES.length);
    const counts = Object.fromEntries(WORLD_BIOMES.map(b => [BIOME_LABELS[b], 0]));
    let min = Infinity, max = -Infinity;
    for (let z = 0; z < resolution; z++) for (let x = 0; x < resolution; x++) {
      const i = z * resolution + x;
      const s = sample((x / (resolution - 1) - 0.5) * recipe.size, (z / (resolution - 1) - 0.5) * recipe.size);
      heights[i] = s.height;
      min = Math.min(min, s.height); max = Math.max(max, s.height);
      counts[BIOME_LABELS[dominantBiome(s)]]++;
      WORLD_BIOMES.forEach((b, j) => { weights[i * WORLD_BIOMES.length + j] = s.weights[b]; });
    }
    self.postMessage({ kind: 'atlas', heights, weights, counts, min, max, resolution, ms: performance.now() - start },
      { transfer: [heights.buffer, weights.buffer] });
  } catch (error) {
    self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

