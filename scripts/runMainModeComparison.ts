import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createEmptyMap } from '../src/shared/map';
import { MapStore } from '../src/server/mapStore';
import { mapCatalog, writeJsonAtomic } from '../src/server/mapCatalog';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import { withGenerationTrace } from '../src/server/generationTrace';

const cases = [
  { name: '拥挤的城中村', prompt: '拥挤的城中村', seed: 2721816274, full: 'map-e178d341-f383-4353', minimal: 'map-680ff29e-e159-47ae' },
  { name: '中古宏伟斗兽场', prompt: '一座中古时期的宏伟石砌斗兽场', seed: 3011432877, full: 'map-9639fa98-557f-43ac', minimal: 'map-c56dae97-b091-46ad' },
  { name: '哥特式大教堂', prompt: '一座高耸宏伟的哥特式石砌大教堂', seed: 2930301838, full: 'map-c3c4075b-7631-46ac', minimal: 'map-1c74009c-d64c-4285' },
  { name: '山谷密集石屋村庄', prompt: '一座坐落在山谷中的密集石屋村庄', seed: 866756897, full: 'map-3ee8dd37-e9a7-4b53', minimal: 'map-8562a1d4-a44b-48fd' },
  { name: '火箭发射中心', prompt: '一座临海平原上的大型火箭发射中心', seed: 566976230, full: 'map-515e68b5-68cc-4bb9', minimal: 'map-2bbfb089-aca3-48bb' },
  { name: '山巅中世纪城堡', prompt: '一座建在陡峭山巅上的宏伟中世纪石城堡', seed: 1470973425, full: 'map-6803a508-7968-4773', minimal: 'map-9e5f5c93-3fa3-4736' },
  { name: '海港渔村码头', prompt: '一座沿海湾展开的密集海港渔村和木质码头', seed: 2368270562, full: 'map-88361ae0-f1d2-487d', minimal: 'map-17cc3e07-7864-4fe7' },
  { name: '山谷水坝与水电站', prompt: '一座横跨陡峭山谷的大型混凝土水坝与水力发电站', seed: 3184729501, full: 'map-2c0e383c-ad0c-4a91', minimal: 'map-0916a9df-36fa-43c7' },
  { name: '现代国际机场与航站楼', prompt: '一座拥有长跑道、现代航站楼和停机坪的国际机场', seed: 409731582, full: 'map-b16d9435-558c-4ae0', minimal: 'map-270705a9-dde4-4faa' },
  { name: '沙漠炼油厂与管线区', prompt: '一座位于沙漠中的大型炼油厂，布满储油罐、蒸馏塔和管线', seed: 1763549208, full: 'map-b29d0b04-6283-4422', minimal: 'map-497e326b-fdb9-4926' },
  { name: '雪山滑雪度假村', prompt: '一座建在雪山坡地上的大型滑雪度假村，包含缆车、雪道和木屋酒店', seed: 2876401359, full: 'map-1130388b-07e9-4831', minimal: 'map-838e6fc8-2f01-44ee' },
  { name: '热带雨林神庙遗迹', prompt: '一座隐藏在热带雨林中的大型古代神庙遗迹', seed: 3549108274, full: 'map-5d72a4e0-e681-47cb', minimal: 'map-5e297ac3-eb15-4158' }
] as const;

type Run = { name: string; prompt: string; seed: number; full: string; minimal: string;
  status: 'queued' | 'planned' | 'saved' | 'failed'; mapId?: string; code?: string;
  transactionId?: string; objectCount?: number; assetCount?: number; diagnostics?: unknown; error?: string;
  earlierAttempts?: { mapId?: string; error?: string }[] };
type Ledger = { name: string; folderId?: string; runs: Run[] };
const retest = process.argv.includes('--retest-failed-stop');
if (retest && process.argv.includes('--retry-failed')) throw new Error('Choose only one run mode');
const file = path.resolve(retest ? 'scripts/mainModeRetest.json' : 'scripts/mainModeComparison.json');
const baseline = retest
  ? JSON.parse(readFileSync('scripts/mainModeComparison.json', 'utf8')) as Ledger
  : undefined;
