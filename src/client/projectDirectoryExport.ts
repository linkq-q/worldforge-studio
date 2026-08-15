import { unzipSync } from 'fflate';

export interface BrowserProjectExportFile {
  path: string;
  bytes: Uint8Array;
}

export interface BrowserProjectExportPreview {
  conflicts: Array<{ path: string; bytes: number }>;
  newFiles: number;
  unchangedFiles: number;
  totalFiles: number;
}

const DB_NAME = 'worldforge-project-export';
const STORE_NAME = 'directory-handles';

export async function pickBrowserProjectDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as Window & {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) throw new Error('browser_directory_picker_unsupported');
  return picker.call(window, { mode: 'readwrite' });
}

export async function saveBrowserProjectDirectory(profileId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const database = await openDatabase();
  await requestResult(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(handle, profileId));
  database.close();
}

export async function loadBrowserProjectDirectory(profileId: string): Promise<FileSystemDirectoryHandle | null> {
  const database = await openDatabase();
  const handle = await requestResult<FileSystemDirectoryHandle | undefined>(
    database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(profileId)
  );
  database.close();
  if (!handle || !await ensureReadWritePermission(handle)) return null;
  return handle;
}

export function decodeProjectExportBundle(bytes: Uint8Array): BrowserProjectExportFile[] {
  return Object.entries(unzipSync(bytes))
    .filter(([file]) => !file.endsWith('/'))
    .map(([file, contents]) => ({ path: safeBundlePath(file), bytes: contents }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function inspectBrowserProjectExport(
  root: FileSystemDirectoryHandle,
  files: readonly BrowserProjectExportFile[]
): Promise<BrowserProjectExportPreview> {
  let newFiles = 0;
  let unchangedFiles = 0;
  const conflicts: BrowserProjectExportPreview['conflicts'] = [];
  for (const file of files) {
    const existing = await readBrowserFile(root, file.path);
    if (!existing) newFiles += 1;
    else if (equalBytes(existing, file.bytes)) unchangedFiles += 1;
    else conflicts.push({ path: file.path, bytes: file.bytes.byteLength });
  }
  return { conflicts, newFiles, unchangedFiles, totalFiles: files.length };
}

export async function writeBrowserProjectExport(
  root: FileSystemDirectoryHandle,
  files: readonly BrowserProjectExportFile[],
  overwritePaths: readonly string[]
): Promise<{ written: number; unchanged: number; conflictsSkipped: number }> {
  const overwrite = new Set(overwritePaths);
  let written = 0;
  let unchanged = 0;
  let conflictsSkipped = 0;
  for (const file of files) {
    const existing = await readBrowserFile(root, file.path);
    if (existing && equalBytes(existing, file.bytes)) {
      unchanged += 1;
      continue;
    }
    if (existing && !overwrite.has(file.path)) {
      conflictsSkipped += 1;
      continue;
    }
    await writeBrowserFile(root, file);
    written += 1;
  }
  return { written, unchanged, conflictsSkipped };
}

async function readBrowserFile(root: FileSystemDirectoryHandle, relativePath: string): Promise<Uint8Array | null> {
  try {
    const { directory, fileName } = await resolveBrowserParent(root, relativePath, false);
    const handle = await directory.getFileHandle(fileName);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function writeBrowserFile(root: FileSystemDirectoryHandle, file: BrowserProjectExportFile): Promise<void> {
  const { directory, fileName } = await resolveBrowserParent(root, file.path, true);
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([copyBuffer(file.bytes)]));
  } finally {
    await writable.close();
  }
}

async function resolveBrowserParent(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  create: boolean
): Promise<{ directory: FileSystemDirectoryHandle; fileName: string }> {
  const parts = safeBundlePath(relativePath).split('/');
  const fileName = parts.pop()!;
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return { directory, fileName };
}

async function ensureReadWritePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const permissionHandle = handle as FileSystemDirectoryHandle & {
    queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
    requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  };
  if (await permissionHandle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
  return await permissionHandle.requestPermission({ mode: 'readwrite' }) === 'granted';
}

function safeBundlePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('invalid_project_export_bundle_path');
  }
  return normalized;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
