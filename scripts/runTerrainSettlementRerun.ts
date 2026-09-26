import { existsSync, readFileSync } from 'node:fs';
import { createEmptyMap } from '../src/shared/map';
import { MapStore } from '../src/server/mapStore';
import { mapCatalog, writeJsonAtomic } from '../src/server/mapCatalog';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import { withGenerationTrace } from '../src/server/generationTrace';

type Run = { name: string; prompt: string; seed: number; minNewAssets: number; maxNewAssets: number;
  status: 'queued' | 'planned' | 'saved' | 'failed'; attempt: number; mapId?: string; code?: string;
  transactionId?: string; objectCount?: number; assetCount?: number; diagnostics?: unknown; error?: string;
  failures?: { attempt: number; mapId?: string; error: string }[] };
type Ledger = { name: string; folderId?: string; runs: Run[] };
const baseline = JSON.parse(readFileSync('scripts/mainModeComparison.json', 'utf8')) as {
  runs: { name: string; prompt: string; seed: number }[];
};
const original = (name: string, minNewAssets: number, maxNewAssets: number) => {
  const source = baseline.runs.find(run => run.name === name);
  if (!source) throw new Error(`Missing original comparison case: ${name}`);
  return { name, prompt: source.prompt, seed: source.seed, minNewAssets, maxNewAssets };
};
const expected = [
  original('山谷密集石屋村庄', 0, 16),
  { name: '峡谷村庄', prompt: '一座建在峡谷中的村庄', seed: 866756897, minNewAssets: 0, maxNewAssets: 16 },
  original('拥挤的城中村', 22, 32)
];
const file = 'scripts/terrainSettlementRerun.json';
const ledger: Ledger = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8')) as Ledger
  : { name: '地形聚落提示更新后复跑 · GPT规划 · DeepSeek资产',
      runs: expected.map(run => ({ ...run, status: 'queued', attempt: 1 })) };
if (ledger.runs.length !== expected.length || ledger.runs.some((run, index) =>
  expected[index].name !== run.name || expected[index].prompt !== run.prompt || expected[index].seed !== run.seed
  || expected[index].minNewAssets !== run.minNewAssets || expected[index].maxNewAssets !== run.maxNewAssets)) {
  throw new Error('Rerun inputs changed; refusing to mix comparisons');
}
const save = () => writeJsonAtomic(file, ledger);
const store = new MapStore();
await store.ensureReady();
const catalog = mapCatalog(store);
if (!ledger.folderId) {
  ledger.folderId = (await catalog.saveFolder({ name: ledger.name })).id;
  await save();
}
let stopped = false;
for (const [index, run] of ledger.runs.entries()) {
  if (run.status === 'saved') continue;
  if (run.status === 'failed' && run.attempt >= 2) { stopped = true; break; }
  while (run.attempt <= 2 && run.status !== 'saved') {
    const progress = (label: string) => console.log(`${index + 1}/${ledger.runs.length} ${run.name} · 第 ${run.attempt} 次首版：${label}`);
    try {
      let map = run.mapId ? await store.loadMap(run.mapId) : null;
      if (!map) {
        map = createEmptyMap(`${run.name}（地形聚落更新 · GPT规划 · DeepSeek资产 · 首版${run.attempt}）`,
          undefined, [96, 16, 96], 'voxel', 'outdoor');
        map.seed = run.seed;
        map = await store.saveMap(map);
        run.mapId = map.id;
        await catalog.move([map.id], ledger.folderId);
        await save();
      }
      const committedBefore = await store.getUndoTransaction(map.id);
      if (committedBefore?.ai?.codePlan?.code && committedBefore.ai.codePlan.code === run.code) {
        run.status = 'saved'; run.transactionId = committedBefore.id;
        run.objectCount = map.objects.length; run.assetCount = map.assets?.length ?? 0;
        await save(); break;
      }
      if (map.objects.length > 0 || (map.assets?.length ?? 0) > 0) throw new Error(`Nonempty target map: ${map.id}`);
      if (!run.code) {
        progress('GPT 规划');
        const plan = await withGenerationTrace(store.rootDir,
          { operation: 'terrain-settlement-plan', scene: run.name, attempt: run.attempt },
          () => generateMapCodeSuggestion(run.prompt, map, [], {
            provider: 'gpt', scope: 'scene', promptMode: 'main', revisionMode: 'first-pass',
            spatialPolicy: 'diagnose', minNewAssets: run.minNewAssets, maxNewAssets: run.maxNewAssets,
            reuseExistingAssets: false, discoveryOnly: true, onProgress: event => progress(event.label)
          }));
        if (!plan.codePlan?.code) throw new Error('missing_plan_code');
        run.code = plan.codePlan.code; run.status = 'planned'; await save();
      }
      progress('DeepSeek 生成资产');
      const createAsset = createMapAssetGenerator(store, map, [], 'deepseek', null, new AbortController().signal);
      const suggestion = await withGenerationTrace(store.rootDir,
        { operation: 'terrain-settlement-generate', scene: run.name, attempt: run.attempt },
        () => generateMapCodeSuggestion(run.prompt, map, [], {
          provider: 'gpt', scope: 'scene', promptMode: 'main', revisionMode: 'first-pass',
          spatialPolicy: 'diagnose', minNewAssets: run.minNewAssets, maxNewAssets: run.maxNewAssets,
          reuseExistingAssets: false, approvedCode: run.code, createAsset,
          onProgress: event => progress(event.label)
        }));
      if (suggestion.blocked) throw new Error('generation_blocked');
      const committed = await store.commitTransaction(map.id, {
        label: ledger.name, source: 'agent', operations: suggestion.operations,
        ai: { prompt: run.prompt, codePlan: suggestion.codePlan, generatedAssets: suggestion.generatedAssets }
      }, map.version);
      run.status = 'saved'; run.transactionId = committed.transaction.id;
      run.objectCount = committed.map.objects.length; run.assetCount = committed.map.assets?.length ?? 0;
      run.diagnostics = suggestion.diagnostics; delete run.error;
      await save();
      progress(`已保存 ${map.id}：${run.objectCount} 个物件，${run.assetCount} 个资产`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.failures = [...(run.failures ?? []), { attempt: run.attempt, mapId: run.mapId, error: message }];
      run.status = 'failed'; run.error = message; await save();
      progress(`失败：${message}`);
      if (run.attempt >= 2) { stopped = true; break; }
      run.attempt += 1; run.status = 'queued';
      delete run.mapId; delete run.code; await save();
    }
  }
  if (stopped) break;
}
console.log(`完成 ${ledger.runs.filter(run => run.status === 'saved').length}/${ledger.runs.length}${stopped ? '；同一场景连续两次失败，已停止' : ''}`);
