import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const GOLDEN_MAPS = ['开阔平原', '清新树林', '樱花竹林', '夕阳草原'];

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const sourceRoot = path.resolve(process.env.WORLDFORGE_DATA_DIR ?? path.join('data', 'map-editor'));
  const outputRoot = path.resolve(process.argv[2] ?? path.join('assets', 'starter-data'));
  const mapFiles = await readJsonFiles(path.join(sourceRoot, 'maps'));
  const maps = GOLDEN_MAPS.map((name) => {
    const matches = mapFiles.filter((entry) => entry.value.name === name);
    if (matches.length !== 1) throw new Error(matches.length ? `starter_map_ambiguous:${name}` : `starter_map_missing:${name}`);
    return matches[0];
  });
  const assetIds = new Set<string>();
  for (const map of maps) {
    for (const object of map.value.objects ?? []) {
      if (typeof object?.assetId === 'string') assetIds.add(object.assetId);
    }
  }
  const schemeIds = new Set(maps.map((map) => map.value.renderSchemeId).filter((id): id is string => typeof id === 'string'));
  const assetFiles = await readJsonFiles(path.join(sourceRoot, 'assets'));
  const schemeFiles = await readJsonFiles(path.join(sourceRoot, 'render-schemes'));
  const selectedAssets = assetFiles.filter((entry) => assetIds.has(entry.value.id));
  const selectedSchemes = schemeFiles.filter((entry) => schemeIds.has(entry.value.id));
  if (selectedAssets.length !== assetIds.size) throw new Error('starter_asset_missing');
  if (selectedSchemes.length !== schemeIds.size) throw new Error('starter_render_scheme_missing');

  await Promise.all(['maps', 'assets', 'render-schemes'].map((directory) => mkdir(path.join(outputRoot, directory), { recursive: true })));
  await Promise.all([
    ...maps.map((entry) => copyFile(entry.file, path.join(outputRoot, 'maps', path.basename(entry.file)))),
    ...selectedAssets.map((entry) => copyFile(entry.file, path.join(outputRoot, 'assets', path.basename(entry.file)))),
    ...selectedSchemes.map((entry) => copyFile(entry.file, path.join(outputRoot, 'render-schemes', path.basename(entry.file))))
  ]);
  await writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'worldforge-starter-data',
    maps: maps.map((entry) => ({ id: entry.value.id, name: entry.value.name })),
    assets: selectedAssets.map((entry) => entry.value.id),
    renderSchemes: selectedSchemes.map((entry) => entry.value.id)
  }, null, 2)}\n`);
  console.log(JSON.stringify({ outputRoot, maps: maps.length, assets: selectedAssets.length, renderSchemes: selectedSchemes.length }, null, 2));
}

async function readJsonFiles(directory: string): Promise<Array<{ file: string; value: any }>> {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json'));
  return Promise.all(files.map(async (file) => {
    const fullPath = path.join(directory, file);
    return { file: fullPath, value: JSON.parse(await readFile(fullPath, 'utf8')) };
  }));
}
