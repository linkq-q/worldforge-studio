import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { worldRoadSurfaceMaterial, worldTileSurfaceWeight } from '../src/client/worldMapRenderer';
import { createEmptyMap } from '../src/shared/map';
import { createPlannedWorldSampler, validateWorldBundle } from '../src/shared/worldPlanning';
import { WORLD_BIOMES, type WorldTileData } from '../src/shared/worldTerrain';

const bundle = validateWorldBundle(JSON.parse(readFileSync(
  new URL('../scripts/fixtures/hierarchical-world.json', import.meta.url),
  'utf8'
).replace(/^\uFEFF/, '')));
const smallBundle = validateWorldBundle({
  plan: {
    version: 1, id: 'small-world', revision: 1, prompt: 'small grassland',
    recipe: { version: 1, seed: 17, size: 500, constraints: [{ region: 'center', biome: 'grassland' }] },
    ecology: [], towns: [], roads: []
  },
  patches: []
});

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
  it('makes a validated harbor quay visually distinct without widening its safe footprint', () => {
    expect(worldRoadSurfaceMaterial({id:'town:harbor:landing',tags:['settlement','sea-landing','harbor-quay']})).toBe('cobblestone');
    expect(worldRoadSurfaceMaterial({id:'town:harbor:street',tags:['settlement','street']})).toBe('brick-paver');
  });

  it('derives a coastal sand band without turning inland lowlands into beach', () => {
    const tile = { x: 0, z: 0, size: 16 };
    const tileData = (ocean: number): WorldTileData => {
      const weights = new Float32Array(4 * WORLD_BIOMES.length);
      for (let index = 0; index < 4; index += 1) {
        weights[index * WORLD_BIOMES.length + WORLD_BIOMES.indexOf('ocean')] = ocean;
        weights[index * WORLD_BIOMES.length + WORLD_BIOMES.indexOf('grassland')] = 1 - ocean;
      }
      return {
        heights: new Float32Array([4, 4, 4, 4]),
        normals: new Float32Array(),
        weights,
        waterLevels: new Float32Array([0, 0, 0, 0]),
        resolution: 2
      };
    };

    expect(worldTileSurfaceWeight(tileData(0.4), tile, 8, 8, ['sand'])).toBe(1);
    expect(worldTileSurfaceWeight(tileData(0), tile, 8, 8, ['sand'])).toBe(0);
    expect(worldTileSurfaceWeight(tileData(0), tile, 8, 8, ['grass'])).toBe(1);
  });

  it('does not add terrain skirts between equal-LOD tiles', async () => {
    const map = createEmptyMap();
    map.world = { bundle: smallBundle, assets: [] };
    map.box.size = [500, 4096, 500];
    const rendered = await buildEditableMapGroup(map, { worldInitialView: { x: 0, z: 0, distance: 400 } });
    try {
      const terrains: THREE.Mesh[] = [];
      rendered.group.traverse(object => {
        if (object.name === 'terrain' && object.visible) terrains.push(object as THREE.Mesh);
      });
      expect(terrains).toHaveLength(16);
      expect(terrains.every(terrain => terrain.geometry.getAttribute('position').count === 65 * 65)).toBe(true);
      rendered.group.updateMatrixWorld(true);
      const edges = new Map<string, { y: number; normal: THREE.Vector3 }>();
      let sharedVertices = 0;
      for (const terrain of terrains) {
        const positions = terrain.geometry.getAttribute('position');
        const normals = terrain.geometry.getAttribute('normal');
        for (let index = 0; index < positions.count; index += 1) {
          const x = positions.getX(index), z = positions.getZ(index);
          if (Math.abs(Math.abs(x) - 31.25) > 1e-5 && Math.abs(Math.abs(z) - 31.25) > 1e-5) continue;
          const world = terrain.localToWorld(new THREE.Vector3(x, positions.getY(index), z));
          const key = `${world.x.toFixed(4)}:${world.z.toFixed(4)}`;
          const normal = new THREE.Vector3().fromBufferAttribute(normals, index);
          const previous = edges.get(key);
          if (previous) {
            sharedVertices += 1;
            expect(world.y).toBeCloseTo(previous.y, 6);
            expect(normal.distanceTo(previous.normal)).toBeLessThan(1e-5);
          } else edges.set(key, { y: world.y, normal });
        }
      }
      expect(sharedVertices).toBeGreaterThan(0);
    } finally {
      rendered.dispose();
    }
  }, 30_000);

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
      expect(stats.contentChunks).toBe(1);
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
      await waitFor(() => {
        const settled = rendered.getDebugStats().streaming;
        return Boolean(settled && settled.pendingTiles === 0 && settled.contentChunks > 1);
      });
      expect(rendered.getDebugStats().streaming?.contentChunks).toBeGreaterThan(1);
      expect(rendered.objectGroups.get('manual-root')!.getWorldPosition(new THREE.Vector3())).toEqual(position);
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
