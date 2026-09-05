import { readFile } from 'node:fs/promises';
import type http from 'node:http';
import { hdriExtensionOf } from '../shared/hdri';
import {
  createPaintStroke,
  surfaceUvFromPoint,
  type EditableMap,
  type MapAsset,
  type MapPaintStroke,
  type MapSceneMode,
  type MapSurface,
  type TerrainBrushMode
} from '../shared/map';
import {
  CHAT_PROVIDER_OPTIONS,
  type AgentProgressEvent,
  type ChatProvider,
  type Vec3
} from '../shared/protocol';
import {
  applyMapOperations,
  type CodePlanAssetReadyPayload,
  type CodePlanPreviewPayload,
  type MapAiSuggestion,
  type MapOperation,
  type MapTransactionRequest,
  type MapTransactionSource
} from '../shared/mapOperations';
import type { RenderScheme } from '../shared/renderScheme';
import type { RenderPlan } from '../shared/renderPlan';
import { normalizeRenderSceneProfile } from '../shared/renderSceneProfile';
import { runMapAgent } from './mapAi';
import { replayGeneratedMapCode } from './mapCodePlanner';
import { reviewMapVisual } from './indoorVisualReview';
import { planMapComposition } from './mapCompositionWorkflow';
import { generateMapLayoutSuggestion } from './mapLayoutAi';
import { generateMapAssetWithRetry } from './mapAssetGenerationRetry';
import { generateModel, replayModel } from './modelApi';
import {
  normalizeModelGenerationMode,
  type ModelGenerationMode
} from '../shared/modelGenerationMode';
import { generateRenderSuggestion, refineRenderSuggestion } from './renderAi';
import { MapStore, mapEditorCliManifest } from './mapStore';
import { isCompositionEmptyMap, type SceneCompositionPlan } from '../shared/sceneComposition';
import type { AssetLibraryMetadata } from '../shared/assetLibrary';
import type { MapAssetLight } from '../shared/mapAssetMetadata';
import { analyzeAssetForLibrary, pendingAssetLibraryMetadata } from './assetLibraryAi';
import {
  decodeWorldForgeTransfer,
  renderSchemeHdriFile,
  replaceRenderSchemeHdriFile
} from '../shared/scenePackage';
import { retuneMapStitchSeam, stitchMaps, type MapStitchDirection, type MapStitchSeamPatch } from '../shared/mapStitch';
import {
  buildProjectExportPlan,
  encodeProjectExportPlan,
  inspectProjectExport,
  writeProjectExport,
  type ProjectExportPlan
} from './projectExport';
import type { ProjectExportProfile } from '../shared/projectExport';
import { applyPaletteToModelJson, type ColorPalette } from '../shared/colorPalette';
import { worldCapabilitySummary } from '../shared/worldCapabilities';
import { WorldAgentRunManager } from './worldAgentRuns';

type Req = http.IncomingMessage;
type Res = http.ServerResponse;

const worldAgentManagers = new WeakMap<MapStore, WorldAgentRunManager>();

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
    if (res.headersSent) {
      sendSse(res, 'error', { error: error instanceof Error ? error.message : String(error) });
      res.end();
      return true;
    }
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

  if (parts[2] === 'capabilities' && req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, { capabilities: worldCapabilitySummary() });
    return;
  }

  if (parts[2] === 'maps') {
    await handleEditorMaps(req, res, store, parts);
    return;
  }

  if (parts[2] === 'agent-runs') {
    await handleWorldAgentRuns(req, res, store, parts);
    return;
  }

  if (parts[2] === 'assets') {
    await handleEditorAssets(req, res, store, parts);
    return;
  }

  if (parts[2] === 'asset-libraries') {
    await handleEditorAssetLibraries(req, res, store, parts);
    return;
  }

  if (parts[2] === 'render-schemes') {
    await handleEditorRenderSchemes(req, res, store, parts);
    return;
  }

  if (parts[2] === 'color-palettes') {
    await handleEditorColorPalettes(req, res, store, parts);
    return;
  }

  if (parts[2] === 'hdri') {
    await handleEditorHdri(req, res, store, parts);
    return;
  }

  if (parts[2] === 'export-profiles') {
    await handleEditorExportProfiles(req, res, store, parts);
    return;
  }

  if (parts[2] === 'project-export') {
    await handleEditorProjectExport(req, res, store, parts);
    return;
  }

  if (parts[2] === 'import' && req.method === 'POST' && parts.length === 3) {
    await handleEditorImport(req, res, store);
    return;
  }

  throw new HttpError(404, 'not_found');
}

