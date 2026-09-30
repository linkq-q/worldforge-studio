import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMapHttp } from '../src/server/mapHttp';
import { MapStore } from '../src/server/mapStore';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('editor asset catalog', () => {
  it('lists lightweight summaries while preserving exact-id full asset loading', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-asset-catalog-'));
    tempDirs.push(rootDir);
    const store = new MapStore({ rootDir });
    const asset = await store.saveAsset({
      name: 'Repeated harbor house',
      prompt: 'A reusable harbor house',
      tags: ['house', 'harbor'],
      modelJson: {
        format: 2,
        nodes: Array.from({ length: 200 }, (_, index) => ({
          id: `part-${index}`,
          mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 } }
        }))
      }
    });
    const server = http.createServer((req, res) => {
      void handleMapHttp(req, res, store).then((handled) => {
        if (!handled) { res.writeHead(404); res.end(); }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = (server.address() as { port: number }).port;
      const catalogResponse = await fetch(`http://127.0.0.1:${port}/api/editor/assets`);
      const catalogText = await catalogResponse.text();
      const catalog = JSON.parse(catalogText) as { assets: Array<Record<string, unknown>> };

      expect(catalogResponse.status).toBe(200);
      expect(catalog.assets).toHaveLength(1);
      expect(catalog.assets[0]).toMatchObject({
        id: asset.id,
        name: asset.name,
        colliderBoxCount: asset.colliderPlan.boxes.length,
        colliderFallbackUsed: asset.colliderPlan.fallbackUsed
      });
      expect(catalog.assets[0]).not.toHaveProperty('modelJson');
      expect(catalog.assets[0]).not.toHaveProperty('colliderPlan');

      const fullResponse = await fetch(`http://127.0.0.1:${port}/api/editor/assets/${asset.id}`);
      const fullText = await fullResponse.text();
      const full = JSON.parse(fullText) as { asset: { id: string; modelJson?: unknown; colliderPlan?: unknown } };
      expect(fullResponse.status).toBe(200);
      expect(full.asset).toMatchObject({ id: asset.id, modelJson: asset.modelJson, colliderPlan: asset.colliderPlan });
      expect(catalogText.length).toBeLessThan(fullText.length / 4);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
