/**
 * Experimental continuous world sampler. Metres, Y up, sea level 0, north = -Z.
 * No editor state, rendering style, network or mutable RNG enters this recipe.
 */
export const WORLD_MIN_SIZE = 500;
export const WORLD_BIOMES = ['ocean', 'grassland', 'forest', 'desert', 'mountains', 'snow'] as const;
export type WorldBiome = typeof WORLD_BIOMES[number];
export const WORLD_REGIONS = {
  west: [-0.8, 0], east: [0.8, 0], north: [0, -0.8], south: [0, 0.8],
  northwest: [-0.65, -0.65], northeast: [0.65, -0.65],
  southwest: [-0.65, 0.65], southeast: [0.65, 0.65], center: [0, 0]
} as const;
export type WorldRegion = keyof typeof WORLD_REGIONS;
export interface WorldConstraint { region: WorldRegion; biome: WorldBiome }
export interface WorldRecipe {
  version: 1;
  seed: number;
  size: number;
  constraints: WorldConstraint[];
  landforms?: Array<{ center: [number, number]; radius: [number, number]; height: number }>;
}
export interface WorldSample {
  height: number;
  temperature: number;
  moisture: number;
  continentalness: number;
  weights: Record<WorldBiome, number>;
}
export interface WorldTile { x: number; z: number; size: number }
export interface WorldTileData {
  heights: Float32Array;
  normals: Float32Array;
  weights: Float32Array;
  resolution: number;
}

const regionWords: Record<WorldRegion, string> = {
  northwest: '西北|northwest', northeast: '东北|northeast',
  southwest: '西南|southwest', southeast: '东南|southeast',
  west: '西|west', east: '东|east', north: '北|north', south: '南|south',
  center: '中央|中心|中部|中间|center|centre'
};
const biomeWords: Record<WorldBiome, string> = {
  ocean: '海洋|大海|海域|海|ocean|sea',
  grassland: '草原|草地|平原|grassland|plains?',
  forest: '森林|树林|雨林|forest',
  desert: '沙漠|荒漠|沙丘|desert',
  mountains: '山脉|山地|高山|群山|mountains?',
  snow: '雪山|雪原|雪地|冰原|snow'
};
export const REGION_LABELS: Record<WorldRegion, string> = {
  west: '西方', east: '东方', north: '北方', south: '南方', center: '中央',
  northwest: '西北', northeast: '东北', southwest: '西南', southeast: '东南'
};
export const BIOME_LABELS: Record<WorldBiome, string> = {
  ocean: '海洋', grassland: '草原', forest: '森林', desert: '沙漠', mountains: '山脉', snow: '雪地'
};

/** Deliberately bounded grammar: refuse omitted/contradictory semantics, never pretend to be an LLM. */
export function parseWorldPrompt(prompt: string, seed = 42, size = 64000): WorldRecipe {
  if (typeof prompt !== 'string' || prompt.length > 500) throw new Error('描述须为 500 字以内的文本。');
  const regionPattern = Object.values(regionWords).join('|');
  const direction = new RegExp(regionPattern, 'giu');
  const matches = [...prompt.matchAll(direction)];
  if (!matches.length) throw new Error('请给出方位与群落，例如：西方是海洋，东方是沙漠。');
  const prefix = prompt.slice(0, matches[0].index).replace(/我|希望|想要|想|一个|生成|地图|请|为|在|的|地形|世界|I|want|would|like|a|world|with|please|generate|\s|[，,。.!！:：]/giu, '');
  if (prefix) throw new Error('无法理解开头描述：' + prefix);
  const constraints: WorldConstraint[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const region = (Object.keys(regionWords) as WorldRegion[]).find(key => new RegExp('^(?:' + regionWords[key] + ')$', 'iu').test(match[0]))!;
    const phrase = prompt.slice(match.index! + match[0].length, matches[i + 1]?.index ?? prompt.length);
    const found = (Object.keys(biomeWords) as WorldBiome[]).filter(key => new RegExp(biomeWords[key], 'iu').test(phrase));
    if (found.length !== 1) throw new Error(REGION_LABELS[region] + '需要一个明确群落；支持海洋、森林、草原、沙漠、山脉、雪地。');
    const residue = phrase.replace(new RegExp(biomeWords[found[0]], 'giu'), '')
      .replace(/方|边|部|面|侧|区域|地区|一片|一带|是|为|有|要|以|主|则|的|和|与|以及|然后|希望|我|到|is|are|has|the|and|with|\s|[，,。.!！:：;；、]/giu, '');
    if (residue) throw new Error('暂不支持这部分描述：' + residue + '。请用“方位＋群落”。');
    const existing = constraints.find(item => item.region === region);
    if (existing && existing.biome !== found[0]) throw new Error(REGION_LABELS[region] + '存在冲突，请只指定一个群落。');
    if (!existing) constraints.push({ region, biome: found[0] });
  }
  return validateWorldRecipe({ version: 1, seed, size, constraints });
}

