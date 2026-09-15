import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { handleMapHttp } from '../src/server/mapHttp';
import { MapStore } from '../src/server/mapStore';

it('persists AI code and diagnostics through the editor HTTP transaction route', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-http-transaction-'));
  const store = new MapStore({ rootDir });
  const server = http.createServer((req, res) => {
    void handleMapHttp(req, res, store).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
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
      codePlan: {
        code: "function plan(api) { api.route({id:'street',points:[[-10,0],[10,0]]}); }",
        placementCount: 0, functions: ['route'], repairAttempts: 2,
        diagnostics: [{ code: 'scene.program-incomplete', severity: 'warning', message: '测试诊断', repaired: false }]
      },
      generatedAssets: []
    };
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '测试规划', source: 'agent', operations: [{ type: 'map.update', name: '已保存' }], ai })
    });
    expect(response.status).toBe(200);
    expect((await response.json()).transaction.ai).toMatchObject(ai);
    expect((await new MapStore({ rootDir }).getUndoTransaction(map.id))?.ai).toMatchObject(ai);
    const loaded = await fetch(url);
    expect((await loaded.json()).transaction.ai).toMatchObject(ai);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(rootDir, { recursive: true, force: true });
  }
});
