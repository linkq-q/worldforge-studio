import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MapStore } from '../src/server/mapStore';
import { normalizeAssetTags } from '../src/shared/mapAssetMetadata';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('map asset metadata', () => {
  it('normalizes semantic asset tags without mixing arbitrary text', () => {
    expect(normalizeAssetTags([' Tree ', 'vegetation', 'TREE', '树', 'rock!'])).toEqual([
      'tree', 'vegetation', 'rock'
    ]);
  });

  it('persists tags and derives footprint metadata from the generated model', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-asset-metadata-'));
    tempDirs.push(rootDir);
    const store = new MapStore({ rootDir });
    const asset = await store.saveAsset({
      name: 'Tagged tree',
      prompt: 'tree',
      tags: ['tree', 'vegetation'],
      light: { kind: 'spot', color: '#80c8ff', intensity: 6, range: 14, offset: [0, 0.5, 0], direction: [0, -1, 0], coneAngleDegrees: 42, penumbra: 0.3 },
      modelJson: {
        format: 2,
        nodes: [{
          id: 'trunk',
          transform: { pos: [0, 1, 0] },
          mesh: { type: 'box', params: { width: 2, height: 2, depth: 2 } }
        }]
      }
    });

    expect(asset.tags).toEqual(['tree', 'vegetation']);
    expect(asset.footprintRadius).toBeGreaterThanOrEqual(1);
    expect(asset.sizeClass).toBe('medium');
    expect(asset.light).toEqual({
      kind: 'spot', color: '#80c8ff', intensity: 6, range: 14,
      offset: [0, 0.5, 0], direction: [0, -1, 0], coneAngleDegrees: 42, penumbra: 0.3
    });
    expect((await store.loadAsset(asset.id)).tags).toEqual(['tree', 'vegetation']);
    expect((await store.loadAsset(asset.id)).light?.kind).toBe('spot');
  });
});
