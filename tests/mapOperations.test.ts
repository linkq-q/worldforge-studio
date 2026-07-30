import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { MapStore } from '../src/server/mapStore';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('map operation transactions', () => {
  it('applies one shared operation list in order', () => {
    const map = createEmptyMap('before', 'map-test');
    map.confirmedAt = 123;
    const result = applyMapOperations(map, [
      { type: 'map.update', name: 'after' },
      { type: 'map.update', renderPromptSuggestions: ['morning mist', 'soft light'] },
      {
        type: 'object.add',
        object: {
          id: 'tree-1',
          name: 'Tree',
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            size: [1, 2, 1]
          }
        }
      },
      {
        type: 'object.update',
        objectId: 'tree-1',
        patch: { transform: { position: [3, 0, -2] } }
      },
      { type: 'sun.set', point: [8, 12, 4] }
    ]);

    expect(result.name).toBe('after');
    expect(result.renderPromptSuggestions).toEqual(['morning mist', 'soft light']);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].transform.position).toEqual([3, 0, -2]);
    expect(result.lighting.sunPosition).toEqual([8, 12, 4]);
    expect(result.confirmedAt).toBeNull();
    expect(map.name).toBe('before');
    expect(map.objects).toHaveLength(0);
  });

  it('rejects an unknown operation without mutating the map', () => {
    const map = createEmptyMap('unchanged', 'map-test');

    expect(() => applyMapOperations(map, [
      { type: 'unknown' } as never
    ])).toThrow('unsupported_operation');
    expect(map.name).toBe('unchanged');
  });

  it('commits atomically and can undo the latest transaction', async () => {
    const store = await createStore();
    const original = await store.createMap({ name: 'before' });

    const committed = await store.commitTransaction(original.id, {
      label: 'AI map pass',
      source: 'agent',
      operations: [{ type: 'map.update', name: 'after' }]
    });

    expect(committed.map.name).toBe('after');
    const restartedStore = new MapStore({ rootDir: store.rootDir });
    expect((await restartedStore.getUndoTransaction(original.id))?.id).toBe(committed.transaction.id);

    const undone = await restartedStore.undoTransaction(original.id);
    expect(undone.map.name).toBe('before');
    expect(undone.transaction.id).toBe(committed.transaction.id);
    expect(await restartedStore.getUndoTransaction(original.id)).toBeNull();
  });

  it('does not save a partially applied invalid transaction', async () => {
    const store = await createStore();
    const original = await store.createMap({ name: 'before' });

    await expect(store.commitTransaction(original.id, {
      source: 'basic-ai',
      operations: [
        { type: 'map.update', name: 'should-not-save' },
        { type: 'object.update', objectId: 'missing', patch: { name: 'x' } }
      ]
    })).rejects.toThrow('object_not_found');

    expect((await store.loadMap(original.id)).name).toBe('before');
    expect(await store.getUndoTransaction(original.id)).toBeNull();
  });

  it('clears the undo snapshot after a later direct save', async () => {
    const store = await createStore();
    const original = await store.createMap({ name: 'before' });
    const committed = await store.commitTransaction(original.id, {
      source: 'agent',
      operations: [{ type: 'map.update', name: 'generated' }]
    });

    await store.replaceMap(original.id, { ...committed.map, name: 'manual edit' });

    expect(await store.getUndoTransaction(original.id)).toBeNull();
    await expect(store.undoTransaction(original.id)).rejects.toThrow('nothing_to_undo');
  });
});

async function createStore(): Promise<MapStore> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-transactions-'));
  tempDirs.push(rootDir);
  const store = new MapStore({ rootDir });
  await store.ensureReady();
  return store;
}
