import { normalizeMap, type EditableMap } from '../shared/map';
import type { CodePlanPreviewPayload, MapAiSuggestion } from '../shared/mapOperations';

export interface BrowserMapDraft {
  mapId: string;
  baseUpdatedAt: number;
  updatedAt: number;
  map: EditableMap;
}

export interface BrowserMapPlan {
  mapId: string;
  baseUpdatedAt: number;
  updatedAt: number;
  prompt: string;
  suggestion: MapAiSuggestion;
  preview: CodePlanPreviewPayload | null;
  options: {
    focusPrompt: string;
    minNewAssets: number;
    maxNewAssets: number;
    reuseExistingAssets: boolean;
    assetLibraryId: string;
    paletteId: string;
  };
}

const DB_NAME = 'worldforge-editor';
const STORE_NAME = 'map-drafts';
const PLAN_STORE_NAME = 'map-plans';

export function isBrowserMapPlanCurrent(map: EditableMap, plan: BrowserMapPlan): boolean {
  return map.id === plan.mapId && map.updatedAt === plan.baseUpdatedAt && Boolean(plan.suggestion.codePlan?.code);
}

export async function saveBrowserMapPlan(plan: BrowserMapPlan): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('此浏览器不支持本地规划保存');
  const database = await openDatabase();
  try {
    await requestResult(database.transaction(PLAN_STORE_NAME, 'readwrite').objectStore(PLAN_STORE_NAME).put(plan));
  } finally {
    database.close();
  }
}

export async function loadBrowserMapPlan(mapId: string): Promise<BrowserMapPlan | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await openDatabase();
  try {
    return await requestResult<BrowserMapPlan | undefined>(
      database.transaction(PLAN_STORE_NAME, 'readonly').objectStore(PLAN_STORE_NAME).get(mapId)
    ) ?? null;
  } finally {
    database.close();
  }
}

export async function deleteBrowserMapPlan(mapId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const database = await openDatabase();
  try {
    await requestResult(database.transaction(PLAN_STORE_NAME, 'readwrite').objectStore(PLAN_STORE_NAME).delete(mapId));
  } finally {
    database.close();
  }
}

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
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'mapId' });
      if (!request.result.objectStoreNames.contains(PLAN_STORE_NAME)) request.result.createObjectStore(PLAN_STORE_NAME, { keyPath: 'mapId' });
    };
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
