import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MapStore } from '../src/server/mapStore';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('map duplication', () => {
  it('creates an independent map with the same scene content and no transaction history', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-duplicate-'));
    tempDirs.push(rootDir);
    const store = new MapStore({ rootDir });
    const source = await store.createMap({ name: '街区' });
    const edited = await store.commitTransaction(source.id, {
      source: 'manual',
      label: 'Add landmark',
      operations: [{ type: 'object.add', object: { name: '钟楼', assetId: null } }]
    });

    const duplicate = await store.duplicateMap(source.id);

    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.name).toBe('街区 副本');
    expect(duplicate.seed).toBe(edited.map.seed);
    expect(duplicate.objects).toEqual(edited.map.objects);
    expect(await store.getUndoTransaction(duplicate.id)).toBeNull();

    await store.replaceMap(duplicate.id, { ...duplicate, name: '独立副本' });
    expect((await store.loadMap(source.id)).name).toBe('街区');
  });

  it('accepts a custom copy name', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-duplicate-name-'));
    tempDirs.push(rootDir);
    const store = new MapStore({ rootDir });
    const source = await store.createMap({ name: '街区' });

    expect((await store.duplicateMap(source.id, '街区方案 B')).name).toBe('街区方案 B');
  });
});
