import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { buildMapGrassField } from '../src/client/mapGrassRenderer';
import { getCollisionMeshBvhBuildStats, resetCollisionMeshBvhBuildStats } from '../src/client/mapMeshCollision';
import { buildWorldWhiteboxOverlay, worldBuildPaintIntervals, worldCoastalSandWeight, worldGrassChunkBudget, worldGrassLayers, worldOceanAnchor, worldRoadSurfaceMaterial, worldTileSurfaceWeight } from '../src/client/worldMapRenderer';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { createPlannedWorldSampler, validateWorldBundle } from '../src/shared/worldPlanning';
import { DEFAULT_RUNTIME_GRASS_STYLE } from '../src/shared/renderPlan';
import { WORLD_BIOMES, type WorldTileData } from '../src/shared/worldTerrain';

const bundle = validateWorldBundle(JSON.parse(readFileSync(
  new URL('../scripts/fixtures/hierarchical-world.json', import.meta.url),
  'utf8'
).replace(/^\uFEFF/, '')));
const smallBundle = validateWorldBundle({
  plan: {
    version: 1, id: 'small-world', revision: 1, prompt: 'small grassland',
    recipe: { version: 1, seed: 17, size: 500, constraints: [
      { region: 'center', biome: 'grassland' },
      { region: 'north', biome: 'ocean' }, { region: 'east', biome: 'ocean' },
      { region: 'south', biome: 'ocean' }, { region: 'west', biome: 'ocean' }
    ] },
    ecology: [], towns: [], roads: []
  },
  patches: []
});

beforeEach(() => vi.stubGlobal('document', {
  createElement: () => ({ width: 0, height: 0, getContext: () => null })
}));
afterEach(() => vi.unstubAllGlobals());

async function waitFor(predicate: () => boolean, attempts = 600): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('streaming_timeout');
}

