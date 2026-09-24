// Replay already-returned code after the v2 save guard rejected repair updates.
// Never invokes a model. A separate journal avoids racing the active generator's ledger.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MapStore } from '../src/server/mapStore';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';
import { assertLandmarkOperations } from './landmarkAblationConfig';
import { REPEAT_BATCH } from './landmarkRepeatConfig';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Expected absolute experiment directory');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
function write(name: string, value: unknown) {
  const file = path.join(output, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const runtimeFiles = ['src/server/mapCodePlanner.ts', 'src/shared/map.ts', 'src/shared/mapOperations.ts', 'src/server/modelApi.ts'];
const loadedHashes = Object.fromEntries(runtimeFiles.map(file => [file, hash(fs.readFileSync(file, 'utf8'))]));
const journalName = 'landmark-v2-save-recovery.json';
const journal = fs.existsSync(path.join(output, journalName)) ? read(journalName) : {};
const store = new MapStore(); await store.ensureReady();
for (;;) {
  const ledger = read('rounds.json');
  const rounds = ledger.rounds.filter((r: any) => r.batch === REPEAT_BATCH);
  for (const round of rounds) {
    if (round.status !== 'failed' || journal[round.key] || !round.error?.includes('landmark_unexpected_environment_mutation:object.update')) continue;
    for (const file of runtimeFiles) if (round.sourceHashes[file] !== loadedHashes[file]) throw new Error(`Recovery runtime differs: ${file}`);
    const map = await store.loadMap(round.mapId);
    if (map.objects.length) throw new Error('Recovery map is not empty; inspect transaction before replaying');
    const assets = await Promise.all(round.assetIds.map((id: string) => store.loadAsset(id)));
    if (hash(JSON.stringify(assets.map(a => ({ id: a.id, modelJson: a.modelJson })))) !== round.kitHash) throw new Error('Recovery kit changed');
    const code = fs.readFileSync(path.join(output, `${round.key}-code.js`), 'utf8');
    const options = { mode: 'final' as const, scope: 'scene' as const, minNewAssets: 0, maxNewAssets: 0 };
    const before = executeMapCodePlan(code, map, assets, { ...options, spatialPolicy: 'diagnose' });
    const after = executeMapCodePlan(code, map, assets, options);
    assertLandmarkOperations(after.operations);
    const ids = new Set(after.operations.filter(o => o.type === 'object.add').map(o => o.object.id));
    if (after.operations.some(o => o.type === 'object.update' && !ids.has(o.objectId))) throw new Error('Repair updates an object outside this trial');
    write(`${round.key}-before-repair.json`, before); write(`${round.key}-suggestion.json`, after);
    const beforeObjects = before.operations.filter(o => o.type === 'object.add').map(o => o.object);
    const saved = await store.commitTransaction(map.id, { label: `校准建筑API保存恢复 ${round.key}`, source: 'agent', operations: after.operations });
    const reloaded = await store.loadMap(map.id);
    journal[round.key] = {
      status: 'saved', transactionId: saved.transaction?.id, objectCount: reloaded.objects.length,
      executedFunctions: after.codePlan?.functions ?? [], diagnostics: after.diagnostics ?? [],
      repairComparison: { beforeCount: beforeObjects.length, afterCount: reloaded.objects.length,
        changedTransformsByIndex: reloaded.objects.filter((o, i) => JSON.stringify(o.transform) !== JSON.stringify(beforeObjects[i]?.transform)).length,
        repairedDiagnostics: after.diagnostics?.filter(d => d.repaired).length ?? 0 },
      harnessError: round.error, error: null, recoveredAt: new Date().toISOString(),
      recovery: 'Exact saved GPT code and asset kit replayed through matching loaded runtime; no additional model requests.'
    };
    write(journalName, journal);
    console.log('RECOVERED', round.key, 'objects', reloaded.objects.length, 'functions', journal[round.key].executedFunctions.join(','));
  }
  const complete = rounds.length === 20 && rounds.every((r: any) => ['saved', 'failed'].includes(r.status));
  if (complete && fs.readFileSync(path.join(output, 'landmark-v2-run.log'), 'utf8').includes('FINISHED')) {
    const latest = read('rounds.json');
    for (const r of latest.rounds) if (journal[r.key]) Object.assign(r, journal[r.key]);
    write('rounds.json', latest); console.log('RECOVERY_COMPLETE'); break;
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
}
