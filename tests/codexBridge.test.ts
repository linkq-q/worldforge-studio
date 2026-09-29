import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { handleMapHttp } from '../src/server/mapHttp';
import { MapStore } from '../src/server/mapStore';
import { createCodexRun, closeCodexRun, pendingCodexRequests, respondToCodexRequest, withCodexRun } from '../src/server/codexBridge';
import { generateModel, llmChat } from '../src/server/modelApi';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('routes every chat call in a Codex run to the host without contacting the GPT backend', async () => {
  const runId = createCodexRun();
  const fetchImpl = vi.fn(() => { throw new Error('unexpected backend call'); });
  try {
    const result = withCodexRun(runId, () => llmChat([
      { role: 'system', content: 'Return JSON only' },
      { role: 'user', content: [{ type: 'text', text: 'Inspect this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }
    ], { traceStage: 'map.visual-review', fetchImpl }));
    const [request] = pendingCodexRequests(runId);
    expect(request.stage).toBe('map.visual-review');
    expect(request.messages[1].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url' })
    ]));
    respondToCodexRequest(runId, request.id, '{"imageVerified":true}');
    await expect(result).resolves.toBe('{"imageVerified":true}');
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    closeCodexRun(runId);
  }
});

it('keeps asset generation on a non-GPT backend in Codex mode', async () => {
  const runId = createCodexRun();
  const fetchImpl = vi.fn().mockResolvedValue(new Response(
    'data: {"stage":"result","done":true,"modelJson":{"name":"tree"}}\n\n',
    { status: 200 }
  ));
  try {
    await expect(withCodexRun(runId, () => generateModel('tree', {
      apiBase: 'https://example.test', fetchImpl, materialTags: false
    }))).resolves.toEqual({ name: 'tree' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body)).provider).toBe('deepseek');
    await expect(withCodexRun(runId, () => generateModel('tree', {
      providers: ['gpt'], fetchImpl, materialTags: false
    }))).rejects.toThrow('codex_asset_gpt_provider_forbidden');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally {
    closeCodexRun(runId);
  }
});

it('resumes the existing map planner after Codex supplies its selected model response', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-codex-'));
  roots.push(rootDir);
  const store = new MapStore({ rootDir });
  const map = await store.createMap({ name: 'Codex bridge test' });
  const server = http.createServer((req, res) => { void handleMapHttp(req, res, store); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const nativeFetch = globalThis.fetch;
  const remote = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).startsWith(base)) return nativeFetch(input, init);
    throw new Error(`unexpected remote request: ${input}`);
  });
  try {
    const session = await fetch(`${base}/api/editor/codex-runs`, { method: 'POST' });
    expect(session.status).toBe(201);
    const { runId } = await session.json() as { runId: string };
    const generation = fetch(`${base}/api/editor/maps/${map.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WorldForge-Codex-Run': runId },
      body: JSON.stringify({ prompt: 'flat grassy field', sceneAgent: true, planOnly: true, maxNewAssets: 0 })
    });
    let requests: Array<{ id: string; stage: string }> = [];
    for (let attempt = 0; attempt < 100 && requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      requests = (await (await fetch(`${base}/api/editor/codex-runs/${runId}/next`)).json()).requests;
    }
    expect(requests[0]?.stage).toBe('map.initial-plan');
    const code = "function plan(api) { api.sceneIntent({kind:'natural'}); api.terrain({preset:'plain',amplitude:0}); }";
    const reply = await fetch(`${base}/api/editor/codex-runs/${runId}/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: requests[0].id, content: code })
    });
    expect(reply.status).toBe(200);
    const response = await generation;
    expect(response.status).toBe(200);
    expect((await response.json()).suggestion.codePlan.code).toBe(code);
    expect(remote.mock.calls.every(([input]) => String(input).startsWith(base))).toBe(true);
    await fetch(`${base}/api/editor/codex-runs/${runId}`, { method: 'DELETE' });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    remote.mockRestore();
  }
});
