import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { handleMapHttp } from '../src/server/mapHttp';
import { MapStore } from '../src/server/mapStore';
import { MODEL_API_BASE } from '../src/shared/protocol';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { createRenderSceneProfile } from '../src/shared/renderSceneProfile';
import { normalizeMapDesignSemantics } from '../src/shared/mapDesign';

it('generates, validates, saves and reloads scene-art rules through the existing local HTTP API', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-art-http-'));
  const store = new MapStore({ rootDir });
  const server = http.createServer((req, res) => { void handleMapHttp(req, res, store); });
  const realFetch = globalThis.fetch;
  const map = createEmptyMap('art context', 'art-context');
  map.objects = [{ ...createMapObject('灯具'), id: 'lamp' }];
  map.designSemantics = normalizeMapDesignSemantics({
    intent: '沿小路抵达灯具焦点', groups: [{ id: 'court', name: '院落', intent: '入口引导' }],
    focuses: [{ id: 'light-focus', groupId: 'court', name: '灯具', kind: 'primary', objectId: 'lamp' }],
    viewpoints: [{ id: 'entry', role: 'entry', point: [-4, 0], targetFocusId: 'light-focus' }]
  }, map.box.size);
  const plan = { version: 2, baseSchemeId: 'render-indoor-neutral', modules: [
    { id: 'runtime.local-light', key: 'lamp', params: { config: JSON.stringify({ objectId: 'lamp', intensity: 6 }) } },
    { id: 'runtime.surface-detail', key: 'animated', params: { config: JSON.stringify({ objectId: 'lamp', colorExpression: 'color * (0.9 + 0.1 * sin(time))' }) } }
  ] };
  const upstream = vi.fn(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    expect(request.messages[0].content).toContain('lamp');
    expect(request.messages[0].content).toContain('沿小路抵达灯具焦点');
    expect(request.messages[0].content).toContain('用光照、色彩对比、材质层次和氛围强化');
    expect(request.messages[0].content).toContain('禁止语句、循环、除法');
    return new Response(JSON.stringify({ ok: true, content: JSON.stringify({ plan, explanation: '只调整灯具' }) }), { headers: { 'Content-Type': 'application/json' } });
  });
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => String(url) === `${MODEL_API_BASE}/api/chat` ? upstream(url, init) : realFetch(url, init));
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/editor/render-schemes`;
    const post = (url: string, body: unknown) => realFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const response = await post(`${base}/generate`, { prompt: '只调整灯具的暖光和缓慢色彩变化', sceneProfile: createRenderSceneProfile(map) });
    expect(response.status).toBe(200);
    const { suggestion } = await response.json();
    expect(suggestion.plan.modules).toHaveLength(2);
    const savedResponse = await post(base, { name: 'Art roundtrip', renderPlan: suggestion.plan });
    expect(savedResponse.status).toBe(201);
    const { renderScheme: saved } = await savedResponse.json();
    const loaded = await (await realFetch(`${base}/${saved.id}`)).json();
    expect(loaded.renderScheme.renderPlan).toEqual(saved.renderPlan);
    expect(JSON.parse(loaded.renderScheme.renderPlan.modules[0].params.config).objectId).toBe('lamp');
    expect(upstream).toHaveBeenCalledOnce();
  } finally {
    mock.mockRestore();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(rootDir, { recursive: true, force: true });
  }
});
