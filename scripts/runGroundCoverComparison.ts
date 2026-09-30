import { existsSync, readFileSync } from 'node:fs';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { MapStore } from '../src/server/mapStore';
import { mapCatalog, writeJsonAtomic } from '../src/server/mapCatalog';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import { withGenerationTrace } from '../src/server/generationTrace';
import { checkGentleSkiSlope } from './checkGentleSkiSlope';

const baseline = JSON.parse(readFileSync('scripts/mainModeComparison.json', 'utf8')) as {
  runs: { name: string; prompt: string; seed: number; full: string; minimal: string; mapId?: string }[];
};
const wanted = ['哥特式大教堂', '雪山滑雪度假村', '热带雨林神庙遗迹'];
const only = process.argv.find(arg => arg.startsWith('--name='))?.slice('--name='.length);
const replace = process.argv.includes('--replace');
const repairPlan = process.argv.includes('--repair-plan');
const gentleSkiSlope = process.argv.includes('--gentle-ski-slope');
const retryPlans = Number(process.argv.find(arg => arg.startsWith('--retry-plans='))?.slice('--retry-plans='.length) ?? (replace ? 1 : 3));
if (!Number.isInteger(retryPlans) || retryPlans < 1 || retryPlans > 3) throw new Error('Invalid --retry-plans value');
if (gentleSkiSlope && only !== '雪山滑雪度假村') throw new Error('--gentle-ski-slope requires the ski scene');
const promptOverride = process.argv.find(arg => arg.startsWith('--prompt='))?.slice('--prompt='.length);
const minPlacements = Number(process.argv.find(arg => arg.startsWith('--min-placements='))?.slice('--min-placements='.length) ?? 0);
if (!Number.isInteger(minPlacements) || minPlacements < 0) throw new Error('Invalid --min-placements value');
const boxHeight = Number(process.argv.find(arg => arg.startsWith('--height='))?.slice('--height='.length) ?? 16);
const minRelief = Number(process.argv.find(arg => arg.startsWith('--min-relief='))?.slice('--min-relief='.length) ?? 0);
if (!Number.isFinite(boxHeight) || boxHeight <= 0 || !Number.isFinite(minRelief) || minRelief < 0) {
  throw new Error('Invalid map height or minimum relief');
}
const codeFile = process.argv.find(arg => arg.startsWith('--code-file='))?.slice('--code-file='.length);
const replayCode = codeFile ? readFileSync(codeFile, 'utf8') : undefined;
if (replace && !only) throw new Error('--replace requires --name to select one scene');
type Run = { name: string; prompt: string; seed: number; full: string; minimal: string;
  generationPrompt?: string; boxHeight?: number; terrainRelief?: number;
  skiSlopes?: { length: number; drop: number; maxGrade: number }[]; repairAttempts?: number;
  minNewAssets: number; maxNewAssets: number; status: 'queued' | 'planned' | 'saved' | 'failed';
  attempt: number; mapId?: string; code?: string; transactionId?: string;
  objectCount?: number; assetCount?: number; diagnostics?: unknown; error?: string;
  failures?: { attempt: number; mapId?: string; error: string }[];
  discardedResults?: { attempt: number; mapId: string; reason: string }[] };
type Ledger = { name: string; folderId?: string; runs: Run[] };
const file = 'scripts/groundCoverComparison.json';
const expected = wanted.map(name => {
  const run = baseline.runs.find(row => row.name === name);
  if (!run) throw new Error(`Missing baseline: ${name}`);
  return { name, prompt: run.prompt, seed: run.seed, full: run.full, minimal: run.minimal,
    minNewAssets: 0, maxNewAssets: 16 };
});
const ledger: Ledger = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8')) as Ledger
  : { name: '道路材质与草层改进后 · 三场景主模式对照',
      runs: expected.map(run => ({ ...run, status: 'queued', attempt: 1 })) };
if (ledger.runs.length !== expected.length || ledger.runs.some((run, i) =>
  run.name !== expected[i].name || run.prompt !== expected[i].prompt || run.seed !== expected[i].seed
  || run.minNewAssets !== expected[i].minNewAssets || run.maxNewAssets !== expected[i].maxNewAssets)) {
  throw new Error('Comparison input changed; refusing to mix runs');
}
const priorIds = new Set(baseline.runs.flatMap(run =>
  [run.full, run.minimal, run.mapId].filter((id): id is string => Boolean(id))));