export function validateWorldRecipe(input: WorldRecipe): WorldRecipe {
  if (!input || input.version !== 1 || !Number.isInteger(input.seed) || input.seed < 0 || input.seed > 0xffffffff
    || !Number.isFinite(input.size) || input.size < WORLD_MIN_SIZE || input.size > 256000
    || !Array.isArray(input.constraints) || input.constraints.length < 1 || input.constraints.length > 9) {
    throw new Error('无效世界配方：尺寸为 500 m–256 km，种子为 0–4294967295 整数。');
  }
  const seen = new Set<WorldRegion>();
  for (const item of input.constraints) {
    if (!item || !Object.hasOwn(WORLD_REGIONS, item.region) || !WORLD_BIOMES.includes(item.biome) || seen.has(item.region)) {
      throw new Error('无效或重复的方位约束。');
    }
    seen.add(item.region);
  }
  const recipe: WorldRecipe = { version: 1, seed: input.seed, size: input.size, constraints: input.constraints.map(item => ({ ...item })) };
  if (input.landforms !== undefined) {
    if (!Array.isArray(input.landforms) || input.landforms.length > 16) throw new Error('invalid_world_landform');
    recipe.landforms = input.landforms.map(form => {
      if (!form || !Array.isArray(form.center) || form.center.length !== 2 || !Array.isArray(form.radius) || form.radius.length !== 2
        || !form.center.every(n => Number.isFinite(n) && Math.abs(n) <= input.size / 2)
        || !form.radius.every(n => Number.isFinite(n) && n >= 10 && n <= input.size)
        || !Number.isFinite(form.height) || Math.abs(form.height) > 500) throw new Error('invalid_world_landform');
      return { center: [...form.center], radius: [...form.radius], height: form.height };
    });
  }
  return recipe;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

function hash(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 69069);
  h = Math.imul(h ^ h >>> 13, 1274126177);
  return ((h ^ h >>> 16) >>> 0) / 2147483647.5 - 1;
}

/** Global coordinates, quintic interpolation, no per-tile normalization. */
function noise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const tx = fade(x - ix), tz = fade(z - iz);
  return mix(mix(hash(ix, iz, seed), hash(ix + 1, iz, seed), tx),
    mix(hash(ix, iz + 1, seed), hash(ix + 1, iz + 1, seed), tx), tz);
}
function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let value = 0, amplitude = 1, total = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise(x, z, seed + i * 1013);
    total += amplitude;
    const nextX = x * 1.7 - z * 1.1 + 13.1;
    z = x * 1.1 + z * 1.7 - 7.7;
    x = nextX;
    amplitude *= 0.48;
  }
  return value / total;
}
const targets: Record<WorldBiome, readonly [number, number, number, number]> = {
  ocean: [-0.95, 0.6, 0.8, 0.05],
  desert: [0.65, 0.95, 0.06, 0.04],
  forest: [0.7, 0.62, 0.94, 0.16],
  grassland: [0.65, 0.65, 0.48, 0.03],
  mountains: [0.85, 0.48, 0.46, 1],
  snow: [0.8, 0.03, 0.5, 0.6]
};

