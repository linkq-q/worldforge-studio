import { normalizeMap, type EditableMap } from '../shared/map';

export interface BrowserMapDraft {
  mapId: string;
  baseUpdatedAt: number;
  updatedAt: number;
  map: EditableMap;
}

const DB_NAME = 'worldforge-editor';
const STORE_NAME = 'map-drafts';

export function createBrowserMapDraft(map: EditableMap, updatedAt = Date.now()): BrowserMapDraft {
  const copy = structuredClone(map);
  delete copy.assets;
  return { mapId: map.id, baseUpdatedAt: map.updatedAt, updatedAt, map: copy };
}

export function recoverBrowserMapDraft(savedMap: EditableMap, draft: BrowserMapDraft): EditableMap {
  if (draft.mapId !== savedMap.id) throw new Error('map_draft_id_mismatch');
  return normalizeMap({ ...structuredClone(draft.map), assets: savedMap.assets });
}

export async function saveBrowserMapDraft(map: EditableMap): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const database = await openDatabase();
  await requestResult(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(createBrowserMapDraft(map)));
  database.close();
}

export async function loadBrowserMapDraft(mapId: string): Promise<BrowserMapDraft | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openDatabase();
  const draft = await requestResult<BrowserMapDraft | undefined>(
    database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(mapId)
  );
  database.close();
  return draft ?? null;
}

export async function deleteBrowserMapDraft(mapId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const database = await openDatabase();
  await requestResult(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(mapId));
  database.close();
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'mapId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('map_draft_database_failed'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('map_draft_request_failed'));
  });
}
