import { createId } from './map';

export const PROJECT_EXPORT_VERSION = 1 as const;

export type ProjectExportMode = 'browser' | 'server';

export interface ProjectExportProfile {
  version: typeof PROJECT_EXPORT_VERSION;
  id: string;
  name: string;
  mode: ProjectExportMode;
  /** Absolute path in server mode; directory-handle display name in browser mode. */
  projectDirectory: string;
  mapsDirectory: string;
  assetsDirectory: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectExportAssetReference {
  id: string;
  name: string;
  file: string;
  sha256: string;
}

export interface ProjectExportManifest {
  schemaVersion: typeof PROJECT_EXPORT_VERSION;
  kind: 'worldforge-project-map';
  mapId: string;
  mapName: string;
  mapVersion: number;
  exportedAt: string;
  map: 'map.json';
  renderScheme: 'render-scheme.json';
  assetRoot: string;
  assetLibrary: string;
  assets: ProjectExportAssetReference[];
  hdri?: { file: string; sha256: string };
}

export function normalizeProjectExportProfile(
  input: Partial<ProjectExportProfile>,
  current?: ProjectExportProfile
): ProjectExportProfile {
  const now = Date.now();
  const mode: ProjectExportMode = input.mode === 'browser' ? 'browser' : 'server';
  const projectDirectory = cleanText(input.projectDirectory, current?.projectDirectory ?? '', 1024);
  if (!projectDirectory) throw new Error('project_export_directory_required');
  return {
    version: PROJECT_EXPORT_VERSION,
    id: cleanId(input.id ?? current?.id),
    name: cleanText(input.name, current?.name ?? '项目导出', 64),
    mode,
    projectDirectory,
    mapsDirectory: normalizeProjectRelativeDirectory(input.mapsDirectory ?? current?.mapsDirectory, 'maps'),
    assetsDirectory: normalizeProjectRelativeDirectory(input.assetsDirectory ?? current?.assetsDirectory, 'assets/worldforge'),
    createdAt: current?.createdAt ?? finiteNumber(input.createdAt, now),
    updatedAt: current ? now : finiteNumber(input.updatedAt, now)
  };
}

export function normalizeProjectRelativeDirectory(value: unknown, fallback: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const normalized = text.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/g, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || /[:<>"|?*\u0000-\u001f]/.test(part))) {
    throw new Error('invalid_project_export_directory');
  }
  return parts.join('/');
}

export function normalizeProjectMapFolder(value: unknown, fallback: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const cleaned = text.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/[. ]+$/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('invalid_project_export_map_folder');
  return cleaned.slice(0, 80);
}

function cleanId(value: unknown): string {
  const cleaned = typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  return cleaned || createId('export-profile');
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}
