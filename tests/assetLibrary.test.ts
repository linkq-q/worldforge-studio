import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MapStore } from '../src/server/mapStore';
import { normalizeAssetLibraryMetadata } from '../src/shared/assetLibrary';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('asset libraries', () => {
  it('stores an independent snapshot and keeps it resolvable after removing the library', async () => {
    const store = await createStore();
    const source = await store.saveAsset({
      name: 'Pine tree',
      prompt: 'a tall pine tree',
      tags: ['pine', 'tree'],
      modelJson: simpleModel()
    });
    const library = await store.createAssetLibrary({ name: 'Forest kit' });
    const { asset: snapshot } = await store.addAssetLibrarySnapshot(library.id, source, {
      tags: ['pine', 'tree'],
      applicableZones: ['forest'],
      analysisStatus: 'ready',
      enabled: true
    });

    expect(snapshot.id).not.toBe(source.id);
    expect(snapshot.libraryId).toBe(library.id);
    expect((await store.listAssets()).map((asset) => asset.id)).toEqual([source.id]);
    expect((await store.listAssetLibraryAssets(library.id)).map((asset) => asset.id)).toEqual([snapshot.id]);

    await store.deleteAssetLibrary(library.id);
    await expect(store.loadAsset(snapshot.id)).resolves.toMatchObject({ id: snapshot.id, name: 'Pine tree' });
  });

  it('exports embedded assets and remaps library and asset ids on import', async () => {
    const store = await createStore();
    const source = await store.saveAsset({ name: 'Rock', prompt: 'granite rock', tags: ['rock'], modelJson: simpleModel() });
    const library = await store.createAssetLibrary({ name: 'Rock kit' });
    const { asset } = await store.addAssetLibrarySnapshot(library.id, source, {
      tags: ['rock'], applicableZones: ['rocky'], analysisStatus: 'ready'
    });

    const imported = await store.importAssetLibrary(await store.exportAssetLibrary(library.id));

    expect(imported.library.id).not.toBe(library.id);
    expect(imported.assets).toHaveLength(1);
    expect(imported.assets[0].id).not.toBe(asset.id);
    expect(imported.assets[0]).toMatchObject({ libraryId: imported.library.id, name: 'Rock' });
    expect(imported.library.assetIds).toEqual([imported.assets[0].id]);
  });

  it('normalizes user-editable placement metadata to safe ranges', () => {
    expect(normalizeAssetLibraryMetadata({
      applicableZones: ['forest', 'forest'],
      priority: 8,
      density: 0,
      minSpacing: -2,
      scaleRange: [2, 1],
      rotation: 'fixed'
    })).toMatchObject({
      applicableZones: ['forest'],
      priority: 1,
      density: 0.01,
      minSpacing: 0.1,
      scaleRange: [2, 2],
      rotation: 'fixed'
    });
  });
});

async function createStore(): Promise<MapStore> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-asset-library-'));
  tempDirs.push(rootDir);
  return new MapStore({ rootDir });
}

function simpleModel(): unknown {
  return {
    format: 2,
    nodes: [{
      id: 'body',
      transform: { pos: [0, 0.5, 0] },
      mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } }
    }]
  };
}