if (ledger.runs.some(run => run.mapId && priorIds.has(run.mapId))) {
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
  if (only && run.name !== only) continue;
  if (promptOverride) {
    run.generationPrompt = promptOverride;
    await save();
  }
  if (boxHeight !== 16) run.boxHeight = boxHeight;
  const generationPrompt = run.generationPrompt ?? run.prompt;
  if (replace && run.status === 'saved') {
    if (!run.mapId) throw new Error(`Saved comparison result has no map ID: ${run.name}`);
    run.discardedResults = [...(run.discardedResults ?? []), {
      attempt: run.attempt, mapId: run.mapId, reason: '用户判定本次模型质量异常，要求独立重生成'
    }];
    run.attempt += 1;
    run.status = 'queued';
    delete run.mapId;
    delete run.code;
    delete run.transactionId;
    delete run.objectCount;
    delete run.assetCount;
    delete run.diagnostics;
    delete run.terrainRelief;
    delete run.skiSlopes;
    delete run.repairAttempts;
    await save();
  }
  if (replace && run.status === 'failed') {
    run.status = 'queued';
    if (!replayCode) {
      run.attempt += 1;
      delete run.mapId;
    }
    delete run.code;
    delete run.error;
    await save();
  }
  if (run.status === 'saved') continue;
  const maxAttempts = replace ? run.attempt + retryPlans - 1 : retryPlans;
  if (run.status === 'failed' && run.attempt >= maxAttempts) { stopped = true; break; }
  if (run.status === 'failed' && run.attempt < maxAttempts) {
    run.attempt += 1;
    run.status = 'queued';
    delete run.mapId;
    delete run.code;
    await save();
  }
  while (run.attempt <= maxAttempts && run.status !== 'saved') {
    const progress = (label: string) => console.log(`${index + 1}/3 ${run.name} · 首版 ${run.attempt}：${label}`);
    let assetGenerationStarted = false;
    try {
      let map = run.mapId ? await store.loadMap(run.mapId) : null;
      if (!map) {
        map = createEmptyMap(`${run.name}（道路草层改进 · GPT规划 · DeepSeek资产 · 首版${run.attempt}）`,
          undefined, [96, run.boxHeight ?? 16, 96], 'voxel', 'outdoor');
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
        progress(replayCode ? '重放原 GPT 首版代码' : 'GPT 规划');
        const plan = await withGenerationTrace(store.rootDir,
          { operation: 'ground-cover-comparison-plan', scene: run.name, attempt: run.attempt },
          () => generateMapCodeSuggestion(generationPrompt, map, [], {
            provider: 'gpt', scope: 'scene', promptMode: 'main', revisionMode: repairPlan ? 'repair' : 'first-pass',
            spatialPolicy: 'diagnose', minNewAssets: run.minNewAssets, maxNewAssets: run.maxNewAssets,
            reuseExistingAssets: false, discoveryOnly: true,
            approvedCode: replayCode,
            onProgress: event => progress(event.label)
          }));
        if (!plan.codePlan?.code) throw new Error('missing_plan_code');
        if ((plan.codePlan.placementCount ?? 0) < minPlacements) {
          throw new Error(`comparison_plan_too_sparse:${plan.codePlan.placementCount ?? 0}<${minPlacements}`);
        }
        if (minRelief > 0 || gentleSkiSlope) {
          const plannedMap = applyMapOperations(map, plan.operations);
          const slope = checkGentleSkiSlope(plannedMap, plan.operations);
          run.terrainRelief = slope.relief;
          if (gentleSkiSlope) {
            run.skiSlopes = slope.slopes;
            if (!slope.valid) throw new Error(`comparison_ski_slope_invalid:relief=${slope.relief.toFixed(1)},routes=${JSON.stringify(slope.slopes)}`);
          } else if (slope.relief < minRelief) {
            throw new Error(`comparison_terrain_too_flat:${slope.relief.toFixed(1)}<${minRelief}`);
          }
        }
        if (plan.codePlan.assetRequirements?.some(asset => /积雪地表|雪地|雪面|雪块|snow blanket|snow cover/i.test(asset.name))) {
          throw new Error('comparison_plan_requests_snow_cover_asset');
        }
        run.code = plan.codePlan.code;
        run.repairAttempts = plan.codePlan.repairAttempts;
        run.status = 'planned';
        await save();
      }
      progress('DeepSeek 生成资产');
      assetGenerationStarted = true;
      const createAsset = createMapAssetGenerator(store, map, [], 'deepseek', null, new AbortController().signal);
      const suggestion = await withGenerationTrace(store.rootDir,
        { operation: 'ground-cover-comparison-generate', scene: run.name, attempt: run.attempt },
        () => generateMapCodeSuggestion(generationPrompt, map, [], {
          provider: 'gpt', scope: 'scene', promptMode: 'main', revisionMode: 'first-pass',
          spatialPolicy: 'diagnose', minNewAssets: run.minNewAssets, maxNewAssets: run.maxNewAssets,
          reuseExistingAssets: false, approvedCode: run.code, createAsset,
          onProgress: event => progress(event.label)
        }));
      if (suggestion.blocked) throw new Error('generation_blocked');
      const committed = await store.commitTransaction(map.id, {
        label: ledger.name, source: 'agent', operations: suggestion.operations,
        ai: { prompt: generationPrompt, codePlan: suggestion.codePlan, generatedAssets: suggestion.generatedAssets }
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
      if (assetGenerationStarted || run.attempt >= maxAttempts) { stopped = true; break; }
      run.attempt += 1;
      run.status = 'queued';
      delete run.mapId;
      delete run.code;
      await save();
    }
  }
  if (stopped) break;
}
console.log(`完成 ${ledger.runs.filter(run => run.status === 'saved').length}/3${stopped ? '，重试链已停止' : ''}`);
