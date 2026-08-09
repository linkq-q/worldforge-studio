import { createId, type MapAsset } from './map';
import { normalizeAssetTags } from './mapAssetMetadata';

export const ASSET_LIBRARY_ZONE_TAGS = [
  'any',
  'grass',
  'forest',
  'water',
  'lowland',
  'dry',
  'settlement',
  'rocky'
] as const;

export type AssetLibraryZoneTag = typeof ASSET_LIBRARY_ZONE_TAGS[number];
export type AssetLibraryAnalysisStatus = 'ready' | 'pending';
export type AssetLibraryRotationPolicy = 'random' | 'fixed';

export interface AssetLibraryMetadata {
  tags: string[];
  applicableZones: AssetLibraryZoneTag[];
  repeatable: boolean;
  landmark: boolean;
  enabled: boolean;
  priority: number;
  analysisStatus: AssetLibraryAnalysisStatus;
  density?: number;
  minSpacing?: number;
  scaleRange?: [number, number];
  rotation: AssetLibraryRotationPolicy;
}

export interface AssetLibrary {
  version: 1;
  id: string;
  name: string;
  description: string;
  assetIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AssetLibraryPack {
  kind: 'worldforge-asset-library';
  version: 1;
  library: AssetLibrary;
  assets: MapAsset[];
}

export function normalizeAssetLibraryMetadata(
  input: Partial<AssetLibraryMetadata> | undefined,
  fallbackTags: unknown = []
): AssetLibraryMetadata {
  const zones = Array.isArray(input?.applicableZones)
    ? input.applicableZones.filter((zone): zone is AssetLibraryZoneTag => (
        typeof zone === 'string' && ASSET_LIBRARY_ZONE_TAGS.includes(zone as AssetLibraryZoneTag)
      ))
    : [];
  const scaleRange = normalizeScaleRange(input?.scaleRange);
  return {
    tags: normalizeAssetTags(input?.tags ?? fallbackTags) ?? [],
    applicableZones: [...new Set<AssetLibraryZoneTag>(zones.length > 0 ? zones : ['any'])],
    repeatable: input?.repeatable !== false,
    landmark: input?.landmark === true,
    enabled: input?.enabled !== false,
    priority: clampNumber(input?.priority, 0, 1, 0.5),
    analysisStatus: input?.analysisStatus === 'pending' ? 'pending' : 'ready',
    ...(Number.isFinite(Number(input?.density))
      ? { density: clampNumber(input?.density, 0.01, 1, 0.5) }
      : {}),
    ...(Number.isFinite(Number(input?.minSpacing))
      ? { minSpacing: clampNumber(input?.minSpacing, 0.1, 100, 1) }
      : {}),
    ...(scaleRange ? { scaleRange } : {}),
    rotation: input?.rotation === 'fixed' ? 'fixed' : 'random'
  };
}

export function normalizeAssetLibrary(input: Partial<AssetLibrary>): AssetLibrary {
  const now = Date.now();
  return {
    version: 1,
    id: cleanId(input.id, 'library'),
    name: cleanText(input.name, '未命名资产库', 48),
    description: cleanText(input.description, '', 240),
    assetIds: [...new Set((Array.isArray(input.assetIds) ? input.assetIds : [])
      .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      .map((id) => id.replace(/[^a-zA-Z0-9_-]/g, ''))
      .filter(Boolean))],
    createdAt: finiteNumber(input.createdAt, now),
    updatedAt: finiteNumber(input.updatedAt, now)
  };
}

export function normalizeAssetLibraryPack(input: unknown): AssetLibraryPack {
  if (!input || typeof input !== 'object') throw new Error('invalid_asset_library_pack');
  const value = input as Partial<AssetLibraryPack>;
  if (value.kind !== 'worldforge-asset-library' || value.version !== 1 || !Array.isArray(value.assets)) {
    throw new Error('invalid_asset_library_pack');
  }
  const library = normalizeAssetLibrary(value.library ?? {});
  if (library.assetIds.some((id) => !value.assets?.some((asset) => asset?.id === id))) {
    throw new Error('asset_library_pack_missing_asset');
  }
  return { kind: value.kind, version: 1, library, assets: value.assets as MapAsset[] };
}

function normalizeScaleRange(input: unknown): [number, number] | undefined {
  if (!Array.isArray(input) || input.length < 2) return undefined;
  const min = clampNumber(input[0], 0.05, 20, 1);
  const max = clampNumber(input[1], min, 20, min);
  return [min, max];
}

function cleanId(value: unknown, prefix: string): string {
  const cleaned = typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  return cleaned || createId(prefix);
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.min(max, Math.max(min, numberValue)) : fallback;
}
