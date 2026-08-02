import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { createRenderScheme } from '../src/shared/renderScheme';
import {
  decodeWorldForgeTransfer,
  encodeMapTransfer,
  encodeRenderSchemeTransfer,
  encodeScenePackage,
  renderSchemeHdriFile
} from '../src/shared/scenePackage';
import { MapStore } from '../src/server/mapStore';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('portable WorldForge scene packages', () => {
  it('round-trips map and render scheme JSON envelopes', () => {
    const map = createEmptyMap('测试地图');
    const scheme = renderScheme();

    expect(decodeWorldForgeTransfer(encodeMapTransfer(map))).toMatchObject({ kind: 'map', map: { name: '测试地图' } });
    expect(decodeWorldForgeTransfer(encodeRenderSchemeTransfer(scheme))).toMatchObject({
      kind: 'render-scheme',
      renderScheme: { name: '黄昏方案' }
    });
  });

  it('packs the confirmed map, scheme and referenced EXR into one ZIP', () => {
    const map = createEmptyMap('完整场景');
    map.confirmedAt = 123;
    const scheme = renderScheme();
    const bytes = encodeScenePackage({
      map,
      renderScheme: scheme,
      hdri: { file: 'sunset.exr', bytes: new Uint8Array([1, 2, 3, 4]) }
    });

    const decoded = decodeWorldForgeTransfer(bytes);
    expect(decoded.kind).toBe('scene');
    if (decoded.kind !== 'scene') return;
    expect(decoded.map.confirmedAt).toBe(123);
    expect(renderSchemeHdriFile(decoded.renderScheme)).toBe('sunset.exr');
    expect([...decoded.hdri!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('imports as a new project, remaps assets, and avoids overwriting a different EXR', async () => {
    const store = await createStore();
    const asset = await store.saveAsset({
      name: '树',
      prompt: '树',
      mode: 'standard',
      modelJson: { nodes: [] }
    });
    const source = createEmptyMap('森林', undefined, undefined, 'standard');
    const object = createMapObject('树', asset.id);
    source.objects.push(object);
    source.assets = [asset];

    const imported = await store.importMap(source, 'render-imported');
    expect(imported.id).not.toBe(source.id);
    expect(imported.name).toBe('森林（导入）');
    expect(imported.renderSchemeId).toBe('render-imported');
    expect(imported.objects[0].assetId).not.toBe(asset.id);
    expect(imported.assets?.[0].id).toBe(imported.objects[0].assetId);
    expect(imported.assetGenerationMode).toBe('standard');

    expect(await store.importHdri('sky.exr', new Uint8Array([1, 2]))).toBe('sky.exr');
    expect(await store.importHdri('sky.exr', new Uint8Array([1, 2]))).toBe('sky.exr');
    const renamed = await store.importHdri('sky.exr', new Uint8Array([3, 4]));
    expect(renamed).toMatch(/^sky-import-\d+\.exr$/);
    expect([...await readFile(path.join(store.rootDir, 'hdri', renamed))]).toEqual([3, 4]);
  });

  it('rejects a map whose referenced assets are not embedded', async () => {
    const store = await createStore();
    const source = createEmptyMap('坏包');
    source.objects.push(createMapObject('缺失资产', 'asset-missing'));
    await expect(store.importMap(source)).rejects.toThrow('import_missing_embedded_asset');
  });
});

function renderScheme() {
  return createRenderScheme({
    name: '黄昏方案',
    renderPlan: {
      version: 2,
      baseSchemeId: 'render-natural',
      modules: [{
        id: 'environment.hdri',
        params: { texture: 'sunset.exr', exposure: 1.1, tint: '#ffc090' }
      }]
    }
  });
}

async function createStore(): Promise<MapStore> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-scene-package-'));
  tempDirs.push(rootDir);
  const store = new MapStore({ rootDir });
  await store.ensureReady();
  return store;
}
