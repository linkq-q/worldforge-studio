import fs from 'node:fs';
import path from 'node:path';
import { createEmptyMap } from '../src/shared/map';
import { discoverMapCodeAssets } from '../src/server/mapCodePlanner';
import { MapStore } from '../src/server/mapStore';
import { llmChat } from '../src/server/modelApi';
import {
  ASSET_PROVIDER, MAX_ASSETS, MIN_ASSETS, PLANNER_PROVIDER, SCENES,
  assertModelRoute, assertRoundAvailable, auditApiUse, experimentPrompt, trialMatrix
} from './apiAblationConfig';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass an absolute output directory');
fs.mkdirSync(output, { recursive: true });
const ledgerFile = path.join(output, 'rounds.json');
const ledger: { limit: number; rounds: Array<Record<string, unknown>> } = fs.existsSync(ledgerFile)
  ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : { limit: 50, rounds: [] };
const store = new MapStore();
const endpoint = 'http://127.0.0.1:8797';
const activeFetch: typeof fetch = (input, init) => {
  assertModelRoute(String(input), JSON.parse(String(init?.body)));
  return fetch(input, init);
};
function saveLedger(): void {
  const temp = `${ledgerFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ledger, null, 2));
  fs.renameSync(temp, ledgerFile);
}
function saveTrial(key: string, name: string, content: string): void {
  fs.writeFileSync(path.join(output, `${key}-${name}`), content);
}
function normalizeCode(raw: string): string {
  const answer = raw.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').trim();
  const fenced = answer.match(/```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i);
  const code = (fenced?.[1] ?? answer).trim();
  return /\bfunction\s+plan\s*\(/.test(code) ? code : `function plan(api) {\n${code}\n}`;
}
async function post(url: string, body: unknown, accept = 'application/json'): Promise<Response> {
  const response = await fetch(`${endpoint}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept }, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${(await response.text()).slice(0, 800)}`);
  return response;
}
async function consumeSuggestion(response: Response, round: Record<string, unknown>): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing_sse_stream');
  const decoder = new TextDecoder();
  let buffer = '';
  let suggestion: any;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const type = /^event:\s*(.+)$/m.exec(event)?.[1];
      const dataText = /^data:\s*(.*)$/m.exec(event)?.[1];
      if (!type || !dataText) continue;
      const data = JSON.parse(dataText);
      if (type === 'progress' && data.label !== round.progress) {
        round.progress = data.label;
        console.log(`${round.key}: ${data.label}`);
      }
      if (type === 'result') suggestion = data.suggestion;
      if (type === 'error') throw new Error(JSON.stringify(data));
    }
  }
  if (!suggestion?.operations) throw new Error('missing_generation_result');
  return suggestion;
}

await store.ensureReady();
const trials = trialMatrix();
const correctedBaseline = { ...trials[0], key: 'airport-core10-r1-coordinate-contract' };
for (const trial of [correctedBaseline, ...trials]) {
  let round = ledger.rounds.find(item => item.key === trial.key);
  if (round && round.status !== 'reserved') continue;
  if (!round) assertRoundAvailable(ledger.rounds.map(item => String(item.key)), trial.key);
  const scene = SCENES.find(item => item.id === trial.scene)!;
  if (!round) {
    round = {
      key: trial.key, scene: trial.scene, profile: trial.profile, repeat: trial.repeat,
      seed: trial.seed, status: 'reserved', startedAt: new Date().toISOString(),
      plannerProvider: PLANNER_PROVIDER, assetProvider: ASSET_PROVIDER,
      minAssetFamilies: MIN_ASSETS, maxAssetFamilies: MAX_ASSETS, prompt: scene.prompt
    };
    ledger.rounds.push(round);
    saveLedger();
  }
  console.log(`ROUND ${ledger.rounds.length}/50 ${trial.key} ${round.mapId ? 'RESUME' : 'START'}`);
  try {
    const map = typeof round.mapId === 'string'
      ? await store.loadMap(round.mapId)
      : await store.saveMap({
        ...createEmptyMap(`API实验 ${trial.key} ${scene.name}`, undefined, [96, 20, 96], 'voxel', 'outdoor'),
        seed: trial.seed
      });
    round.mapId = map.id;
    saveLedger();
    const systemPrompt = experimentPrompt(map, trial.profile);
    saveTrial(trial.key, 'system-prompt.txt', systemPrompt);
    const code = normalizeCode(await llmChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: scene.prompt }
    ], { provider: PLANNER_PROVIDER, temperature: 0.25, maxTokens: 16_000, fetchImpl: activeFetch, reasoningLogPath: false }));
    saveTrial(trial.key, 'code.js', code);
    round.apiCalls = auditApiUse(code, trial.profile);
    const requirements = discoverMapCodeAssets(code, map, [], MAX_ASSETS);
    round.assetFamiliesRequested = requirements.length;
    if (requirements.length < MIN_ASSETS || requirements.length > MAX_ASSETS) {
      throw new Error(`experiment_asset_family_count:${requirements.length}`);
    }
    round.status = 'generating-assets';
    saveLedger();
    const response = await post(`/api/editor/maps/${map.id}/generate`, {
      prompt: scene.prompt, provider: PLANNER_PROVIDER, assetProvider: ASSET_PROVIDER,
      approvedCode: code, sceneAgent: true, minNewAssets: MIN_ASSETS, maxNewAssets: MAX_ASSETS,
      codePromptMode: 'standard', codeRevisionMode: 'first-pass', codeSpatialPolicy: 'diagnose',
      reuseExistingAssets: false
    }, 'text/event-stream');
    const suggestion = await consumeSuggestion(response, round);
    saveTrial(trial.key, 'suggestion.json', JSON.stringify(suggestion, null, 2));
    const saved = await (await post(`/api/editor/maps/${map.id}/transactions`, {
      label: `API对照 ${trial.key}`, source: 'agent', operations: suggestion.operations,
      ai: { prompt: scene.prompt, generationTraceId: suggestion.generationTraceId,
        codePlan: suggestion.codePlan, generatedAssets: suggestion.generatedAssets }
    })).json();
    round.status = 'saved';
    round.transactionId = saved.transaction?.id;
    round.generationTraceId = suggestion.generationTraceId;
    round.objectCount = saved.map?.objects?.length ?? 0;
    round.assetCountGenerated = suggestion.generatedAssets?.length ?? 0;
    round.executedFunctions = suggestion.codePlan?.functions ?? [];
    round.diagnostics = (suggestion.diagnostics ?? []).map((item: any) => ({ code: item.code, message: item.message, repaired: item.repaired }));
    round.completedAt = new Date().toISOString();
    saveLedger();
    console.log(`ROUND ${ledger.rounds.length}/50 ${trial.key} SAVED ${map.id} families=${round.assetFamiliesRequested} assets=${round.assetCountGenerated} objects=${round.objectCount}`);
  } catch (error) {
    round.status = 'failed';
    round.error = error instanceof Error ? error.stack ?? error.message : String(error);
    round.completedAt = new Date().toISOString();
    saveLedger();
    console.error(`ROUND ${ledger.rounds.length}/50 ${trial.key} FAILED ${round.error}`);
  }
}
console.log(`FINISHED ${ledger.rounds.length}/50 rounds (including pilot and failures)`);