async function handleEditorImport(req: Req, res: Res, store: MapStore): Promise<void> {
  const transfer = decodeWorldForgeTransfer(new Uint8Array(await readBody(req, 512 * 1024 * 1024)));
  if (transfer.kind === 'render-scheme') {
    const renderScheme = await store.saveRenderScheme(transfer.renderScheme);
    sendJson(res, 201, { kind: transfer.kind, renderScheme });
    return;
  }
  if (transfer.kind === 'map') {
    const map = await store.importMap(transfer.map);
    sendJson(res, 201, { kind: transfer.kind, map });
    return;
  }

  let renderScheme = transfer.renderScheme;
  let hdriImported: string | null = null;
  if (transfer.hdri) {
    hdriImported = await store.importHdri(transfer.hdri.file, transfer.hdri.bytes);
    renderScheme = replaceRenderSchemeHdriFile(renderScheme, hdriImported);
  }
  const savedScheme = await store.saveRenderScheme(renderScheme);
  const map = await store.importMap(transfer.map, savedScheme.id);
  sendJson(res, 201, {
    kind: transfer.kind,
    map,
    renderScheme: savedScheme,
    hdriImported
  });
}

async function handleWorldAgentRuns(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  const runId = parts[3];
  if (!runId) throw new HttpError(404, 'not_found');
  const manager = worldAgentManager(store);
  try {
    if (req.method === 'GET' && parts.length === 4) {
      sendJson(res, 200, { run: manager.get(runId) });
      return;
    }
    if (req.method === 'DELETE' && parts.length === 4) {
      manager.cancel(runId);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && parts[4] === 'preview' && parts.length === 5) {
      sendJson(res, 200, manager.previewRun(runId));
      return;
    }
    if (req.method === 'POST' && parts[4] === 'tools' && parts.length === 6) {
      const body = await readJson<{ input?: unknown }>(req);
      sendJson(res, 200, manager.execute(runId, decodeURIComponent(parts[5]), body.input));
      return;
    }
    if (req.method === 'POST' && parts[4] === 'commit' && parts.length === 5) {
      const body = await readJson<{ approved?: boolean; label?: string }>(req);
      sendJson(res, 200, await manager.commit(runId, body.approved === true, body.label));
      return;
    }
  } catch (error) {
    throw worldAgentHttpError(error);
  }
  throw new HttpError(404, 'not_found');
}

function worldAgentManager(store: MapStore): WorldAgentRunManager {
  const existing = worldAgentManagers.get(store);
  if (existing) return existing;
  const manager = new WorldAgentRunManager(store);
  worldAgentManagers.set(store, manager);
  return manager;
}

function worldAgentHttpError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : 'world_agent_failed';
  if (message === 'unknown_world_agent_run' || message.startsWith('unknown_world_agent_asset:')) {
    return new HttpError(404, message);
  }
  if (message === 'world_agent_run_stale' || message === 'world_agent_tool_limit') {
    return new HttpError(409, message);
  }
  return new HttpError(400, message);
}

const HDRI_CONTENT_TYPES: Record<string, string> = {
  hdr: 'image/vnd.radiance',
  exr: 'image/x-exr',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png'
};

