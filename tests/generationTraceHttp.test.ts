import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { handleMapHttp } from '../src/server/mapHttp';
import { MapStore } from '../src/server/mapStore';
import { MODEL_API_BASE } from '../src/shared/protocol';

it('links a generated suggestion, its visual review and saved transaction to local trace files', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-trace-http-'));
  const store = new MapStore({ rootDir });
  const pending: Array<Promise<unknown>> = [];
  const server = http.createServer((req, res) => { pending.push(handleMapHttp(req, res, store)); });
  const nativeFetch = globalThis.fetch;
  const code = "function plan(api) { api.sceneIntent({kind:'natural'}); api.terrain({preset:'plain',amplitude:0}); }";
  const responses = [code, JSON.stringify({ summary: '检查完成', findings: [] })];
  const upstream = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, content: responses.shift() }), {
    headers: { 'Content-Type': 'application/json' }
  })));
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url === `${MODEL_API_BASE}/api/chat`) return upstream();
    if (url.startsWith('http://127.0.0.1:')) return nativeFetch(input, init);
    throw new Error(`unexpected external request: ${url}`);
  });
  try {
    const map = await store.createMap({ name: '完整记录测试' });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api/editor/maps/${map.id}`;
    const post = (route: string, body: unknown) => fetch(`${base}/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const generated = await post('generate', { prompt: '简单草地', sceneAgent: true, maxNewAssets: 0 });
    expect(generated.status).toBe(200);
    const { suggestion } = await generated.json();
    const generationId = suggestion.generationTraceId;
    expect(generationId).toBe(generated.headers.get('X-WorldForge-Trace-Id'));
    const reviewed = await post('visual-review', {
      parentTraceId: generationId, baseOperations: suggestion.operations,
      imageDataUrl: 'data:image/png;base64,aGVsbG8='
    });
    expect(reviewed.status).toBe(200);
    const review = await reviewed.json();
    expect(review.generationTraceId).not.toBe(generationId);
    const saved = await post('transactions', {
      source: 'agent', label: suggestion.summary, operations: suggestion.operations,
      ai: { prompt: '简单草地', generationTraceId: generationId, codePlan: suggestion.codePlan }
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).transaction.ai.generationTraceId).toBe(generationId);
    await Promise.all(pending);
    expect(upstream).toHaveBeenCalledTimes(2);
    const day = (await readdir(path.join(rootDir, 'logs'))).find((name) => name.startsWith('generation-'))!;
    const read = async (id: string) => (await readFile(path.join(rootDir, 'logs', day, `${id}.jsonl`), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    const generation = await read(generationId);
    expect(generation[0].data).toMatchObject({ mapId: map.id, operation: 'generate' });
    expect(generation.find((r) => r.type === 'chat.request').data.stage).toBe('map.initial-plan');
    expect(generation.find((r) => r.type === 'generation.result').data.suggestion.codePlan.code).toBe(code);
    expect(generation.at(-1).data.status).toBe('completed');
    const inspection = await read(review.generationTraceId);
    expect(inspection.find((r) => r.type === 'request.input').data.parentTraceId).toBe(generationId);
    expect(inspection.find((r) => r.type === 'request.input').data.imageDataUrl.localImage).toBeTruthy();
    expect(inspection.find((r) => r.type === 'review.result').data.review.summary).toBe('检查完成');
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await Promise.all(pending);
    fetchMock.mockRestore();
    await rm(rootDir, { recursive: true, force: true });
  }
});