const retestCases = baseline?.runs.filter(run => run.status === 'failed').map(run => ({
  name: run.name, prompt: run.prompt, seed: run.seed, full: run.full, minimal: run.minimal
}));
const ledger: Ledger = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8')) as Ledger
  : { name: retest ? '主模式修复后重测 · 2026-09-26' : '主模式与旧双模式对照 · 2026-09-26',
      runs: (retestCases ?? cases).map(c => ({ ...c, status: 'queued' as const })) };
const expectedCases = retestCases ?? cases;
if (ledger.runs.length !== expectedCases.length || ledger.runs.some((r, i) =>
  r.name !== expectedCases[i].name || r.prompt !== expectedCases[i].prompt || r.seed !== expectedCases[i].seed)) {
  throw new Error('Comparison input changed; refusing to mix runs.');
}
if (retest && ledger.runs.some(run => run.status === 'failed')) throw new Error('Retest already stopped on a failure');
const save = () => writeJsonAtomic(file, ledger);
if (process.argv.includes('--retry-failed')) {
  for (const run of ledger.runs.filter(run => run.status === 'failed' && !run.earlierAttempts?.length)) {
    run.earlierAttempts = [{ mapId: run.mapId, error: run.error }];
    run.status = 'queued';
    delete run.mapId; delete run.code; delete run.error;
  }
  await save();
}
const store = new MapStore();
await store.ensureReady();
const catalog = mapCatalog(store);
if (!ledger.folderId) {
  ledger.folderId = (await catalog.saveFolder({ name: ledger.name })).id;
  await save();
}

for (const [index, run] of ledger.runs.entries()) {
  if (run.status === 'saved' || run.status === 'failed') continue;
  const progress = (label: string) => console.log(`${index + 1}/${ledger.runs.length} ${run.name}: ${label}`);
  try {
    let map = run.mapId ? await store.loadMap(run.mapId) : null;
    if (!map) {
      map = createEmptyMap(`${run.name}（${retest ? '修复后重测' : '新主模式'} · GPT规划 · DeepSeek资产 · 不修复）`, undefined, [96, 16, 96], 'voxel', 'outdoor');
      map.seed = run.seed;
      map = await store.saveMap(map);
      run.mapId = map.id;
      await catalog.move([map.id], ledger.folderId);
      await save();
    }
    const previous = await store.getUndoTransaction(map.id);
    if (previous?.ai?.codePlan?.code && previous.ai.codePlan.code === run.code) {
      run.status = 'saved'; run.transactionId = previous.id;
      run.objectCount = map.objects.length; run.assetCount = map.assets?.length ?? 0;
      await save(); continue;
    }
    if (!run.code) {
      progress('GPT 规划');
      const plan = await withGenerationTrace(store.rootDir, { operation: retest ? 'main-mode-retest-plan' : 'main-mode-comparison-plan', scene: run.name },
        () => generateMapCodeSuggestion(run.prompt, map, [], {
          provider: 'gpt', scope: 'scene', promptMode: 'main', revisionMode: 'first-pass',
          spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 16,
          reuseExistingAssets: false, discoveryOnly: true, onProgress: event => progress(event.label)
        }));
      if (!plan.codePlan?.code) throw new Error('missing_plan_code');
      run.code = plan.codePlan.code; run.status = 'planned'; await save();
    }
    progress('DeepSeek 生成资产');
    const createAsset = createMapAssetGenerator(store, map, [], 'deepseek', null, new AbortController().signal);
    const suggestion = await withGenerationTrace(store.rootDir, { operation: retest ? 'main-mode-retest-generate' : 'main-mode-comparison-generate', scene: run.name },
      () => generateMapCodeSuggestion(run.prompt, map, [], {
        provider: 'gpt', scope: 'scene', promptMode: 'main', revisionMode: 'first-pass',
        spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 16,
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
    progress(`完成：${map.id}，物件 ${run.objectCount}，资产 ${run.assetCount}`);
  } catch (error) {
    run.status = 'failed'; run.error = error instanceof Error ? error.message : String(error);
    await save(); progress(`失败：${run.error}`);
    if (retest) break;
  }
}
console.log(`完成 ${ledger.runs.filter(r => r.status === 'saved').length}/${ledger.runs.length}`);
