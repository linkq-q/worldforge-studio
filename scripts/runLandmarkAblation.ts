import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { calculateModelVisualBounds } from '../src/shared/modelBounds';
import { MapStore } from '../src/server/mapStore';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';
import { llmChat } from '../src/server/modelApi';
import { assertModelRoute, assertRoundAvailable } from './apiAblationConfig';
import { assertLandmarkOperations, auditLandmarkCode, LANDMARKS, landmarkSystemPrompt, landmarkTrials } from './landmarkAblationConfig';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass the existing absolute experiment directory');
const ledgerPath = path.join(output, 'rounds.json');
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const store = new MapStore();
await store.ensureReady();
const snapshotDir = path.join(output, `landmark-source-snapshot-${Date.now()}`);
fs.mkdirSync(snapshotDir, { recursive: true });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const files = ['scripts/landmarkAblationConfig.ts', 'scripts/runLandmarkAblation.ts', 'src/server/mapCodePlanner.ts', 'src/shared/terrainGeneration.ts', 'src/server/mapAssetGenerator.ts'];
const sourceHashes = Object.fromEntries(files.map(file => {
  const content = fs.readFileSync(file, 'utf8');
  const saved = path.join(snapshotDir, file.replaceAll('/', '__'));
  fs.writeFileSync(saved, content);
  return [file, hash(content)];
}));
function write(name: string, data: unknown) {
  const file = path.join(output, name);
  fs.writeFileSync(`${file}.tmp`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}
function save() { write('rounds.json', ledger); }
// Imports stay loaded in this process. Record concurrent disk edits rather than
// switching to a hot-reloaded HTTP executor between experimental arms.
function recordDiskDrift() {
  const changed = Object.entries(sourceHashes).filter(([file, digest]) => hash(fs.readFileSync(file, 'utf8')) !== digest).map(([file]) => file);
  if (changed.length) write('landmark-concurrent-disk-edits.json', { changed, executionSourceHashes: sourceHashes, snapshotDir });
}
for (const previous of ledger.rounds.filter((item: any) => item.batch === 'landmark-fixed-kit-v1' && item.status === 'saved')) {
  if (JSON.stringify(previous.sourceHashes) !== JSON.stringify(sourceHashes)) throw new Error('landmark_resume_requires_same_execution_source');
}
const checkedFetch: typeof fetch = (input, init) => {
  assertModelRoute(String(input), JSON.parse(String(init?.body)));
  return fetch(input, init);
};
function unfence(raw: string) { return raw.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').replace(/^\s*```(?:json|javascript|js)?\s*/i, '').replace(/\s*```\s*$/, '').trim(); }
async function chat(system: string, user: string) {
  return unfence(await llmChat([{ role: 'system', content: system }, { role: 'user', content: user }], {
    provider: 'gpt', temperature: 0.25, maxTokens: 16000, fetchImpl: checkedFetch, reasoningLogPath: false
  }));
}

for (const scene of LANDMARKS) {
  const trials = landmarkTrials().filter(trial => trial.scene === scene.id);
  const first = trials[0];
  let firstRound = ledger.rounds.find((item: any) => item.key === first.key);
  if (!firstRound) {
    assertRoundAvailable(ledger.rounds.map((item: any) => item.key), first.key);
    firstRound = { ...first, batch: 'landmark-fixed-kit-v1', status: 'preparing-kit', startedAt: new Date().toISOString() };
    ledger.rounds.push(firstRound); save();
  }
  const kitFile = path.join(output, `landmark-${scene.id}-kit.json`);
  const kit: { requirements: Array<{key:string;name:string;prompt:string;dimensions:[number,number,number]}>; assets: Array<{key:string;assetId:string}> } = fs.existsSync(kitFile)
    ? JSON.parse(fs.readFileSync(kitFile, 'utf8')) : { requirements: [], assets: [] };
  if (!kit.requirements.length) {
    const prompt = `You design a shared reusable asset kit for a controlled landmark assembly experiment. Return only JSON {"requirements":[{"key":"...","name":"简短中文名","prompt":"...","dimensions":[width,height,depth]}]}. Produce 10 to 16 distinct architectural component families in total. All assets will be made by DeepSeek. Do not choose a placement API or write assembly code. Split the recognizable building into meaningful reusable structural components at a useful scale; no whole completed landmark asset, no trees or unrelated props. A tightly coupled continuous roof or curved component may remain one asset; do not require every shape to be rectangular. Fit the whole building within 80x44x80 world units. Describe mating faces, hollow openings, connection axis and size explicitly; no duplicate bases/end caps at intended joins. Each prompt at most 450 characters. Coordinates Y+ up, Z+ front, X+ right. Component budgets and this same kit are shared by all conditions. Do not include unsupported exact reconstruction claims.`;
    write(`landmark-${scene.id}-kit-system.txt`, prompt);
    const raw = await chat(prompt, scene.prompt);
    write(`landmark-${scene.id}-kit-raw.txt`, raw);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.requirements) || parsed.requirements.length < 10 || parsed.requirements.length > 16) throw new Error('landmark_invalid_kit_count');
    kit.requirements = parsed.requirements;
    if (new Set(kit.requirements.map(item => item.key)).size !== kit.requirements.length || kit.requirements.some(item => !item.key || !item.name || !item.prompt || item.prompt.length > 450 || item.dimensions?.length !== 3 || item.dimensions.some(value => !Number.isFinite(value) || value <= 0))) throw new Error('landmark_invalid_kit_contract');
    write(path.basename(kitFile), kit);
  }
  const template = createEmptyMap(scene.name, undefined, [96, 48, 96], 'voxel', 'outdoor');
  const createAsset = createMapAssetGenerator(store, template, [], 'deepseek', null, new AbortController().signal);
  for (let start = 0; start < kit.requirements.length; start += 4) {
    const results = await Promise.allSettled(kit.requirements.slice(start, start + 4).map(async requirement => {
      if (kit.assets.some(item => item.key === requirement.key)) return;
      console.log(`ASSET_START ${scene.id} ${requirement.name}`);
      const asset = await createAsset({ name: `${scene.name}实验-${requirement.name}`, prompt: `${requirement.prompt}\nTarget dimensions [width,height,depth]=${JSON.stringify(requirement.dimensions)}. Y+ up, Z+ front, X+ right. Center geometry horizontally. No ground or background.`, mode: 'voxel', tags: ['landmark-api-experiment', scene.id, requirement.key] }, () => {});
      kit.assets.push({ key: requirement.key, assetId: asset.id });
      write(path.basename(kitFile), kit);
      console.log(`ASSET_SAVED ${scene.id} ${requirement.name} ${asset.id}`);
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  const assets: MapAsset[] = await Promise.all(kit.requirements.map(req => store.loadAsset(kit.assets.find(item => item.key === req.key)!.assetId)));
  const catalog = assets.map((asset, i) => {
    const bounds = calculateModelVisualBounds(asset.modelJson);
    return { key: kit.requirements[i].key, id: asset.id, name: kit.requirements[i].name, prompt: kit.requirements[i].prompt, bounds, actualSize: bounds.max.map((value, axis) => value - bounds.min[axis]) };
  });
  const kitHash = hash(JSON.stringify(assets.map(asset => ({id: asset.id, modelJson: asset.modelJson}))));
  write(`landmark-${scene.id}-catalog.json`, catalog);
  // Freeze all six prompts before the first assembly call.
  for (const trial of trials) {
    const name = `${trial.key}-system-prompt.txt`;
    const prompt = landmarkSystemPrompt(trial.profile, catalog, trial.seed);
    const file = path.join(output, name);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== prompt) throw new Error('landmark_prompt_changed');
    write(name, prompt);
  }
  for (const trial of trials) {
    recordDiskDrift();
    let round = ledger.rounds.find((item: any) => item.key === trial.key);
    if (round && ['saved', 'failed'].includes(round.status)) continue;
    if (!round) {
      assertRoundAvailable(ledger.rounds.map((item: any) => item.key), trial.key);
      round = { ...trial, batch: 'landmark-fixed-kit-v1', status: 'reserved', startedAt: new Date().toISOString() };
      ledger.rounds.push(round);
    }
    Object.assign(round, { plannerProvider: 'gpt', assetProvider: 'deepseek', prompt: scene.prompt, source: scene.source, kitHash, assetIds: assets.map(asset => asset.id), assetFamiliesRequested: assets.length, assetCountGenerated: trial.key === first.key ? assets.length : 0, sourceHashes });
    save();
    console.log(`ROUND ${ledger.rounds.length}/50 ${trial.key} START`);
    try {
      const map = round.mapId ? await store.loadMap(round.mapId) : await store.saveMap({ ...createEmptyMap(`建筑API实验 ${scene.name} ${trial.profile} r${trial.repeat}`, undefined, [96, 48, 96], 'voxel', 'outdoor'), seed: trial.seed });
      round.mapId = map.id; round.status = 'planning'; save();
      const codePath = path.join(output, `${trial.key}-code.js`);
      const code = fs.existsSync(codePath) ? fs.readFileSync(codePath, 'utf8') : await chat(fs.readFileSync(path.join(output, `${trial.key}-system-prompt.txt`), 'utf8'), scene.prompt);
      write(`${trial.key}-code.js`, code);
      round.apiCalls = auditLandmarkCode(code, trial.profile);
      const suggestion = executeMapCodePlan(code, map, assets, { mode: 'final', scope: 'scene', promptMode: 'standard', spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 0 });
      write(`${trial.key}-suggestion.json`, suggestion);
      assertLandmarkOperations(suggestion.operations);
      const saved = await store.commitTransaction(map.id, { label: `建筑API对照 ${trial.key}`, source: 'agent', operations: suggestion.operations });
      Object.assign(round, { status: 'saved', transactionId: saved.transaction?.id, objectCount: saved.map?.objects?.length, executedFunctions: suggestion.codePlan?.functions ?? [], diagnostics: suggestion.diagnostics ?? [], completedAt: new Date().toISOString() });
      console.log(`SAVED ${trial.key} ${map.id} objects=${round.objectCount}`);
    } catch (error) {
      Object.assign(round, { status: 'failed', error: String(error), completedAt: new Date().toISOString() });
      console.error(`FAILED ${trial.key}: ${error}`);
    }
    save();
  }
}
console.log(`FINISHED ${ledger.rounds.length}/50`);