export function createWorldSampler(input: WorldRecipe): (x: number, z: number) => WorldSample {
  const recipe = validateWorldRecipe(input);
  const { seed, size, constraints } = recipe;
  return (x: number, z: number): WorldSample => {
    const nx = x / (size / 2), nz = z / (size / 2);
    const warpX = fbm(x / 13000 + 17, z / 13000, seed + 41, 2);
    const warpZ = fbm(x / 13000, z / 13000 - 23, seed + 73, 2);
    const ux = nx + warpX * 0.12, uz = nz + warpZ * 0.12;
    const broad = fbm(x / 8500, z / 8500, seed + 103);
    let continentalness = (0.5 + broad * 0.5) * 0.12;
    let temperature = (0.62 - nz * 0.12) * 0.12;
    let moisture = (0.52 + fbm(x / 10000, z / 10000, seed + 701, 2) * 0.28) * 0.12;
    let uplift = (0.15 + smooth(-0.15, 0.65, broad) * 0.7) * 0.12;
    let total = 0.12;
    for (const constraint of constraints) {
      const anchor = WORLD_REGIONS[constraint.region];
      const d2 = (ux - anchor[0]) ** 2 + (uz - anchor[1]) ** 2;
      const w = Math.exp(-d2 / 0.27) * 2.4;
      const target = targets[constraint.biome];
      continentalness += target[0] * w;
      temperature += target[1] * w;
      moisture += target[2] * w;
      uplift += target[3] * w;
      total += w;
    }
    continentalness = continentalness / total + broad * 0.14;
    moisture = clamp(moisture / total + fbm(x / 4500 + 13, z / 4500, seed + 809, 2) * 0.08);
    temperature = clamp(temperature / total);
    uplift = uplift / total;
    const land = smooth(-0.03, 0.22, continentalness);
    const wx = x + warpX * 1500, wz = z + warpZ * 1500;
    const ridgeNoise = fbm(wx / 2600, wz / 2600, seed + 211, 3);
    const ridge = Math.cos(ridgeNoise * Math.PI / 2) ** 4;
    const mass = smooth(-0.45, 0.5, fbm(wx / 6200, wz / 6200, seed + 919, 3));
    const mountain = uplift * (0.16 + mass * 0.84);
    const dry = smooth(0.53, 0.82, temperature) * (1 - smooth(0.14, 0.44, moisture));
    const rolling = fbm(wx / 1200, wz / 1200, seed + 311, 4) * 115;
    const dunes = (0.5 + 0.5 * Math.sin(wx / 85 + wz / 160 + noise(wx / 1100, wz / 1100, seed + 505) * 4)) ** 1.5 * 28;
    const base = continentalness < 0 ? continentalness * 1050 : Math.pow(continentalness, 1.4) * 400;
    let height = base + land * (mountain * ridge * 3100 + rolling * (1 - dry * 0.8) + dry * dunes);
    for (const form of recipe.landforms ?? []) {
      const d2 = ((x - form.center[0]) / form.radius[0]) ** 2 + ((z - form.center[1]) / form.radius[1]) ** 2;
      // Compact support with zero first and second derivatives at the boundary.
      if (d2 < 1) height += form.height * (1 - d2) ** 3;
    }
    const localTemp = clamp(temperature - Math.max(0, height - 300) * 0.00012);
    const ocean = 1 - smooth(-12, 8, height);
    const snow = smooth(0.28, 0.1, localTemp) * (1 - ocean);
    const rock = smooth(0.24, 0.65, mountain) * (1 - ocean) * (1 - snow);
    const remainder = Math.max(0, 1 - ocean - snow - rock);
    const desert = dry * remainder;
    const forest = smooth(0.5, 0.82, moisture) * (remainder - desert);
    const grassland = Math.max(0, remainder - desert - forest);
    return {
      height, continentalness, temperature: localTemp, moisture,
      weights: { ocean, grassland, forest, desert, mountains: rock, snow }
    };
  };
}

