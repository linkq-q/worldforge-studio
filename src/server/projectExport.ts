import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import type { EditableMap, MapAsset } from '../shared/map';
import {
  normalizeProjectMapFolder,
  type ProjectExportAssetReference,
  type ProjectExportManifest,
  type ProjectExportProfile
} from '../shared/projectExport';
import type { RenderScheme } from '../shared/renderScheme';

export interface ProjectExportFile {
  path: string;
  bytes: Uint8Array;
}

export interface ProjectExportPlan {
  mapFolder: string;
  files: ProjectExportFile[];
  manifest: ProjectExportManifest;
}

export interface ProjectExportPreview {
  conflicts: Array<{ path: string; bytes: number }>;
  newFiles: number;
  unchangedFiles: number;
  totalFiles: number;
}

export function buildProjectExportPlan(input: {
  map: EditableMap;
  renderScheme: RenderScheme;
  profile: ProjectExportProfile;
  mapFolder?: string;
  hdri?: { file: string; bytes: Uint8Array };
}): ProjectExportPlan {
  const mapFolder = normalizeProjectMapFolder(input.mapFolder, input.map.name);
  const mapRoot = path.posix.join(input.profile.mapsDirectory, mapFolder);
  const assetRoot = input.profile.assetsDirectory;
  const assetReferenceRoot = path.posix.relative(mapRoot, assetRoot) || '.';
  const modelFiles = new Map<string, ProjectExportFile>();
  const assetReferences: ProjectExportAssetReference[] = [];
  const exportedAssets = (input.map.assets ?? []).map((asset) => {
    const modelBytes = jsonBytes(asset.modelJson);
    const sha256 = hash(modelBytes);
    const modelFile = `models/${sha256}.json`;
    modelFiles.set(modelFile, { path: path.posix.join(assetRoot, modelFile), bytes: modelBytes });
    assetReferences.push({ id: asset.id, name: asset.name, file: modelFile, sha256 });
    return {
      ...asset,
      modelJson: { $ref: path.posix.join(assetReferenceRoot, modelFile), sha256 }
    };
  });
  const exportedMap = { ...input.map, assets: exportedAssets };
  const libraryFile = `libraries/${input.map.id}.json`;
  const library = {
    kind: 'worldforge-project-asset-library',
    version: 1,
    mapId: input.map.id,
    mapName: input.map.name,
    assets: (input.map.assets ?? []).map((asset) => externalAssetMetadata(asset, assetReferences))
  };
  const manifest: ProjectExportManifest = {
    schemaVersion: 1,
    kind: 'worldforge-project-map',
    mapId: input.map.id,
    mapName: input.map.name,
    mapVersion: input.map.version,
    exportedAt: new Date(finiteTimestamp(input.map.updatedAt)).toISOString(),
    map: 'map.json',
    renderScheme: 'render-scheme.json',
    assetRoot: assetReferenceRoot,
    assetLibrary: path.posix.join(assetReferenceRoot, libraryFile),
    assets: assetReferences,
    ...(input.hdri ? {
      hdri: { file: `hdri/${safeFileName(input.hdri.file)}`, sha256: hash(input.hdri.bytes) }
    } : {})
  };
  const files: ProjectExportFile[] = [
    { path: path.posix.join(mapRoot, 'map.json'), bytes: jsonBytes(exportedMap) },
    { path: path.posix.join(mapRoot, 'render-scheme.json'), bytes: jsonBytes(input.renderScheme) },
    { path: path.posix.join(mapRoot, 'manifest.json'), bytes: jsonBytes(manifest) },
    { path: path.posix.join(assetRoot, libraryFile), bytes: jsonBytes(library) },
    ...modelFiles.values()
  ];
  if (input.hdri) {
    files.push({
      path: path.posix.join(assetRoot, 'hdri', safeFileName(input.hdri.file)),
      bytes: input.hdri.bytes
    });
  }
  return { mapFolder, manifest, files: files.sort((left, right) => left.path.localeCompare(right.path)) };
}

export function encodeProjectExportPlan(plan: ProjectExportPlan): Uint8Array {
  return zipSync(Object.fromEntries(plan.files.map((file) => [file.path, file.bytes])), { level: 0 });
}

export async function inspectProjectExport(projectRoot: string, plan: ProjectExportPlan): Promise<ProjectExportPreview> {
  let newFiles = 0;
  let unchangedFiles = 0;
  const conflicts: ProjectExportPreview['conflicts'] = [];
  for (const file of plan.files) {
    const destination = resolveInside(projectRoot, file.path);
    const existing = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!existing) newFiles += 1;
    else if (existing.equals(Buffer.from(file.bytes))) unchangedFiles += 1;
    else conflicts.push({ path: file.path, bytes: file.bytes.byteLength });
  }
  return { conflicts, newFiles, unchangedFiles, totalFiles: plan.files.length };
}

export async function writeProjectExport(
  projectRoot: string,
  plan: ProjectExportPlan,
  overwritePaths: readonly string[]
): Promise<{ written: number; unchanged: number; conflictsSkipped: number }> {
  const overwrite = new Set(overwritePaths);
  let written = 0;
  let unchanged = 0;
  let conflictsSkipped = 0;
  for (const file of plan.files) {
    const destination = resolveInside(projectRoot, file.path);
    const existing = await readFile(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing?.equals(Buffer.from(file.bytes))) {
      unchanged += 1;
      continue;
    }
    if (existing && !overwrite.has(file.path)) {
      conflictsSkipped += 1;
      continue;
    }
    await atomicWrite(destination, file.bytes);
    written += 1;
  }
  return { written, unchanged, conflictsSkipped };
}

function externalAssetMetadata(asset: MapAsset, references: readonly ProjectExportAssetReference[]): unknown {
  const { modelJson: _modelJson, ...metadata } = asset;
  const reference = references.find((entry) => entry.id === asset.id)!;
  return { ...metadata, modelFile: reference.file, sha256: reference.sha256 };
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, ...relativePath.split('/'));
  if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('project_export_path_outside_root');
  }
  return destination;
}

async function atomicWrite(destination: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function safeFileName(value: string): string {
  const file = value.replaceAll('\\', '/').split('/').pop()?.trim() ?? '';
  if (!file || /[<>:"|?*\u0000-\u001f]/.test(file)) throw new Error('invalid_project_export_file');
  return file;
}

function finiteTimestamp(value: unknown): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
