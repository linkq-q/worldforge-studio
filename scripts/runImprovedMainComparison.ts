import { existsSync, readFileSync } from 'node:fs';
import { createEmptyMap } from '../src/shared/map';
import { MapStore } from '../src/server/mapStore';
import { mapCatalog, writeJsonAtomic } from '../src/server/mapCatalog';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import { withGenerationTrace } from '../src/server/generationTrace';

const baseline = JSON.parse(readFileSync('scripts/mainModeComparison.json', 'utf8')) as {
  runs: { name: string; prompt: string; seed: number; full: string; minimal: string }[];
};
const wanted = ['拥挤的城中村', '中古宏伟斗兽场', '哥特式大教堂', '山谷密集石屋村庄'];
type Run = { name: string; prompt: string; seed: number; full: string; minimal: string;
  minNewAssets: number; maxNewAssets: number;
  status: 'queued' | 'planned' | 'saved' | 'failed'; attempt: number;
  mapId?: string; code?: string; transactionId?: string; objectCount?: number; assetCount?: number;
  diagnostics?: unknown; error?: string; failures?: { attempt: number; mapId?: string; error: string }[];
  interruptedBudgetAttempt?: { mapId: string; minNewAssets: number; maxNewAssets: number; stage: string };
  discardedResults?: { attempt: number; mapId: string; reason: string }[] };
type Ledger = { name: string; folderId?: string; runs: Run[] };
const file = 'scripts/mainModeImprovedComparison.json';
const expected = wanted.map(name => {
  const run = baseline.runs.find(row => row.name === name);
  if (!run) throw new Error(`Missing baseline: ${name}`);
  // Match each scene's original 2026-09-21 request.input, not the later 0..16 rerun.
  const [minNewAssets, maxNewAssets] = name === '拥挤的城中村' ? [22, 32] : [0, 16];
  return { name: run.name, prompt: run.prompt, seed: run.seed, full: run.full, minimal: run.minimal,
    minNewAssets, maxNewAssets };
});
const ledger: Ledger = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8')) as Ledger
  : { name: '建筑与聚落提示恢复后 · 新主模式首版对照',
      runs: expected.map(run => ({ ...run, status: 'queued', attempt: 1 })) };
if (ledger.runs.length !== expected.length || ledger.runs.some((run, i) =>
  run.name !== expected[i].name || run.prompt !== expected[i].prompt || run.seed !== expected[i].seed
  || run.minNewAssets !== expected[i].minNewAssets || run.maxNewAssets !== expected[i].maxNewAssets)) {
  throw new Error('Comparison input changed; refusing to mix runs');
}
const baselineMapIds = new Set(baseline.runs.flatMap(run =>
  [run.full, run.minimal, (run as typeof run & { mapId?: string }).mapId].filter((id): id is string => Boolean(id))));
if (ledger.runs.some(run => run.mapId && baselineMapIds.has(run.mapId))) {
  throw new Error('Comparison map ID points to an existing baseline map');
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
  while (run.attempt <= 2 && run.status !== 'saved') {
    const progress = (label: string) => console.log(`${index + 1}/4 ${run.name} · 首版 ${run.attempt}：${label}`);
    try {
      let map = run.mapId ? await store.loadMap(run.mapId) : null;
      if (!map) {
        map = createEmptyMap(`${run.name}（建筑聚落改进 · GPT规划 · DeepSeek资产 · 首版${run.attempt}）`,
          undefined, [96, 16, 96], 'voxel', 'outdoor');
        map.seed = run.seed;
        map = await store.saveMap(map);
        run.mapId = map.id;
        await catalog.move([map.id], ledger.folderId);
        await save();
      }
      if (map.objects.length > 0 || (map.assets?.length ?? 0) > 0) {
        throw new Error(`Comparison target is not an empty map: ${map.id}`);
      }
      if (!run.code) {
        progress('GPT 规划');
        const plan = await withGenerationTrace(store.rootDir,
          { operation: 'improved-main-comparison-plan', scene: run.name, attempt: run.attempt },
          () => generateMapCodeSuggestion(run.prompt, map, [], {
            provider: 'gpt', scope: 'scene', promptMode: 'main', revisionMode: 'first-pass',
            spatialPolicy: 'diagnose', minNewAssets: run.minNewAssets, maxNewAssets: run.maxNewAssets,
            reuseExistingAssets: false, discoveryOnly: true, onProgress: event => progress(event.label)
          }));
        if (!plan.codePlan?.code) throw new Error('missing_plan_code');
        run.code = plan.codePlan.code;
        run.status = 'planned';
        await save();
      }
      progress('DeepSeek 生成资产');
      const createAsset = createMapAssetGenerator(store, map, [], 'deepseek', null, new AbortController().signal);
      const suggestion = await withGenerationTrace(store.rootDir,
        { operation: 'improved-main-comparison-generate', scene: run.name, attempt: run.attempt },
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
      run.status = 'saved';
      run.transactionId = committed.transaction.id;
      run.objectCount = committed.map.objects.length;
      run.assetCount = committed.map.assets?.length ?? 0;
      run.diagnostics = suggestion.diagnostics;
      delete run.error;
      await save();
      progress(`已保存 ${map.id}：${run.objectCount} 个物件，${run.assetCount} 个资产`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.failures = [...(run.failures ?? []), { attempt: run.attempt, mapId: run.mapId, error: message }];
      run.status = 'failed';
      run.error = message;
      await save();
      progress(`失败：${message}`);
      if (run.attempt >= 2) { stopped = true; break; }
      run.attempt += 1;
      run.status = 'queued';
      delete run.mapId;
      delete run.code;
      await save();
    }
  }
  if (stopped) break;
}
console.log(`完成 ${ledger.runs.filter(run => run.status === 'saved').length}/4${stopped ? '，连续两次失败，已停止' : ''}`);
