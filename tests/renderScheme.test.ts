import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MapStore } from '../src/server/mapStore';
import {
  compileRuntimeLightRig,
  compileRuntimeOutline,
  compileRuntimePostQuality,
  compileRuntimePresentation,
  compileRuntimeStyle
} from '../src/shared/renderPlan';
import { BUILTIN_RENDER_SCHEMES, normalizeRenderScheme } from '../src/shared/renderScheme';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('render schemes', () => {
  it('ships the two accepted stylized presets plus a neutral indoor base', () => {
    expect(BUILTIN_RENDER_SCHEMES.map((scheme) => scheme.id)).toEqual([
      'render-runtime-sketch-mist',
      'render-runtime-comic-print',
      'render-indoor-neutral'
    ]);
  });

  it('keeps the indoor base clear, PBR and contact-shadowed', () => {
    const indoor = BUILTIN_RENDER_SCHEMES.find((item) => item.id === 'render-indoor-neutral')!;

    expect(indoor.settings.fogDensity).toBe(0);
    expect(compileRuntimeStyle(indoor.renderPlan!)).toMatchObject({ mode: 'pbr' });
    expect(compileRuntimeLightRig(indoor.renderPlan!)).toMatchObject({ recipe: 'interior-daylight' });
    expect(compileRuntimePostQuality(indoor.renderPlan!)).toMatchObject({ bloom: 'off', ssao: 'soft' });
  });

  it('ships a deterministic runtime-backed sketch preset', () => {
    const scheme = BUILTIN_RENDER_SCHEMES.find((item) => item.id === 'render-runtime-sketch-mist');
    expect(scheme?.renderPlan).toBeDefined();
    expect(compileRuntimePresentation(scheme!.renderPlan!)).toMatchObject({
      mode: 'sketch',
      sketch: {
        coordinateSpace: 'world',
        worldScale: 3.5,
        strength: 0.72,
        hatchSpacing: 7,
        preserveColor: true
      }
    });
    expect(compileRuntimeOutline(scheme!.renderPlan!)).toMatchObject({
      mode: 'ink',
      params: { strength: 0.9, width: 1.35 }
    });
  });

  it('ships the accepted comic print recipe', () => {
    const print = BUILTIN_RENDER_SCHEMES.find((item) => item.id === 'render-runtime-comic-print');

    expect(compileRuntimePresentation(print!.renderPlan!)).toMatchObject({ mode: 'comic-print' });
    expect(compileRuntimeOutline(print!.renderPlan!)).toMatchObject({ mode: 'clean' });
    expect(compileRuntimeStyle(print!.renderPlan!)).toMatchObject({ mode: 'cel' });
  });

  it('normalizes colors and clamps the safe environment settings', () => {
    const scheme = normalizeRenderScheme({
      id: 'scheme-test',
      settings: {
        ...BUILTIN_RENDER_SCHEMES[0].settings,
        background: 'not-a-color',
        fogDensity: 9,
        sunIntensity: -4,
        exposure: 20
      }
    });

    expect(scheme.settings.background).toBe(BUILTIN_RENDER_SCHEMES[0].settings.background);
    expect(scheme.settings.fogDensity).toBe(0.08);
    expect(scheme.settings.sunIntensity).toBe(0);
    expect(scheme.settings.exposure).toBe(3);
  });

  it('keeps built-ins read-only and persists custom copies separately', async () => {
    const store = await createStore();
    const builtins = await store.listRenderSchemes();
    expect(builtins.slice(0, BUILTIN_RENDER_SCHEMES.length).map((scheme) => scheme.id))
      .toEqual(BUILTIN_RENDER_SCHEMES.map((scheme) => scheme.id));

    const custom = await store.saveRenderScheme({
      ...builtins[0],
      name: '田园晨雾',
      settings: { ...builtins[0].settings, fogDensity: 0.021 },
      sourcePrompt: '素描风格的田园晨雾',
      styleTags: ['sketch', 'pastoral'],
      provider: 'gpt',
      renderPlan: {
        version: 1,
        baseSchemeId: builtins[0].id,
        modules: [
          { id: 'atmosphere.fog', params: { density: 0.021 } },
          { id: 'presentation.exposure', params: { value: 1.1 } }
        ]
      }
    });
    expect(custom.kind).toBe('custom');
    expect(custom.id).not.toBe(builtins[0].id);

    const restartedStore = new MapStore({ rootDir: store.rootDir });
    const loaded = await restartedStore.loadRenderScheme(custom.id);
    expect(loaded.settings.fogDensity).toBe(0.021);
    expect(loaded.styleTags).toEqual(['sketch', 'pastoral']);
    expect(loaded.renderPlan?.modules).toHaveLength(2);
    expect(loaded.renderPlan?.modules[0]).toEqual({
      id: 'atmosphere.fog',
      params: { density: 0.021 }
    });
    expect(loaded.sourcePrompt).toBe('素描风格的田园晨雾');
    await expect(restartedStore.deleteRenderScheme(builtins[0].id)).rejects.toThrow('builtin_scheme_readonly');
  });

  it('can promote a local scheme to a read-only default scheme', async () => {
    const store = await createStore();
    const custom = await store.saveRenderScheme({
      ...BUILTIN_RENDER_SCHEMES[0],
      name: '本地清晨'
    });

    const promoted = await store.updateRenderScheme(custom.id, { name: '清透晨林', kind: 'builtin' });

    expect(promoted).toMatchObject({ id: custom.id, name: '清透晨林', kind: 'builtin' });
    await expect(store.deleteRenderScheme(custom.id)).rejects.toThrow('builtin_scheme_readonly');
  });

  it('persists confirmation and a reusable renderSchemeId on the map', async () => {
    const store = await createStore();
    const map = await store.createMap({ name: '已确认地图' });
    map.confirmedAt = 123456;
    map.renderSchemeId = BUILTIN_RENDER_SCHEMES[1].id;

    await store.replaceMap(map.id, map);
    const restartedStore = new MapStore({ rootDir: store.rootDir });
    const loaded = await restartedStore.loadMap(map.id);
    const summary = (await restartedStore.listMapSummaries()).find((item) => item.id === map.id);

    expect(loaded.confirmedAt).toBe(123456);
    expect(loaded.renderSchemeId).toBe(BUILTIN_RENDER_SCHEMES[1].id);
    expect(summary?.renderSchemeId).toBe(BUILTIN_RENDER_SCHEMES[1].id);
  });

  it('moves maps back to the default preset when a custom scheme is deleted', async () => {
    const store = await createStore();
    const custom = await store.saveRenderScheme({
      ...BUILTIN_RENDER_SCHEMES[1],
      name: '待删除方案',
      kind: 'custom'
    });
    const map = await store.createMap({ name: '引用自定义方案' });
    await store.replaceMap(map.id, { ...map, renderSchemeId: custom.id });

    await store.deleteRenderScheme(custom.id);

    await expect(store.loadRenderScheme(custom.id)).rejects.toThrow();
    expect((await store.loadMap(map.id)).renderSchemeId).toBe(BUILTIN_RENDER_SCHEMES[0].id);
  });
});

async function createStore(): Promise<MapStore> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-render-scheme-'));
  tempDirs.push(rootDir);
  const store = new MapStore({ rootDir });
  await store.ensureReady();
  return store;
}
