import { readFileSync, writeFileSync } from 'node:fs';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';
import { MapStore } from '../src/server/mapStore';

// Replay the exact model-written program. No planning or asset API calls.
const source = process.argv[2];
const id = process.argv[3];
if (!source || !id || !/^[a-z0-9-]+$/.test(id)) throw Error('Usage: tsx scripts/replayUrbanPrompt.ts ledger.json capture-id [--seed=123] [--save]');
const record = JSON.parse(readFileSync(source, 'utf8'));
const requestedSeed = process.argv.find(arg => arg.startsWith('--seed='))?.slice(7);
const store = new MapStore();
const original = record.baseMap ?? await store.loadMap(record.mapId);
const base = createEmptyMap(`${record.prompt} · ${id}`, undefined, original.box.size, original.assetGenerationMode, original.sceneMode);
base.seed = requestedSeed === undefined ? original.seed : Number(requestedSeed);
if (!Number.isInteger(base.seed) || base.seed < 0 || base.seed > 0xffffffff) throw Error('Invalid seed');
const bindings = new Map<string, MapAsset[]>();
if (record.status === 'saved') {
  for (const requirement of record.suggestion.codePlan.assetRequirements) {
    const family: MapAsset[] = [];
    for (let variant = 0; variant < requirement.variants; variant++) {
      const name = requirement.variants > 1 ? `${requirement.name} ${variant + 1}` : requirement.name;
      const asset = record.suggestion.generatedAssets.find((candidate: { name: string }) => candidate.name === name);
      if (!asset) throw Error(`Missing recorded asset: ${name}`);
      family.push(await store.loadAsset(asset.id));
    }
    bindings.set(requirement.key, family);
  }
}
const suggestion = executeMapCodePlan(record.suggestion.codePlan.code, base, [...bindings.values()].flat(), {
  mode: bindings.size ? 'final' : 'discovery', scope: 'scene', promptMode: 'main', legacyApis: false,
  spatialPolicy: 'diagnose', assetBindings: bindings
});
let map = applyMapOperations(base, suggestion.operations);
map.assets = [...bindings.values()].flat();
if (process.argv.includes('--save')) {
  if (!bindings.size) throw Error('Only save a replay with recorded real assets');
  const savedBase = await store.saveMap(base);
  map = (await store.commitTransaction(base.id, { label: `城市种子对照 · ${id}`, source: 'agent', operations: suggestion.operations,
    ai: { prompt: record.prompt, codePlan: suggestion.codePlan, generatedAssets: record.suggestion.generatedAssets } }, savedBase.version)).map;
} else {
  writeFileSync(`output/urban-city-study/${id}-draft-map.json`, JSON.stringify(map));
}
const names = Object.fromEntries([...new Set(map.objects.map(object => object.name))].map(name => [name, map.objects.filter(object => object.name === name).length]));
const result = { id, source, prompt: record.prompt, mapId: map.id, seed: base.seed, objectCount: map.objects.length,
  assetCount: map.assets?.length ?? 0, roads: map.guides.length, names, diagnostics: suggestion.diagnostics };
writeFileSync(`output/urban-city-study/${id}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