function sampleOceanFloor(
  binding: { texture: THREE.DataTexture; terrainSize: [number, number]; mapSize: [number, number]; center: [number, number] },
  x: number,
  z: number
): number {
  const [width, depth] = binding.terrainSize;
  const heights = (binding.texture.image as unknown as { data: Float32Array }).data;
  const gx = THREE.MathUtils.clamp((x - binding.center[0]) / binding.mapSize[0] * (width - 1) + (width - 1) / 2, 0, width - 1);
  const gz = THREE.MathUtils.clamp((z - binding.center[1]) / binding.mapSize[1] * (depth - 1) + (depth - 1) / 2, 0, depth - 1);
  const ix = Math.min(width - 2, Math.floor(gx)), iz = Math.min(depth - 2, Math.floor(gz));
  const fx = gx - ix, fz = gz - iz;
  const a = heights[iz * width + ix], b = heights[iz * width + ix + 1];
  const c = heights[(iz + 1) * width + ix], d = heights[(iz + 1) * width + ix + 1];
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

describe('main editor streamed world renderer', () => {
  it('renders whitebox semantic paths and anchors above sampled terrain', () => {
    const plan = structuredClone(smallBundle.plan);
    plan.whitebox = true;
    plan.featureGraph = {
      regions: [{ id: 'region', kind: 'district', name: 'Region', center: [0, 0], radius: 100 }],
      paths: [{ id: 'route', kind: 'trail', name: 'Route', points: [[-10, 0], [10, 0]], width: 4 }],
      anchors: [{ id: 'poi', kind: 'landmark', position: [3, 4], regionId: 'region' }],
      relations: []
    };
    const overlay = buildWorldWhiteboxOverlay(plan, (x, z) => ({ height: x + z }));
    const path = overlay.getObjectByName('world-whitebox-path:route') as THREE.Line;
    const ribbon = overlay.getObjectByName('world-whitebox-path-surface:route') as THREE.Mesh;
    const anchor = overlay.getObjectByName('world-whitebox-anchor:poi') as THREE.Mesh;
    expect(path.geometry.getAttribute('position').getY(0)).toBeCloseTo(-9.2);
    expect(path.geometry.getAttribute('position').count).toBeGreaterThan(2);
    expect(ribbon.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(anchor.position.toArray()).toEqual([3, 10.3, 4]);
    expect((path.material as THREE.LineBasicMaterial).depthTest).toBe(false);
  });

  it('does not extend a semantic river line past the rendered river mouth', () => {
    const plan = structuredClone(smallBundle.plan);
    plan.whitebox = true;
    plan.recipe.waterBodies = [{
      id: 'river-water', type: 'river',
      region: { kind: 'path', points: [[-12, 0], [0, 3], [6, 1.5], [12, 0]], width: 18 },
      levels: [2, 1, 0.5, 0], depth: 3
    }];
    plan.featureGraph = {
      regions: [],
      paths: [
        { id: 'river-feature', kind: 'watercourse', name: 'River', points: [[-12, 0], [0, 3], [12, 0]], width: 18 },
        { id: 'trail', kind: 'trail', name: 'Trail', points: [[-10, 8], [10, 8]], width: 3 }
      ],
      anchors: [], relations: []
    };

    const overlay = buildWorldWhiteboxOverlay(plan, () => ({ height: -2, waterLevel: 1 }));
    expect(overlay.getObjectByName('world-whitebox-path:river-feature')).toBeUndefined();
    expect(overlay.getObjectByName('world-whitebox-path-surface:river-feature')).toBeUndefined();
    expect(overlay.getObjectByName('world-whitebox-path-surface:trail')).toBeInstanceOf(THREE.Mesh);
  });

  it('outlines only unique authored settlement and intentional-empty regions in whitebox mode', () => {
    const plan = structuredClone(smallBundle.plan);
    plan.whitebox = true;
    plan.featureGraph = {
      regions: [
        { id: 'town-region', kind: 'district', name: 'Town', center: [10, 20], radius: 40 },
        { id: 'quiet-region', kind: 'wilds', name: 'Quiet', center: [-60, 0], radius: 25 },
        { id: 'other-region', kind: 'ridge', name: 'Other', center: [0, -80], radius: 30 }
      ],
      paths: [],
      anchors: [
        { id: 'town-a', kind: 'settlement', position: [10, 20], regionId: 'town-region' },
        { id: 'town-b', kind: 'settlement', position: [15, 20], regionId: 'town-region' }
      ],
      relations: []
    };
    plan.settlementPlan = { settlements: [
      { id: 'a', anchorId: 'town-a', role: 'core' }, { id: 'b', anchorId: 'town-b', role: 'edge' }
    ] };
    plan.intentionalEmptyAreas = [
      { id: 'quiet-a', regionId: 'quiet-region', purpose: 'pause' },
      { id: 'quiet-b', regionId: 'quiet-region', purpose: 'silence' }
    ];

    const overlay = buildWorldWhiteboxOverlay(plan, () => ({ height: 2 }));
    const outlines = overlay.children.filter(child => child.name.startsWith('world-whitebox-region:')) as THREE.LineLoop[];
    expect(outlines.map(outline => outline.name).sort()).toEqual([
      'world-whitebox-region:empty:quiet-region', 'world-whitebox-region:settlement:town-region'
    ]);
    expect(outlines.every(outline => outline.geometry.getAttribute('position').count === 48)).toBe(true);
    expect(outlines.every(outline => (outline.material as THREE.LineBasicMaterial).depthTest === false)).toBe(true);
    expect(overlay.getObjectByName('world-whitebox-region:settlement:other-region')).toBeUndefined();

    delete plan.whitebox;
    expect(buildWorldWhiteboxOverlay(plan, () => ({ height: 2 })).children).toHaveLength(0);
  });

  it('marks submerged whitebox anchors visibly without relocating the authored point', () => {
    const plan = structuredClone(smallBundle.plan);
    plan.whitebox = true;
    plan.featureGraph = {
      regions: [{ id: 'shore', kind: 'coast', name: 'Shore', center: [0, 0], radius: 40 }],
      paths: [],
      anchors: [
        { id: 'wet', kind: 'harbor', position: [2, 3], regionId: 'shore' },
        { id: 'dry', kind: 'market', position: [12, 3], regionId: 'shore' }
      ],
      relations: []
    };
    const overlay = buildWorldWhiteboxOverlay(plan, (x) => x < 10
      ? { height: -1, waterLevel: 0 } : { height: 2, waterLevel: null });
    const wet = overlay.getObjectByName('world-whitebox-anchor:wet') as THREE.Mesh;
    const dry = overlay.getObjectByName('world-whitebox-anchor:dry') as THREE.Mesh;
    expect((wet.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xff5252);
    expect((dry.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0xffb547);
    expect(wet.position.toArray()).toEqual([2, 3.3, 3]);
    expect(dry.position.toArray()).toEqual([12, 5.3, 3]);
    expect(overlay.getObjectByName('world-whitebox-anchor-wet:wet')).toBeInstanceOf(THREE.LineLoop);
    expect(overlay.getObjectByName('world-whitebox-anchor-wet:dry')).toBeUndefined();
  });

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
        freshWaterWeights: new Float32Array(4),
        resolution: 2
      };
    };

    expect(worldTileSurfaceWeight(tileData(0.4), tile, 8, 8, ['sand'])).toBeGreaterThan(0.6);
    expect(worldTileSurfaceWeight(tileData(0), tile, 8, 8, ['sand'])).toBe(0);
    expect(worldTileSurfaceWeight(tileData(0), tile, 8, 8, ['grass'])).toBe(1);
    expect(worldGrassLayers(tileData(0), tile)[0].densities.every(density => density > 0.7)).toBe(true);
    expect(worldCoastalSandWeight(16, 0.4)).toBe(0);
    expect(worldCoastalSandWeight(4, 0.4)).toBeGreaterThan(0.6);

    const inlandWater = tileData(0);
    inlandWater.freshWaterWeights.fill(1);
    expect(worldTileSurfaceWeight(inlandWater, tile, 8, 8, ['water'])).toBe(1);
    expect(worldTileSurfaceWeight(inlandWater, tile, 8, 8, ['sand'])).toBe(0);
    expect(worldTileSurfaceWeight(inlandWater, tile, 8, 8, ['grass'])).toBe(0);

    const freshWaterBank = tileData(0);
    freshWaterBank.freshWaterWeights.fill(0.7);
    expect(worldTileSurfaceWeight(freshWaterBank, tile, 8, 8, ['sand'])).toBe(0);
    expect(worldTileSurfaceWeight(freshWaterBank, tile, 8, 8, ['grass'])).toBeLessThan(0.8);
    expect(worldTileSurfaceWeight(freshWaterBank, tile, 8, 8, ['water'])).toBeCloseTo(0.7);

    const lowRiverbank = tileData(0.4);
    lowRiverbank.freshWaterWeights.fill(0.7);
    expect(worldTileSurfaceWeight(lowRiverbank, tile, 8, 8, ['sand'])).toBeLessThanOrEqual(0.08);

  });

  it('does not outline freshwater banks with parallel sand and rock ribbons', () => {
    const tile = { x: 0, z: 0, size: 20 };
    const data = (heights: number[], freshWater: number, ocean: number): WorldTileData => {
      const weights = new Float32Array(9 * WORLD_BIOMES.length);
      for (let index = 0; index < 9; index += 1) {
        weights[index * WORLD_BIOMES.length + WORLD_BIOMES.indexOf('ocean')] = ocean;
        weights[index * WORLD_BIOMES.length + WORLD_BIOMES.indexOf('grassland')] = 1 - ocean;
      }
      return {
        heights: new Float32Array(heights), normals: new Float32Array(), weights,
        waterLevels: new Float32Array(9), freshWaterWeights: new Float32Array(9).fill(freshWater), resolution: 3
      };
    };

    const lowTransition = data([4, 4, 4, 4, 4, 4, 4, 4, 4], 0.92, 0.4);
    expect(worldTileSurfaceWeight(lowTransition, tile, 10, 10, ['sand'])).toBe(0);
    const steepBank = data([0, 10, 20, 0, 10, 20, 0, 10, 20], 0.7, 0);
    expect(worldTileSurfaceWeight(steepBank, tile, 10, 10, ['rocky'])).toBeLessThan(0.05);
  });

  it('gives compact grassland chunks dense ground cover within the resident streaming budget', () => {
    const tile = { x: -128, z: -128, size: 256 };
    const weights = new Float32Array(4 * WORLD_BIOMES.length);
    for (let index = 0; index < 4; index += 1) {
      weights[index * WORLD_BIOMES.length + WORLD_BIOMES.indexOf('grassland')] = 1;
    }
    const tileData: WorldTileData = {
      heights: new Float32Array(4), normals: new Float32Array(), weights,
      waterLevels: new Float32Array(4), freshWaterWeights: new Float32Array(4), resolution: 2
    };
    const grassMap = createEmptyMap('streamed grass budget', 'streamed-grass-budget', [tile.size, 32, tile.size]);
    grassMap.terrain = { resolutionX: 2, resolutionZ: 2, heights: [0, 0, 0, 0] };
    grassMap.grassLayers = worldGrassLayers(tileData, tile);
    const grass = buildMapGrassField(grassMap, {
      ...DEFAULT_RUNTIME_GRASS_STYLE,
      maxInstances: worldGrassChunkBudget(4)
    })!;
    expect(grass.getStats().bladeCount).toBeGreaterThan(3_500);
    expect(grass.getStats().bladeCount).toBeLessThanOrEqual(15_000);
    expect(worldGrassChunkBudget(25) * 25).toBeLessThanOrEqual(120_000);
    grass.dispose();
  });

  it('reserves clean paint intervals after an expensive streamed chunk', () => {
    expect(worldBuildPaintIntervals(0)).toBe(1);
    expect(worldBuildPaintIntervals(4, 3)).toBe(3);
    expect(worldBuildPaintIntervals(40, 3)).toBe(5);
    expect(worldBuildPaintIntervals(4, 3, 113)).toBe(15);
  });

  it('keeps compact-world ocean ownership fixed while large worlds follow the streamed focus', () => {
    expect(worldOceanAnchor(500, 160, -90)).toEqual({ x: 0, z: 0 });
    expect(worldOceanAnchor(64_000, 160, -90)).toEqual({ x: 160, z: -90 });
  });

  it('exposes steep inland terrain as rock without changing flat biome weights', () => {
    const tile = { x: 0, z: 0, size: 20 };
    const weights = new Float32Array(9 * WORLD_BIOMES.length);
    for (let index = 0; index < 9; index += 1) {
      weights[index * WORLD_BIOMES.length + WORLD_BIOMES.indexOf('grassland')] = 1;
    }
    const data = (heights: number[]): WorldTileData => ({
      heights: new Float32Array(heights), normals: new Float32Array(), weights,
      waterLevels: new Float32Array(9), freshWaterWeights: new Float32Array(9), resolution: 3
    });

    expect(worldTileSurfaceWeight(data([0, 0, 0, 0, 0, 0, 0, 0, 0]), tile, 10, 10, ['rocky'])).toBe(0);
    const steep = data([0, 10, 20, 0, 10, 20, 0, 10, 20]);
    expect(worldTileSurfaceWeight(steep, tile, 10, 10, ['rocky'])).toBe(1);
    expect(worldTileSurfaceWeight(steep, tile, 10, 10, ['grass'])).toBeCloseTo(0.28);
  });

  it('streams equal-LOD terrain and content progressively without skirts', async () => {
    let paintYields = 0;
    let streamed: Awaited<ReturnType<typeof buildEditableMapGroup>> | undefined;
    let sawProgressiveTerrain = false;
    let sawProgressiveContent = false;
    let sawDeferredOcean = false;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      setTimeout(() => {
        paintYields += 1;
        if (streamed) {
          const stats = streamed.getDebugStats().streaming!;
          const mounted = streamed.group.children.map(child => child.name);
          if (stats.pendingTiles > 0) {
            sawProgressiveTerrain ||= mounted.filter(name => name.startsWith('world-tile:')).length > stats.terrainTiles;
            sawProgressiveContent ||= mounted.filter(name => name.startsWith('world-content:')).length > stats.contentChunks;
            sawDeferredOcean ||= streamed.group.getObjectByName('water:world-ocean')?.parent?.visible === false;
          }
        }
        callback(performance.now());
      }, 0);
      return paintYields + 1;
    }));
    const map = createEmptyMap();
    map.world = { bundle: smallBundle, assets: [] };
    map.box.size = [500, 4096, 500];
    const originalSample = createPlannedWorldSampler(smallBundle.plan, smallBundle.patches);
    streamed = await buildEditableMapGroup(map, { worldInitialView: { x: 0, z: 0, distance: 400 } });
    const rendered = streamed;
    try {
      const terrains: THREE.Mesh[] = [];
      rendered.group.traverse(object => {
        if (object.name === 'terrain' && object.visible) terrains.push(object as THREE.Mesh);
      });
      expect(terrains).toHaveLength(16);
      expect(terrains.every(terrain => (
        (terrain.material as THREE.MeshStandardMaterial).map?.image as HTMLCanvasElement
      ).width === 256)).toBe(true);
      const ocean = rendered.group.getObjectByName('water:world-ocean') as THREE.Mesh;
      expect(ocean.parent?.visible).toBe(false);
      expect(ocean.userData.waterOceanTerrain).toBeDefined();
      expect(ocean.userData.waterOceanTerrain.mapSize[0]).toBeGreaterThanOrEqual(500);
      expect(ocean.userData.waterOceanTerrain.mapSize[1]).toBeGreaterThanOrEqual(500);
      let oceanCount = 0;
      rendered.group.traverse(object => { if (object.name === 'water:world-ocean') oceanCount += 1; });
      expect(oceanCount).toBe(1);
      expect(rendered.getDebugStats().grassBlades).toBeGreaterThan(0);
      expect(rendered.getDebugStats().grassBlades).toBeLessThanOrEqual(15_000);
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(160, 100, 0);
      camera.lookAt(160, 0, 0);
      rendered.update(1 / 60, camera, 1_000);
      await new Promise(resolve => setTimeout(resolve, 20));
      await waitFor(() => {
        if (rendered.getDebugStats().streaming?.pendingTiles !== 0) return false;
        let visible = true;
        rendered.modelsRoot.traverse(object => {
          if (object.userData.isStructuredWaterRoot === true) visible &&= object.visible;
        });
        return visible;
      }, 1_000);
      expect(rendered.group.getObjectByName('water:world-ocean')).toBe(ocean);
      expect(paintYields).toBeGreaterThanOrEqual(16);
      expect(sawProgressiveTerrain).toBe(true);
      expect(sawProgressiveContent).toBe(true);
      expect(sawDeferredOcean).toBe(true);
      rendered.modelsRoot.traverse(object => {
        if (object.userData.isStructuredWaterRoot === true) expect(object.visible).toBe(true);
      });
      expect(terrains.every(terrain => terrain.geometry.getAttribute('position').count === 65 * 65)).toBe(true);
      rendered.group.updateMatrixWorld(true);
      const oceanFloor = ocean.userData.waterOceanTerrain as Parameters<typeof sampleOceanFloor>[0];
      let sunkVertices = 0;
      for (const terrain of terrains) {
        const positions = terrain.geometry.getAttribute('position');
        for (let index = 0; index < positions.count; index += 1) {
          const world = terrain.localToWorld(new THREE.Vector3(
            positions.getX(index), positions.getY(index), positions.getZ(index)
          ));
          const authored = originalSample(world.x, world.z).height;
          if (authored > 0) expect(world.y).toBeCloseTo(authored, 4);
          else {
            const expected = Math.min(authored, sampleOceanFloor(oceanFloor, world.x, world.z));
            expect(world.y).toBeCloseTo(expected, 4);
            if (expected < authored - 0.05) sunkVertices += 1;
          }
        }
      }
      expect(sunkVertices).toBeGreaterThan(0);
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

    resetCollisionMeshBvhBuildStats();
    const rendered = await buildEditableMapGroup(map);
    try {
      const stats = rendered.getDebugStats().streaming!;
      const bvhBuilds = getCollisionMeshBvhBuildStats();
      expect(bvhBuilds.count).toBe(stats.collisionMeshes);
      expect(bvhBuilds.totalMs).toBeGreaterThan(0);
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
      expect(rendered.pickables.some(object => object.userData.mapObjectId === 'manual-root')).toBe(true);
      expect(rendered.getCollisionWorld?.()?.raycastFirst(
        [position.x, position.y + 10, position.z], [0, -1, 0], 20, new Set(['scene'])
      )?.meshId).toContain('manual-root');
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

  it('keeps ordinary raw construction visible as primitives beside a partial asset pack', async () => {
    const map = createEmptyMap();
    const town = bundle.plan.towns[0];
    const sample = createPlannedWorldSampler(bundle.plan, bundle.patches);
    const landmarkAsset: MapAsset = {
      id: 'asset-landmark', name: 'Landmark', prompt: 'Landmark', modelJson: {},
      colliderPlan: {version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true},
      mode: 'voxel', createdAt: 1, updatedAt: 1
    };
    map.assets = [landmarkAsset];
    map.world = {bundle, assets: [{key: 'landmarks', role: 'landmark', assetId: landmarkAsset.id}]};
    map.box.size = [bundle.plan.recipe.size, 4096, bundle.plan.recipe.size];
    map.spawnPoints = [[town.center[0], sample(...town.center).height, town.center[1]]];

    const rendered = await buildEditableMapGroup(map);
    try {
      await waitFor(() => rendered.objectGroups.has('world-building:forest-south-home-center'));
      expect(rendered.objectGroups.get('world-building:forest-south-home-center')).toBeInstanceOf(THREE.Group);
    } finally {
      rendered.dispose();
    }
  }, 30_000);
});
