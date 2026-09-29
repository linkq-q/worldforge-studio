import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { applyMapOperations, type MapAiSuggestion } from '../src/shared/mapOperations';
import { generateMapCodeSuggestion, executeMapCodePlan } from '../src/server/mapCodePlanner';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { MapStore } from '../src/server/mapStore';
import { withGenerationTrace } from '../src/server/generationTrace';
import { urbanCityCases } from './urbanCityCases';

// Local acceptance experiment. Planning source is authored by this Codex GPT task;
// --generate explicitly pays for DeepSeek assets. --replay reuses those exact assets.
const mode = process.argv.includes('--generate') ? 'generate' : process.argv.includes('--replay') ? 'replay' : 'draft';
const only = process.argv.find(arg => arg.startsWith('--id='))?.slice(5);
const directory = 'output/urban-city-study';
mkdirSync(directory, {recursive:true});
const store = new MapStore();
await store.ensureReady();
for (const scene of urbanCityCases) {
  if (only && scene.id !== only) continue;
  const file = `${directory}/${scene.id}.json`;
  const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (mode === 'generate' && prior.status === 'saved' && (prior.generatedCode ?? prior.code) === scene.code) {
    console.log(`${scene.id}: already generated; use --replay to evaluate edited code without buying assets again`);
    continue;
  }
  const reusable = scene.reuseFrom && existsSync(`${directory}/${scene.reuseFrom}.json`)
    ? JSON.parse(readFileSync(`${directory}/${scene.reuseFrom}.json`,'utf8')).bindings : {};
  const ledger = {...prior, id:scene.id,name:scene.name,prompt:scene.prompt,code:scene.code,
    generatedCode:prior.generatedCode ?? (prior.status === 'saved' ? prior.code : undefined),
    planningProvider:'current Codex GPT',assetProvider:'deepseek',bindings:prior.bindings ?? reusable, status:mode};
  const save = () => writeFileSync(file, JSON.stringify(ledger, null, 2));
  const base = createEmptyMap(scene.name, undefined, scene.size, 'voxel', 'outdoor');
  base.seed = scene.seed;
  const started = Date.now();
  const progress = (label:string) => console.log(`${scene.id}: ${label}`);
  let suggestion: MapAiSuggestion;
  if (mode === 'replay') {
    const bindings = new Map<string,MapAsset[]>();
    for (const [key,ids] of Object.entries(ledger.bindings) as [string,string[]][]) {
      bindings.set(key, await Promise.all(ids.map(id => store.loadAsset(id))));
    }
    if (!bindings.size) throw new Error(`No generated bindings for ${scene.id}`);
    suggestion = executeMapCodePlan(scene.code, base, [...bindings.values()].flat(), {
      mode:'final',scope:'scene',promptMode:'main',legacyApis:false,assetBindings:bindings,spatialPolicy:'diagnose'
    });
  } else {
    const generate = createMapAssetGenerator(store, base, [], 'deepseek', null, new AbortController().signal)!;
    suggestion = await withGenerationTrace(store.rootDir, {operation:'urban-city-study',scene:scene.id,mode}, () =>
      generateMapCodeSuggestion(scene.prompt, base, [], {
        approvedCode:scene.code,provider:'gpt',scope:'scene',promptMode:'main',revisionMode:'first-pass',
        spatialPolicy:'diagnose',minNewAssets:0,maxNewAssets:8,discoveryOnly:mode === 'draft',
        onProgress:event => progress(event.label),
        onAssetReady:({key,variantIndex,asset}) => {
          ledger.bindings[key] ??= [];
          ledger.bindings[key][variantIndex] = asset.id;
          save();
        },
        createAsset:async (request,report) => {
          // Resume an interrupted paid run using only an exact prior request match.
          for (const ids of Object.values(ledger.bindings) as string[][]) for (const id of ids.filter(Boolean)) {
            const asset = await store.loadAsset(id);
            if (asset.name === request.name && asset.prompt === request.prompt) return asset;
          }
          return generate(request,report);
        }
      }));
  }
  if (suggestion.blocked) throw new Error(`Blocked ${scene.id}`);
  ledger.elapsedMs = Date.now() - started;
  ledger.diagnostics = suggestion.diagnostics;
  ledger.operations = suggestion.operations;
  if (mode === 'draft') {
    const map = applyMapOperations(base, suggestion.operations);
    writeFileSync(`${directory}/${scene.id}-draft-map.json`,JSON.stringify(map));
    ledger.draftObjects = map.objects.length;
    ledger.status = prior.status ?? 'draft';
    progress(`draft: ${map.objects.length} objects, ${map.guides.length} roads`);
  } else {
    if (suggestion.diagnostics?.some(d => d.code === 'asset.generation-degraded' || d.code === 'asset.unplaced')) {
      save();
      throw new Error(`Incomplete paid assets for ${scene.id}; inspect diagnostics and resume`);
    }
    const map = await store.saveMap(base);
    const committed = await store.commitTransaction(map.id, {
      label:`城市生成研究 · ${scene.name}`,source:'agent',operations:suggestion.operations,
      ai:{prompt:scene.prompt,codePlan:suggestion.codePlan,generatedAssets:suggestion.generatedAssets}
    },map.version);
    ledger.previousMaps = [...(prior.previousMaps ?? []), ...(prior.mapId ? [prior.mapId] : [])];
    ledger.mapId = map.id;
    ledger.transactionId = committed.transaction.id;
    ledger.objectCount = committed.map.objects.length;
    ledger.assetCount = committed.map.assets?.length ?? 0;
    ledger.status = 'saved';
    ledger.generatedCode = scene.code;
    progress(`saved ${map.id}: ${ledger.objectCount} objects, ${ledger.assetCount} assets`);
  }
  save();
}
