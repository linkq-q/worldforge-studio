import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { calculateModelVisualBounds } from '../src/shared/modelBounds';
import { MapStore } from '../src/server/mapStore';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';
import { llmChat } from '../src/server/modelApi';
import { assertModelRoute } from './apiAblationConfig';
import { LANDMARKS, assertLandmarkOperations, auditLandmarkCode } from './landmarkAblationConfig';
import { REPEAT_BATCH, calibratedTrials, calibratedPrompt, assertRepeatBudget } from './landmarkRepeatConfig';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass the original absolute experiment directory');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
function write(name: string, value: unknown) {
  const file = path.join(output, name);
  fs.writeFileSync(file + '.tmp', typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ledger = read('rounds.json');
const save = () => write('rounds.json', ledger);
const store = new MapStore();
await store.ensureReady();
// One process holds the executor stable even when another task edits the checkout.
const sourceFiles = ['scripts/landmarkAblationConfig.ts', 'scripts/landmarkRepeatConfig.ts', 'scripts/runLandmarkRepeats.ts', 'src/server/mapCodePlanner.ts', 'src/shared/map.ts', 'src/shared/mapOperations.ts', 'src/server/modelApi.ts'];
const snapshot = path.join(output, 'landmark-v2-source-' + Date.now());
fs.mkdirSync(snapshot, { recursive: true });
const sourceHashes = Object.fromEntries(sourceFiles.map(file => {
  const content = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(path.join(snapshot, file.replaceAll('/', '__')), content);
  return [file, hash(content)];
}));
for (const previous of ledger.rounds.filter((r: any) => r.batch === REPEAT_BATCH)) {
  if (JSON.stringify(previous.sourceHashes) !== JSON.stringify(sourceHashes)) throw new Error('repeat_resume_source_changed');
}
const kits = new Map<string, { assets: MapAsset[]; catalog: any[]; kitHash: string }>();
for (const scene of LANDMARKS) {
  const kit = read(`landmark-${scene.id}-kit.json`);
  const assets = await Promise.all(kit.requirements.map((req: any) => store.loadAsset(kit.assets.find((a: any) => a.key === req.key).assetId)));
  const kitHash = hash(JSON.stringify(assets.map(asset => ({ id: asset.id, modelJson: asset.modelJson }))));
  const old = ledger.rounds.find((r: any) => r.batch === 'landmark-fixed-kit-v1' && r.scene === scene.id);
  if (old?.kitHash !== kitHash) throw new Error(`shared_asset_kit_changed:${scene.id}`);
  const catalog = assets.map((asset, i) => {
    const bounds = calculateModelVisualBounds(asset.modelJson);
    return { key: kit.requirements[i].key, id: asset.id, name: kit.requirements[i].name, prompt: kit.requirements[i].prompt, bounds, actualSize: bounds.max.map((v, axis) => v - bounds.min[axis]) };
  });
  kits.set(scene.id, { assets, catalog, kitHash });
}

// In-memory calibration uses existing DeepSeek geometry, no model request or saved map.
const colosseum = kits.get('colosseum')!;
const wallId = colosseum.catalog.find((a: any) => a.key === 'lower_arcade_module').id;
const calibrationCode = `function plan(api){const p=[];for(let i=0;i<24;i++){const a=i*Math.PI*2/24;p.push([30*Math.cos(a),22*Math.sin(a)]);}for(let i=0;i<p.length;i++)api.placeBetween({assetId:'${wallId}',name:'闭合校准-'+i,start:p[i],end:p[(i+1)%p.length],dimensions:[8,8,4],spanAxis:'x',terrain:false,frontTarget:[0,0],groupId:'calibration',role:'structure'});}`;
const calibrationMap = createEmptyMap('内存校准', undefined, [96,48,96], 'voxel', 'outdoor');
const calibration = executeMapCodePlan(calibrationCode, calibrationMap, colosseum.assets, { mode: 'final', scope: 'scene' });
assertLandmarkOperations(calibration.operations);
if (calibration.operations.filter(o => o.type === 'object.add').length !== 24) throw new Error('ellipse_calibration_failed');
write('landmark-v2-calibration.json', { code: calibrationCode, suggestion: calibration, modelCalls: 0, savedMaps: 0 });
console.log('CALIBRATION_PASS 24 connected modules; no model calls');

for (const trial of calibratedTrials()) {
  if (ledger.rounds.some((r: any) => r.key === trial.key)) continue;
  assertRepeatBudget(ledger.rounds, trial.key);
  const scene = LANDMARKS.find(s => s.id === trial.scene)!;
  const { assets, catalog, kitHash } = kits.get(scene.id)!;
  const system = calibratedPrompt(trial.profile, catalog, trial.seed);
  const round: any = { ...trial, batch: REPEAT_BATCH, status: 'reserved', startedAt: new Date().toISOString(), plannerProvider: 'gpt', assetProvider: 'deepseek', temperature: 0.25, kitHash, assetIds: assets.map((a: any) => a.id), assetFamiliesRequested: assets.length, assetCountGenerated: 0, sourceHashes, promptHash: hash(system), prompt: scene.prompt, spatialPolicy: 'repair', modelRequests: 0 };
  ledger.rounds.push(round); save();
  write(`${trial.key}-system-prompt.txt`, system);
  console.log(`ROUND ${ledger.rounds.length}/70 ${trial.key} START`);
  try {
    const map = await store.saveMap({ ...createEmptyMap(`建筑API校准实验 ${scene.name} ${trial.profile} r${trial.repeat}`, undefined, [96,48,96], 'voxel', 'outdoor'), seed: trial.seed });
    round.mapId = map.id; round.status = 'planning'; save();
    const raw = await llmChat([{ role: 'system', content: system }, { role: 'user', content: scene.prompt }], {
      provider: 'gpt', temperature: 0.25, maxTokens: 16000, reasoningLogPath: false, signal: AbortSignal.timeout(8 * 60_000),
      fetchImpl: (input, init) => {
        const body = JSON.parse(String(init?.body));
        assertModelRoute(String(input), body);
        if (new URL(String(input)).pathname !== '/api/chat') throw new Error('repeat_asset_generation_forbidden');
        round.modelRequests++; save();
        return fetch(input, init);
      }
    });
    write(`${trial.key}-raw-response.txt`, raw);
    const code = raw.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').replace(/^\s*```(?:javascript|js)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    write(`${trial.key}-code.js`, code);
    round.apiCalls = auditLandmarkCode(code, trial.profile);
    const options = { mode: 'final' as const, scope: 'scene' as const, minNewAssets: 0, maxNewAssets: 0 };
    const before = executeMapCodePlan(code, map, assets, { ...options, spatialPolicy: 'diagnose' });
    const after = executeMapCodePlan(code, map, assets, options);
    assertLandmarkOperations(after.operations);
    write(`${trial.key}-before-repair.json`, before);
    write(`${trial.key}-suggestion.json`, after);
    const beforeObjects = before.operations.filter(o => o.type === 'object.add').map(o => o.object);
    const afterObjects = after.operations.filter(o => o.type === 'object.add').map(o => o.object);
    round.repairComparison = { beforeCount: beforeObjects.length, afterCount: afterObjects.length,
      changedTransformsByIndex: afterObjects.filter((o, i) => JSON.stringify(o.transform) !== JSON.stringify(beforeObjects[i]?.transform)).length,
      repairedDiagnostics: after.diagnostics?.filter(d => d.repaired).length ?? 0 };
    const saved = await store.commitTransaction(map.id, { label: `校准建筑API ${trial.key}`, source: 'agent', operations: after.operations });
    const reloaded = await store.loadMap(map.id);
    Object.assign(round, { status: 'saved', transactionId: saved.transaction?.id, objectCount: reloaded.objects.length, executedFunctions: after.codePlan?.functions ?? [], diagnostics: after.diagnostics ?? [] });
    console.log(`SAVED ${trial.key} objects=${round.objectCount} calls=${round.executedFunctions.join(',')} changed=${round.repairComparison.changedTransformsByIndex}`);
  } catch (error) {
    round.status = 'failed'; round.error = String(error);
    console.error(`FAILED ${trial.key}: ${error}`);
  }
  round.completedAt = new Date().toISOString(); save();
  const changed = sourceFiles.filter(file => hash(fs.readFileSync(file, 'utf8')) !== sourceHashes[file]);
  if (changed.length) write('landmark-v2-concurrent-disk-edits.json', { changed, sourceHashes, snapshot });
}
console.log(`FINISHED ${ledger.rounds.length}/70`);
