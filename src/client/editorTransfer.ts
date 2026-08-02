import type { EditableMap } from '../shared/map';
import type { RenderScheme } from '../shared/renderScheme';
import {
  encodeMapTransfer,
  encodeRenderSchemeTransfer,
  encodeScenePackage,
  renderSchemeHdriFile
} from '../shared/scenePackage';

export type EditorExportKind = 'map' | 'render-scheme' | 'scene';

export interface ImportTransferResult {
  kind: EditorExportKind;
  map?: EditableMap;
  renderScheme?: RenderScheme;
  hdriImported?: string | null;
}

export async function exportWorldForge(
  kind: EditorExportKind,
  map: EditableMap,
  renderScheme: RenderScheme | null,
  options: {
    hdriUrl: (file: string) => string;
    download?: (file: string, bytes: Uint8Array, mime: string) => void;
  }
): Promise<string> {
  const download = options.download ?? downloadBytes;
  const stem = safeFileStem(map.name);
  if (kind === 'map') {
    const file = `${stem}.worldforge-map.json`;
    download(file, encodeMapTransfer(map), 'application/json');
    return file;
  }
  if (!renderScheme) throw new Error('export_requires_render_scheme');
  if (kind === 'render-scheme') {
    const file = `${safeFileStem(renderScheme.name)}.worldforge-render.json`;
    download(file, encodeRenderSchemeTransfer(renderScheme), 'application/json');
    return file;
  }
  if (!map.confirmedAt) throw new Error('export_scene_requires_confirmed_map');
  const hdriFile = renderSchemeHdriFile(renderScheme);
  const hdri = hdriFile
    ? { file: hdriFile, bytes: await fetchBytes(options.hdriUrl(hdriFile)) }
    : undefined;
  const file = `${stem}.worldforge-scene.zip`;
  download(file, encodeScenePackage({ map, renderScheme, hdri }), 'application/zip');
  return file;
}

export async function importWorldForgeFile(file: File, endpoint: string): Promise<ImportTransferResult> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': file.name.toLowerCase().endsWith('.zip') ? 'application/zip' : 'application/json' },
    body: file
  });
  const result = await response.json().catch(() => ({})) as ImportTransferResult & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

function downloadBytes(file: string, bytes: Uint8Array, mime: string): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file;
  anchor.click();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`export_hdri_failed:${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function safeFileStem(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-').replace(/[. ]+$/g, '');
  return cleaned.slice(0, 80) || 'worldforge';
}
