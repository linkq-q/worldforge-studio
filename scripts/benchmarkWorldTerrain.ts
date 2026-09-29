import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import assert from 'node:assert/strict';
import { WORLD_BIOMES, WORLD_REGIONS, createWorldSampler, dominantBiome, parseWorldPrompt, sampleWorldTile, selectWorldTiles } from '../src/shared/worldTerrain';

const prompts = [
  '西方是海洋，东方是沙漠',
  '东方是海洋，西方是沙漠',
  '北方是海洋，南方是沙漠，西方是森林，东方是草原，中央是山脉',
  '西方是海洋，东方是沙漠，北方是雪地，南方是森林，中央是山脉',
  '西北是海洋，东北是雪地，西南是森林，东南是沙漠，中央是草原'
];
const cases = [];
for (const prompt of prompts) for (const seed of [1, 42, 2026]) {
  const recipe = parseWorldPrompt(prompt, seed);
  const sample = createWorldSampler(recipe);
  const fractions = Object.fromEntries(WORLD_BIOMES.map(b => [b, 0]));
  let min = Infinity, max = -Infinity, mixed = 0;
  const start = performance.now(), n = 129;
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const s = sample((ix / (n - 1) - 0.5) * recipe.size, (iz / (n - 1) - 0.5) * recipe.size);
    fractions[dominantBiome(s)]++;
    min = Math.min(min, s.height); max = Math.max(max, s.height);
    if (Object.values(s.weights).filter(w => w > 0.1).length > 1) mixed++;
  }
  for (const b of WORLD_BIOMES) fractions[b] /= n * n;
  const coreChecks = recipe.constraints.filter(c => c.biome === 'ocean' || c.biome === 'desert').map(c => {
    const [ax, az] = WORLD_REGIONS[c.region];
    let passed = 0;
    for (let iz = -4; iz <= 4; iz++) for (let ix = -4; ix <= 4; ix++) {
      const s = sample((ax + ix * 0.025) * recipe.size / 2, (az + iz * 0.025) * recipe.size / 2);
      if (dominantBiome(s) === c.biome && (c.biome === 'ocean' ? s.height < 0 : s.height > 0)) passed++;
    }
    const ratio = passed / 81;
    assert(ratio >= (c.biome === 'ocean' ? 0.9 : 0.8), prompt + ': ' + c.region + ' core compliance failed');
    return { region: c.region, biome: c.biome, passed, sampled: 81, ratio };
  });
  cases.push({ prompt, seed, minHeight: min, maxHeight: max, fractions, mixedFraction: mixed / (n * n), sampleMs: performance.now() - start, coreChecks });
}
const scaling = [];
for (const size of [16000, 64000, 256000]) {
  const recipe = parseWorldPrompt(prompts[3], 42, size);
  const tiles = selectWorldTiles(size, 1200, -2500, 600);
  sampleWorldTile(recipe, tiles[0]); // warmup
  const timings = [], bytes = [];
  for (const tile of tiles.slice(0, 24)) {
    const start = performance.now(), data = sampleWorldTile(recipe, tile);
    timings.push(performance.now() - start);
    bytes.push(data.heights.byteLength + data.normals.byteLength + data.weights.byteLength);
  }
  timings.sort((a,b) => a-b);
  scaling.push({ size, tileCount: tiles.length, verticesWithoutSkirts: tiles.length * 33 * 33,
    nearestSpacing: Math.min(...tiles.map(t => t.size / 32)), sampledTiles: timings.length,
    tileP50Ms: timings[Math.floor(timings.length * 0.5)], tileP95Ms: timings[Math.floor(timings.length * 0.95)],
    tileArrayBytes: bytes[0] });
}
const report = { date: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model,
  note: 'CPU sampler benchmark only; GPU/browser quality and frame times are measured separately.',
  acceptance: 'Ocean/desert cores are 9x9 samples within +/-0.1 normalized units of the explicit region anchor; exclude transitions.',
  cases, scaling };
await mkdir('output/terrain-biome-lab', { recursive: true });
await writeFile('output/terrain-biome-lab/benchmark.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ cases: cases.length, minimumCoreCompliance: Math.min(...cases.flatMap(c => c.coreChecks.map(k => k.ratio))), scaling }, null, 2));

