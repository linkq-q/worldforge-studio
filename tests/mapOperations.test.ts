import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyMap, sampleTerrainHeight } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { MapStore } from '../src/server/mapStore';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('map operation transactions', () => {
  it('creates a large map with its matching terrain resolution', async () => {
    const store = await createStore();
    const map = await store.createMap({ name: 'large', size: [192, 24, 192] });

    expect(map.box.size).toEqual([192, 24, 192]);
    expect(map.terrain.resolutionX).toBe(129);
    expect(map.terrain.resolutionZ).toBe(129);
  });

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

  it('applies a large scatter transaction without mutating the source map', () => {
    const map = createEmptyMap('large transaction', 'map-large-transaction', [192, 24, 192]);
    const operations = Array.from({ length: 409 }, (_, index) => ({
      type: 'object.add' as const,
      object: {
        id: `tree-${index}`,
        name: `Tree ${index}`,
        transform: { position: [index % 20, 0, Math.floor(index / 20)] as [number, number, number] }
      }
    }));

    const result = applyMapOperations(map, operations);

    expect(result.objects).toHaveLength(409);
    expect(map.objects).toHaveLength(0);
  });

  it('adds, updates and removes structured lakes and rivers atomically', () => {
    const map = createEmptyMap('waters', 'map-water-test');
    const result = applyMapOperations(map, [
      {
        type: 'water.add',
        water: {
          id: 'lake-1',
          name: '中央湖泊',
          type: 'lake',
          level: 0.45,
          points: [[-4, -3], [4, -3], [5, 3], [-3, 4]]
        }
      },
      {
        type: 'water.add',
        water: {
          id: 'river-1',
          name: '北侧河流',
          type: 'river',
          level: 0.32,
          width: 1.4,
          points: [[-7, -6], [-1, -2], [6, 5]]
        }
      },
      { type: 'water.update', waterId: 'lake-1', patch: { level: 0.6 } },
      { type: 'water.remove', waterId: 'river-1' }
    ]);

    expect(result.waterBodies).toHaveLength(1);
    expect(result.waterBodies[0]).toMatchObject({
      id: 'lake-1',
      name: '中央湖泊',
      type: 'lake',
      level: 0.6
    });
    expect(map.waterBodies).toHaveLength(0);
  });

  it('carves a lake basin into the terrain so the water plane sits inside it', () => {
    const map = createEmptyMap('lake basin', 'map-lake-basin');
    const lake = {
      id: 'lake-1',
      name: '湖泊',
      type: 'lake' as const,
      level: 1,
      depth: 2,
      points: [[-6, -6], [6, -6], [6, 6], [-6, 6]] as Array<[number, number]>
    };
    const result = applyMapOperations(map, [{ type: 'water.add', water: lake }]);

    // Basin floor reaches level - depth, and nothing inside the lake pokes
    // above the water plane.
    expect(sampleTerrainHeight(result, 0, 0)).toBeCloseTo(-1, 4);
    for (const [x, z] of [[0, 0], [4, 4], [-5.5, 0], [0, 5.5]]) {
      expect(sampleTerrainHeight(result, x, z)).toBeLessThan(lake.level);
    }
    // Terrain outside the polygon is untouched.
    expect(sampleTerrainHeight(result, 12, 12)).toBeCloseTo(0, 4);

    // Re-applying the same geometry must not dig progressively deeper.
    const recarved = applyMapOperations(result, [
      { type: 'water.update', waterId: 'lake-1', patch: { level: 1 } }
    ]);
    expect(sampleTerrainHeight(recarved, 0, 0)).toBeCloseTo(-1, 4);
    expect(sampleTerrainHeight(recarved, 4, 4)).toBeCloseTo(sampleTerrainHeight(result, 4, 4), 4);
  });

  it('rejects malformed structured water without mutating the map', () => {
    const map = createEmptyMap('unchanged', 'map-water-invalid');

    expect(() => applyMapOperations(map, [{
      type: 'water.add',
      water: {
        id: 'bad-lake',
        name: '坏湖泊',
        type: 'lake',
        level: 0.4,
        points: [[0, 0], [1, 1]]
      }
    }])).toThrow('invalid_water_body');
    expect(map.waterBodies).toHaveLength(0);
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

  it('rejects assets from a different map generation mode at the transaction boundary', async () => {
    const store = await createStore();
    const map = await store.createMap({ name: 'PRO map', assetGenerationMode: 'standard' });
    const voxelAsset = await store.saveAsset({
      name: 'Voxel tree',
      prompt: 'tree',
      modelJson: {},
      mode: 'voxel'
    });

    await expect(store.commitTransaction(map.id, {
      source: 'basic-ai',
      operations: [{
        type: 'object.add',
        object: { name: 'Wrong style tree', assetId: voxelAsset.id }
      }]
    })).rejects.toThrow('map_asset_mode_mismatch');

    expect((await store.loadMap(map.id)).objects).toHaveLength(0);
  });

  it('lists only supported panoramas from the hdri directory and resolves them by name', async () => {
    const store = await createStore();
    const hdriDir = path.join(store.rootDir, 'hdri');
    await writeFile(path.join(hdriDir, 'meadow.hdr'), 'not-a-real-hdr');
    await writeFile(path.join(hdriDir, 'studio.jpg'), 'not-a-real-jpg');
    await writeFile(path.join(hdriDir, 'notes.txt'), 'ignored');
    await writeFile(path.join(hdriDir, 'catalog.json'), JSON.stringify({
      textures: [{
        file: 'meadow.hdr',
        tags: ['day', 'forest'],
        skyColor: '#aaccff',
        groundColor: '#61745a'
      }]
    }));

    const textures = await store.listHdriTextures();

    expect(textures.map((texture) => texture.file)).toEqual(['meadow.hdr', 'studio.jpg']);
    expect(textures[0]).toMatchObject({
      id: 'meadow', extension: 'hdr', tags: ['day', 'forest'], skyColor: '#aaccff', groundColor: '#61745a'
    });
    expect(await store.resolveHdriFile('meadow.hdr')).toBe(path.join(hdriDir, 'meadow.hdr'));
    // Unlisted names must not become a path, or the route turns into a file read primitive.
    expect(await store.resolveHdriFile('../../maps/secret.json')).toBeNull();
    expect(await store.resolveHdriFile('notes.txt')).toBeNull();
  });

  it('persists one time and temperature category per HDRI without losing swatches', async () => {
    const store = await createStore();
    const hdriDir = path.join(store.rootDir, 'hdri');
    await writeFile(path.join(hdriDir, 'forest.exr'), 'not-a-real-exr');
    await writeFile(path.join(hdriDir, 'catalog.json'), JSON.stringify({
      textures: [{
        file: 'forest.exr',
        tags: ['forest', 'morning', 'cool'],
        skyColor: '#aaccff',
        groundColor: '#61745a'
      }]
    }));

    const updated = await store.updateHdriClassification('forest.exr', {
      timeOfDay: 'evening',
      temperature: 'warm'
    });
    const restarted = new MapStore({ rootDir: store.rootDir });
    const [persisted] = await restarted.listHdriTextures();

    expect(updated.tags).toEqual(['forest', 'evening', 'warm']);
    expect(persisted).toMatchObject({
      tags: ['forest', 'evening', 'warm'],
      skyColor: '#aaccff',
      groundColor: '#61745a'
    });
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
