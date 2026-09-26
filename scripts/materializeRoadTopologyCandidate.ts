import { readFileSync, writeFileSync } from 'node:fs';
import { createEmptyMap } from '../src/shared/map';
import { MapStore } from '../src/server/mapStore';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';

const [fixture, repeatText, arm, existingMapId] = process.argv.slice(2);
if (!fixture || !repeatText || !arm) throw new Error('Usage: tsx scripts/materializeRoadTopologyCandidate.ts <fixture> <repeat> <arm>');
const file = 'scripts/roadTopologyStudy.json';
const study = JSON.parse(readFileSync(file, 'utf8')) as {
  fixtures: Array<{ id: string; seed: number; sourceMapId?: string }>;
  runs: Array<{ fixture: string; repeat: number; arm: string; status: string; code?: string; materializedMapId?: string; materializedObjectCount?: number; materializationError?: string }>;
};
const run = study.runs.find(item => item.fixture === fixture && item.repeat === Number(repeatText) && item.arm === arm);
const experiment = study.fixtures.find(item => item.id === fixture);
if (!run || run.status !== 'saved' || !run.code || !experiment?.sourceMapId) throw new Error('A saved high-relief Code run is required');
const save = () => writeFileSync(file, JSON.stringify(study, null, 2) + '\n');
const store = new MapStore();
await store.ensureReady();
const source = await store.loadMap(experiment.sourceMapId);
const prompt = '在现有雪山起伏地形上生成可步行游览的石屋村庄。让住宅、公共场所和通路因可建坡度、不同标高和地形遮挡形成自然的组团；在合适的地面安排房屋，并用必要的地基、坡道或台阶处理建筑入口与道路的高差。不要为了密集或弯曲而牺牲实际可走性。';
let map = run.materializedMapId || existingMapId ? await store.loadMap(run.materializedMapId ?? existingMapId) : null;
if (!map) {
  const initial = createEmptyMap(`固定高差村庄 · ${arm} ${repeatText}`, undefined, [96, 16, 96], 'voxel', 'outdoor');
  initial.seed = experiment.seed;
  map = await store.saveMap(initial);
  run.materializedMapId = map.id;
  save();
  console.log(`MAP ${map.id}`);
}
if (!run.materializedMapId) {
  run.materializedMapId = map.id;
  save();
}
if (map.terrain.heights.length !== source.terrain.heights.length
  || map.terrain.heights.some((height, index) => Math.abs(height - source.terrain.heights[index]) > 0.0001)) {
  const committed = await store.commitTransaction(map.id, {
    label: '复用滑雪场高度场', source: 'agent', operations: [{ type: 'terrain.set', terrain: source.terrain }]
  }, map.version);
  map = committed.map;
}
if (map.objects.length) {
  console.log(`ALREADY_SAVED ${map.id}`);
  process.exit(0);
}
let lastLabel = '';
try {
  const createAsset = createMapAssetGenerator(store, map, [], 'deepseek', null, new AbortController().signal);
  const suggestion = await generateMapCodeSuggestion(prompt, map, [], {
    provider: 'gpt', scope: 'scene', promptMode: 'standard', revisionMode: 'first-pass',
    spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 16,
    reuseExistingAssets: false, approvedCode: run.code, createAsset,
    onProgress: event => {
      if (event.label !== lastLabel) console.log(lastLabel = event.label);
    }
  });
  if (suggestion.blocked) throw new Error('generation_blocked');
  const committed = await store.commitTransaction(map.id, {
    label: '固定高差村庄 · 完整资产', source: 'agent', operations: suggestion.operations,
    ai: { prompt, codePlan: suggestion.codePlan, generatedAssets: suggestion.generatedAssets }
  }, map.version);
  run.materializedObjectCount = committed.map.objects.length;
  delete run.materializationError;
  save();
  console.log(`SAVED ${committed.map.id} objects=${committed.map.objects.length} assets=${committed.map.assets?.length ?? 0}`);
} catch (error) {
  run.materializationError = error instanceof Error ? error.message : String(error);
  save();
  throw error;
}
