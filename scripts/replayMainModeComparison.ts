import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createEmptyMap } from '../src/shared/map';
import { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';

// Local discovery only: keep historical code/data untouched and forbid paid calls.
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass an absolute output JSON path');
const ledger = JSON.parse(readFileSync('scripts/mainModeComparison.json', 'utf8')) as {
  runs: { name: string; prompt: string; seed: number }[];
};
const traceDir = 'data/map-editor/logs/generation-2026-09-26';
const plans = readdirSync(traceDir).filter(file => file.endsWith('.jsonl')).flatMap(file => {
  const rows = readFileSync(path.join(traceDir, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  if (rows[0]?.data?.operation !== 'main-mode-comparison-plan') return [];
  const code = rows.find(row => row.type === 'chat.response')?.data?.response?.content;
  if (typeof code !== 'string') throw new Error(`Missing saved code: ${file}`);
  return [{ scene: rows[0].data.scene as string, at: rows[0].at as string, code, trace: file,
    originalError: rows.find(row => row.type === 'run.end')?.data?.error?.message as string | undefined }];
}).sort((a, b) => a.at.localeCompare(b.at));
const results = [];
for (const plan of plans) {
  const scene = ledger.runs.find(run => run.name === plan.scene);
  if (!scene) throw new Error(`Unknown scene: ${plan.scene}`);
  const map = createEmptyMap(scene.name, 'local-replay', [96, 16, 96], 'voxel', 'outdoor');
  map.seed = scene.seed;
  let error: string | undefined;
  let operationCount = 0;
  try {
    const result = await generateMapCodeSuggestion(scene.prompt, map, [], {
      provider: 'gpt', scope: 'scene', promptMode: 'main', revisionMode: 'first-pass',
      spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 16,
      reuseExistingAssets: false, discoveryOnly: true, approvedCode: plan.code,
      fetchImpl: async () => { throw new Error('Replay must not call a model'); },
      createAsset: async () => { throw new Error('Replay must not generate assets'); }
    });
    operationCount = result.operations.length;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  results.push({ scene: plan.scene, at: plan.at, trace: plan.trace,
    codeSha256: createHash('sha256').update(plan.code).digest('hex'),
    originalError: plan.originalError, passed: !error, operationCount, error });
  console.log(`${error ? 'FAIL' : 'PASS'} ${plan.scene}${error ? `: ${error}` : ''}`);
}
writeFileSync(output, JSON.stringify({ kind: 'local-discovery-replay', modelCalls: 0, assetCalls: 0,
  total: results.length, passed: results.filter(result => result.passed).length, results }, null, 2));
console.log(`PASSED ${results.filter(result => result.passed).length}/${results.length}`);
