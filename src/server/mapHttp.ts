import type http from 'node:http';
import {
  createPaintStroke,
  surfaceUvFromPoint,
  type EditableMap,
  type MapPaintStroke,
  type MapSurface,
  type TerrainBrushMode
} from '../shared/map';
import { CHAT_PROVIDER_OPTIONS, type ChatProvider, type Vec3 } from '../shared/protocol';
import type { MapTransactionRequest, MapTransactionSource } from '../shared/mapOperations';
import type { RenderScheme } from '../shared/renderScheme';
import { runMapAgent } from './mapAi';
import { generateModel } from './modelApi';
import { generateRenderSuggestion } from './renderAi';
import { MapStore, mapEditorCliManifest } from './mapStore';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

export async function handleMapHttp(req: Req, res: Res, store: MapStore): Promise<boolean> {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (parts[0] === 'api' && parts[1] === 'maps') {
      await handlePublicMapRoute(req, res, store, parts);
      return true;
    }

    if (parts[0] === 'api' && parts[1] === 'editor') {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'editor_api_local_only' });
        return true;
      }
      await handleEditorRoute(req, res, store, parts);
      return true;
    }

    if (parts[0] === 'editor') {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'editor_local_only' });
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        app: 'worldforge-studio',
        note: '在浏览器根路径打开 WorldForge Studio。服务端编辑 API 位于 /api/editor。'
      });
      return true;
    }
  } catch (error) {
    sendJson(res, error instanceof HttpError ? error.status : 500, {
      error: error instanceof Error ? error.message : String(error)
    });
    return true;
  }

  return false;
}

async function handlePublicMapRoute(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, { maps: await store.listMapSummaries() });
    return;
  }
  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, { map: await store.loadMap(parts[2]) });
    return;
  }
  throw new HttpError(404, 'not_found');
}

async function handleEditorRoute(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, { ok: true, commands: mapEditorCliManifest() });
    return;
  }

  if (parts[2] === 'manifest' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, commands: mapEditorCliManifest() });
    return;
  }

  if (parts[2] === 'maps') {
    await handleEditorMaps(req, res, store, parts);
    return;
  }

  if (parts[2] === 'assets') {
    await handleEditorAssets(req, res, store, parts);
    return;
  }

  if (parts[2] === 'render-schemes') {
    await handleEditorRenderSchemes(req, res, store, parts);
    return;
  }

  throw new HttpError(404, 'not_found');
}

async function handleEditorMaps(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, { maps: await store.listMapSummaries() });
    return;
  }
  if (req.method === 'POST' && parts.length === 3) {
    const body = await readJson<{ name?: string; size?: Vec3 }>(req);
    sendJson(res, 201, { map: await store.createMap(body) });
    return;
  }

  const mapId = parts[3];
  if (!mapId) throw new HttpError(404, 'not_found');

  if (req.method === 'GET' && parts.length === 4) {
    sendJson(res, 200, { map: await store.loadMap(mapId) });
    return;
  }
  if (req.method === 'PUT' && parts.length === 4) {
    const body = await readJson<{ map?: EditableMap }>(req);
    if (!body.map) throw new HttpError(400, 'missing_map');
    sendJson(res, 200, { map: await store.replaceMap(mapId, body.map) });
    return;
  }
  if (req.method === 'DELETE' && parts.length === 4) {
    await store.deleteMap(mapId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (parts[4] === 'generate' && req.method === 'POST' && parts.length === 5) {
    const body = await readJson<{ prompt?: string; provider?: ChatProvider }>(req);
    const prompt = body.prompt?.trim();
    if (!prompt) throw new HttpError(400, 'missing_prompt');
    const provider = body.provider ?? 'gpt';
    const option = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
    if (!option || option.disabled) throw new HttpError(400, 'provider_unavailable');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortIfOpen = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', abortIfOpen);
    try {
      const [map, assets] = await Promise.all([store.loadMap(mapId), store.listAssets()]);
      const modelProvider = provider === 'deepseek-v4-pro' ? 'deepseek' : provider;
      sendJson(res, 200, {
        suggestion: await runMapAgent(prompt, map, assets, {
          provider,
          signal: controller.signal,
          createAsset: async (request) => {
            const modelJson = await generateModel(request.prompt, {
              mode: 'voxel',
              providers: [modelProvider],
              signal: controller.signal
            });
            return store.saveAsset({
              name: request.name,
              prompt: request.prompt,
              modelJson,
              mode: 'voxel',
              provider: modelProvider
            });
          }
        })
      });
    } finally {
      req.off('aborted', abort);
      res.off('close', abortIfOpen);
    }
    return;
  }

  if (parts[4] === 'transactions') {
    if (req.method === 'GET' && parts.length === 5) {
      sendJson(res, 200, { transaction: await store.getUndoTransaction(mapId) });
      return;
    }
    if (req.method === 'POST' && parts.length === 5) {
      const body = await readJson<Partial<MapTransactionRequest>>(req);
      if (!isTransactionSource(body.source)) throw new HttpError(400, 'invalid_transaction_source');
      if (!Array.isArray(body.operations)) throw new HttpError(400, 'invalid_operations');
      try {
        sendJson(res, 200, await store.commitTransaction(mapId, {
          label: body.label,
          source: body.source,
          operations: body.operations
        }));
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'invalid_transaction');
      }
      return;
    }
    if (req.method === 'POST' && parts[5] === 'undo' && parts.length === 6) {
      try {
        sendJson(res, 200, await store.undoTransaction(mapId));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'undo_failed';
        throw new HttpError(message === 'nothing_to_undo' ? 409 : 500, message);
      }
      return;
    }
  }

  if (parts[4] === 'box' && req.method === 'PATCH') {
    const body = await readJson<{ size?: Vec3; colors?: Record<string, string> }>(req);
    sendJson(res, 200, { map: await store.updateMapBox(mapId, body) });
    return;
  }

  if (parts[4] === 'objects') {
    await handleEditorObjects(req, res, store, parts, mapId);
    return;
  }

  if (parts[4] === 'paint' && req.method === 'POST') {
    const map = await store.loadMap(mapId);
    const body = await readJson<Partial<MapPaintStroke> & { surface: MapSurface; point: Vec3 }>(req);
    const stroke = createPaintStroke({
      ...body,
      uv: body.uv ?? surfaceUvFromPoint(map, body.surface, body.point)
    });
    sendJson(res, 200, { map: await store.addPaint(mapId, stroke) });
    return;
  }

  if (parts[4] === 'terrain' && req.method === 'POST') {
    const body = await readJson<{ mode: TerrainBrushMode; point: Vec3; size?: number; strength?: number; targetHeight?: number }>(req);
    sendJson(res, 200, {
      map: await store.applyTerrain(mapId, body.mode, body.point, body.size ?? 1.5, body.strength ?? 0.3, body.targetHeight)
    });
    return;
  }

  if (parts[4] === 'spawn' && (req.method === 'POST' || req.method === 'PATCH')) {
    const body = await readJson<{ point?: Vec3 }>(req);
    sendJson(res, 200, { map: await store.setSpawnPoint(mapId, body.point ?? [0, 0, 0]) });
    return;
  }

  if (parts[4] === 'sun' && (req.method === 'POST' || req.method === 'PATCH')) {
    const body = await readJson<{ point?: Vec3 }>(req);
    sendJson(res, 200, { map: await store.setSunPosition(mapId, body.point ?? [-18, 24, 14]) });
    return;
  }

  throw new HttpError(404, 'not_found');
}

