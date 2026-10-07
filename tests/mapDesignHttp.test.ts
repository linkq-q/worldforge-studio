import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { handleMapHttp } from '../src/server/mapHttp';
import { mapDesignManager } from '../src/server/mapDesignHttp';
import { MapStore } from '../src/server/mapStore';

it('runs a persistent design through the HTTP/Codex bridge, including steering, draft and commit', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-design-http-'));
  const store = new MapStore({ rootDir });
  const map = await store.createMap({ name: 'HTTP conversation' });
  const server = http.createServer((req, res) => { void handleMapHttp(req, res, store); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/editor`;
  const nativeFetch = globalThis.fetch;
  const remote = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).startsWith(base)) return nativeFetch(input, init);
    throw new Error('unexpected_paid_request');
  });
  let runId = '';
  let id = '';
  async function post(url: string, body: unknown, bridge = true) {
    return fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(bridge && runId ? {'X-WorldForge-Codex-Run': runId} : {}) }, body: JSON.stringify(body) });
  }
  async function next() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { requests } = await (await fetch(`${base}/codex-runs/${runId}/next`)).json();
      if (requests.length) return requests[0];
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('missing_bridge_design_request');
  }
  try {
    runId = (await (await post('/codex-runs', {}, false)).json()).runId;
    const invalid = await post(`/maps/${map.id}/design-sessions`, { prompt: 'Town' });
    expect(invalid.status).toBe(400);
    const created = await post(`/maps/${map.id}/design-sessions`, { prompt: 'Keep the terrain, add a walking route', requirePlanApproval:false,expectedVersion: map.version });
    expect(created.status).toBe(201);
    id = (await created.json()).session.id;
    const interrupted = await next();
    expect(interrupted.stage).toBe('map.design-session');
    expect((await post(`/design-sessions/${id}/messages`, { message: 'Make the route narrow' })).status).toBe(200);
    const request = await next();
    expect(request.id).not.toBe(interrupted.id);
    expect(JSON.stringify(request.messages)).toContain('Make the route narrow');
    await post(`/codex-runs/${runId}/respond`, { requestId: request.id, content: JSON.stringify({ action:'execute',
      code:"function plan(api) { api.route({id:'walk',points:[[-10,0],[0,4],[10,0]],width:2}); }", summary:'A narrow route' }) }, false);
    const finish = await next();
    expect(JSON.stringify(finish.messages)).toContain('draftRevision');
    await post(`/codex-runs/${runId}/respond`, {requestId:finish.id,content:JSON.stringify({action:'finish',summary:'Route ready'})}, false);
    await mapDesignManager(store).settled(id);
    const draft = await (await fetch(`${base}/design-sessions/${id}/draft`)).json();
    expect(draft.session.draftRevision).toBe(1);
    expect(draft.suggestion.operations.length).toBeGreaterThan(0);
    const version = draft.session.version;
    const unchanged = await (await fetch(`${base}/design-sessions/${id}?sinceVersion=${version}`)).json();
    expect(unchanged).toEqual({ session: null, version });
    const changed = await (await fetch(`${base}/design-sessions/${id}?sinceVersion=${version - 1}`)).json();
    expect(changed.session.messages).toEqual(draft.session.messages);
    expect((await (await fetch(`${base}/design-sessions/${id}`)).json()).session.id).toBe(id);
    expect((await post(`/design-sessions/${id}/commit`, {expectedRevision:0,approved:true})).status).toBe(409);
    expect((await post(`/design-sessions/${id}/commit`, {expectedRevision:1,approved:false})).status).toBe(400);
    const committed = await post(`/design-sessions/${id}/commit`, {expectedRevision:1,approved:true});
    expect(committed.status).toBe(200);
    expect((await committed.json()).session.status).toBe('committed');
    expect((await (await fetch(`${base}/maps/${map.id}/design-sessions`)).json()).sessions[0].id).toBe(id);
    expect(remote.mock.calls.every(([input]) => String(input).startsWith(base))).toBe(true);
  } finally {
    if (id) { await mapDesignManager(store).pause(id).catch(() => undefined); }
    if (runId) await fetch(`${base}/codex-runs/${runId}`, {method:'DELETE'});
    if (id) await mapDesignManager(store).settled(id);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    remote.mockRestore();
    await rm(rootDir, {recursive:true,force:true});
  }
});
