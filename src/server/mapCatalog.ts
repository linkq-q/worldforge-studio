import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createId } from '../shared/map';
import type { MapCatalog, MapFolder } from '../shared/experiments';
import type { MapStore } from './mapStore';

export async function readOptionalJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + createId('write') + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await rename(temp, file);
}
export class MapCatalogStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(private readonly maps: MapStore) { this.file = path.join(maps.rootDir, 'map-catalog.json'); }
  async read(): Promise<MapCatalog> {
    await this.queue;
    return readOptionalJson(this.file, { folders: [], membership: {} });
  }
  private mutate<T>(work: (catalog: MapCatalog) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const catalog = await readOptionalJson<MapCatalog>(this.file, { folders: [], membership: {} });
      const result = await work(catalog);
      await writeJsonAtomic(this.file, catalog);
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async requireFolder(id: string): Promise<void> {
    if (!(await this.read()).folders.some(folder => folder.id === id)) throw new Error('unknown_folder');
  }
  saveFolder(input: { id?: string; name: string; parentId?: string | null }): Promise<MapFolder> {
    return this.mutate(catalog => {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80) throw new Error('invalid_folder_name');
      const existing = input.id ? catalog.folders.find(folder => folder.id === input.id) : undefined;
      if (input.id && !existing) throw new Error('unknown_folder');
      const parentId = input.parentId === undefined ? existing?.parentId ?? null : input.parentId;
      if (parentId && !catalog.folders.some(folder => folder.id === parentId)) throw new Error('unknown_parent_folder');
      let cursor = parentId;
      while (cursor) {
        if (cursor === input.id) throw new Error('folder_cycle');
        cursor = catalog.folders.find(folder => folder.id === cursor)?.parentId ?? null;
      }
      if (catalog.folders.some(folder => folder.id !== input.id && folder.parentId === parentId && folder.name === name)) {
        throw new Error('duplicate_folder_name');
      }
      const folder = { id: existing?.id ?? createId('folder'), name, parentId };
      if (existing) Object.assign(existing, folder); else catalog.folders.push(folder);
      return folder;
    });
  }
  move(mapIds: string[], folderId: string | null): Promise<void> {
    return this.mutate(async catalog => {
      if (!Array.isArray(mapIds) || !mapIds.length || mapIds.length > 500 || mapIds.some(id => typeof id !== 'string')) {
        throw new Error('invalid_map_selection');
      }
      if (folderId !== null && !catalog.folders.some(folder => folder.id === folderId)) throw new Error('unknown_folder');
      const known = new Set((await this.maps.listMapSummaries()).map(map => map.id));
      if (mapIds.some(id => !known.has(id))) throw new Error('unknown_map');
      for (const id of mapIds) {
        if (folderId) catalog.membership[id] = folderId; else delete catalog.membership[id];
      }
    });
  }
}
const stores = new WeakMap<MapStore, MapCatalogStore>();
export function mapCatalog(store: MapStore): MapCatalogStore {
  let catalog = stores.get(store);
  if (!catalog) { catalog = new MapCatalogStore(store); stores.set(store, catalog); }
  return catalog;
}
