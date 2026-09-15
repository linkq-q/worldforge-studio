import http from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { handleMapHttp } from '../src/server/mapHttp';
import { MapStore } from '../src/server/mapStore';

it('persists AI code and diagnostics through the editor HTTP transaction route', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-http-transaction-'));
  const store = new MapStore({ rootDir });
  const pending: Array<Promise<unknown>> = [];
  const server = http.createServer((req, res) => {
    pending.push(handleMapHttp(req, res, store).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    }));
  });
  try {
    const map = await store.createMap({ name: '诊断记录测试' });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/api/editor/maps/${map.id}/transactions`;
    const ai = {
      prompt: '日式街道',
      generationTraceId: 'previous-generation-trace',
      codePlan: {
        code: "function plan(api) { api.route({id:'street',points:[[-10,0],[10,0]]}); }",
        placementCount: 0, functions: ['route'], repairAttempts: 2,
        diagnostics: [{ code: 'scene.program-incomplete', severity: 'warning', message: '测试诊断', repaired: false }]
      },
      generatedAssets: []
    };
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer DO_NOT_LOG_HEADER' },
      body: JSON.stringify({ label: '测试规划', source: 'agent', operations: [{ type: 'map.update', name: '已保存' }], ai })
    });
    expect(response.status).toBe(200);
    const traceId = response.headers.get('X-WorldForge-Trace-Id');
    expect(traceId).toBeTruthy();
    expect((await response.json()).transaction.ai).toMatchObject(ai);
    expect((await new MapStore({ rootDir }).getUndoTransaction(map.id))?.ai).toMatchObject(ai);
    const loaded = await fetch(url);
    expect((await loaded.json()).transaction.ai).toMatchObject(ai);
    await Promise.all(pending);
    const day = (await readdir(path.join(rootDir, 'logs'))).find((name) => name.startsWith('generation-'))!;
    const trace = await readFile(path.join(rootDir, 'logs', day, `${traceId}.jsonl`), 'utf8');
    expect(trace).toContain('previous-generation-trace');
    expect(trace).toContain('transaction.input');
    expect(trace).not.toContain('DO_NOT_LOG_HEADER');
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await Promise.all(pending);
    await rm(rootDir, { recursive: true, force: true });
  }
});
