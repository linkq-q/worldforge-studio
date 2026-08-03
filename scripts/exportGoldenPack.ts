import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';
import { renderSchemeHdriFile, encodeScenePackage } from '../src/shared/scenePackage';
import { MapStore } from '../src/server/mapStore';

const DEFAULT_GOLDEN_MAPS = ['开阔平原', '清新树林', '樱花竹林', '夕阳草原'];
const execFileAsync = promisify(execFile);

interface GoldenSceneEntry {
  file: string;
  mapId: string;
  name: string;
  renderSchemeId: string;
  renderSchemeName: string;
  hdri: string | null;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const requestedNames = (args.maps ?? DEFAULT_GOLDEN_MAPS.join(','))
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (requestedNames.length === 0) throw new Error('golden_pack_requires_maps');

  const output = resolve(args.output ?? join('data', 'exports', `worldforge-golden-pack-${dateStamp()}.zip`));
  await assertDoesNotExist(output);

  const store = new MapStore();
  await store.ensureReady();
  const summaries = await store.listMapSummaries();
  const schemes = await store.listRenderSchemes();
  const entries: GoldenSceneEntry[] = [];
  const files: Record<string, Uint8Array> = {};

  for (const [index, name] of requestedNames.entries()) {
    const matches = summaries.filter((map) => map.name === name);
    if (matches.length !== 1) throw new Error(matches.length ? `golden_map_name_ambiguous:${name}` : `golden_map_not_found:${name}`);
    const map = await store.loadMap(matches[0].id);
    if (!map.confirmedAt) throw new Error(`golden_map_not_confirmed:${name}`);
    const scheme = schemes.find((candidate) => candidate.id === map.renderSchemeId);
    if (!scheme) throw new Error(`golden_render_scheme_not_found:${name}`);

    const hdriFile = renderSchemeHdriFile(scheme);
    const hdriPath = hdriFile ? await store.resolveHdriFile(hdriFile) : null;
    if (hdriFile && !hdriPath) throw new Error(`golden_hdri_not_found:${hdriFile}`);
    const hdri = hdriPath ? { file: hdriFile!, bytes: new Uint8Array(await readFile(hdriPath)) } : undefined;
    const file = `scenes/${String(index + 1).padStart(2, '0')}-${fileStem(name)}.worldforge-scene.zip`;
    files[file] = encodeScenePackage({ map, renderScheme: scheme, hdri });
    entries.push({
      file,
      mapId: map.id,
      name: map.name,
      renderSchemeId: scheme.id,
      renderSchemeName: scheme.name,
      hdri: hdriFile
    });
  }

  const versions = {
    createdAt: new Date().toISOString(),
    node: process.version,
    worldforgeCommit: await gitRevision(process.cwd()),
    voxelStudioCommit: await gitRevision(resolve(process.cwd(), '..', '3d-generate'))
  };
  files['manifest.json'] = jsonBytes({ schemaVersion: 1, kind: 'worldforge-golden-pack', scenes: entries, versions });
  files['README.txt'] = strToU8(readme(entries));
  files['versions.json'] = jsonBytes(versions);

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, zipSync(files, { level: 0 }));
  console.log(JSON.stringify({ output, scenes: entries, versions }, null, 2));
}

function parseArgs(argv: string[]): { maps?: string; output?: string } {
  const result: { maps?: string; output?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key !== '--maps' && key !== '--output') continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing_value:${key}`);
    result[key.slice(2) as 'maps' | 'output'] = value;
    index += 1;
  }
  return result;
}

async function assertDoesNotExist(file: string): Promise<void> {
  try {
    await access(file);
    throw new Error(`golden_pack_output_exists:${file}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('golden_pack_output_exists:')) throw error;
  }
}

async function gitRevision(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function readme(entries: readonly GoldenSceneEntry[]): string {
  return [
    'WorldForge Studio 金样场景包',
    '',
    '使用：',
    '1. 解压本 ZIP。',
    '2. 启动 WorldForge Studio。',
    '3. 顶栏“更多” > “导入文件…”，逐个选择 scenes/ 下的 .worldforge-scene.zip。',
    '4. 每个场景包自带它实际引用的模型资产、渲染方案和 HDRI；导入后可继续编辑、进入渲染或游玩。',
    '',
    '本包场景：',
    ...entries.map((entry) => `- ${entry.name}：${entry.file}；方案 ${entry.renderSchemeName}${entry.hdri ? `；HDRI ${entry.hdri}` : '；无 HDRI'}`),
    '',
    '完整 HDRI 库不在本 ZIP 中，避免无关贴图和文件体积膨胀。需要完整库时，请单独复制 data/map-editor/hdri/。'
  ].join('\n');
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function fileStem(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').trim().slice(0, 80) || 'scene';
}

function dateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
