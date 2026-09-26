import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createEmptyMap } from '../src/shared/map';
import { MapStore } from '../src/server/mapStore';
import { mapCatalog, writeJsonAtomic } from '../src/server/mapCatalog';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';

const PROMPT = '生成一座山谷里的密集石屋村庄。需要住宅、公共建筑、公共聚集处、多条相连街巷和周边自然环境。村庄应有丰富的空间层次，建筑和道路适应起伏地形，人能够沿地面连续步行游览。';
const BASE_SEED = 2077257521;
const LEDGER_PATH = path.resolve('scripts/terrainAwareVillageStudy.json');
type Run = { repeat: number; mapId?: string; transactionId?: string; code?: string; status: 'queued' | 'planned' | 'saved' | 'failed'; error?: string; failedAttempts?: string[]; objectCount?: number; assetCount?: number; diagnostics?: unknown; functions?: string[] };
type Ledger = { name: string; prompt: string; baseSeed: number; folderId?: string; runs: Run[] };
const ledger: Ledger = existsSync(LEDGER_PATH)
  ? JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) as Ledger
  : { name: '地形感知标准规划 · 山谷石屋村庄', prompt: PROMPT, baseSeed: BASE_SEED,
      runs: [1, 2, 3, 4].map(repeat => ({ repeat, status: 'queued' as const })) };
const save = () => writeJsonAtomic(LEDGER_PATH, ledger);
const store = new MapStore();
await store.ensureReady();
const catalog = mapCatalog(store);
if (!ledger.folderId) {
  ledger.folderId = (await catalog.saveFolder({ name: ledger.name })).id;
  await save();
}

for (const run of ledger.runs) {
  if (run.status === 'saved') continue;
  let lastProgress = '';
  const progress = (label: string) => {
    if (label === lastProgress) return;
    lastProgress = label;
    console.log(`RUN_${run.repeat} ${label}`);
  };
  try {
    let map;
    if (run.mapId) map = await store.loadMap(run.mapId);
    else {
      map = createEmptyMap(`${ledger.name} ${run.repeat}`, undefined, [96, 16, 96], 'voxel', 'outdoor');
      map.seed = ledger.baseSeed;
      map = await store.saveMap(map);
      run.mapId = map.id;
      await catalog.move([map.id], ledger.folderId);
      await save();
    }
    if (!run.code) {
      progress('GPT 规划');
      const plan = await generateMapCodeSuggestion(ledger.prompt, map, [], {
        provider: 'gpt', scope: 'scene', promptMode: 'standard', revisionMode: 'first-pass',
        spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 16,
        reuseExistingAssets: false, discoveryOnly: true,
        onProgress: event => progress(event.label)
      });
      if (!plan.codePlan?.code) throw new Error('missing_plan_code');
      run.code = plan.codePlan.code;
      run.status = 'planned';
      await save();
    }
    const previous = await store.getUndoTransaction(map.id);
    if (previous?.ai?.codePlan?.code === run.code) {
      run.status = 'saved';
      delete run.error;
      run.transactionId = previous.id;
      run.objectCount = map.objects.length;
      run.assetCount = map.assets?.length ?? 0;
      await save();
      continue;
    }
    progress('DeepSeek 生成资产');
    const createAsset = createMapAssetGenerator(store, map, [], 'deepseek', null, new AbortController().signal);
    const suggestion = await generateMapCodeSuggestion(ledger.prompt, map, [], {
      provider: 'gpt', scope: 'scene', promptMode: 'standard', revisionMode: 'first-pass',
      spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 16,
      reuseExistingAssets: false, approvedCode: run.code,
      createAsset,
      onProgress: event => progress(event.label)
    });
    if (suggestion.blocked) throw new Error('generation_blocked');
    const committed = await store.commitTransaction(map.id, {
      label: ledger.name, source: 'agent', operations: suggestion.operations,
      ai: { prompt: ledger.prompt, codePlan: suggestion.codePlan, generatedAssets: suggestion.generatedAssets }
    }, map.version);
    run.status = 'saved';
    delete run.error;
    run.transactionId = committed.transaction.id;
    run.objectCount = committed.map.objects.length;
    run.assetCount = committed.map.assets?.length ?? 0;
    run.diagnostics = suggestion.diagnostics;
    run.functions = suggestion.codePlan?.functions;
    await save();
    console.log(`RUN_${run.repeat} SAVED ${map.id} objects=${run.objectCount} assets=${run.assetCount}`);
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    run.failedAttempts = [...(run.failedAttempts ?? []), run.error];
    await save();
    console.error(`RUN_${run.repeat} FAILED ${run.error}`);
  }
}
console.log(`STUDY_COMPLETE ${ledger.runs.filter(run => run.status === 'saved').length}/4`);
