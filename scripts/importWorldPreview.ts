import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { EditableMap, MapAsset } from '../src/shared/map';
import { validateWorldBundle } from '../src/shared/worldPlanning';
import type { WorldAssetBinding } from '../src/shared/worldMapState';

const [worldFile, assetFile, stateFile, api] = process.argv.slice(2);
if (!worldFile || !assetFile || !stateFile || !api) throw new Error('Usage: importWorldPreview.ts world.json assets.json state.json api-url');
const bundle = validateWorldBundle(JSON.parse(await readFile(worldFile, 'utf8')));
type Source = {id: string; name: string; role: WorldAssetBinding['role']; assetId?: string; modelJson: unknown;
  ecologyKind?: WorldAssetBinding['ecologyKind']; ecologyRuleId?: string};
const sources: Source[] = JSON.parse(await readFile(assetFile, 'utf8'));
type State = {mapId?: string; bindings: Array<WorldAssetBinding & {hash: string}>};
let previous: State = {bindings: []};
try { previous = JSON.parse(await readFile(stateFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
async function request<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(api + '/api/editor' + route, body === undefined ? undefined : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
const bindings: State['bindings'] = [];
const pending: Array<{source: Source; hash: string}> = [];
for (const source of sources) {
  const hash = createHash('sha256').update(JSON.stringify(source.modelJson)).digest('hex');
  const reused = previous.bindings.find(binding => binding.key === source.id && binding.hash === hash);
  const id = reused?.assetId ?? source.assetId;
  if (id) {
    const response = await fetch(api + '/api/editor/assets/' + encodeURIComponent(id));
    if (response.ok) { bindings.push({key: source.id, assetId: id, role: source.role, hash,
      ...(source.ecologyKind ? {ecologyKind: source.ecologyKind} : {}),
      ...(source.ecologyRuleId ? {ecologyRuleId: source.ecologyRuleId} : {})}); continue; }
  }
  pending.push({source, hash});
}
if (pending.length) {
  const assets = pending.map(({source}) => ({id: source.id, name: source.name,
    prompt: 'Reused world scene asset: ' + source.name, modelJson: source.modelJson, mode: 'voxel-pro'}));
  const imported = await request<{assets: MapAsset[]}>('/asset-libraries/import', {
    kind: 'worldforge-asset-library', version: 1,
    library: {version: 1, id: 'world-preview-assets', name: bundle.plan.id, description: 'Existing generated assets and Scene Code assemblies',
      assetIds: assets.map(asset => asset.id), createdAt: Date.now(), updatedAt: Date.now()}, assets
  });
  if (imported.assets.length !== pending.length) throw new Error('asset_import_count_mismatch');
  pending.forEach(({source, hash}, index) => bindings.push({key: source.id, role: source.role, assetId: imported.assets[index].id, hash,
    ...(source.ecologyKind ? {ecologyKind: source.ecologyKind} : {}),
    ...(source.ecologyRuleId ? {ecologyRuleId: source.ecologyRuleId} : {})}));
}
let map: EditableMap;
if (previous.mapId) map = (await request<{map: EditableMap}>('/maps/' + previous.mapId)).map;
else map = (await request<{map: EditableMap}>('/maps', {name: bundle.plan.id + ' · 连续世界', size: [96, 32, 96], assetGenerationMode: 'voxel-pro'})).map;
await mkdir(path.dirname(path.resolve(stateFile)), {recursive: true});
// Keep imported ids even if validation or the subsequent transaction fails.
await writeFile(stateFile, JSON.stringify({mapId: map.id, bindings}, null, 2));
const result = await request<{map: EditableMap; transaction: {id: string}}>('/maps/' + map.id + '/transactions', {
  source: 'agent', label: '连续世界生成与资产复用',
  operations: [{type: 'world.set', world: {bundle, assets: bindings.map(({hash: _hash, ...binding}) => binding)}}]
});
console.log(JSON.stringify({mapId: result.map.id, transactionId: result.transaction.id, buildings: bundle.patches.reduce((sum, patch) => sum + patch.buildings.length, 0),
  assetFamilies: bindings.length, url: api + '/?map=' + result.map.id}));
