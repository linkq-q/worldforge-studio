import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { buildMapGrassField } from '../src/client/mapGrassRenderer';
import * as grassRenderer from '../src/client/mapGrassRenderer';
import { worldBridgeDeck } from '../src/client/worldContent';
import { getCollisionMeshBvhBuildStats, resetCollisionMeshBvhBuildStats } from '../src/client/mapMeshCollision';
import { buildWorldWhiteboxOverlay, worldBuildPaintIntervals, worldCoastalSandWeight, worldGrassChunkBudget, worldGrassLayers, worldOceanAnchor, worldRoadSurfaceMaterial, worldRoadSurfaceStyle, worldTileSurfaceWeight, yieldWorldBuild } from '../src/client/worldMapRenderer';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { createPlannedWorldSampler, validateWorldBundle } from '../src/shared/worldPlanning';
import { DEFAULT_RUNTIME_GRASS_STYLE } from '../src/shared/renderPlan';
import { selectWorldTiles, WORLD_BIOMES, type WorldTileData } from '../src/shared/worldTerrain';

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
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
  it.each([0, 0.2])('keeps streamed street surfaces on visible terrain through tile refinement (slope %s)', async (slope) => {
    const roadBundle = validateWorldBundle({
      plan: {
        version: 1, id: 'street-grounding', revision: 1, prompt: 'street across small mounds',
        generationPolicy: 'raw-first-call',
        recipe: { version: 1, seed: 17, size: 500,
          constraints: [{ region: 'center', biome: 'grassland' }],
          terrainBrushes: [
            { id: 'ground', mode: 'flatten', region: { kind: 'circle', center: [0, 0], radius: 400 }, height: 10 },
            ...(slope ? [{ id: 'slope', mode: 'grade', region: { kind: 'path',
              points: [[-200, 0], [200, 0]], width: 500 }, heights: [20, 100], feather: 0 }] : []),
            ...(slope ? [] : [[25.5, 18.75], [62.5, 37.25]].map((center, index) => ({
              id: `mound-${index}`, mode: 'raise', region: { kind: 'circle', center, radius: 1 }, amount: 1, feather: 1
            })))
          ] },
        ecology: [], towns: [], roads: [{ id: 'street', name: 'Street',
          points: [[12, 12], [80, 46]], curve: 'polyline', closed: false, width: 4, tags: ['settlement'] }, {
          id: 'stone-edge', name: 'Stone edge', points: [[12, 16], [80, 50]], curve: 'polyline',
          closed: false, width: 4, tags: ['working-waterfront'] }, {
          id: 'hill-trail', name: 'Hill trail', points: [[15, 80], [80, 80]], curve: 'polyline',
          closed: false, width: 2, tags: ['footpath'] }]
      }, patches: []
    });
    const map = createEmptyMap();
    map.world = { bundle: roadBundle, assets: [] };
    map.box.size = [500, 4096, 500];
    map.spawnPoints = [[30, 12, 20]];
    const grassSpy = vi.spyOn(grassRenderer, 'buildMapGrassField');
    const rendered = await buildEditableMapGroup(map);
    const assertRoadClearance = () => {
      rendered.group.updateMatrixWorld(true);
      const terrain: THREE.Mesh[] = [], streets: THREE.Mesh[] = [], soilTrails: THREE.Mesh[] = [];
      rendered.group.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !object.visible) return;
        if (object.name === 'terrain') terrain.push(object);
        if (object.name.startsWith('brick-road-surface:world-road:street:')) streets.push(object);
        if (object.name.startsWith('road-surface:world-road:hill-trail:')) soilTrails.push(object);
      });
      expect(streets.length).toBeGreaterThan(0);
      const tileSize = 500 / Math.sqrt(terrain.length);
      const matrix = new THREE.Matrix4();
      let stoneCount = 0;
      rendered.group.traverse(object => {
        if (!(object instanceof THREE.InstancedMesh) || object.name !== 'road-bodies:cobblestone') return;
        stoneCount += object.count;
        for (let index = 0; index < object.count; index += 1) {
          object.getMatrixAt(index, matrix);
          expect(Math.abs(matrix.elements[12])).toBeLessThanOrEqual(tileSize / 2);
          expect(Math.abs(matrix.elements[14])).toBeLessThanOrEqual(tileSize / 2);
        }
      });
      expect(stoneCount).toBeGreaterThan(0);
      const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
      let minimumClearance = Infinity;
      let maximumClearance = -Infinity;
      let minimumAt: number[] = [];
      for (let x = 22; x <= 67; x += 0.1) for (const across of [-1.5, 0, 1.5]) {
        ray.ray.origin.set(x - across / Math.sqrt(5), 100, 6 + x / 2 + across * 2 / Math.sqrt(5));
        const ground = ray.intersectObjects(terrain, false)[0];
        const street = ray.intersectObjects(streets, false)[0];
        expect(ground).toBeDefined();
        expect(street).toBeDefined();
        if (street.point.y - ground.point.y < minimumClearance) minimumAt = [ray.ray.origin.x, ray.ray.origin.z];
        minimumClearance = Math.min(minimumClearance, street.point.y - ground.point.y);
        maximumClearance = Math.max(maximumClearance, street.point.y - ground.point.y);
      }
      expect(minimumClearance, JSON.stringify(minimumAt)).toBeGreaterThan(0);
      if (slope) expect(maximumClearance).toBeLessThan(0.05);
      for (const x of [20, 40, 62.4, 62.6, 70]) {
        ray.ray.origin.set(x, 100, 80);
        const ground = ray.intersectObjects(terrain, false)[0];
        const trail = ray.intersectObjects(soilTrails, false)[0];
        expect(trail).toBeDefined();
        expect(trail.point.y - ground.point.y).toBeGreaterThan(0);
        expect(trail.point.y - ground.point.y).toBeLessThan(0.05);
      }
    };
    try {
      assertRoadClearance();
      await waitFor(() => rendered.group.children.filter(child => child.name.startsWith('world-tile:')).length === 64
        && rendered.getDebugStats().streaming?.pendingTiles === 0, 1_000);
      assertRoadClearance();
      const content = grassSpy.mock.calls.map(([grassMap]) => grassMap)
        .find(grassMap => grassMap.id.endsWith(':content:0:0'))!;
      expect(content).toBeDefined();
      expect(content.grassLayers[0].densities[5 * 65 + 5]).toBe(0);
      expect(content.grassLayers[0].densities[25 * 65 + 25]).toBeGreaterThan(0);
      expect(content.visualSemantics.zones.some(zone => zone.tags.includes('soil'))).toBe(true);
      const terrainMaps = grassSpy.mock.calls.map(([grassMap]) => grassMap)
        .filter(grassMap => grassMap.id.includes(':world:'));
      expect(terrainMaps.length).toBeGreaterThan(0);
      expect(terrainMaps.flatMap(tileMap => tileMap.visualSemantics.zones)
        .some(zone => zone.material === 'compacted-earth')).toBe(true);
      const soilSurfaces: THREE.Mesh[] = [];
      rendered.group.traverse(object => {
        if (object instanceof THREE.Mesh && object.name.startsWith('road-surface:world-road:hill-trail:')) soilSurfaces.push(object);
      });
      expect(soilSurfaces.length).toBeGreaterThan(0);
      expect((soilSurfaces[0].material as THREE.MeshStandardMaterial).color.getHexString()).toBe('967c60');
    } finally {
      rendered.dispose();
      grassSpy.mockRestore();
    }
  }, 30_000);

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

  it('renders an explicitly curved whitebox path through its sampled centerline', () => {
    const plan = structuredClone(smallBundle.plan);
    plan.whitebox = true;
    plan.featureGraph = {
      regions: [],
      paths: [{ id: 'curved-route', kind: 'trail', name: 'Curved route',
        points: [[-20, 0], [0, 20], [20, 0]], curve: 'catmull-rom', width: 3 }],
      anchors: [], relations: []
    };
    const overlay = buildWorldWhiteboxOverlay(plan, () => ({ height: 2 }));
    const path = overlay.getObjectByName('world-whitebox-path:curved-route') as THREE.Line;
    const positions = path.geometry.getAttribute('position');
    const centerline = Array.from({ length: positions.count }, (_, index) =>
      [positions.getX(index), positions.getZ(index)] as [number, number]);
    const distanceToSegment = (point: [number, number], a: [number, number], b: [number, number]) => {
      const dx=b[0]-a[0],dz=b[1]-a[1],length2=dx*dx+dz*dz;
      const t=Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dz)/length2));
      return Math.hypot(point[0]-a[0]-dx*t,point[1]-a[1]-dz*t);
    };
    expect(centerline.some(point => Math.min(distanceToSegment(point,[-20,0],[0,20]),
      distanceToSegment(point,[0,20],[20,0]))>.25)).toBe(true);
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

  it('shows the complete authored path of an infeasible river as a distinct terrain-following intent line', () => {
    const plan = structuredClone(smallBundle.plan);
    plan.whitebox = true;
    plan.recipe.waterBodies = [{
      id: 'infeasible-river', type: 'river', surfaceMode: 'terrain-fit',
      region: { kind: 'path', points: [[-30, 0], [0, 12], [40, 20]], width: 10 },
      depth: 2, shorelineSmoothness: 0, shorelineIrregularity: 0
    }];
    plan.featureGraph = { regions: [], paths: [], anchors: [], relations: [] };
    expect(buildWorldWhiteboxOverlay(plan, () => ({ height: 0 }), true)
      .getObjectByName('world-whitebox-water-intent:infeasible-river')).toBeUndefined();
    const overlay = buildWorldWhiteboxOverlay(plan, (x, z) => ({ height: x / 10 + z / 20 }), true, [{
      code: 'river_profile_infeasible', waterBodyId: 'infeasible-river', reason: 'excessive_cut',
      position: [0, 12], fallback: 'omitted', message: 'infeasible-river: excessive_cut; fallback=omitted.'
    }]);

    const intent = overlay.getObjectByName('world-whitebox-water-intent:infeasible-river') as THREE.Line;
    const positions = intent.geometry.getAttribute('position');
    expect([positions.getX(0), positions.getZ(0)]).toEqual([-30, 0]);
    expect([positions.getX(positions.count - 1), positions.getZ(positions.count - 1)]).toEqual([40, 20]);
    expect(positions.getY(0)).toBeCloseTo(-2.2);
    expect(positions.getY(positions.count - 1)).toBeCloseTo(5.8);
    expect(intent.material).toBeInstanceOf(THREE.LineDashedMaterial);
    expect((intent.material as THREE.LineDashedMaterial).color.getHex()).toBe(0xc778ff);
    expect(overlay.getObjectByName('world-whitebox-water-intent:infeasible-river-surface')).toBeUndefined();
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

  it('renders authored vessels and dockside details as visible whitebox site proxies', () => {
    const plan = structuredClone(smallBundle.plan);
    plan.whitebox = true;
    plan.featureGraph = {
      regions: [{ id: 'harbor', kind: 'harbor', name: 'Harbor', center: [0, 0], radius: 60 }],
      paths: [],
      anchors: [
        { id: 'tour-boat', kind: 'moored-tour-boat', position: [2, 3], regionId: 'harbor',
          site: { role: 'vehicle', surface: 'water', dimensions: [5, 3, 14], rotation: 0.4 } },
        { id: 'net-rack', kind: 'net-drying-rack', position: [16, 3], regionId: 'harbor',
          site: { role: 'equipment', surface: 'land', dimensions: [5, 3, 2] } }
      ],
      relations: []
    };
    const overlay = buildWorldWhiteboxOverlay(plan, (x) => x < 10
      ? { height: -1, waterLevel: 0 } : { height: 2, waterLevel: null });
    const vessel = overlay.getObjectByName('world-whitebox-site:tour-boat') as THREE.Group;
    const equipment = overlay.getObjectByName('world-whitebox-site:net-rack') as THREE.Group;
    expect(vessel).toBeInstanceOf(THREE.Group);
    expect(vessel.getObjectByName('world-whitebox-site-hull:tour-boat')).toBeInstanceOf(THREE.Mesh);
    expect(vessel.getObjectByName('world-whitebox-site-cabin:tour-boat')).toBeInstanceOf(THREE.Mesh);
    expect(vessel.position.toArray()).toEqual([2, 0, 3]);
    expect(vessel.rotation.y).toBeCloseTo(0.4);
    expect(equipment).toBeInstanceOf(THREE.Group);
    expect(equipment.position.toArray()).toEqual([16, 2, 3]);
    expect(equipment.getObjectByName('world-whitebox-site-body:net-rack')).toBeInstanceOf(THREE.Mesh);
    expect(overlay.getObjectByName('world-whitebox-anchor-wet:tour-boat')).toBeUndefined();
    expect(overlay.getObjectByName('world-whitebox-anchor:tour-boat')).toBeUndefined();
  });

  it('makes a validated harbor quay visually distinct without widening its safe footprint', () => {
    expect(worldRoadSurfaceMaterial({id:'town:harbor:landing',tags:['settlement','sea-landing','harbor-quay']})).toBe('cobblestone');
    expect(worldRoadSurfaceMaterial({id:'town:harbor:waterfront',tags:['settlement','working-waterfront']})).toBe('cobblestone');
    expect(worldRoadSurfaceMaterial({id:'island-bridge',tags:['world-route','walking-bridge']})).toBe('cobblestone');
    expect(worldRoadSurfaceMaterial({id:'town:harbor:street',tags:['settlement','street']})).toBe('brick-paver');
  });

  it('renders wilderness routes as soil trails without a forced hard-road overlay', () => {
    for (const tag of ['walking_trail', 'rim_trail', 'shore_trail']) {
      expect(worldRoadSurfaceStyle({ id: `${tag}-route`, tags: [tag, 'world-route'] })).toEqual({
        tags: ['soil'], intensity: 0.55, material: 'compacted-earth', forceRoadOverlay: false
      });
    }
  });

  it('keeps town streets, town access, and harbor quays visibly paved', () => {
    expect(worldRoadSurfaceStyle({ id: 'main-street', tags: ['local_street', 'world-route'] })).toEqual({
      tags: ['paving', 'settlement'], intensity: 1, material: 'brick-paver', forceRoadOverlay: true
    });
    expect(worldRoadSurfaceStyle({ id: 'trail-access', tags: ['walking_trail', 'town-access'] })).toEqual({
      tags: ['paving', 'settlement'], intensity: 1, material: 'brick-paver', forceRoadOverlay: true
    });
    expect(worldRoadSurfaceStyle({ id: 'harbor-landing', tags: ['harbor-quay'] })).toEqual({
      tags: ['paving', 'settlement'], intensity: 1, material: 'cobblestone', forceRoadOverlay: true
    });
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
    expect(worldTileSurfaceWeight(freshWaterBank, tile, 8, 8, ['soil'])).toBeGreaterThan(0.5);
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

  it('splits open grass from shorter forest understory', () => {
    const tile = { x: 0, z: 0, size: 2 };
    const weights = new Float32Array(4 * WORLD_BIOMES.length);
    for (let index = 0; index < 4; index += 1) {
      const biome = index < 2 ? 'grassland' : 'forest';
      weights[index * WORLD_BIOMES.length + WORLD_BIOMES.indexOf(biome)] = 1;
    }
    const layers = worldGrassLayers({
      heights: new Float32Array(4), normals: new Float32Array(), weights,
      waterLevels: new Float32Array(4), freshWaterWeights: new Float32Array(4), resolution: 2
    }, tile);
    const open = layers.find(layer => layer.id === 'world-open-grass')!;
    const understory = layers.find(layer => layer.id === 'world-forest-understory')!;

    expect(open.densities).toEqual([0.72, 0.72, 0, 0]);
    expect(understory.densities).toEqual([0, 0, 0.5, 0.5]);
    expect(understory.height).toBeLessThan(open.height);
    expect(understory.mix).not.toEqual(open.mix);
  });

  it('thins completed town cores and clears grass at road and building exclusions', () => {
    const tile = { x: 0, z: 0, size: 2 };
    const weights = new Float32Array(9 * WORLD_BIOMES.length);
    for (let index = 0; index < 9; index += 1) {
      weights[index * WORLD_BIOMES.length + WORLD_BIOMES.indexOf('grassland')] = 1;
    }
    const blocked = new Set(['0:1', '2:1']);
    const [open] = worldGrassLayers({
      heights: new Float32Array(9), normals: new Float32Array(), weights,
      waterLevels: new Float32Array(9), freshWaterWeights: new Float32Array(9), resolution: 3
    }, tile, {
      density: (x, z) => x === 1 && z === 1 ? 0.35 : 1,
      exclusion: (x, z) => blocked.has(`${x}:${z}`)
    });

    expect(open.densities[0]).toBe(0.72);
    expect(open.densities[3]).toBe(0);
    expect(open.densities[4]).toBeCloseTo(0.252);
    expect(open.densities[5]).toBe(0);
  });

  it('gives compact grassland chunks dense ground cover within the resident streaming budget', () => {
    const tile = { x: -128, z: -128, size: 256 };
    const weights = new Float32Array(4 * WORLD_BIOMES.length);
    for (let index = 0; index < 4; index += 1) {
      const biome = index < 2 ? 'grassland' : 'forest';
      weights[index * WORLD_BIOMES.length + WORLD_BIOMES.indexOf(biome)] = 1;
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
    expect(grass.getStats().layerCount).toBe(2);
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
    expect(worldBuildPaintIntervals(12_000, 3)).toBe(15);
    expect(worldBuildPaintIntervals(12_000, 3, 0, 4)).toBe(4);
  });

  it('keeps three paint intervals when requestAnimationFrame runs normally', async () => {
    vi.useFakeTimers();
    let nextFrameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));

    const wait = yieldWorldBuild(4, 3);
    for (const paintAt of [16, 32, 48]) {
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id);
      callback(paintAt);
    }
    await vi.advanceTimersByTimeAsync(0);
    await wait;

    expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
  });

  it('caps a throttled requestAnimationFrame wait and cancels its pending callback', async () => {
    vi.useFakeTimers();
    let nextFrameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    }));
    const cancelAnimationFrame = vi.fn((id: number) => { frames.delete(id); });
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

    let completed = false;
    const wait = yieldWorldBuild(4, 3).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await wait;

    expect(completed).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
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

  it('covers compact-world terrain before showing progressively streamed content', async () => {
    let paintYields = 0;
    let streamed: Awaited<ReturnType<typeof buildEditableMapGroup>> | undefined;
    let sawProgressiveContent = false;
    let sawUncoveredTerrain = false;
    const expectedTerrainTiles = selectWorldTiles(500, 0, 0, 400, 64).length;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      setTimeout(() => {
        paintYields += 1;
        if (streamed) {
          const stats = streamed.getDebugStats().streaming!;
          const mounted = streamed.group.children.map(child => child.name);
          if (stats.pendingTiles > 0) {
            const mountedContent = mounted.filter(name => name.startsWith('world-content:')).length;
            sawProgressiveContent ||= mountedContent > stats.contentChunks;
            const tileBounds = mounted.filter(name => name.startsWith('world-tile:'))
              .map(name => name.slice('world-tile:'.length).split(':').map(Number));
            sawUncoveredTerrain ||= [[-249, -249], [-249, 249], [249, -249], [249, 249]]
              .some(([x, z]) => !tileBounds.some(([tileX, tileZ, size]) =>
                x >= tileX && x < tileX + size && z >= tileZ && z < tileZ + size));
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
      // The coarse preview must cover the entire world before returning.
      expect(terrains).toHaveLength(16);
      rendered.group.updateMatrixWorld(true);
      const mountedTiles = rendered.group.children
        .filter(child => child.name.startsWith('world-tile:'))
        .map(child => child.name.slice('world-tile:'.length).split(':').map(Number)) as number[][];
      for (const [x, z] of [[-249, -249], [-249, 249], [249, -249], [249, 249]]) {
        expect(mountedTiles.some(([tileX, tileZ, size]) =>
          x >= tileX && x < tileX + size && z >= tileZ && z < tileZ + size)).toBe(true);
      }
      const edgeSkirt = rendered.group.getObjectByName('world-tile:-250:-250:125')
        ?.getObjectByName('terrain-skirt') as THREE.Mesh | undefined;
      expect(edgeSkirt).toBeDefined();
      const edgePositions = edgeSkirt!.geometry.getAttribute('position');
      expect(Math.min(...Array.from({ length: edgePositions.count }, (_, index) => edgePositions.getY(index))))
        .toBeLessThanOrEqual(-4);
      const skirtMaterial = edgeSkirt!.material as THREE.MeshStandardMaterial;
      expect(skirtMaterial.color.getHex()).toBe(0x8d8573);
      expect(skirtMaterial.map).toBeNull();
      expect(terrains.every(terrain =>
        (terrain.material as THREE.MeshStandardMaterial).side === THREE.DoubleSide)).toBe(true);
      expect(terrains.every(terrain => (
        (terrain.material as THREE.MeshStandardMaterial).map?.image as HTMLCanvasElement
      ).width === 256)).toBe(true);
      const ocean = rendered.group.getObjectByName('water:world-ocean') as THREE.Mesh;
      expect(ocean.parent?.visible).toBe(true);
      expect(ocean.userData.waterOceanTerrain).toBeDefined();
      expect(ocean.userData.waterOceanTerrain.terrainBounds).toEqual([-250, -250, 250, 250]);
      expect(ocean.userData.waterOceanTerrain.mapSize[0]).toBeGreaterThanOrEqual(500);
      expect(ocean.userData.waterOceanTerrain.mapSize[1]).toBeGreaterThanOrEqual(500);
      expect(ocean.userData.waterOceanTerrain.terrainSize[0]).toBeGreaterThanOrEqual(251);
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
        if (rendered.group.children.filter(child => child.name.startsWith('world-tile:')).length !== expectedTerrainTiles) return false;
        if (rendered.getDebugStats().streaming?.pendingTiles !== 0) return false;
        let visible = true;
        rendered.modelsRoot.traverse(object => {
          if (object.userData.isStructuredWaterRoot === true) visible &&= object.visible;
        });
        return visible;
      }, 1_000);
      expect(rendered.group.getObjectByName('water:world-ocean')).toBe(ocean);
      expect(rendered.group.children.filter(child => child.name.startsWith('world-tile:')))
        .toHaveLength(expectedTerrainTiles);
      expect(paintYields).toBeGreaterThanOrEqual(16);
      expect(sawProgressiveContent).toBe(true);
      expect(sawUncoveredTerrain).toBe(false);
      rendered.modelsRoot.traverse(object => {
        if (object.userData.isStructuredWaterRoot === true) expect(object.visible).toBe(true);
      });
      expect(terrains.every(terrain => terrain.geometry.getAttribute('position').count === 65 * 65)).toBe(true);
      rendered.group.updateMatrixWorld(true);
      const oceanFloor = ocean.userData.waterOceanTerrain as Parameters<typeof sampleOceanFloor>[0];
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
          }
        }
      }
      const edges = new Map<string, { y: number; normal: THREE.Vector3 }>();
      let sharedVertices = 0;
      for (const terrain of terrains) {
        const positions = terrain.geometry.getAttribute('position');
        const normals = terrain.geometry.getAttribute('normal');
        for (let index = 0; index < positions.count; index += 1) {
          const x = positions.getX(index), z = positions.getZ(index);
          if (Math.abs(Math.abs(x) - 62.5) > 1e-5 && Math.abs(Math.abs(z) - 62.5) > 1e-5) continue;
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
      const ocean = rendered.group.getObjectByName('water:world-ocean') as THREE.Mesh;
      const half = bundle.plan.recipe.size / 2;
      expect(ocean.userData.waterOceanTerrain.terrainBounds).toEqual([-half, -half, half, half]);
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
  }, 90_000);

  it('shows unbound public and ordinary buildings as distinct planning frames beside a partial asset pack', async () => {
    const map = createEmptyMap();
    const town = bundle.plan.towns[0];
    const sample = createPlannedWorldSampler(bundle.plan, bundle.patches);
    const previewBundle = structuredClone(bundle);
    const school = previewBundle.patches.flatMap(patch => patch.buildings)
      .find(building => building.id === 'forest-south-home-center');
    if (!school) throw new Error('missing_fixture_building');
    school.use = 'school';
    school.assetKey = 'missing-school';
    const hall = previewBundle.patches.flatMap(patch => patch.buildings)
      .find(building => building.id !== school.id);
    if (!hall) throw new Error('missing_second_fixture_building');
    hall.use = 'civic hall';
    delete hall.assetKey;
    const landmarkAsset: MapAsset = {
      id: 'asset-landmark', name: 'Landmark', prompt: 'Landmark', modelJson: {},
      colliderPlan: {version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true},
      mode: 'voxel', createdAt: 1, updatedAt: 1
    };
    map.assets = [landmarkAsset];
    map.world = {bundle: previewBundle, assets: [{key: 'landmarks', role: 'landmark', assetId: landmarkAsset.id}]};
    map.box.size = [bundle.plan.recipe.size, 4096, bundle.plan.recipe.size];
    map.spawnPoints = [[town.center[0], sample(...town.center).height, town.center[1]]];

    const rendered = await buildEditableMapGroup(map);
    try {
      await waitFor(() => rendered.objectGroups.has('world-building:forest-south-home-center'));
      const schoolGroup = rendered.objectGroups.get('world-building:forest-south-home-center');
      expect(schoolGroup).toBeInstanceOf(THREE.Group);
      expect(schoolGroup?.children.every(child => !child.visible)).toBe(true);
      await waitFor(() => rendered.objectGroups.has(`world-building:${hall.id}`));
      const frames: THREE.InstancedMesh[] = [];
      rendered.modelsRoot.traverse(child => {
        if (child instanceof THREE.InstancedMesh && child.parent?.name.startsWith('world-building-whitebox:')) {
          frames.push(child);
        }
      });
      expect(frames.length).toBeGreaterThan(0);
      const colors = frames.flatMap(frame => Array.from({ length: frame.count }, (_, index) => {
        const color = new THREE.Color();
        frame.getColorAt(index, color);
        return color.getHex();
      }));
      expect(colors).toContain(0xe8a54b);
      expect(colors).toContain(0x55c47a);
    } finally {
      rendered.dispose();
    }
  }, 30_000);

  it('shows unbound ecology as planning frames instead of solid fallback cubes', async () => {
    const map = createEmptyMap();
    const town = bundle.plan.towns[0];
    const sample = createPlannedWorldSampler(bundle.plan, bundle.patches);
    map.world = { bundle, assets: [] };
    map.box.size = [bundle.plan.recipe.size, 4096, bundle.plan.recipe.size];
    map.spawnPoints = [[town.center[0], sample(...town.center).height, town.center[1]]];

    const rendered = await buildEditableMapGroup(map);
    try {
      await waitFor(() => [...rendered.objectGroups.keys()].some(id => id.startsWith('world-ecology:')));
      const ecologyGroups = [...rendered.objectGroups].filter(([id]) => id.startsWith('world-ecology:'));
      expect(ecologyGroups.length).toBeGreaterThan(0);
      expect(ecologyGroups.every(([, group]) => group.children.every(child => !child.visible))).toBe(true);
      const frames: THREE.InstancedMesh[] = [];
      rendered.modelsRoot.traverse(child => {
        if (child instanceof THREE.InstancedMesh && child.parent?.name.startsWith('world-ecology-whitebox:')) {
          frames.push(child);
        }
      });
      expect(frames.reduce((count, frame) => count + frame.count, 0)).toBeGreaterThan(ecologyGroups.length);
    } finally {
      rendered.dispose();
    }
  }, 30_000);

  it('renders a planned harbor landing as a walkable deck beyond the shoreline', async () => {
    const map = createEmptyMap();
    const previewBundle = structuredClone(smallBundle);
    previewBundle.plan.recipe.heightScale = 0.02;
    previewBundle.plan.roads.push({
      id: 'harbor-landing', name: 'Harbor landing', points: [[30, 0], [56, 0]],
      curve: 'polyline', closed: false, width: 5, tags: ['harbor-quay', 'sea-landing']
    });
    const sample = createPlannedWorldSampler(previewBundle.plan, previewBundle.patches);
    map.world = { bundle: previewBundle, assets: [] };
    map.box.size = [500, 4096, 500];
    map.spawnPoints = [[56, sample(56, 0).height, 0]];

    const rendered = await buildEditableMapGroup(map);
    try {
      await waitFor(() => rendered.objectGroups.has('world-harbor-quay:harbor-landing'));
      const deck = rendered.objectGroups.get('world-harbor-quay:harbor-landing')!;
      expect(deck.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(63);
      expect(deck.scale.z).toBeCloseTo(14);
      const hit = rendered.getCollisionWorld?.()?.raycastFirst(
        [68, 3, 0], [0, -1, 0], 10, new Set(['scene'])
      );
      expect(hit?.meshId).toContain('world-harbor-quay:harbor-landing');
    } finally {
      rendered.dispose();
    }
  }, 30_000);

  it('renders an explicit bridge route as a collidable deck over planned water', async () => {
    const map = createEmptyMap();
    const previewBundle = structuredClone(smallBundle);
    previewBundle.plan.recipe.heightScale = 0.02;
    previewBundle.plan.recipe.waterBodies = [{ id: 'crossing-lake', type: 'lake',
      region: { kind: 'circle', center: [0, 0], radius: 10 }, levels: [1.5], depth: 3 }];
    previewBundle.plan.roads.push({ id: 'island-bridge', name: 'Island bridge',
      points: [[-30, 0], [30, 0]], curve: 'polyline', closed: false, width: 4,
      tags: ['world-route', 'walking-bridge'] });
    map.world = { bundle: previewBundle, assets: [] };
    map.box.size = [500, 4096, 500];
    map.spawnPoints = [[0, 3, 0]];

    const rendered = await buildEditableMapGroup(map);
    try {
      await waitFor(() => rendered.objectGroups.has('world-bridge:island-bridge'));
      const bridge = rendered.objectGroups.get('world-bridge:island-bridge')!;
      expect(bridge.scale.z).toBeCloseTo(60);
      const hit = rendered.getCollisionWorld?.()?.raycastFirst(
        [0, 8, 0], [0, -1, 0], 10, new Set(['scene'])
      );
      expect(hit?.meshId).toContain('world-bridge:island-bridge');
      const groundSurfaces: string[] = [];
      rendered.group.traverse(object => {
        if (object.name.includes('road-surface:world-road:island-bridge:')
          || object.name === 'road-bodies:cobblestone') groundSurfaces.push(object.name);
      });
      expect(groundSurfaces).toEqual([]);
    } finally {
      rendered.dispose();
    }
  }, 30_000);

  it('aligns sloped bridge slab corners with both authored bank tops at arbitrary headings', async () => {
    const previewBundle = structuredClone(smallBundle);
    previewBundle.plan.recipe.terrainBrushes = [
      { id: 'flat', mode: 'flatten', region: { kind: 'circle', center: [0, 0], radius: 400 }, height: 40, feather: 0 },
      { id: 'slope', mode: 'grade', region: { kind: 'path', points: [[-200, -200], [200, 200]], width: 500 },
        heights: [10, 70], feather: 0 }
    ];
    previewBundle.plan.recipe.waterBodies = [{ id: 'bridge-lake', type: 'lake',
      region: { kind: 'circle', center: [0, 0], radius: 10 }, levels: [30], depth: 3 }];
    previewBundle.plan.roads = [[1, 0], [0, 1], [0.8, 0.6], [-0.6, 0.8]].flatMap(([dx, dz], heading) =>
      [-1, 1].map(sign => ({ id: `sloped-bridge-${heading}-${sign}`, name: 'Sloped bridge',
        points: [[-dx * 30 * sign, -dz * 30 * sign], [dx * 30 * sign, dz * 30 * sign]] as [number, number][],
        width: 4, curve: 'polyline' as const, closed: false, tags: ['walking-bridge'] })));
    const map = createEmptyMap();
    map.world = { bundle: previewBundle, assets: [] };
    map.box.size = [500, 4096, 500];
    map.spawnPoints = [[0, 35, 0]];
    const sample = createPlannedWorldSampler(previewBundle.plan, previewBundle.patches);
    const rendered = await buildEditableMapGroup(map);
    try {
      await waitFor(() => previewBundle.plan.roads.every(road => rendered.objectGroups.has(`world-bridge:${road.id}`)));
      rendered.group.updateMatrixWorld(true);
      let maximumCornerError = 0, cornersOutsideCollision = 0;
      for (const road of previewBundle.plan.roads) {
        const deck = worldBridgeDeck(road, sample)!;
        expect(deck).toBeDefined();
        const bridge = rendered.objectGroups.get(`world-bridge:${road.id}`)!;
        const dx = deck.to[0] - deck.from[0], dz = deck.to[1] - deck.from[1];
        const forward = new THREE.Vector3(dx, deck.toHeight - deck.fromHeight, dz).normalize();
        const right = new THREE.Vector3(dz, 0, -dx).normalize();
        const up = forward.clone().cross(right);
        const collider = rendered.getCollisionWorld!()!.instances.find(instance => instance.id.endsWith(`map:world-bridge:${road.id}`));
        expect(collider).toBeDefined();
        const bounds = collider!.bounds.clone().expandByScalar(1e-5);
        for (const x of [-0.5, 0.5]) for (const y of [0, 1]) for (const z of [-0.5, 0.5]) {
          const endpoint = z < 0 ? deck.from : deck.to;
          const height = z < 0 ? deck.fromHeight : deck.toHeight;
          const expected = new THREE.Vector3(endpoint[0], height, endpoint[1])
            .addScaledVector(right, x * deck.width).addScaledVector(up, (y - 1) * 0.3);
          const actual = bridge.localToWorld(new THREE.Vector3(x, y, z));
          maximumCornerError = Math.max(maximumCornerError, actual.distanceTo(expected));
          if (!bounds.containsPoint(actual)) cornersOutsideCollision++;
        }
      }
      expect(maximumCornerError, JSON.stringify({ cornersOutsideCollision })).toBeLessThan(1e-5);
      expect(cornersOutsideCollision).toBe(0);
    } finally {
      rendered.dispose();
    }
  }, 30_000);

  it('keeps authored semantic anchors visible in an asset-free construction preview', async () => {
    const map = createEmptyMap();
    const previewBundle = structuredClone(smallBundle);
    previewBundle.plan.featureGraph = {
      regions: [{ id: 'bay', kind: 'harbor', name: 'Bay', center: [0, 0], radius: 20 }],
      paths: [{ id: 'harbor-path', kind: 'local-road', name: 'Harbor path', points: [[0, 0], [10, 0]], width: 4 }],
      anchors: [{ id: 'harbor-anchor', kind: 'harbor', position: [0, 0], regionId: 'bay' }],
      relations: []
    };
    map.world = { bundle: previewBundle, assets: [], review: {
      draftAssets: [], plannedBuildings: [], paidCallCount: 1, diagnostics: [], complete: true
    } };
    map.box.size = [500, 4096, 500];
    map.spawnPoints = [[0, 0, 0]];

    const rendered = await buildEditableMapGroup(map);
    try {
      expect(rendered.group.getObjectByName('world-whitebox-anchor:harbor-anchor')).toBeInstanceOf(THREE.Mesh);
      expect(rendered.group.getObjectByName('world-whitebox-path:harbor-path')).toBeUndefined();
    } finally {
      rendered.dispose();
    }
  }, 30_000);
});
