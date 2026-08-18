import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAP_TRASH_RETENTION_MS } from '../src/shared/map';
import { MapStore } from '../src/server/mapStore';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('map trash', () => {
  it('keeps deleted maps recoverable for seven days', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-trash-'));
    tempDirs.push(rootDir);
    const store = new MapStore({ rootDir });
    const map = await store.createMap({ name: 'Recover me' });

    await store.deleteMap(map.id);

    await expect(store.loadMap(map.id)).rejects.toThrow();
    const deleted = await store.listDeletedMaps();
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ id: map.id, name: 'Recover me' });
    expect(deleted[0].expiresAt - deleted[0].deletedAt).toBe(MAP_TRASH_RETENTION_MS);

    const restored = await store.restoreDeletedMap(map.id);
    expect(restored.id).toBe(map.id);
    expect(await store.listDeletedMaps()).toEqual([]);
    expect((await store.loadMap(map.id)).name).toBe('Recover me');
  });

  it('restores the latest AI transaction snapshot with the map', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-trash-history-'));
    tempDirs.push(rootDir);
    const store = new MapStore({ rootDir });
    const map = await store.createMap({ name: 'Before Agent' });
    await store.commitTransaction(map.id, {
      source: 'agent', label: 'Agent edit', operations: [{ type: 'map.update', name: 'After Agent' }]
    });

    await store.deleteMap(map.id);
    await store.restoreDeletedMap(map.id);

    expect((await store.getUndoTransaction(map.id))?.label).toBe('Agent edit');
    expect((await store.undoTransaction(map.id)).map.name).toBe('Before Agent');
  });
});