export function dominantBiome(sample: WorldSample): WorldBiome {
  return WORLD_BIOMES.reduce((a, b) => sample.weights[a] >= sample.weights[b] ? a : b);
}

export function sampleWorldTile(recipe: WorldRecipe, tile: WorldTile, resolution = 33, sample = createWorldSampler(recipe)): WorldTileData {
  if (!Number.isInteger(resolution) || resolution < 3 || resolution > 129 || !Number.isFinite(tile.x)
    || !Number.isFinite(tile.z) || !Number.isFinite(tile.size) || tile.size <= 0 || tile.size > recipe.size) {
    throw new Error('invalid_world_tile');
  }
  const heights = new Float32Array(resolution * resolution);
  const normals = new Float32Array(resolution * resolution * 3);
  const weights = new Float32Array(resolution * resolution * WORLD_BIOMES.length);
  // A fixed world-space stencil gives identical normals at every LOD's shared vertices.
  const epsilon = 4;
  for (let iz = 0; iz < resolution; iz++) for (let ix = 0; ix < resolution; ix++) {
    const i = iz * resolution + ix;
    const x = tile.x + ix * tile.size / (resolution - 1);
    const z = tile.z + iz * tile.size / (resolution - 1);
    const point = sample(x, z);
    heights[i] = point.height;
    const dx = sample(x + epsilon, z).height - sample(x - epsilon, z).height;
    const dz = sample(x, z + epsilon).height - sample(x, z - epsilon).height;
    const length = Math.hypot(dx, epsilon * 2, dz);
    normals.set([-dx / length, epsilon * 2 / length, -dz / length], i * 3);
    for (let j = 0; j < WORLD_BIOMES.length; j++) weights[i * WORLD_BIOMES.length + j] = point.weights[WORLD_BIOMES[j]];
  }
  return { heights, normals, weights, resolution };
}

/** Bounded quadtree covering the whole world; detail follows the camera and its orbit target. */
export function selectWorldTiles(size: number, focusX: number, focusZ: number, distance: number, maxTiles = 256): WorldTile[] {
  if (![size, focusX, focusZ, distance, maxTiles].every(Number.isFinite) || size < WORLD_MIN_SIZE || size > 256000
    || distance < 0 || maxTiles < 1 || maxTiles > 1024 || !Number.isInteger(maxTiles)) throw new Error('invalid_world_lod');
  const tiles: WorldTile[] = [{ x: -size / 2, z: -size / 2, size }];
  while (tiles.length + 3 <= maxTiles) {
    let best = -1, priority = 1 / 1.65;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      if (tile.size <= Math.min(125, size / 16)) continue;
      const dx = Math.max(0, Math.abs(focusX - (tile.x + tile.size / 2)) - tile.size / 2);
      const dz = Math.max(0, Math.abs(focusZ - (tile.z + tile.size / 2)) - tile.size / 2);
      const score = tile.size > size / 8 ? 1000 + tile.size / size
        : tile.size / Math.max(1, Math.hypot(dx, dz, distance * 0.35));
      if (score > priority) { priority = score; best = i; }
    }
    if (best === -1) break;
    const tile = tiles[best], half = tile.size / 2;
    tiles.splice(best, 1,
      { x: tile.x, z: tile.z, size: half }, { x: tile.x + half, z: tile.z, size: half },
      { x: tile.x, z: tile.z + half, size: half }, { x: tile.x + half, z: tile.z + half, size: half });
  }
  return tiles;
}