async function handleEditorHdri(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, { hdriTextures: await store.listHdriTextures() });
    return;
  }
  if (req.method === 'GET' && parts.length === 4) {
    const filePath = await store.resolveHdriFile(decodeURIComponent(parts[3]));
    if (!filePath) throw new HttpError(404, 'unknown_hdri_texture');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Cache-Control': 'public, max-age=3600',
      'Content-Length': body.byteLength,
      'Content-Type': HDRI_CONTENT_TYPES[hdriExtensionOf(filePath) ?? ''] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
    return;
  }
  if (req.method === 'PUT' && parts.length === 4) {
    const body = await readJson<{ timeOfDay?: string; temperature?: string }>(req);
    const hdriTexture = await store.updateHdriClassification(decodeURIComponent(parts[3]), body);
    sendJson(res, 200, { hdriTexture });
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
    const body = await readJson<{
      name?: string;
      size?: Vec3;
      sceneMode?: MapSceneMode;
      roomSize?: Vec3;
      assetGenerationMode?: ModelGenerationMode;
      playerHeight?: number;
      worldScaleProfile?: EditableMap['worldScaleProfile'];
    }>(req);
    sendJson(res, 201, { map: await store.createMap(body) });
    return;
  }

  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'trash') {
    sendJson(res, 200, { maps: await store.listDeletedMaps() });
    return;
  }
  if (req.method === 'POST' && parts.length === 6 && parts[3] === 'trash' && parts[5] === 'restore') {
    sendJson(res, 200, { map: await store.restoreDeletedMap(decodeURIComponent(parts[4])) });
    return;
  }

  const mapId = parts[3];
  if (!mapId) throw new HttpError(404, 'not_found');

  if (parts[4] === 'duplicate' && req.method === 'POST' && parts.length === 5) {
    const body = await readJson<{ name?: string }>(req);
    sendJson(res, 201, { map: await store.duplicateMap(mapId, body.name) });
    return;
  }

  if (parts[4] === 'agent-runs' && req.method === 'POST' && parts.length === 5) {
    const body = await readJson<{ assetIds?: string[] }>(req);
    try {
      const run = await worldAgentManager(store).create(mapId, Array.isArray(body.assetIds) ? body.assetIds : []);
      sendJson(res, 201, { run });
    } catch (error) {
      throw worldAgentHttpError(error);
    }
    return;
  }

  if (parts[4] === 'code-replay' && req.method === 'POST' && parts.length === 5) {
    const body = await readJson<{ token?: string }>(req);
    const token = body.token?.trim();
    if (!token) throw new HttpError(400, 'missing_map_code_replay_token');
    try {
      sendJson(res, 200, { suggestion: replayGeneratedMapCode(token, await store.loadMap(mapId)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'map_code_replay_failed';
      if (message === 'map_code_replay_expired') throw new HttpError(410, message);
      if (message === 'map_code_replay_stale') throw new HttpError(409, message);
      throw error;
    }
    return;
  }

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

  if (parts[4] === 'layout' && req.method === 'POST' && parts.length === 5) {
    const body = await readJson<{ prompt?: string; provider?: ChatProvider }>(req);
    const prompt = body.prompt?.trim();
    if (!prompt) throw new HttpError(400, 'missing_layout_prompt');
    const provider = body.provider ?? 'gpt';
    const option = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
    if (!option || option.disabled) throw new HttpError(400, 'provider_unavailable');
    const controller = new AbortController();
    const stream = acceptsEventStream(req);
    if (stream) beginSse(res);
    const onProgress = stream
      ? (event: AgentProgressEvent) => sendSse(res, 'progress', event)
      : undefined;
    const abort = () => controller.abort();
    const abortIfOpen = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', abortIfOpen);
    try {
      const suggestion = await generateMapLayoutSuggestion(prompt, await store.loadMap(mapId), {
        provider,
        signal: controller.signal,
        onProgress
      });
      if (stream) {
        sendSse(res, 'result', { suggestion });
        res.end();
      } else {
        sendJson(res, 200, { suggestion });
      }
    } finally {
      req.off('aborted', abort);
      res.off('close', abortIfOpen);
    }
    return;
  }

  if (parts[4] === 'stitch' && req.method === 'POST' && parts.length === 5) {
    const body = await readJson<{
      sourceMapId?: string;
      name?: string;
      direction?: MapStitchDirection;
      mode?: 'contact' | 'corridor';
      width?: number;
      irregularity?: number;
      seed?: number;
      prompt?: string;
    }>(req);
    if (!body.sourceMapId || body.sourceMapId === mapId) throw new HttpError(400, 'invalid_stitch_source');
    const [primary, secondary] = await Promise.all([store.loadMap(mapId), store.loadMap(body.sourceMapId)]);
    const primarySources = new Set([primary.id, ...primary.layout.stitchSources.map((source) => source.mapId)]);
    const secondarySources = new Set([secondary.id, ...secondary.layout.stitchSources.map((source) => source.mapId)]);
    if ([...primarySources].some((id) => secondarySources.has(id))) {
      throw new HttpError(409, 'duplicate_stitch_source');
    }
    const combined = stitchMaps(primary, secondary, body);
    let saved = await store.importMap(combined);
    saved = await store.replaceMap(saved.id, { ...saved, name: combined.name });
    sendJson(res, 201, { map: saved });
    return;
  }

  if (parts[4] === 'seams' && req.method === 'PATCH' && parts.length === 6) {
    const seamId = parts[5];
    const body = await readJson<MapStitchSeamPatch>(req);
    const map = await store.loadMap(mapId);
    const seam = map.layout.seams.find((item) => item.id === seamId);
    if (!seam) throw new HttpError(404, 'unknown_stitch_seam');
    const [firstSource, secondSource] = await Promise.all(seam.sourceMapIds.map((id) => store.loadMap(id)));
    const sourceVersions = new Map(map.layout.stitchSources.map((source) => [source.mapId, source.version]));
    if (sourceVersions.get(firstSource.id) !== firstSource.version
      || sourceVersions.get(secondSource.id) !== secondSource.version) {
      throw new HttpError(409, 'stitch_seam_source_changed');
    }
    const updated = retuneMapStitchSeam(map, firstSource, secondSource, seamId, body);
    sendJson(res, 200, { map: await store.replaceMap(mapId, updated) });
    return;
  }

  if (parts[4] === 'visual-review' && req.method === 'POST' && parts.length === 5) {
    const body = await readJson<{
      imageDataUrl?: string;
      provider?: ChatProvider;
      baseOperations?: MapOperation[];
    }>(req);
    const provider = body.provider ?? 'gpt';
    const option = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
    if (!option || option.disabled) throw new HttpError(400, 'provider_unavailable');
    if (!body.imageDataUrl) throw new HttpError(400, 'missing_map_review_image');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortIfOpen = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', abortIfOpen);
    try {
      const [map, assets] = await Promise.all([store.loadMap(mapId), store.listAssets()]);
      const mapWithAssets = { ...map, assets: dedupeAssets([...assets, ...(map.assets ?? [])]) };
      const planningMap = Array.isArray(body.baseOperations) && body.baseOperations.length > 0
        ? applyMapOperations(mapWithAssets, body.baseOperations)
        : mapWithAssets;
      const review = await reviewMapVisual(planningMap, body.imageDataUrl, {
        provider,
        signal: controller.signal
      });
      sendJson(res, 200, { review });
    } finally {
      req.off('aborted', abort);
      res.off('close', abortIfOpen);
    }
    return;
  }

  if ((parts[4] === 'generate' || parts[4] === 'refine') && req.method === 'POST' && parts.length === 5) {
    const body = await readJson<{
      prompt?: string;
      provider?: ChatProvider;
      baseOperations?: MapOperation[];
      reuseExistingAssets?: boolean;
      assetLibraryId?: string;
      minNewAssets?: number;
      maxNewAssets?: number;
      targetVisualZoneId?: string;
      targetRegionId?: string;
      baseTerrainOnly?: boolean;
      planOnly?: boolean;
      approvedCompositionPlan?: SceneCompositionPlan;
      approvedCode?: string;
      sceneAgent?: boolean;
      focusPrompt?: string;
      paletteId?: string;
      selectedObjectIds?: string[];
    }>(req);
    const prompt = body.prompt?.trim();
    if (!prompt) throw new HttpError(400, 'missing_prompt');
    const provider = body.provider ?? 'gpt';
    const option = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
    if (!option || option.disabled) throw new HttpError(400, 'provider_unavailable');
    const controller = new AbortController();
    const stream = acceptsEventStream(req);
    if (stream) beginSse(res);
    const onProgress = stream
      ? (event: AgentProgressEvent) => sendSse(res, 'progress', event)
      : undefined;
    const onPreview = stream
      ? (suggestion: MapAiSuggestion) => sendSse(res, 'preview', { suggestion })
      : undefined;
    const onPlanPreview = stream
      ? (plan: CodePlanPreviewPayload) => sendSse(res, 'plan', plan)
      : undefined;
    const onAssetReady = stream
      ? (event: CodePlanAssetReadyPayload) => sendSse(res, 'asset-ready', event)
      : undefined;
    const abort = () => controller.abort();
    const abortIfOpen = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', abortIfOpen);
    try {
      const [map, assets, libraryAssets, colorPalette] = await Promise.all([
        store.loadMap(mapId),
        store.listAssets(),
        body.reuseExistingAssets === true && body.assetLibraryId
          ? store.listAssetLibraryAssets(body.assetLibraryId)
          : Promise.resolve([]),
        body.paletteId ? store.loadColorPalette(body.paletteId) : Promise.resolve(null)
      ]);
      const directedPrompt = prompt;
      if (parts[4] === 'generate' && !isCompositionEmptyMap(map)) {
        throw new HttpError(409, 'map_composition_requires_empty_map');
      }
      const baseOperations = parts[4] === 'refine' && Array.isArray(body.baseOperations)
        ? body.baseOperations
        : [];
      const planningMap = baseOperations.length > 0
        ? applyMapOperations(map, baseOperations)
        : map;
      const refinableObjectIds = baseOperations.flatMap((operation) => (
        operation.type === 'object.add' && operation.object.id ? [operation.object.id] : []
      ));
      const modelProvider = provider === 'deepseek-v4-pro' ? 'deepseek' : provider;
      const planningAssets = dedupeAssets([
        ...assets,
        ...(planningMap.assets ?? []),
        ...libraryAssets
      ]);
      if (body.planOnly === true) {
        if (parts[4] !== 'generate' || planningMap.sceneMode === 'mixed') {
          throw new HttpError(400, 'composition_plan_preview_unavailable');
        }
        if (planningMap.sceneMode === 'indoor') {
          const suggestion = await runMapAgent(directedPrompt, planningMap, planningAssets, {
            provider,
            signal: controller.signal,
            mode: 'generate',
            reuseExistingAssets: body.reuseExistingAssets === true,
            reusableAssetIds: libraryAssets.map((asset) => asset.id),
            minNewAssets: body.minNewAssets,
            maxNewAssets: body.maxNewAssets,
            focusPrompt: body.focusPrompt,
            discoveryOnly: true,
            onProgress,
            onPlanPreview,
            onAssetReady,
            createAsset: async () => { throw new Error('discovery_only_asset_generation'); }
          });
          if (stream) {
            sendSse(res, 'result', { suggestion });
            res.end();
          } else {
            sendJson(res, 200, { suggestion });
          }
          return;
        }
        const plan = await planMapComposition(directedPrompt, planningMap, planningAssets, {
          provider,
          signal: controller.signal,
          reuseExistingAssets: body.reuseExistingAssets === true,
          reusableAssetIds: libraryAssets.map((asset) => asset.id),
          minNewAssets: body.minNewAssets,
          maxNewAssets: body.maxNewAssets,
          onProgress
        });
        if (stream) {
          sendSse(res, 'result', { plan });
          res.end();
        } else {
          sendJson(res, 200, { plan });
        }
        return;
      }
      const seededModelSources = new Map<string, Promise<unknown>>();
      const suggestion = await runMapAgent(directedPrompt, planningMap, planningAssets, {
          provider,
          signal: controller.signal,
          mode: parts[4] === 'refine' ? 'refine' : 'generate',
          reuseExistingAssets: body.reuseExistingAssets === true,
          reusableAssetIds: libraryAssets.map((asset) => asset.id),
          minNewAssets: body.baseTerrainOnly ? 0 : body.minNewAssets,
          maxNewAssets: body.baseTerrainOnly ? 0 : body.maxNewAssets,
          targetVisualZoneId: parts[4] === 'refine' ? body.targetVisualZoneId : undefined,
          targetRegionId: parts[4] === 'refine' ? body.targetRegionId : undefined,
          baseTerrainOnly: parts[4] === 'refine' && body.baseTerrainOnly === true,
          approvedCompositionPlan: body.approvedCompositionPlan,
          approvedCode: body.approvedCode,
          sceneAgent: body.sceneAgent === true,
          focusPrompt: body.focusPrompt,
          refinableObjectIds,
          selectedObjectIds: Array.isArray(body.selectedObjectIds)
            ? body.selectedObjectIds.filter((id): id is string => typeof id === 'string').slice(0, 64)
            : [],
          onProgress,
          onPreview,
          onPlanPreview,
          onAssetReady,
          createAsset: async (request, report) => {
            const generationPrompt = request.prompt;
            const retryOptions = {
              attempts: 3,
              signal: controller.signal,
              onProgress: (event: AgentProgressEvent) => report({
                status: event.phase === 'asset-retrying' ? 'retrying' as const : 'running' as const,
                detail: event.detail ?? event.label
              })
            };
            const variantIndex = request.variantIndex ?? 0;
            const seededFamily = request.seedFamilyKey && (request.variantCount ?? 0) > 1;
            let generatedModelJson: unknown;
            if (seededFamily) {
              let source = seededModelSources.get(request.seedFamilyKey!);
              if (!source) {
                source = generateMapAssetWithRetry(request.name, () => generateModel(generationPrompt, {
                  mode: request.mode,
                  providers: [modelProvider],
                  seeded: true,
                  seed: mapAssetVariantSeed(planningMap.seed, request.seedFamilyKey!, 0),
                  signal: controller.signal,
                  onStage: (stage) => report({ status: 'running', detail: stage.stage })
                }), retryOptions);
                seededModelSources.set(request.seedFamilyKey!, source);
              }
              generatedModelJson = variantIndex === 0
                ? await source
                : await generateMapAssetWithRetry(
                    request.name,
                    async () => replayModel(
                      await source,
                      mapAssetVariantSeed(planningMap.seed, request.seedFamilyKey!, variantIndex),
                      { signal: controller.signal }
                    ),
                    retryOptions
                  );
            } else {
              generatedModelJson = await generateMapAssetWithRetry(request.name, () => generateModel(generationPrompt, {
                mode: request.mode,
                providers: [modelProvider],
                signal: controller.signal,
                onStage: (stage) => report({ status: 'running', detail: stage.stage })
              }), retryOptions);
            }
            const modelJson = colorPalette
              ? applyPaletteToModelJson(generatedModelJson, colorPalette)
              : generatedModelJson;
            return store.saveAsset({
              name: request.name,
              prompt: request.prompt,
              tags: request.tags,
              light: request.light,
              modelJson,
              mode: request.mode,
              provider: modelProvider
            });
          }
        });
      if (stream) {
        sendSse(res, 'result', { suggestion });
        res.end();
      } else {
        sendJson(res, 200, { suggestion });
      }
    } finally {
      req.off('aborted', abort);
      res.off('close', abortIfOpen);
    }
    return;
  }

  if (parts[4] === 'transactions') {
    if (req.method === 'GET' && parts.length === 5) {
      const [transaction, redoTransaction] = await Promise.all([
        store.getUndoTransaction(mapId),
        store.getRedoTransaction(mapId)
      ]);
      sendJson(res, 200, { transaction, redoTransaction });
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
    if (req.method === 'POST' && parts[5] === 'redo' && parts.length === 6) {
      try {
        sendJson(res, 200, await store.redoTransaction(mapId));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'redo_failed';
        throw new HttpError(message === 'nothing_to_redo' ? 409 : 500, message);
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
    const body = await readJson<{
      prompt?: string;
      name?: string;
      tags?: string[];
      light?: MapAssetLight;
      mode?: ModelGenerationMode;
      paletteId?: string;
    }>(req);
    const prompt = body.prompt?.trim();
    if (!prompt) throw new HttpError(400, 'missing_prompt');
    const mode = normalizeModelGenerationMode(body.mode);
    const colorPalette = body.paletteId ? await store.loadColorPalette(body.paletteId) : null;
    const generatedModelJson = await generateModel(prompt, { mode });
    const modelJson = colorPalette
      ? applyPaletteToModelJson(generatedModelJson, colorPalette)
      : generatedModelJson;
    const asset = await store.saveAsset({ prompt, name: body.name, tags: body.tags, light: body.light, modelJson, mode });
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

async function handleEditorExportProfiles(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, { profiles: await store.listProjectExportProfiles() });
    return;
  }
  if (req.method === 'POST' && parts.length === 3) {
    const profile = await store.saveProjectExportProfile(await readJson<Partial<ProjectExportProfile>>(req));
    sendJson(res, 201, { profile });
    return;
  }
  if (req.method === 'DELETE' && parts.length === 4) {
    await store.deleteProjectExportProfile(parts[3]);
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new HttpError(404, 'not_found');
}

async function handleEditorProjectExport(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  if (req.method !== 'POST' || parts.length !== 4) throw new HttpError(404, 'not_found');
  const body = await readJson<{
    mapId?: string;
    profileId?: string;
    mapFolder?: string;
    renderSchemeId?: string;
    overwritePaths?: string[];
  }>(req);
  const { profile, plan } = await prepareProjectExport(store, body);
  if (parts[3] === 'bundle') {
    sendBytes(res, 200, encodeProjectExportPlan(plan), 'application/zip', `${plan.mapFolder}.worldforge-project.zip`);
    return;
  }
  if (profile.mode !== 'server') throw new HttpError(400, 'project_export_profile_requires_server_mode');
  if (parts[3] === 'preview') {
    sendJson(res, 200, {
      profile,
      mapFolder: plan.mapFolder,
      manifest: plan.manifest,
      preview: await inspectProjectExport(profile.projectDirectory, plan)
    });
    return;
  }
  if (parts[3] === 'write') {
    const overwritePaths = Array.isArray(body.overwritePaths)
      ? body.overwritePaths.filter((value): value is string => typeof value === 'string')
      : [];
    const result = await writeProjectExport(profile.projectDirectory, plan, overwritePaths);
    sendJson(res, 200, { profile, mapFolder: plan.mapFolder, manifest: plan.manifest, result });
    return;
  }
  throw new HttpError(404, 'not_found');
}

async function prepareProjectExport(
  store: MapStore,
  input: { mapId?: string; profileId?: string; mapFolder?: string; renderSchemeId?: string }
): Promise<{ profile: ProjectExportProfile; plan: ProjectExportPlan }> {
  if (!input.mapId || !input.profileId) throw new HttpError(400, 'project_export_map_and_profile_required');
  const profile = (await store.listProjectExportProfiles()).find((item) => item.id === input.profileId);
  if (!profile) throw new HttpError(404, 'unknown_project_export_profile');
  const map = await store.loadMap(input.mapId);
  const schemes = await store.listRenderSchemes();
  const renderSchemeId = input.renderSchemeId || map.renderSchemeId || schemes[0]?.id;
  if (!renderSchemeId) throw new HttpError(400, 'project_export_requires_render_scheme');
  const renderScheme = await store.loadRenderScheme(renderSchemeId);
  const hdriFile = renderSchemeHdriFile(renderScheme);
  const hdriPath = hdriFile ? await store.resolveHdriFile(hdriFile) : null;
  if (hdriFile && !hdriPath) throw new HttpError(409, 'project_export_hdri_missing');
  const hdri = hdriFile && hdriPath
    ? { file: hdriFile, bytes: new Uint8Array(await readFile(hdriPath)) }
    : undefined;
  return {
    profile,
    plan: buildProjectExportPlan({ map, renderScheme, profile, mapFolder: input.mapFolder, hdri })
  };
}

async function handleEditorAssetLibraries(
  req: Req,
  res: Res,
  store: MapStore,
  parts: string[]
): Promise<void> {
  if (parts.length === 3 && req.method === 'GET') {
    sendJson(res, 200, { libraries: await store.listAssetLibraries() });
    return;
  }
  if (parts.length === 3 && req.method === 'POST') {
    const body = await readJson<{ name?: string; description?: string }>(req);
    sendJson(res, 201, { library: await store.createAssetLibrary(body) });
    return;
  }
  if (parts[3] === 'import' && parts.length === 4 && req.method === 'POST') {
    sendJson(res, 201, await store.importAssetLibrary(await readJson(req, 512 * 1024 * 1024)));
    return;
  }

  const libraryId = parts[3];
  if (!libraryId) throw new HttpError(404, 'not_found');
  if (parts.length === 4 && req.method === 'GET') {
    sendJson(res, 200, {
      library: await store.loadAssetLibrary(libraryId),
      assets: await store.listAssetLibraryAssets(libraryId)
    });
    return;
  }
  if (parts.length === 4 && req.method === 'PATCH') {
    const body = await readJson<{ name?: string; description?: string }>(req);
    sendJson(res, 200, { library: await store.updateAssetLibrary(libraryId, body) });
    return;
  }
  if (parts.length === 4 && req.method === 'DELETE') {
    await store.deleteAssetLibrary(libraryId);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (parts[4] === 'export' && parts.length === 5 && req.method === 'GET') {
    sendJson(res, 200, await store.exportAssetLibrary(libraryId));
    return;
  }
  if (parts[4] === 'assets' && parts.length === 5 && req.method === 'POST') {
    const body = await readJson<{ assetId?: string; provider?: ChatProvider }>(req);
    if (!body.assetId) throw new HttpError(400, 'missing_asset_id');
    const source = await store.loadAsset(body.assetId);
    const metadata = await analyzeAssetMetadataOrPending(source, body.provider);
    sendJson(res, 201, await store.addAssetLibrarySnapshot(libraryId, source, metadata));
    return;
  }
  if (parts[4] === 'import-asset' && parts.length === 5 && req.method === 'POST') {
    const body = await readJson<{
      name?: string;
      prompt?: string;
      tags?: string[];
      light?: MapAssetLight;
      modelJson?: unknown;
      mode?: string;
      provider?: ChatProvider;
    }>(req, 512 * 1024 * 1024);
    if (!body.modelJson) throw new HttpError(400, 'missing_model_json');
    const created = await store.addImportedAssetLibrarySnapshot(libraryId, {
      name: body.name,
      prompt: body.prompt?.trim() || body.name?.trim() || 'Imported model',
      tags: body.tags,
      light: body.light,
      modelJson: body.modelJson,
      mode: body.mode || 'voxel'
    }, pendingAssetLibraryMetadata({ tags: body.tags }));
    const metadata = await analyzeAssetMetadataOrPending(created.asset, body.provider);
    const asset = await store.updateAssetLibraryEntry(libraryId, created.asset.id, { metadata });
    sendJson(res, 201, { library: created.library, asset });
    return;
  }

  const assetId = parts[5];
  if (parts[4] === 'assets' && assetId && parts.length === 6 && req.method === 'PATCH') {
    const body = await readJson<{
      name?: string;
      prompt?: string;
      metadata?: Partial<AssetLibraryMetadata>;
    }>(req);
    sendJson(res, 200, { asset: await store.updateAssetLibraryEntry(libraryId, assetId, body) });
    return;
  }
  if (parts[4] === 'assets' && assetId && parts.length === 6 && req.method === 'DELETE') {
    sendJson(res, 200, { library: await store.removeAssetLibraryEntry(libraryId, assetId) });
    return;
  }
  if (parts[4] === 'assets' && assetId && parts[6] === 'analyze' && parts.length === 7 && req.method === 'POST') {
    const body = await readJson<{ provider?: ChatProvider }>(req);
    const asset = await store.loadAsset(assetId);
    const metadata = await analyzeAssetMetadataOrPending(asset, body.provider);
    sendJson(res, 200, {
      asset: await store.updateAssetLibraryEntry(libraryId, assetId, { metadata })
    });
    return;
  }
  throw new HttpError(404, 'not_found');
}

async function analyzeAssetMetadataOrPending(
  asset: Awaited<ReturnType<MapStore['loadAsset']>>,
  provider?: ChatProvider
): Promise<AssetLibraryMetadata> {
  try {
    return await analyzeAssetForLibrary(asset, { provider });
  } catch {
    return pendingAssetLibraryMetadata(asset);
  }
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
  if (
    req.method === 'POST'
    && (parts[3] === 'generate' || parts[3] === 'refine')
    && parts.length === 4
  ) {
    const body = await readJson<{
      prompt?: string;
      provider?: ChatProvider;
      currentPlan?: RenderPlan;
      useHdriSky?: boolean;
      sceneProfile?: unknown;
    }>(req);
    const prompt = body.prompt?.trim();
    if (!prompt) throw new HttpError(400, 'missing_prompt');
    const provider = body.provider ?? 'gpt';
    const option = CHAT_PROVIDER_OPTIONS.find((item) => item.key === provider);
    if (!option || option.disabled) throw new HttpError(400, 'provider_unavailable');
    const sceneProfile = normalizeRenderSceneProfile(body.sceneProfile);
    if (body.sceneProfile !== undefined && !sceneProfile) throw new HttpError(400, 'invalid_render_scene_profile');
    const controller = new AbortController();
    const stream = acceptsEventStream(req);
    if (stream) beginSse(res);
    const onProgress = stream
      ? (event: AgentProgressEvent) => sendSse(res, 'progress', event)
      : undefined;
    const abort = () => controller.abort();
    const abortIfOpen = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', abortIfOpen);
    try {
      const schemes = await store.listRenderSchemes();
      const hdriTextures = await store.listHdriTextures();
      const requireHdriSky = body.useHdriSky !== false && hdriTextures.length > 0;
      const suggestion = parts[3] === 'refine'
        ? await refineRenderSuggestion(
            prompt,
            requireRenderPlan(body.currentPlan),
            schemes,
            { provider, signal: controller.signal, onProgress, hdriTextures, requireHdriSky, sceneProfile }
          )
        : await generateRenderSuggestion(prompt, schemes, {
            provider,
            signal: controller.signal,
            onProgress,
            hdriTextures,
            requireHdriSky,
            sceneProfile
          });
      if (stream) {
        sendSse(res, 'result', { suggestion });
        res.end();
      } else {
        sendJson(res, 200, { suggestion });
      }
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
  if (req.method === 'PATCH' && parts.length === 4) {
    const body = await readJson<Partial<RenderScheme>>(req);
    try {
      sendJson(res, 200, { renderScheme: await store.updateRenderScheme(schemeId, body) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'update_failed';
      throw new HttpError(message === 'builtin_scheme_readonly' ? 409 : 500, message);
    }
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

async function handleEditorColorPalettes(req: Req, res: Res, store: MapStore, parts: string[]): Promise<void> {
  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, { colorPalettes: await store.listColorPalettes() });
    return;
  }
  if (req.method === 'POST' && parts.length === 3) {
    const body = await readJson<Partial<ColorPalette> & { colors?: unknown }>(req);
    sendJson(res, 201, { colorPalette: await store.saveColorPalette(body) });
    return;
  }
  const paletteId = parts[3];
  if (!paletteId) throw new HttpError(404, 'not_found');
  if (req.method === 'GET' && parts.length === 4) {
    sendJson(res, 200, { colorPalette: await store.loadColorPalette(paletteId) });
    return;
  }
  if (req.method === 'DELETE' && parts.length === 4) {
    await store.deleteColorPalette(paletteId);
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new HttpError(404, 'not_found');
}

function isTransactionSource(value: unknown): value is MapTransactionSource {
  return value === 'basic-ai' || value === 'agent' || value === 'manual';
}

async function readJson<T>(req: Req, maxBytes = 16 * 1024 * 1024): Promise<T> {
  const body = await readBody(req, maxBytes);
  if (body.length === 0) return {} as T;
  return JSON.parse(body.toString('utf8')) as T;
}

function dedupeAssets(assets: readonly MapAsset[]): MapAsset[] {
  return [...new Map(assets.map((asset) => [asset.id, asset])).values()];
}

function mapAssetVariantSeed(mapSeed: number, familyKey: string, variantIndex: number): number {
  let hash = Math.trunc(mapSeed) >>> 0;
  for (const character of `${familyKey}:${variantIndex}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

async function readBody(req: Req, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new HttpError(413, 'request_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: Res, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendBytes(res: Res, status: number, bytes: Uint8Array, contentType: string, fileName: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': bytes.byteLength,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
  });
  res.end(Buffer.from(bytes));
}

function acceptsEventStream(req: Req): boolean {
  return String(req.headers.accept ?? '').includes('text/event-stream');
}

function beginSse(res: Res): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
}

function sendSse(res: Res, event: string, body: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

function requireRenderPlan(value: unknown): RenderPlan {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'missing_current_render_plan');
  return value as RenderPlan;
}

function setCorsHeaders(res: Res): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
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
