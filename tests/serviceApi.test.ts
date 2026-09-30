import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleMapHttp } from '../src/server/mapHttp';
import { MapStore } from '../src/server/mapStore';
import { MODEL_API_BASE } from '../src/shared/protocol';

const token = 'test-only-worldforge-service-credential';
let store: MapStore;
let server: http.Server;
let base: string;
let rootDir: string;
const pending: Promise<unknown>[] = [];
const nativeFetch = globalThis.fetch;

beforeEach(async () => {
  vi.stubEnv('WORLDFORGE_SERVICE_TOKEN', token);
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-service-'));
  store = new MapStore({ rootDir });
  server = http.createServer((req, res) => {
    pending.push(handleMapHttp(req, res, store, true).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(500); res.end(); }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(pending.splice(0));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(rootDir, { recursive: true, force: true });
});

function post(route: string, body: unknown, headers: Record<string, string> = {}) {
  return nativeFetch(`${base}/api/service/v1${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body)
  });
}

it('requires a configured server credential and limits the exposed routes', async () => {
  vi.stubEnv('WORLDFORGE_SERVICE_TOKEN', '');
  expect((await post('/maps', {})).status).toBe(503);
  vi.stubEnv('WORLDFORGE_SERVICE_TOKEN', token);
  for (const authorization of ['', 'Bearer wrong']) {
    const response = await post('/maps', {}, { Authorization: authorization });
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  }
  for (const route of ['/codex-runs', '/import', '/project-export', '/maps/trash/restore']) {
    expect((await post(route, {})).status).toBe(404);
  }
  const codex = await post('/maps', {}, { 'X-WorldForge-Codex-Run': 'not-a-service-provider' });
  expect(codex.status).toBe(400);
  for (const route of ['/api/maps', '/api/editor/maps', '/']) {
    expect((await nativeFetch(`${base}${route}`)).status).toBe(404);
  }
  expect(await store.listMapSummaries()).toEqual([]);
});

it('generates and refines through the backend, previews structured maps, and commits only approved current versions', async () => {
  let code = "function plan(api) { api.sceneIntent({kind:'natural'}); api.terrain({preset:'plain',amplitude:0}); }";
  const upstream = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body)).provider).toBe('gpt');
    return new Response(JSON.stringify({ ok: true, content: code }));
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) === `${MODEL_API_BASE}/api/chat`) return upstream(input, init);
    throw new Error(`unexpected upstream request: ${input}`);
  });
  const created = await post('/maps', { name: 'Service scene' });
  expect(created.status).toBe(201);
  const { map: original } = await created.json();
  const route = `/maps/${original.id}`;
  const generated = await post(`${route}/generate`, { prompt: 'flat grassy field', maxNewAssets: 0 });
  expect(generated.status).toBe(200);
  const draft = await generated.json();
  expect(draft.baseVersion).toBe(original.version);
  expect(draft.suggestion.operations.length).toBeGreaterThan(0);
  expect((await store.loadMap(original.id)).version).toBe(original.version);
  const preview = await post(`${route}/preview`, {
    expectedVersion: draft.baseVersion, operations: draft.suggestion.operations
  });
  expect(preview.status).toBe(200);
  expect((await preview.json()).map.terrain).not.toBeNull();
  const transaction = {
    expectedVersion: draft.baseVersion, source: 'agent', operations: draft.suggestion.operations
  };
  expect((await post(`${route}/transactions`, transaction)).status).toBe(400);
  expect((await post(`${route}/transactions`, { ...transaction, approved: true, expectedVersion: undefined })).status).toBe(400);
  const committed = await post(`${route}/transactions`, { ...transaction, approved: true });
  expect(committed.status).toBe(200);
  const saved = (await committed.json()).map;
  expect(saved.version).toBeGreaterThan(original.version);
  expect((await post(`${route}/transactions`, { ...transaction, approved: true })).status).toBe(409);
  expect((await post(`${route}/preview`, transaction)).status).toBe(409);
  expect((await post(`${route}/refine`, { prompt: 'Change the draft', baseOperations: draft.suggestion.operations, expectedVersion: draft.baseVersion })).status).toBe(409);
  code = "function plan(api) { api.sculptTerrain({mode:'raise',point:[2,3],radius:4,strength:1}); }";
  const refined = await post(`${route}/refine`, { prompt: 'Raise a small hill at x=2, z=3', maxNewAssets: 0 });
  expect(refined.status, await refined.clone().text()).toBe(200);
  const refinedDraft = await refined.json();
  expect(refinedDraft.baseVersion).toBe(saved.version);
  const refinedPreview = await post(`${route}/preview`, {
    expectedVersion: saved.version, operations: refinedDraft.suggestion.operations
  });
  expect(refinedPreview.status).toBe(200);
  expect((await refinedPreview.json()).map.terrain.heights).not.toEqual(saved.terrain.heights);
  expect((await store.loadMap(original.id)).version).toBe(saved.version);
  expect(upstream).toHaveBeenCalledTimes(2);
});

it('keeps new assets on DeepSeek and includes their model data in the preview', async () => {
  const code = `function plan(api) {
    api.sceneIntent({kind:'natural'});
    api.terrain('plain');
    const rock = api.requireAsset({key:'rock',name:'Rock',prompt:'A standalone rock',tags:['rock'],variants:1,role:'environment'});
    api.place({assetId:api.asset(rock,0),name:'Rock',position:[5,5],role:'environment'});
  }`;
  const modelJson = { nodes: [{ id: 'rock-body', mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } } }] };
  const assetCalls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) === `${MODEL_API_BASE}/api/chat`) return new Response(JSON.stringify({ ok: true, content: code }));
    if (String(input) === `${MODEL_API_BASE}/api/generate/model`) {
      assetCalls.push(JSON.parse(String(init?.body)).provider);
      return new Response(`data: ${JSON.stringify({ stage: 'result', done: true, modelJson })}\n\n`);
    }
    throw new Error(`unexpected upstream request: ${input}`);
  });
  const { map } = await (await post('/maps', { name: 'One rock' })).json();
  const response = await post(`/maps/${map.id}/generate`, { prompt: 'Flat land with one rock', maxNewAssets: 1 });
  expect(response.status, await response.clone().text()).toBe(200);
  const draft = await response.json();
  expect(assetCalls).toEqual(['deepseek']);
  const preview = await post(`/maps/${map.id}/preview`, { expectedVersion: draft.baseVersion, operations: draft.suggestion.operations });
  expect(preview.status).toBe(200);
  const result = await preview.json();
  expect(result.map.assets).toHaveLength(1);
  expect(result.map.assets[0].modelJson).toMatchObject(modelJson);
  expect(result.map.objects.some((object: { assetId?: string }) => object.assetId === result.map.assets[0].id)).toBe(true);
});

it('applies exactly one of two concurrent commits based on the same map version', async () => {
  const { map } = await (await post('/maps', { name: 'Concurrent scene' })).json();
  const request = { approved: true, expectedVersion: map.version, source: 'agent', operations: [{ type: 'map.update', name: 'Changed' }] };
  const responses = await Promise.all([post(`/maps/${map.id}/transactions`, request), post(`/maps/${map.id}/transactions`, request)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
});