async function handleEditorObjects(req: Req, res: Res, store: MapStore, parts: string[], mapId: string): Promise<void> {
  if (req.method === 'POST' && parts.length === 5) {
    sendJson(res, 201, { map: await store.addObject(mapId, await readJson(req)) });
    return;
  }

  const objectId = parts[5];
  if (!objectId) throw new HttpError(404, 'not_found');
  if (req.method === 'PATCH' && parts.length === 6) {
    sendJson(res, 200, { map: await store.patchObject(mapId, objectId, await readJson(req)) });
    return;
  }
  if (req.method === 'DELETE' && parts.length === 6) {
    sendJson(res, 200, { map: await store.deleteObject(mapId, objectId) });
    return;
  }
  throw new HttpError(404, 'not_found');
}

async function handleEditorAssets(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, { assets: await store.listAssets() });
    return;
  }
  if (req.method === 'POST' && parts[3] === 'generate') {
    const body = await readJson<{ prompt?: string; name?: string; mode?: 'standard' | 'lite' | 'voxel' | 'voxel-pro' | 'curve' | 'wire' }>(req);
    const prompt = body.prompt?.trim();
    if (!prompt) throw new HttpError(400, 'missing_prompt');
    const mode = body.mode ?? 'voxel';
    const modelJson = await generateModel(prompt, { mode });
    const asset = await store.saveAsset({ prompt, name: body.name, modelJson, mode });
    sendJson(res, 201, { asset });
    return;
  }

  const assetId = parts[3];
  if (!assetId) throw new HttpError(404, 'not_found');
  if (req.method === 'GET' && parts.length === 4) {
    sendJson(res, 200, { asset: await store.loadAsset(assetId) });
    return;
  }
  if (req.method === 'DELETE' && parts.length === 4) {
    await store.deleteAsset(assetId);
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new HttpError(404, 'not_found');
}

async function handleEditorRenderSchemes(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, { renderSchemes: await store.listRenderSchemes() });
    return;
  }
  if (req.method === 'POST' && parts.length === 3) {
    const body = await readJson<Partial<RenderScheme>>(req);
    sendJson(res, 201, { renderScheme: await store.saveRenderScheme(body) });
    return;
  }
  if (req.method === 'POST' && parts[3] === 'generate' && parts.length === 4) {
    const body = await readJson<{ prompt?: string; provider?: ChatProvider }>(req);
    const prompt = body.prompt?.trim();
    if (!prompt) throw new HttpError(400, 'missing_prompt');
    const provider = body.provider ?? 'gpt';
    const option = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
    if (!option || option.disabled) throw new HttpError(400, 'provider_unavailable');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortIfOpen = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', abortIfOpen);
    try {
      const suggestion = await generateRenderSuggestion(prompt, await store.listRenderSchemes(), {
        provider,
        signal: controller.signal
      });
      sendJson(res, 200, { suggestion });
    } finally {
      req.off('aborted', abort);
      res.off('close', abortIfOpen);
    }
    return;
  }

  const schemeId = parts[3];
  if (!schemeId) throw new HttpError(404, 'not_found');
  if (req.method === 'GET' && parts.length === 4) {
    sendJson(res, 200, { renderScheme: await store.loadRenderScheme(schemeId) });
    return;
  }
  if (req.method === 'DELETE' && parts.length === 4) {
    try {
      await store.deleteRenderScheme(schemeId);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'delete_failed';
      throw new HttpError(message === 'builtin_scheme_readonly' ? 409 : 500, message);
    }
    return;
  }
  throw new HttpError(404, 'not_found');
}

function isTransactionSource(value: unknown): value is MapTransactionSource {
  return value === 'basic-ai' || value === 'agent';
}

async function readJson<T>(req: Req): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function sendJson(res: Res, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function setCorsHeaders(res: Res): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isLoopbackRequest(req: Req): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address === '';
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
