import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { createEmptyMap } from '../src/shared/map';
import { createPlannedWorldSampler, validateWorldBundle } from '../src/shared/worldPlanning';

const bundle = validateWorldBundle(JSON.parse(readFileSync(
  new URL('../scripts/fixtures/hierarchical-world.json', import.meta.url),
  'utf8'
).replace(/^\uFEFF/, '')));

beforeEach(() => vi.stubGlobal('document', {
  createElement: () => ({ width: 0, height: 0, getContext: () => null })
}));
afterEach(() => vi.unstubAllGlobals());

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('streaming_timeout');
}

describe('main editor streamed world renderer', () => {
  it('bounds resident terrain/content and keeps manual objects in the live collision world', async () => {
    const map = createEmptyMap();
    const town = bundle.plan.towns[0];
    const sample = createPlannedWorldSampler(bundle.plan, bundle.patches);
    map.world = { bundle, assets: [] };
    map.box.size = [bundle.plan.recipe.size, 4096, bundle.plan.recipe.size];
    map.spawnPoints = [[town.center[0], sample(...town.center).height, town.center[1]]];
    map.objects = [{
      id: 'manual-root', name: 'Manual root', parentId: null, assetId: null,
      transform: { position: [town.center[0] + 4, sample(town.center[0] + 4, town.center[1]).height, town.center[1]], rotation: [0, 0, 0], scale: [1, 1, 1], size: [2, 3, 2] },
      heightMode: 'fixed', visible: true, locked: false, behavior: { kind: 'static', locomotion: 'static' }
    }, {
      id: 'manual-child', name: 'Manual child', parentId: 'manual-root', assetId: null,
      transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1] },
      heightMode: 'fixed', visible: true, locked: false, behavior: { kind: 'static', locomotion: 'static' }
    }];

    const rendered = await buildEditableMapGroup(map);
    try {
      const stats = rendered.getDebugStats().streaming!;
      expect(stats.terrainTiles).toBeGreaterThan(1);
      expect(stats.terrainTiles).toBeLessThanOrEqual(128);
      expect(stats.contentChunks).toBeLessThanOrEqual(25);
      expect(stats.buildings).toBeGreaterThan(0);
      expect(stats.texturePixels).toBeLessThanOrEqual(128 * 128 * 128 * 4 + 25 * 32 * 32 * 4);
      expect(stats.collisionMeshes).toBeGreaterThan(0);
      expect(stats.finestTerrainSpacing).toBeGreaterThan(0);
      expect(rendered.objectGroups.has('manual-root')).toBe(true);
      expect(rendered.objectGroups.has('manual-child')).toBe(true);
      expect(rendered.getCollisionWorld?.()?.instances.some(instance => instance.id.includes('manual-root'))).toBe(true);
      const position = rendered.objectGroups.get('manual-root')!.getWorldPosition(new THREE.Vector3());
      expect(position.x).toBeCloseTo(town.center[0] + 4);
      expect(position.z).toBeCloseTo(town.center[1]);
      await waitFor(() => rendered.getDebugStats().streaming?.pendingTiles === 0);
      const collision = rendered.getCollisionWorld?.();
      const manualGroup = rendered.objectGroups.get('manual-root');
      const manualCollision = collision?.instances.find(instance => instance.id.includes('manual-root'));
      let contentChanges = 0;
      const unsubscribe = rendered.subscribeContentChanges?.(() => { contentChanges += 1; });
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(town.center[0], sample(...town.center).height + 100, town.center[1]);
      camera.lookAt(town.center[0], sample(...town.center).height, town.center[1]);
      rendered.update(1 / 60, camera, 1_000);
      rendered.update(1 / 60, camera, 1_000);
      await Promise.resolve();
      expect(rendered.getCollisionWorld?.()).toBe(collision);
      expect(contentChanges).toBe(0);
      camera.position.x += 24;
      camera.lookAt(town.center[0] + 24, sample(town.center[0] + 24, town.center[1]).height, town.center[1]);
      rendered.update(1 / 60, camera, 1_000);
      await Promise.resolve();
      expect(rendered.getCollisionWorld?.()).toBe(collision);
      expect(contentChanges).toBe(0);
      const localX = town.center[0] - Math.floor(town.center[0] / 256) * 256;
      const movedX = town.center[0] + (localX <= 128 ? 160 : -160);
      camera.position.set(movedX, sample(movedX, town.center[1]).height + 100, town.center[1]);
      camera.lookAt(movedX, sample(movedX, town.center[1]).height, town.center[1]);
      rendered.update(1 / 60, camera, 1_000);
      await waitFor(() => contentChanges > 0 && rendered.getDebugStats().streaming?.pendingTiles === 0);
      expect(rendered.objectGroups.get('manual-root')).toBe(manualGroup);
      expect(rendered.getCollisionWorld?.()?.instances.find(instance => instance.id.includes('manual-root'))).toBe(manualCollision);
      unsubscribe?.();
    } finally {
      rendered.dispose();
    }
  }, 30_000);
});
