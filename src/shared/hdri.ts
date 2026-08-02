/** Panorama formats the packaged runtime loader accepts. */
export const HDRI_EXTENSIONS = ['hdr', 'exr', 'jpg', 'jpeg', 'png'] as const;
export const HDRI_CATALOG_FILE = 'catalog.json';

export type HdriExtension = typeof HDRI_EXTENSIONS[number];

export interface HdriTexture {
  /** Filename without extension. Stable id a render scheme refers to. */
  id: string;
  /** Filename as it sits on disk, used to build the download URL. */
  file: string;
  extension: HdriExtension;
  bytes: number;
  /** Curated mood labels that let the AI choose without guessing from filenames. */
  tags: string[];
  /** Average sky-facing colour, used to harmonize hemisphere light. */
  skyColor?: string;
  /** Average lower-panorama colour, used to harmonize fog and ground light. */
  groundColor?: string;
}

export interface HdriCatalogEntry {
  file: string;
  tags?: string[];
  skyColor?: string;
  groundColor?: string;
}

export function parseHdriCatalog(value: unknown): Map<string, Required<Pick<HdriCatalogEntry, 'tags'>> & Omit<HdriCatalogEntry, 'tags'>> {
  const raw = value && typeof value === 'object' ? value as { textures?: unknown } : {};
  const entries = Array.isArray(raw.textures) ? raw.textures : [];
  const catalog = new Map<string, Required<Pick<HdriCatalogEntry, 'tags'>> & Omit<HdriCatalogEntry, 'tags'>>();
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as HdriCatalogEntry;
    const file = typeof entry.file === 'string' ? entry.file.trim() : '';
    if (!file || !hdriExtensionOf(file)) continue;
    const tags = Array.isArray(entry.tags)
      ? [...new Set(entry.tags.filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32))
        .filter(Boolean))].slice(0, 12)
      : [];
    const color = (candidate: unknown): string | undefined => (
      typeof candidate === 'string' && /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : undefined
    );
    catalog.set(file, { file, tags, skyColor: color(entry.skyColor), groundColor: color(entry.groundColor) });
  }
  return catalog;
}

export function hdriExtensionOf(file: string): HdriExtension | null {
  const extension = file.split('.').pop()?.toLowerCase() ?? '';
  return (HDRI_EXTENSIONS as readonly string[]).includes(extension)
    ? extension as HdriExtension
    : null;
}
