import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { hdriExtensionOf } from './hdri';
import { normalizeMap, type EditableMap } from './map';
import { normalizeRenderScheme, type RenderScheme } from './renderScheme';

export const WORLD_FORGE_TRANSFER_VERSION = 1;

export type WorldForgeTransfer =
  | { kind: 'map'; map: EditableMap }
  | { kind: 'render-scheme'; renderScheme: RenderScheme }
  | {
      kind: 'scene';
      map: EditableMap;
      renderScheme: RenderScheme;
      hdri?: { file: string; bytes: Uint8Array };
    };

interface ScenePackageManifest {
  schemaVersion: 1;
  kind: 'worldforge-scene';
  createdAt: string;
  files: {
    map: 'map.json';
    renderScheme: 'render-scheme.json';
    hdri?: string;
  };
}

export function encodeMapTransfer(map: EditableMap): Uint8Array {
  return jsonBytes({
    schemaVersion: WORLD_FORGE_TRANSFER_VERSION,
    kind: 'worldforge-map',
    map: normalizeMap(map)
  });
}

export function encodeRenderSchemeTransfer(renderScheme: RenderScheme): Uint8Array {
  return jsonBytes({
    schemaVersion: WORLD_FORGE_TRANSFER_VERSION,
    kind: 'worldforge-render-scheme',
    renderScheme: normalizeRenderScheme(renderScheme)
  });
}

export function encodeScenePackage(input: {
  map: EditableMap;
  renderScheme: RenderScheme;
  hdri?: { file: string; bytes: Uint8Array };
}): Uint8Array {
  const hdriFile = input.hdri ? safeHdriFile(input.hdri.file) : null;
  const manifest: ScenePackageManifest = {
    schemaVersion: WORLD_FORGE_TRANSFER_VERSION,
    kind: 'worldforge-scene',
    createdAt: new Date().toISOString(),
    files: {
      map: 'map.json',
      renderScheme: 'render-scheme.json',
      ...(hdriFile ? { hdri: `hdri/${hdriFile}` } : {})
    }
  };
  const files: Record<string, Uint8Array> = {
    'manifest.json': jsonBytes(manifest),
    'map.json': jsonBytes(normalizeMap(input.map)),
    'render-scheme.json': jsonBytes(normalizeRenderScheme(input.renderScheme)),
    'README.txt': strToU8('WorldForge Studio scene package\nImport this ZIP from the editor Export menu.\n')
  };
  if (hdriFile && input.hdri) files[`hdri/${hdriFile}`] = input.hdri.bytes;
  return zipSync(files, { level: 0 });
}

export function decodeWorldForgeTransfer(bytes: Uint8Array): WorldForgeTransfer {
  if (isZip(bytes)) return decodeScenePackage(bytes);
  const input = parseJson(bytes) as Record<string, unknown>;
  if (input.schemaVersion !== WORLD_FORGE_TRANSFER_VERSION) throw new Error('unsupported_transfer_version');
  if (input.kind === 'worldforge-map' && input.map && typeof input.map === 'object') {
    return { kind: 'map', map: normalizeMap(input.map as Partial<EditableMap>) };
  }
  if (input.kind === 'worldforge-render-scheme' && input.renderScheme && typeof input.renderScheme === 'object') {
    return {
      kind: 'render-scheme',
      renderScheme: normalizeRenderScheme(input.renderScheme as Partial<RenderScheme>)
    };
  }
  throw new Error('invalid_worldforge_transfer');
}

export function renderSchemeHdriFile(renderScheme: RenderScheme): string | null {
  const module = renderScheme.renderPlan?.modules.find((entry) => entry.id === 'environment.hdri');
  const texture = module?.params && typeof module.params.texture === 'string'
    ? module.params.texture.trim()
    : '';
  return safeHdriFileOrNull(texture);
}

export function replaceRenderSchemeHdriFile(renderScheme: RenderScheme, file: string): RenderScheme {
  const next = structuredClone(renderScheme);
  const module = next.renderPlan?.modules.find((entry) => entry.id === 'environment.hdri');
  if (module) module.params.texture = safeHdriFile(file);
  return normalizeRenderScheme(next);
}

function decodeScenePackage(bytes: Uint8Array): WorldForgeTransfer {
  const files = unzipSync(bytes);
  const manifest = parseEntry<ScenePackageManifest>(files, 'manifest.json');
  if (manifest.schemaVersion !== WORLD_FORGE_TRANSFER_VERSION || manifest.kind !== 'worldforge-scene') {
    throw new Error('invalid_scene_package_manifest');
  }
  const map = normalizeMap(parseEntry<Partial<EditableMap>>(files, manifest.files.map));
  const renderScheme = normalizeRenderScheme(
    parseEntry<Partial<RenderScheme>>(files, manifest.files.renderScheme)
  );
  const hdriPath = manifest.files.hdri;
  const hdriBytes = hdriPath ? files[hdriPath] : undefined;
  const hdriFile = hdriPath?.startsWith('hdri/')
    ? hdriPath.slice('hdri/'.length)
    : '';
  if (hdriPath && (!hdriBytes || !safeHdriFileOrNull(hdriFile))) {
    throw new Error('invalid_scene_package_hdri');
  }
  return {
    kind: 'scene',
    map,
    renderScheme,
    ...(hdriPath && hdriBytes ? {
      hdri: { file: safeHdriFile(hdriFile), bytes: hdriBytes }
    } : {})
  };
}

function parseEntry<T>(files: Record<string, Uint8Array>, file: string): T {
  const bytes = files[file];
  if (!bytes) throw new Error(`scene_package_missing:${file}`);
  return parseJson(bytes) as T;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    throw new Error('invalid_worldforge_json');
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function safeHdriFile(file: string): string {
  const normalized = file.replaceAll('\\', '/').split('/').pop()?.trim() ?? '';
  if (!safeHdriFileOrNull(normalized)) throw new Error('invalid_hdri_file');
  return normalized;
}

function safeHdriFileOrNull(file: string): string | null {
  const normalized = file.replaceAll('\\', '/').split('/').pop()?.trim() ?? '';
  if (!normalized || !/^[^<>:"|?*]+$/.test(normalized) || !hdriExtensionOf(normalized)) return null;
  return normalized;
}
