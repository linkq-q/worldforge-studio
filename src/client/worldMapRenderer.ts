import * as THREE from 'three';
import { RuntimeIndex } from '@voxel-studio/render-runtime';
import {
  DEFAULT_RUNTIME_GRASS_STYLE,
  DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE,
  type RuntimeGrassStyle,
  type RuntimeTerrainMaterialStyle
} from '../shared/renderPlan';
import { DEFAULT_MAP_DESIGN_SEMANTICS } from '../shared/mapDesign';
import { createDefaultMapLayout } from '../shared/mapLayout';
import { calculateModelVisualFrame } from '../shared/modelBounds';
import { DEFAULT_MAP_VISUAL_SEMANTICS, type SceneVisualZone, type VisualZoneTag } from '../shared/visualDirection';
import { ECOLOGY_CHUNK_SIZE, generateEcologyChunk, selectEcologyChunks, type EcologyChunk, type EcologyInstance } from '../shared/worldEcology';
import { createWorldEcologyDensity, createWorldExclusion, type TownBuilding, type WorldPlan } from '../shared/worldPlanning';
import { WORLD_BIOMES, sampleWorldTile, selectWorldTiles, type WorldBiome, type WorldTile, type WorldTileData } from '../shared/worldTerrain';
import { selectWorldEcologyAsset, worldBuildingRole, worldMapTerrainContext, type WorldAssetBinding } from '../shared/worldMapState';
import type { ColorPalette } from '../shared/colorPalette';
import type { SceneArtPlan } from '../shared/sceneArt';
import type { Vec3 } from '../shared/protocol';
import { getObjectWorldTransforms, type EditableMap, type MapAsset, type MapObject, type MapWaterBody } from '../shared/map';
import type { MapGuide } from '../shared/mapGuide';
import type { MapGrassLayer } from '../shared/mapGrass';
import { buildOceanCoastField, sampleCoastGrid, type OceanCoastField } from '../shared/oceanCoast';
import type { PaletteCoverageReport } from './paletteMaterialRuntime';
import {
  buildNormalizedEditableMapGroupCore,
  buildStructuredWaterGroup,
  disposeStructuredWaterGroup,
  type MapRenderOptions,
  type RenderedMap,
  type RenderedMapDebugStats,
  type TerrainBorderSide
} from './mapRenderer';
import {
  buildMapMeshCollisionWorld,
  MeshCollisionWorld,
  type CollisionMeshKind
} from './mapMeshCollision';

const MAX_TERRAIN_TILE_BUDGET = 128;
const UNIFORM_TERRAIN_TILE_BUDGET = 64;
const FINE_TERRAIN_RESOLUTION = 65;
const TARGET_FINE_TERRAIN_SPACING = 1.5;
const FINE_TERRAIN_TEXTURE_SIZE = 256;
const CONTENT_DISTANCE_LIMIT = 3_000;
const WORLD_GRASS_CHUNK_INSTANCE_BUDGET = 15_000;
const WORLD_GRASS_RESIDENT_INSTANCE_BUDGET = 120_000;
const WORLD_STREAM_BUILD_FRAME_BUDGET_MS = 8;
const WORLD_STREAM_MIN_BACKGROUND_PAINTS = 3;
// Chunk build time includes its own cooperative rAF waits, so it cannot justify an unbounded second wait here.
const WORLD_STREAM_MAX_RECOVERY_PAINTS = 15;
// Terrain already mounts one tile per batch; keep several clean paints without multiplying the pause across 48 tiles.
const WORLD_STREAM_MAX_TERRAIN_RECOVERY_PAINTS = 4;
const BIOME_CHANNEL = Object.fromEntries(WORLD_BIOMES.map((biome, index) => [biome, index])) as Record<WorldBiome, number>;
const EMPTY_PALETTE_REPORT: PaletteCoverageReport = {
  strictMaterials: 0,
  approximateMaterials: 0,
  technicalMaterials: 0,
  unmatchedMaterials: 0,
  usedColors: [],
  roleCounts: {}
};

export function worldRoadSurfaceMaterial(road: Pick<MapGuide,'id'|'tags'>): 'brick-paver'|'cobblestone'|'compacted-earth' {
  if(road.tags.includes('harbor-quay')) return 'cobblestone';
  return road.id.startsWith('town:')||road.tags.some(tag=>/street|settlement|town/i.test(tag))?'brick-paver':'compacted-earth';
}

export function buildWorldWhiteboxOverlay(
  plan: WorldPlan,
  sample: (x: number, z: number) => { height: number; waterLevel?: number | null }
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'world-whitebox-overlay';
  if (!plan.whitebox || !plan.featureGraph) return root;
  const visibleHeight = (x: number, z: number) => {
    const surface = sample(x, z);
    return Math.max(surface.height, surface.waterLevel ?? surface.height) + 0.8;
  };
  const settlementRegionIds = new Set((plan.settlementPlan?.settlements ?? []).flatMap(settlement => {
    const anchor = plan.featureGraph!.anchors.find(item => item.id === settlement.anchorId);
    return anchor ? [anchor.regionId] : [];
  }));
  const emptyRegionIds = new Set((plan.intentionalEmptyAreas ?? []).map(area => area.regionId)
    .filter(id => !settlementRegionIds.has(id)));
  for (const region of plan.featureGraph.regions) {
    const role = settlementRegionIds.has(region.id) ? 'settlement' : emptyRegionIds.has(region.id) ? 'empty' : null;
    if (!role) continue;
    const points: THREE.Vector3[] = [];
    const segments = 48;
    for (let index = 0; index < segments; index++) {
      const angle = index / segments * Math.PI * 2;
      const x = region.center[0] + Math.cos(angle) * region.radius;
      const z = region.center[1] + Math.sin(angle) * region.radius;
      points.push(new THREE.Vector3(x, visibleHeight(x, z), z));
    }
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: role === 'settlement' ? 0xffa552 : 0x8aa6b8,
        depthTest: false, transparent: true, opacity: role === 'settlement' ? 0.9 : 0.55 }));
    outline.name = `world-whitebox-region:${role}:${region.id}`;
    outline.renderOrder = 18;
    root.add(outline);
  }
  for (const path of plan.featureGraph.paths) {
    const waterPath = /river|water|canal/i.test(path.kind);
    const renderedRiver = waterPath && (plan.recipe.waterBodies ?? []).some(water => {
      if (water.type !== 'river' || water.region.kind !== 'path') return false;
      // The authored water may contain extra control points that the semantic route omits.
      // Shared points identify the same river without depending on identical sampling.
      const riverPoints = water.region.points;
      const overlap = path.points.filter(point => riverPoints.some(candidate =>
        Math.abs(point[0] - candidate[0]) < 1e-4 && Math.abs(point[1] - candidate[1]) < 1e-4)).length;
      return overlap >= Math.max(2, Math.ceil(path.points.length * 0.6));
    });
    // The structured water already shows this route. A semantic line would
    // continue across the ocean after the derived river mouth is clipped.
    if (renderedRiver) continue;
    const color = waterPath ? 0x468ff2
      : /trail|foot|hike/i.test(path.kind) ? 0xf6b46c : 0x35d7ff;
    const points: THREE.Vector3[] = [];
    for (let index = 1; index < path.points.length; index++) {
      const from = path.points[index - 1], to = path.points[index];
      const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 6));
      for (let step = index === 1 ? 0 : 1; step <= steps; step++) {
        const t = step / steps, x = from[0] + (to[0] - from[0]) * t, z = from[1] + (to[1] - from[1]) * t;
        const surface = sample(x, z);
        const y = Math.max(surface.height, surface.waterLevel ?? surface.height) + 0.8;
        points.push(new THREE.Vector3(x, y, z));
      }
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.name = `world-whitebox-path:${path.id}`;
    line.renderOrder = 20;
    root.add(line);
    const ribbon: number[] = [];
    const halfWidth = Math.max(0.8, Math.min(4, path.width / 2));
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index], dx = b.x - a.x, dz = b.z - a.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 1e-6) continue;
      const ox = -dz / distance * halfWidth, oz = dx / distance * halfWidth;
      ribbon.push(a.x + ox, a.y, a.z + oz, a.x - ox, a.y, a.z - oz, b.x + ox, b.y, b.z + oz,
        b.x + ox, b.y, b.z + oz, a.x - ox, a.y, a.z - oz, b.x - ox, b.y, b.z - oz);
    }
    const surface = new THREE.BufferGeometry();
    surface.setAttribute('position', new THREE.Float32BufferAttribute(ribbon, 3));
    surface.computeVertexNormals();
    const strip = new THREE.Mesh(surface, new THREE.MeshBasicMaterial({ color, depthTest: false,
      side: THREE.DoubleSide, transparent: true, opacity: 0.55 }));
    strip.name = `world-whitebox-path-surface:${path.id}`;
    strip.renderOrder = 19;
    root.add(strip);
  }
  const anchorGeometry = new THREE.ConeGeometry(1.8, 5, 8);
  const anchorMaterial = new THREE.MeshBasicMaterial({ color: 0xffb547, depthTest: false });
  const wetAnchorMaterial = new THREE.MeshBasicMaterial({ color: 0xff5252, depthTest: false });
  for (const anchor of plan.featureGraph.anchors) {
    const terrain = sample(...anchor.position);
    const flooded = terrain.waterLevel != null && terrain.waterLevel > terrain.height + 0.05;
    const marker = new THREE.Mesh(anchorGeometry, flooded ? wetAnchorMaterial : anchorMaterial);
    marker.name = `world-whitebox-anchor:${anchor.id}`;
    if (flooded) marker.scale.setScalar(2);
    marker.position.set(anchor.position[0], Math.max(terrain.height, terrain.waterLevel ?? terrain.height) + 3.3,
      anchor.position[1]);
    marker.renderOrder = 21;
    root.add(marker);
    if (flooded) {
      const points = Array.from({ length: 32 }, (_, index) => {
        const angle = index / 32 * Math.PI * 2;
        const x = anchor.position[0] + Math.cos(angle) * 12;
        const z = anchor.position[1] + Math.sin(angle) * 12;
        return new THREE.Vector3(x, visibleHeight(x, z), z);
      });
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0xff5252, depthTest: false }));
      ring.name = `world-whitebox-anchor-wet:${anchor.id}`;
      ring.renderOrder = 21;
      root.add(ring);
    }
  }
  return root;
}

interface GlobalBuilding extends TownBuilding { x: number; z: number; townId: string }
interface ManualObjectTree { rootId: string; x: number; z: number; objects: MapObject[] }
interface ReconcileRequest { x: number; z: number; distance: number }
interface TileEntry {
  tile: WorldTile;
  signature: string;
  map: EditableMap;
  rendered: RenderedMap;
  terrainMount: THREE.Group;
  collision: MeshCollisionWorld | null;
  buildings: number;
  ecology: number;
  texturePixels: number;
}
interface ContentEntry {
  chunk: EcologyChunk;
  signature: string;
  map: EditableMap;
  rendered: RenderedMap;
  mount: THREE.Group;
  collision: MeshCollisionWorld;
  buildings: number;
  ecology: number;
  texturePixels: number;
  grassChunkBudget: number;
}

function groupManualObjectTrees(map: EditableMap): ManualObjectTree[] {
  const byId = new Map(map.objects.map(object => [object.id, object]));
  const worldTransforms = getObjectWorldTransforms(map);
  const rootIds = new Map<string, string>();
  const rootIdFor = (object: MapObject): string => {
    const cached = rootIds.get(object.id);
    if (cached) return cached;
    const path: MapObject[] = [];
    const seen = new Set<string>();
    let current = object;
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current);
      current = byId.get(current.parentId)!;
    }
    for (const item of path) rootIds.set(item.id, current.id);
    rootIds.set(current.id, current.id);
    return current.id;
  };
  const grouped = new Map<string, MapObject[]>();
  for (const object of map.objects) {
    const rootId = rootIdFor(object);
    const objects = grouped.get(rootId) ?? [];
    objects.push(object);
    grouped.set(rootId, objects);
  }
  return [...grouped].map(([rootId, objects]) => {
    const position = worldTransforms.get(rootId)?.position ?? byId.get(rootId)?.transform.position ?? [0, 0, 0];
    return { rootId, x: position[0], z: position[2], objects };
  });
}

function manualObjectsForTile(
  trees: ManualObjectTree[],
  tile: WorldTile,
  contentKeys: ReadonlySet<string>,
  centerX: number,
  centerZ: number
): MapObject[] {
  return trees
    .filter(tree => contentKeys.has(pointEcologyKey(tree.x, tree.z)) && tileContains(tile, tree.x, tree.z))
    .flatMap(tree => tree.objects.map(object => ({
      ...object,
      transform: {
        ...object.transform,
        position: object.id === tree.rootId
          ? [object.transform.position[0] - centerX, object.transform.position[1], object.transform.position[2] - centerZ]
          : [...object.transform.position],
        rotation: [...object.transform.rotation],
        scale: [...object.transform.scale],
        size: [...object.transform.size]
      }
    })));
}

interface StreamStyleState {
  grass: RuntimeGrassStyle;
  terrain: RuntimeTerrainMaterialStyle;
  palette: ColorPalette | null;
  sceneArt: SceneArtPlan | null;
  sceneArtPalette?: ColorPalette;
  wetness: number;
  snowCover: number;
  sandFlow: number;
  timeOfDay: Parameters<RenderedMap['setLightingTimeOfDay']>[0];
  lightingQuality: number;
  lightingSoloObjectId: string | null;
  lightingHelpersVisible: boolean;
  environment: THREE.Texture | null;
  waterEnvironment: THREE.Texture | null;
}

export async function buildStreamedWorldMapGroup(map: EditableMap, options: MapRenderOptions = {}): Promise<RenderedMap> {
  if (!map.world) throw new Error('world_renderer_requires_world');
  const world = map.world;
  const bundle = world.bundle;
  const terrainTileBudget = bundle.plan.recipe.size / 8 / (FINE_TERRAIN_RESOLUTION - 1) <= TARGET_FINE_TERRAIN_SPACING
    ? UNIFORM_TERRAIN_TILE_BUDGET
    : MAX_TERRAIN_TILE_BUDGET;
  const terrainContext = worldMapTerrainContext(world);
  const sample = terrainContext.sample;
  const root = new THREE.Group();
  root.name = `world-map:${map.id}`;
  const modelsRoot = new THREE.Group();
  modelsRoot.name = 'modelsRoot';
  modelsRoot.userData.isModelRoot = true;
  root.add(modelsRoot);
  const whiteboxOverlay = buildWorldWhiteboxOverlay(bundle.plan, sample);
  root.add(whiteboxOverlay);

  const assetsById = new Map((map.assets ?? []).map(asset => [asset.id, asset]));
  const bindingsByKey = new Map(world.assets.map(binding => [binding.key, binding]));
  const bindingsByRole = groupBindingsByRole(world.assets);
  validateWorldAssets(map, bindingsByKey, bindingsByRole, assetsById);
  const buildings = globalBuildings(bundle);
  const roads = globalRoads(bundle);
  const manualObjectTrees = groupManualObjectTrees(map);
  const ecologyCache = new Map<string, EcologyInstance[]>();
  const exclusion = createWorldExclusion(bundle.plan, bundle.patches);
  const density = createWorldEcologyDensity(bundle.plan, bundle.patches);
  const entries = new Map<string, TileEntry>();
  const contentEntries = new Map<string, ContentEntry>();
  const objectGroups = new Map<string, THREE.Group>();
  const pickables: THREE.Object3D[] = [];
  const listeners = new Set<() => void>();
  const runtimeIndex = new RuntimeIndex();
  let collisionWorld: MeshCollisionWorld | null = null;
  let disposed = false;
  let pendingTiles = 0;
  let unloadedTiles = 0;
  let lastTerrainBuildMs = 0;
  let maxTerrainBuildMs = 0;
  let lastTerrainSampleMs = 0;
  let lastTerrainRenderMs = 0;
  let lastTerrainCollisionMs = 0;
  let desiredRequest: ReconcileRequest | null = null;
  let appliedRequest: ReconcileRequest | null = null;
  let failedRequest: { key: string; at: number } | null = null;
  let requestRevision = 0;
  let completionTimer: ReturnType<typeof setTimeout> | null = null;
  let reconciling = false;
  let activeCenter: Vec3 = [map.spawnPoints[0]?.[0] ?? 0, 0, map.spawnPoints[0]?.[2] ?? 0];
  let activeLightingSize: Vec3 = [1280, 256, 1280];
  const style: StreamStyleState = {
    grass: DEFAULT_RUNTIME_GRASS_STYLE,
    terrain: DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE,
    palette: null,
    sceneArt: null,
    wetness: 0,
    snowCover: 0,
    sandFlow: 0,
    timeOfDay: 'noon',
    lightingQuality: 1,
    lightingSoloObjectId: null,
    lightingHelpersVisible: false,
    environment: null,
    waterEnvironment: null
  };
  const compactOceanBuild = bundle.plan.recipe.size <= CONTENT_DISTANCE_LIMIT
    ? buildCompactWorldOcean()
    : null;
  const compactOcean = compactOceanBuild?.group ?? null;
  const compactOceanCoast = compactOceanBuild?.coast ?? null;
  if (compactOcean) {
    compactOcean.visible = false;
    modelsRoot.add(compactOcean);
  }

  const initialRequest = normalizedReconcileRequest(
    options.worldInitialView?.x ?? map.spawnPoints[0]?.[0] ?? 0,
    options.worldInitialView?.z ?? map.spawnPoints[0]?.[2] ?? 0,
    options.worldInitialView?.distance ?? 50
  );
  await reconcile(initialRequest.x, initialRequest.z, initialRequest.distance, requestRevision, { terrain: 16, content: 1 });
  completionTimer = setTimeout(() => {
    completionTimer = null;
    if (!desiredRequest) requestReconcile(initialRequest.x, initialRequest.z, initialRequest.distance);
  }, 0);

  async function reconcile(
    focusX: number,
    focusZ: number,
    distance: number,
    revision: number,
    limits?: { terrain: number; content: number }
  ): Promise<boolean> {
    const tiles = selectWorldTiles(bundle.plan.recipe.size, focusX, focusZ, distance, terrainTileBudget);
    const contentChunks = selectEcologyChunks(
      bundle.plan.recipe.size,
      focusX,
      focusZ,
      distance > CONTENT_DISTANCE_LIMIT ? distance : 0
    );
    const oceanAnchor = worldOceanAnchor(bundle.plan.recipe.size, focusX, focusZ);
    const oceanOwner = compactOcean ? undefined : tiles.find(tile => tileContains(tile, oceanAnchor.x, oceanAnchor.z))
      ?? tiles.find(tile => tileContains(tile, focusX, focusZ));
    const desiredTerrain = new Map(tiles.map(tile => {
      const logicalKey = tileKey(tile);
      const skirtSides = terrainSkirtSides(tile, tiles);
      const signature = `${logicalKey}|o${oceanOwner === tile ? 1 : 0}|s${skirtSides.join('.')}`;
      return [logicalKey, { tile, signature, ocean: oceanOwner === tile, skirtSides }] as const;
    }));
    const desiredContent = new Map(contentChunks.map(chunk => [ecologyKey(chunk), chunk] as const));
    const focusContentKey = pointEcologyKey(focusX, focusZ);
    const allMissingTerrain = [...desiredTerrain.entries()]
      .filter(([key, value]) => entries.get(key)?.signature !== value.signature)
      .sort(([, left], [, right]) => tileDistanceSquared(left.tile, focusX, focusZ) - tileDistanceSquared(right.tile, focusX, focusZ));
    const allMissingContent = [...desiredContent.entries()]
      .filter(([key]) => !contentEntries.has(key))
      .sort(([leftKey, left], [rightKey, right]) => Number(rightKey === focusContentKey) - Number(leftKey === focusContentKey)
        || chunkDistanceSquared(left, focusX, focusZ) - chunkDistanceSquared(right, focusX, focusZ));
    const missingTerrain = limits ? allMissingTerrain.slice(0, limits.terrain) : allMissingTerrain;
    const missingContent = limits ? allMissingContent.slice(0, limits.content) : allMissingContent;
    pendingTiles = allMissingTerrain.length + allMissingContent.length;
    const builtTerrain = new Map<string, TileEntry>();
    const builtContent = new Map<string, ContentEntry>();
    const discardBuilt = (): void => {
      builtTerrain.forEach(entry => {
        if (entry.terrainMount.parent) unmountEntry(entry);
        disposeEntry(entry);
      });
      builtContent.forEach(entry => {
        if (entry.mount.parent) unmountContentEntry(entry);
        disposeContentEntry(entry);
      });
    };
    const contentBatchSize = limits ? 3 : 1;
    // sampleWorldTile is synchronous until buildTerrainEntry reaches its first
    // await. Starting four entries together therefore samples four complete
    // tiles in one frame; keep terrain work to one tile per paint interval.
    const terrainBatchSize = 1;
    for (let index = 0; index < missingTerrain.length && !disposed; index += terrainBatchSize) {
      const batchStartedAt = performance.now();
      const batch = missingTerrain.slice(index, index + terrainBatchSize);
      const results = await Promise.allSettled(batch.map(async ([key, value]) => [key, await buildTerrainEntry(
        value.tile, value.signature, value.ocean, value.skirtSides
      )] as const));
      for (const result of results) if (result.status === 'fulfilled') builtTerrain.set(result.value[0], result.value[1]);
      pendingTiles -= results.length;
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        discardBuilt();
        pendingTiles = 0;
        throw failure.reason;
      }
      if (disposed || revision !== requestRevision) { discardBuilt(); return false; }
      results.forEach(result => {
        if (result.status === 'fulfilled') {
          if (!limits) setEntryWaterVisible(result.value[1], false);
          mountEntry(result.value[1]);
        }
      });
      await yieldWorldBuild(
        performance.now() - batchStartedAt,
        limits ? 1 : WORLD_STREAM_MIN_BACKGROUND_PAINTS,
        WORLD_STREAM_MAX_TERRAIN_RECOVERY_PAINTS
      );
      if (revision !== requestRevision) { discardBuilt(); return false; }
    }
    for (let index = 0; index < missingContent.length && !disposed; index += contentBatchSize) {
      const batchStartedAt = performance.now();
      const batch = missingContent.slice(index, index + contentBatchSize);
      const results = await Promise.allSettled(batch.map(async ([key, chunk]) => [
        key, await buildContentEntry(chunk, desiredContent.size)
      ] as const));
      for (const result of results) if (result.status === 'fulfilled') builtContent.set(result.value[0], result.value[1]);
      pendingTiles -= results.length;
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) {
        discardBuilt();
        pendingTiles = 0;
        throw failure.reason;
      }
      if (disposed || revision !== requestRevision) { discardBuilt(); return false; }
      results.forEach(result => {
        if (result.status === 'fulfilled') mountContentEntry(result.value[1]);
      });
      await yieldWorldBuild(performance.now() - batchStartedAt, limits ? 1 : WORLD_STREAM_MIN_BACKGROUND_PAINTS);
      if (revision !== requestRevision) { discardBuilt(); return false; }
    }
    if (disposed) {
      discardBuilt();
      return false;
    }
    for (const [key, entry] of entries) {
      const replacement = builtTerrain.get(key);
      if (!desiredTerrain.has(key) || replacement) {
        unmountEntry(entry);
        disposeEntry(entry);
        entries.delete(key);
        unloadedTiles += 1;
      }
    }
    for (const [key, entry] of builtTerrain) {
      if (!desiredTerrain.has(key)) { disposeEntry(entry); continue; }
      entries.set(key, entry);
      setEntryWaterVisible(entry, true);
      if (!entry.terrainMount.parent) mountEntry(entry);
    }
    for (const [key, entry] of contentEntries) {
      if (desiredContent.has(key)) continue;
      unmountContentEntry(entry);
      disposeContentEntry(entry);
      contentEntries.delete(key);
      unloadedTiles += 1;
    }
    for (const [key, entry] of builtContent) {
      if (!desiredContent.has(key)) { disposeContentEntry(entry); continue; }
      contentEntries.set(key, entry);
      if (!entry.mount.parent) mountContentEntry(entry);
    }
    rebuildPublicIndexes();
    rebuildCollision();
    updateLightingBounds(focusX, focusZ);
    if (!limits && compactOcean) compactOcean.visible = true;
    listeners.forEach(listener => listener());
    return true;
  }

  async function buildTerrainEntry(
    tile: WorldTile,
    signature: string,
    includeOcean: boolean,
    skirtSides: readonly TerrainBorderSide[]
  ): Promise<TileEntry> {
    const buildStartedAt = performance.now();
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const resolution = tile.size <= 256 ? FINE_TERRAIN_RESOLUTION : tile.size <= 2_048 ? 33 : 17;
    const sampled = sampleWorldTile(bundle.plan.recipe, tile, resolution, sample, false);
    if (compactOceanCoast) applyWorldOceanFloor(sampled.heights, tile, resolution, compactOceanCoast);
    const sampledAt = performance.now();
    const tileMap = makeTerrainTileMap(tile, sampled.heights, includeOcean);
    const textureSize = tile.size <= 256 ? FINE_TERRAIN_TEXTURE_SIZE : tile.size <= 2_048 ? 64 : 32;
    const rendered = await buildNormalizedEditableMapGroupCore(tileMap, {
      ...options,
      editorHelpers: false,
      terrainTextureSize: textureSize,
      terrainBorderSides: skirtSides,
      terrainBorderDepth: 4,
      oceanCoast: false,
      waterOceanCoast: includeOcean,
      terrainOnly: true,
      terrainSurfaceWeight: (x, z, tags) => worldTileSurfaceWeight(sampled, tile, centerX + x, centerZ + z, tags),
      waterTerrainHeight: (x, z) => sample(centerX + x, centerZ + z).height
    });
    applyWorldTerrainEdgeNormals(rendered.group, tile, centerX, centerZ);
    const renderedAt = performance.now();
    applyStyle(rendered, tileMap, tile);
    const terrainMount = new THREE.Group();
    terrainMount.name = `world-tile:${tileKey(tile)}`;
    terrainMount.position.set(centerX, 0, centerZ);
    const collision = tile.size <= 256 ? buildGlobalCollision(tileMap, centerX, centerZ, new Set(['terrain'])) : null;
    const collisionAt = performance.now();
    lastTerrainSampleMs = sampledAt - buildStartedAt;
    lastTerrainRenderMs = renderedAt - sampledAt;
    lastTerrainCollisionMs = collisionAt - renderedAt;
    lastTerrainBuildMs = collisionAt - buildStartedAt;
    maxTerrainBuildMs = Math.max(maxTerrainBuildMs, lastTerrainBuildMs);
    return {
      tile,
      signature,
      map: tileMap,
      rendered,
      terrainMount,
      collision,
      buildings: 0,
      ecology: 0,
      texturePixels: textureSize * textureSize * 4
    };
  }

  async function buildContentEntry(chunk: EcologyChunk, residentContentCount: number): Promise<ContentEntry> {
    const tile: WorldTile = { x: chunk.x * ECOLOGY_CHUNK_SIZE, z: chunk.z * ECOLOGY_CHUNK_SIZE, size: ECOLOGY_CHUNK_SIZE };
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const sampled = sampleWorldTile(bundle.plan.recipe, tile, 65, sample, false);
    const contentMap = makeContentMap(tile, sampled, chunk);
    const rendered = await buildNormalizedEditableMapGroupCore(contentMap, {
      ...options,
      editorHelpers: false,
      terrainTextureSize: 32,
      terrainBorderSides: false,
      terrainVisible: false,
      oceanCoast: false
    });
    applyStyle(rendered, contentMap, tile);
    const grassChunkBudget = worldGrassChunkBudget(residentContentCount);
    rendered.setGrassStyle(worldGrassStyle(style.grass, grassChunkBudget));
    const mount = new THREE.Group();
    mount.name = `world-content:${ecologyKey(chunk)}`;
    mount.position.set(centerX, 0, centerZ);
    return {
      chunk,
      signature: ecologyKey(chunk),
      map: contentMap,
      rendered,
      mount,
      collision: buildGlobalCollision(contentMap, centerX, centerZ, new Set(['scene'])),
      buildings: contentMap.objects.filter(object => object.id.startsWith('world-building:')).length,
      ecology: contentMap.objects.filter(object => object.id.startsWith('world-ecology:')).length,
      texturePixels: 32 * 32 * 4,
      grassChunkBudget
    };
  }

  function makeTerrainTileMap(
    tile: WorldTile,
    heights: Float32Array,
    includeOcean: boolean
  ): EditableMap {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const boxSize: Vec3 = [tile.size, map.box.size[1], tile.size];
    const waterBodies = tileWaterBodies(tile, includeOcean);
    return {
      ...map,
      id: `${map.id}:world:${tileKey(tile)}`,
      name: `${map.name} ${tileKey(tile)}`,
      seed: map.seed ^ stringSeed(tileKey(tile)),
      world: undefined,
      box: { ...map.box, size: boxSize },
      sceneMode: 'outdoor',
      room: null,
      interiorArtDirection: null,
      terrain: { resolutionX: Math.sqrt(heights.length), resolutionZ: Math.sqrt(heights.length), heights: Array.from(heights) },
      grassLayers: [],
      waterBodies,
      paintStrokes: [],
      objects: [],
      spawnPoints: [[0, sample(centerX, centerZ).height, 0]],
      visualSemantics: {
        version: 1,
        zones: [],
        wind: { ...map.visualSemantics?.wind ?? DEFAULT_MAP_VISUAL_SEMANTICS.wind }
      },
      layout: createDefaultMapLayout(boxSize),
      guides: [],
      designSemantics: DEFAULT_MAP_DESIGN_SEMANTICS,
      assets: [],
      collisionBake: undefined
    };
  }

  function buildCompactWorldOcean(): { group: THREE.Group; coast: OceanCoastField } {
    const size = bundle.plan.recipe.size;
    const tile: WorldTile = { x: -size / 2, z: -size / 2, size };
    const resolution = Math.min(129, Math.max(65, Math.ceil(size / 4) + 1));
    const sampled = sampleWorldTile(bundle.plan.recipe, tile, resolution, sample, false);
    const oceanMap: EditableMap = {
      ...map,
      id: `${map.id}:world-ocean`,
      world: undefined,
      box: { ...map.box, size: [size, map.box.size[1], size] },
      sceneMode: 'outdoor', room: null, interiorArtDirection: null,
      terrain: { resolutionX: resolution, resolutionZ: resolution, heights: Array.from(sampled.heights) },
      grassLayers: [], paintStrokes: [], objects: [], spawnPoints: [[0, sample(0, 0).height, 0]],
      waterBodies: [{
        id: 'world-ocean', name: '海面', type: 'ocean', level: 0, depth: 12, width: size,
        points: [[-size / 2, -size / 2], [size / 2, -size / 2], [size / 2, size / 2], [-size / 2, size / 2]]
      }],
      visualSemantics: { version: 1, zones: [], wind: { ...map.visualSemantics?.wind ?? DEFAULT_MAP_VISUAL_SEMANTICS.wind } },
      layout: createDefaultMapLayout([size, map.box.size[1], size]), guides: [],
      designSemantics: DEFAULT_MAP_DESIGN_SEMANTICS, assets: [], collisionBake: undefined
    };
    const coast = buildOceanCoastField(oceanMap, 0);
    return { group: buildStructuredWaterGroup(oceanMap, coast), coast };
  }

  function worldTerrainHeight(x: number, z: number): number {
    const height = sample(x, z).height;
    return compactOceanCoast && height <= compactOceanCoast.level
      ? Math.min(height, sampleCoastGrid(compactOceanCoast, x, z))
      : height;
  }

  function applyWorldTerrainEdgeNormals(group: THREE.Object3D, tile: WorldTile, centerX: number, centerZ: number): void {
    const terrain = group.getObjectByName('terrain') as THREE.Mesh | undefined;
    const positions = terrain?.geometry.getAttribute('position');
    const normals = terrain?.geometry.getAttribute('normal');
    if (!terrain || !positions || !normals) return;
    const half = tile.size / 2;
    const epsilon = 4;
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index), z = positions.getZ(index);
      if (Math.abs(Math.abs(x) - half) > 1e-5 && Math.abs(Math.abs(z) - half) > 1e-5) continue;
      const worldX = centerX + x, worldZ = centerZ + z;
      const dx = worldTerrainHeight(worldX + epsilon, worldZ) - worldTerrainHeight(worldX - epsilon, worldZ);
      const dz = worldTerrainHeight(worldX, worldZ + epsilon) - worldTerrainHeight(worldX, worldZ - epsilon);
      const length = Math.hypot(dx, epsilon * 2, dz);
      normals.setXYZ(index, -dx / length, epsilon * 2 / length, -dz / length);
    }
    normals.needsUpdate = true;
  }

  function makeContentMap(tile: WorldTile, sampled: WorldTileData, chunk: EcologyChunk): EditableMap {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const contentKeys = new Set([ecologyKey(chunk)]);
    const tileBuildings = buildings.filter(building => pointEcologyKey(building.x, building.z) === ecologyKey(chunk));
    const ecology = ecologyForChunk(chunk);
    const objects = [
      ...tileBuildings.map(building => buildingObject(building, centerX, centerZ)),
      ...ecology.map(instance => ecologyObject(instance, centerX, centerZ)),
      ...manualObjectsForTile(manualObjectTrees, tile, contentKeys, centerX, centerZ)
    ];
    const usedAssetIds = new Set(objects.flatMap(object => object.assetId ? [object.assetId] : []));
    const boxSize: Vec3 = [tile.size, map.box.size[1], tile.size];
    return {
      ...map,
      id: `${map.id}:content:${ecologyKey(chunk)}`,
      name: `${map.name} content ${ecologyKey(chunk)}`,
      seed: map.seed ^ stringSeed(ecologyKey(chunk)),
      world: undefined,
      box: { ...map.box, size: boxSize },
      sceneMode: 'outdoor',
      room: null,
      interiorArtDirection: null,
      terrain: { resolutionX: sampled.resolution, resolutionZ: sampled.resolution, heights: Array.from(sampled.heights) },
      grassLayers: worldGrassLayers(sampled, tile),
      waterBodies: [],
      paintStrokes: [],
      objects,
      spawnPoints: [[0, sample(centerX, centerZ).height, 0]],
      visualSemantics: {
        version: 1,
        zones: roadZones(tile),
        wind: { ...map.visualSemantics?.wind ?? DEFAULT_MAP_VISUAL_SEMANTICS.wind }
      },
      layout: createDefaultMapLayout(boxSize),
      guides: [],
      designSemantics: DEFAULT_MAP_DESIGN_SEMANTICS,
      assets: (map.assets ?? []).filter(asset => usedAssetIds.has(asset.id)),
      collisionBake: undefined
    };
  }

  function buildGlobalCollision(
    localMap: EditableMap,
    centerX: number,
    centerZ: number,
    kinds: ReadonlySet<CollisionMeshKind>
  ): MeshCollisionWorld {
    const transform = new THREE.Matrix4().makeTranslation(centerX, 0, centerZ);
    return buildMapMeshCollisionWorld(localMap, kinds, { transform, idPrefix: localMap.id });
  }

  function ecologyForChunk(chunk: EcologyChunk): EcologyInstance[] {
    const key = ecologyKey(chunk);
    const cached = ecologyCache.get(key);
    if (cached) return cached;
    const generated = generateEcologyChunk(bundle.plan.recipe, bundle.plan.ecology, chunk, {
      sample, exclusion, density, freshWaterDistance: terrainContext.freshWaterDistance
    }).instances;
    ecologyCache.set(key, generated);
    return generated;
  }

  function buildingObject(building: GlobalBuilding, centerX: number, centerZ: number): MapObject {
    const asset = resolveBuildingAsset(building);
    const scale = asset ? fitAssetScale(asset, building.width, building.depth) : 1;
    return {
      id: `world-building:${building.id}`,
      name: building.use || building.id,
      parentId: null,
      assetId: asset?.id ?? null,
      transform: {
        position: [building.x - centerX, sample(building.x, building.z).height, building.z - centerZ],
        rotation: [0, building.rotation ?? 0, 0],
        scale: [1, 1, 1],
        size: asset ? [scale, scale, scale] : [building.width, building.height, building.depth]
      },
      heightMode: 'fixed',
      visible: true,
      locked: true,
      behavior: { kind: 'static', locomotion: 'static' }
    };
  }

  function ecologyObject(instance: EcologyInstance, centerX: number, centerZ: number): MapObject {
    const asset = resolveEcologyAsset(instance);
    const targetWidth = instance.kind === 'shrub' ? 2.2 : instance.kind === 'rock' ? 1.8 : 9;
    const scale = asset ? fitAssetScale(asset, targetWidth * instance.scale, targetWidth * instance.scale) : 1;
    const fallbackSize: Vec3 = instance.kind === 'rock'
      ? [1.8 * instance.scale, 1.2 * instance.scale, 1.6 * instance.scale]
      : instance.kind === 'shrub'
        ? [2.2 * instance.scale, 1.6 * instance.scale, 2.2 * instance.scale]
        : [2.4 * instance.scale, 8 * instance.scale, 2.4 * instance.scale];
    return {
      id: `world-ecology:${instance.id}`,
      name: instance.kind,
      parentId: null,
      assetId: asset?.id ?? null,
      transform: {
        position: [instance.x - centerX, instance.y, instance.z - centerZ],
        rotation: [0, instance.rotation, 0],
        scale: [1, 1, 1],
        size: asset ? [scale, scale, scale] : fallbackSize
      },
      heightMode: 'fixed',
      visible: true,
      locked: true,
      behavior: { kind: 'static', locomotion: 'static' }
    };
  }

  function resolveBuildingAsset(building: GlobalBuilding): MapAsset | null {
    if (world.assets.length === 0) return null;
    let binding: WorldAssetBinding | undefined;
    if (building.assetKey) binding = bindingsByKey.get(building.assetKey);
    else {
      const role = worldBuildingRole(building);
      const candidates = bindingsByRole.get(role) ?? [];
      binding = candidates[stableIndex(building.id, candidates.length)];
    }
    if (!binding) {
      const role = worldBuildingRole(building);
      if (building.assetKey || role === 'landmark') throw new Error(`world_missing_asset_binding:${building.assetKey ?? role}`);
      return null;
    }
    const asset = assetsById.get(binding.assetId);
    if (!asset) throw new Error(`world_missing_asset:${binding.assetId}`);
    return asset;
  }

  function resolveEcologyAsset(instance: EcologyInstance): MapAsset | null {
    if (world.assets.length === 0) return null;
    const binding = selectWorldEcologyAsset(bindingsByRole.get('tree') ?? [], instance);
    if (!binding) return null;
    const asset = assetsById.get(binding.assetId);
    if (!asset) throw new Error(`world_missing_asset:${binding.assetId}`);
    return asset;
  }

  function roadZones(tile: WorldTile): SceneVisualZone[] {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const result: SceneVisualZone[] = [];
    for (const road of roads) {
      const points = road.closed ? [...road.points, road.points[0]] : road.points;
      const fragments = clipPolylineToRect(points, tile.x, tile.z, tile.x + tile.size, tile.z + tile.size, Boolean(road.closed));
      fragments.forEach((fragment, index) => {
        const local = fragment.points.map(([x, z]) => [x - centerX, z - centerZ] as [number, number]);
        const minX = Math.min(...local.map(point => point[0])), maxX = Math.max(...local.map(point => point[0]));
        const minZ = Math.min(...local.map(point => point[1])), maxZ = Math.max(...local.map(point => point[1]));
        const zoneX = (minX + maxX) / 2, zoneZ = (minZ + maxZ) / 2;
        result.push({
          id: `world-road:${road.id}:${index}:${tileKey(tile)}`,
          tags: ['paving', 'settlement'],
          center: [zoneX, zoneZ],
          radius: Math.max(...local.map(point => Math.hypot(point[0] - zoneX, point[1] - zoneZ))) + road.width,
          intensity: 1,
          material: worldRoadSurfaceMaterial(road),
          region: { kind: 'path', points: local, width: road.width },
          roadDistanceOffset: fragment.distanceOffset,
          roadContinuesBefore: fragment.continuesBefore,
          roadContinuesAfter: fragment.continuesAfter,
          forceRoadOverlay: true
        } as SceneVisualZone);
      });
    }
    return result;
  }

  function tileWaterBodies(tile: WorldTile, includeOcean: boolean): MapWaterBody[] {
    const centerX = tile.x + tile.size / 2;
    const centerZ = tile.z + tile.size / 2;
    const bodies = terrainContext.waterBodies.flatMap((prepared): MapWaterBody[] => {
      const water = prepared.source;
      const owner = water.region.kind === 'circle'
        ? water.region.center
        : water.region.points[Math.floor(water.region.points.length / 2)];
      if (!tileContains(tile, owner[0], owner[1])) return [];
      return [{
        ...prepared.mapWater,
        points: prepared.mapWater.points.map(([x, z]) => [x - centerX, z - centerZ]),
        levels: prepared.mapWater.levels ? [...prepared.mapWater.levels] : undefined,
        widths: prepared.mapWater.widths ? [...prepared.mapWater.widths] : undefined
      }];
    });
    if (includeOcean) bodies.push({
      id: 'world-ocean',
      name: '海面',
      type: 'ocean',
      level: 0,
      depth: 12,
      width: tile.size,
      points: [[-tile.size / 2, -tile.size / 2], [tile.size / 2, -tile.size / 2], [tile.size / 2, tile.size / 2], [-tile.size / 2, tile.size / 2]]
    });
    return bodies;
  }

  function applyStyle(rendered: RenderedMap, tileMap: EditableMap, tile: WorldTile): void {
    if (!sameValue(style.grass, DEFAULT_RUNTIME_GRASS_STYLE)) rendered.setGrassStyle(style.grass);
    if (!sameValue(style.terrain, DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE)) rendered.setTerrainMaterialStyle(style.terrain);
    if (style.palette) rendered.setColorPalette(style.palette);
    if (style.sceneArt) rendered.setSceneArt(localSceneArt(style.sceneArt, tileMap, tile), style.sceneArtPalette);
    if (style.wetness || style.snowCover) rendered.setWeatherSurface(style.wetness, style.snowCover);
    if (style.sandFlow) rendered.setSandFlowStrength(style.sandFlow);
    if (style.timeOfDay !== 'noon') rendered.setLightingTimeOfDay(style.timeOfDay);
    if (style.lightingQuality !== 1) rendered.setLightingQuality(style.lightingQuality);
    if (style.lightingSoloObjectId) rendered.setLightingSoloObjectId(style.lightingSoloObjectId);
    if (style.lightingHelpersVisible) rendered.setLightingHelpersVisible(true);
    if (style.environment || style.waterEnvironment) rendered.syncMaterialEnvironment(style.environment, style.waterEnvironment);
  }

  function mountEntry(entry: TileEntry): void {
    const centerX = entry.tile.x + entry.tile.size / 2;
    const centerZ = entry.tile.z + entry.tile.size / 2;
    entry.terrainMount.add(entry.rendered.group);
    root.add(entry.terrainMount);
    entry.rendered.modelsRoot.position.set(centerX, 0, centerZ);
    modelsRoot.add(entry.rendered.modelsRoot);
    offsetWorldWaterBindings(entry.rendered.modelsRoot, centerX, centerZ);
  }

  function setEntryWaterVisible(entry: TileEntry, visible: boolean): void {
    const water = entry.rendered.modelsRoot.getObjectByName('waterBodies');
    if (water?.userData.isStructuredWaterRoot === true) water.visible = visible;
  }

  function unmountEntry(entry: TileEntry): void {
    entry.terrainMount.removeFromParent();
    entry.rendered.modelsRoot.removeFromParent();
    entry.rendered.modelsRoot.position.set(0, 0, 0);
    entry.rendered.group.add(entry.rendered.modelsRoot);
  }

  function disposeEntry(entry: TileEntry): void {
    entry.collision?.dispose();
    entry.rendered.dispose();
  }

  function mountContentEntry(entry: ContentEntry): void {
    const centerX = entry.chunk.x * ECOLOGY_CHUNK_SIZE + ECOLOGY_CHUNK_SIZE / 2;
    const centerZ = entry.chunk.z * ECOLOGY_CHUNK_SIZE + ECOLOGY_CHUNK_SIZE / 2;
    entry.mount.add(entry.rendered.group);
    root.add(entry.mount);
    entry.rendered.modelsRoot.position.set(centerX, 0, centerZ);
    modelsRoot.add(entry.rendered.modelsRoot);
  }

  function unmountContentEntry(entry: ContentEntry): void {
    entry.mount.removeFromParent();
    entry.rendered.modelsRoot.removeFromParent();
    entry.rendered.modelsRoot.position.set(0, 0, 0);
    entry.rendered.group.add(entry.rendered.modelsRoot);
  }

  function disposeContentEntry(entry: ContentEntry): void {
    entry.collision.dispose();
    entry.rendered.dispose();
  }

  function renderedEntries(): Array<TileEntry | ContentEntry> {
    return [...entries.values(), ...contentEntries.values()];
  }

  function rebuildPublicIndexes(): void {
    objectGroups.clear();
    pickables.length = 0;
    for (const entry of renderedEntries()) {
      for (const [id, group] of entry.rendered.objectGroups) objectGroups.set(id, group);
      pickables.push(...entry.rendered.pickables);
    }
  }

  function rebuildCollision(): void {
    const instances = [
      ...[...entries.values()].flatMap(entry => entry.collision?.instances ?? []),
      ...[...contentEntries.values()].flatMap(entry => entry.collision.instances)
    ];
    collisionWorld?.dispose();
    collisionWorld = new MeshCollisionWorld(instances, false);
  }

  function updateLightingBounds(focusX: number, focusZ: number): void {
    const nearby = [...entries.values()].filter(entry => entry.tile.size <= 256
      && tileDistanceSquared(entry.tile, focusX, focusZ) <= 900 * 900);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const entry of nearby) for (const height of entry.map.terrain.heights) {
      if (height < min) min = height;
      if (height > max) max = height;
    }
    if (!Number.isFinite(min)) min = sample(focusX, focusZ).height;
    if (!Number.isFinite(max)) max = min + 80;
    activeCenter = [focusX, min, focusZ];
    activeLightingSize = [1_280, Math.max(128, max - min + 80), 1_280];
  }

  function requestReconcile(x: number, z: number, distance: number): void {
    const next = normalizedReconcileRequest(x, z, distance, desiredRequest ?? appliedRequest);
    const nextKey = reconcileRequestKey(next);
    if (sameReconcileRequest(desiredRequest, next)) {
      if (!failedRequest || failedRequest.key !== nextKey || performance.now() - failedRequest.at < 5_000) return;
    }
    desiredRequest = next;
    requestRevision += 1;
    if (reconciling) return;
    reconciling = true;
    void (async () => {
      try {
        while (desiredRequest && !disposed && !sameReconcileRequest(appliedRequest, desiredRequest)) {
          const current = desiredRequest;
          const revision = requestRevision;
          try {
            const completed = await reconcile(current.x, current.z, current.distance, revision);
            if (completed) appliedRequest = current;
            failedRequest = null;
          } catch (error) {
            const key = reconcileRequestKey(current);
            if (failedRequest?.key !== key) console.error('[WorldStreaming] chunk reconcile failed', error);
            failedRequest = { key, at: performance.now() };
            break;
          }
        }
      } finally {
        reconciling = false;
      }
    })();
  }

  const aggregatePaletteReport = (): PaletteCoverageReport => {
    const reports = renderedEntries().map(entry => entry.rendered.getColorPaletteCoverage());
    const usedColors = new Set<string>();
    const roleCounts: Record<string, number> = {};
    const report = { ...EMPTY_PALETTE_REPORT, usedColors: [] as string[], roleCounts };
    for (const item of reports) {
      report.strictMaterials += item.strictMaterials;
      report.approximateMaterials += item.approximateMaterials;
      report.technicalMaterials += item.technicalMaterials;
      report.unmatchedMaterials += item.unmatchedMaterials;
      item.usedColors.forEach(color => usedColors.add(color));
      for (const [role, count] of Object.entries(item.roleCounts)) roleCounts[role] = (roleCounts[role] ?? 0) + count;
    }
    report.usedColors = [...usedColors];
    return report;
  };

  const aggregateDebugStats = (): RenderedMapDebugStats => {
    const base: RenderedMapDebugStats = {
      totalParts: 0, batchableParts: 0, instancedParts: 0, batchedMeshParts: 0,
      fallbackMeshParts: 0, fallbackVisualClones: 0, buildYieldCount: 0, maxBuildSliceMs: 0,
      batchCount: 0, effectBatchCount: 0, effectBatchParts: 0, runtimeIndexPartRefs: 0,
      orphanPartRefs: 0, orphanInstanceRefs: 0, culled: 0, tested: 0,
      grassLayers: 0, grassBlades: 0, grassFlowers: 0, grassDrawCalls: 0
    };
    const sumKeys = Object.keys(base) as Array<Exclude<keyof RenderedMapDebugStats, 'streaming'>>;
    for (const entry of renderedEntries()) {
      const child = entry.rendered.getDebugStats();
      for (const key of sumKeys) {
        base[key] = key === 'maxBuildSliceMs' ? Math.max(base[key], child[key]) : base[key] + child[key];
      }
    }
    base.streaming = {
      terrainTiles: entries.size,
      contentChunks: contentEntries.size,
      buildings: [...contentEntries.values()].reduce((sum, entry) => sum + entry.buildings, 0),
      ecologyInstances: [...contentEntries.values()].reduce((sum, entry) => sum + entry.ecology, 0),
      texturePixels: renderedEntries().reduce((sum, entry) => sum + entry.texturePixels, 0),
      collisionTriangles: collisionWorld?.instances.reduce((sum, instance) => sum + instance.triangleCount, 0) ?? 0,
      collisionMeshes: collisionWorld?.instances.length ?? 0,
      pendingTiles,
      unloadedTiles,
      finestTerrainSpacing: entries.size
        ? Math.min(...[...entries.values()].map(entry => entry.tile.size / Math.max(1, entry.map.terrain.resolutionX - 1)))
        : 0,
      lastTerrainBuildMs,
      maxTerrainBuildMs,
      lastTerrainSampleMs,
      lastTerrainRenderMs,
      lastTerrainCollisionMs
    };
    return base;
  };

  const buildProfile = (): RenderedMap['buildProfile'] => renderedEntries().reduce((total, entry) => ({
    setupMs: total.setupMs + entry.rendered.buildProfile.setupMs,
    primitiveBatchMs: total.primitiveBatchMs + entry.rendered.buildProfile.primitiveBatchMs,
    objectVisualMs: total.objectVisualMs + entry.rendered.buildProfile.objectVisualMs,
    finalizeMs: total.finalizeMs + entry.rendered.buildProfile.finalizeMs,
    totalMs: total.totalMs + entry.rendered.buildProfile.totalMs
  }), { setupMs: 0, primitiveBatchMs: 0, objectVisualMs: 0, finalizeMs: 0, totalMs: 0 });

  return {
    group: root,
    modelsRoot,
    runtimeIndex,
    objectGroups,
    pickables,
    buildProfile: buildProfile(),
    syncObjectTransform: id => renderedEntries().forEach(entry => entry.rendered.syncObjectTransform(id)),
    update: (deltaTime, camera, maxDistance) => {
      const focus = worldFocusFromCamera(camera, sample);
      entries.forEach(entry => {
        if (tileDistanceSquared(entry.tile, focus.x, focus.z) <= (3_000 + entry.tile.size) ** 2) {
          entry.rendered.update(deltaTime, camera, maxDistance);
        }
      });
      contentEntries.forEach(entry => entry.rendered.update(deltaTime, camera, maxDistance));
      const height = sample(focus.x, focus.z).height;
      requestReconcile(focus.x, focus.z, Math.abs(camera.position.y - height));
    },
    restoreMaterialEffects: () => renderedEntries().forEach(entry => entry.rendered.restoreMaterialEffects()),
    syncMaterialEnvironment: (environment, waterEnvironment) => {
      style.environment = environment;
      style.waterEnvironment = waterEnvironment;
      renderedEntries().forEach(entry => entry.rendered.syncMaterialEnvironment(environment, waterEnvironment));
    },
    getRuntimeBatchMeshes: () => renderedEntries().flatMap(entry => entry.rendered.getRuntimeBatchMeshes()),
    setGrassStyle: value => {
      if (sameValue(style.grass, value)) return;
      style.grass = value;
      entries.forEach(entry => entry.rendered.setGrassStyle(value));
      contentEntries.forEach(entry => entry.rendered.setGrassStyle(worldGrassStyle(value, entry.grassChunkBudget)));
    },
    setSceneArt: (plan, palette) => {
      if (sameValue(style.sceneArt, plan) && sameValue(style.sceneArtPalette, palette)) return;
      style.sceneArt = plan;
      style.sceneArtPalette = palette;
      entries.forEach(entry => entry.rendered.setSceneArt(localSceneArt(plan, entry.map, entry.tile), palette));
      contentEntries.forEach(entry => entry.rendered.setSceneArt(localSceneArt(plan, entry.map, contentEntryTile(entry)), palette));
    },
    setTerrainMaterialStyle: value => {
      if (sameValue(style.terrain, value)) return;
      style.terrain = value;
      renderedEntries().forEach(entry => entry.rendered.setTerrainMaterialStyle(value));
    },
    setColorPalette: palette => {
      if (sameValue(style.palette, palette)) return aggregatePaletteReport();
      style.palette = palette;
      renderedEntries().forEach(entry => entry.rendered.setColorPalette(palette));
      return aggregatePaletteReport();
    },
    getColorPaletteCoverage: aggregatePaletteReport,
    setWeatherSurface: (wetness, snowCover) => {
      if (style.wetness === wetness && style.snowCover === snowCover) return;
      style.wetness = wetness;
      style.snowCover = snowCover;
      renderedEntries().forEach(entry => entry.rendered.setWeatherSurface(wetness, snowCover));
    },
    setSandFlowStrength: strength => {
      if (style.sandFlow === strength) return;
      style.sandFlow = strength;
      renderedEntries().forEach(entry => entry.rendered.setSandFlowStrength(strength));
    },
    setRoomWallDisplayMode: (mode, camera) => renderedEntries().forEach(entry => entry.rendered.setRoomWallDisplayMode(mode, camera)),
    setLightingTimeOfDay: value => { style.timeOfDay = value; renderedEntries().forEach(entry => entry.rendered.setLightingTimeOfDay(value)); },
    setLightingQuality: value => { style.lightingQuality = value; renderedEntries().forEach(entry => entry.rendered.setLightingQuality(value)); },
    setLightingSoloObjectId: value => { style.lightingSoloObjectId = value; renderedEntries().forEach(entry => entry.rendered.setLightingSoloObjectId(value)); },
    setLightingHelpersVisible: value => { style.lightingHelpersVisible = value; renderedEntries().forEach(entry => entry.rendered.setLightingHelpersVisible(value)); },
    interactGrass: (position, elapsedSeconds) => {
      for (const entry of entries.values()) if (tileContains(entry.tile, position[0], position[2])) {
        entry.rendered.interactGrass([
          position[0] - entry.tile.x - entry.tile.size / 2,
          position[1],
          position[2] - entry.tile.z - entry.tile.size / 2
        ], elapsedSeconds);
      }
    },
    clearGrassInteraction: () => renderedEntries().forEach(entry => entry.rendered.clearGrassInteraction()),
    getDebugStats: aggregateDebugStats,
    getCollisionWorld: () => collisionWorld,
    subscribeContentChanges: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    getActiveLightingBounds: () => ({ center: [...activeCenter], size: [...activeLightingSize] }),
    refreshGrass: () => {},
    refreshTerrain: () => {},
    dispose: () => {
      disposed = true;
      desiredRequest = null;
      if (completionTimer) clearTimeout(completionTimer);
      completionTimer = null;
      listeners.clear();
      collisionWorld?.dispose();
      collisionWorld = null;
      entries.forEach(entry => { unmountEntry(entry); disposeEntry(entry); });
      entries.clear();
      contentEntries.forEach(entry => { unmountContentEntry(entry); disposeContentEntry(entry); });
      contentEntries.clear();
      if (compactOcean) disposeStructuredWaterGroup(compactOcean);
      disposeWorldWhiteboxOverlay(whiteboxOverlay);
      root.clear();
    }
  };
}

function disposeWorldWhiteboxOverlay(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse(object => {
    const rendered = object as THREE.Mesh | THREE.Line;
    if (rendered.geometry) geometries.add(rendered.geometry);
    const material = rendered.material;
    if (Array.isArray(material)) material.forEach(value => materials.add(value));
    else if (material) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

function validateWorldAssets(
  map: EditableMap,
  bindingsByKey: Map<string, WorldAssetBinding>,
  bindingsByRole: Map<WorldAssetBinding['role'], WorldAssetBinding[]>,
  assetsById: Map<string, MapAsset>
): void {
  const world = map.world!;
  if (world.assets.length === 0) return;
  for (const binding of world.assets) if (!assetsById.has(binding.assetId)) throw new Error(`world_missing_asset:${binding.assetId}`);
  for (const patch of world.bundle.patches) for (const building of patch.buildings) {
    if (building.assetKey && !bindingsByKey.has(building.assetKey)) throw new Error(`world_missing_asset_binding:${building.assetKey}`);
    const role = worldBuildingRole(building);
    if (role === 'landmark' && !building.assetKey && !(bindingsByRole.get(role)?.length)) throw new Error(`world_missing_asset_binding:${role}`);
  }
}

function groupBindingsByRole(bindings: WorldAssetBinding[]): Map<WorldAssetBinding['role'], WorldAssetBinding[]> {
  const result = new Map<WorldAssetBinding['role'], WorldAssetBinding[]>();
  for (const binding of bindings) {
    const values = result.get(binding.role) ?? [];
    values.push(binding);
    result.set(binding.role, values);
  }
  return result;
}

function globalBuildings(bundle: EditableMap['world'] extends infer _ ? NonNullable<EditableMap['world']>['bundle'] : never): GlobalBuilding[] {
  return bundle.patches.flatMap(patch => {
    const town = bundle.plan.towns.find(candidate => candidate.id === patch.townId);
    if (!town) throw new Error(`world_missing_town:${patch.townId}`);
    return patch.buildings.map(building => ({
      ...building,
      x: building.x + town.center[0],
      z: building.z + town.center[1],
      townId: town.id
    }));
  });
}

function globalRoads(bundle: NonNullable<EditableMap['world']>['bundle']): MapGuide[] {
  return [
    ...bundle.plan.roads,
    ...bundle.patches.flatMap(patch => {
      const town = bundle.plan.towns.find(candidate => candidate.id === patch.townId);
      if (!town) throw new Error(`world_missing_town:${patch.townId}`);
      return patch.streets.map(street => ({
        ...street,
        id: `town:${town.id}:${street.id}`,
        points: street.points.map(([x, z]): [number, number] => [x + town.center[0], z + town.center[1]])
      }));
    })
  ];
}

function fitAssetScale(asset: MapAsset, width: number, depth: number): number {
  const bounds = calculateModelVisualFrame(asset.modelJson).bounds;
  const modelWidth = Math.max(0.01, bounds.max[0] - bounds.min[0]);
  const modelDepth = Math.max(0.01, bounds.max[2] - bounds.min[2]);
  return Math.min(width / modelWidth, depth / modelDepth);
}

function stableIndex(id: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return count ? (hash >>> 0) % count : 0;
}

function stringSeed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function tileKey(tile: WorldTile): string { return `${tile.x}:${tile.z}:${tile.size}`; }
function ecologyKey(chunk: EcologyChunk): string { return `${chunk.x}:${chunk.z}`; }
function contentEntryTile(entry: ContentEntry): WorldTile {
  return { x: entry.chunk.x * ECOLOGY_CHUNK_SIZE, z: entry.chunk.z * ECOLOGY_CHUNK_SIZE, size: ECOLOGY_CHUNK_SIZE };
}
function pointEcologyKey(x: number, z: number): string { return `${Math.floor(x / 256)}:${Math.floor(z / 256)}`; }
function tileContains(tile: WorldTile, x: number, z: number): boolean {
  return x >= tile.x && x < tile.x + tile.size && z >= tile.z && z < tile.z + tile.size;
}
function terrainSkirtSides(tile: WorldTile, tiles: readonly WorldTile[]): TerrainBorderSide[] {
  const result = new Set<TerrainBorderSide>();
  const epsilon = 1e-6;
  const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => Math.min(a1, b1) - Math.max(a0, b0) > epsilon;
  for (const neighbor of tiles) {
    if (neighbor === tile || neighbor.size <= tile.size) continue;
    if (Math.abs(tile.z - (neighbor.z + neighbor.size)) <= epsilon
      && overlaps(tile.x, tile.x + tile.size, neighbor.x, neighbor.x + neighbor.size)) result.add('north');
    if (Math.abs(tile.z + tile.size - neighbor.z) <= epsilon
      && overlaps(tile.x, tile.x + tile.size, neighbor.x, neighbor.x + neighbor.size)) result.add('south');
    if (Math.abs(tile.x - (neighbor.x + neighbor.size)) <= epsilon
      && overlaps(tile.z, tile.z + tile.size, neighbor.z, neighbor.z + neighbor.size)) result.add('west');
    if (Math.abs(tile.x + tile.size - neighbor.x) <= epsilon
      && overlaps(tile.z, tile.z + tile.size, neighbor.z, neighbor.z + neighbor.size)) result.add('east');
  }
  return (['north', 'south', 'west', 'east'] as const).filter(side => result.has(side));
}
function chunkIntersectsTile(chunk: EcologyChunk, tile: WorldTile): boolean {
  const x = chunk.x * 256, z = chunk.z * 256;
  return x < tile.x + tile.size && x + 256 > tile.x && z < tile.z + tile.size && z + 256 > tile.z;
}
function tileDistanceSquared(tile: WorldTile, x: number, z: number): number {
  const dx = Math.max(0, tile.x - x, x - tile.x - tile.size);
  const dz = Math.max(0, tile.z - z, z - tile.z - tile.size);
  return dx * dx + dz * dz;
}
function chunkDistanceSquared(chunk: EcologyChunk, x: number, z: number): number {
  const tile = { x: chunk.x * ECOLOGY_CHUNK_SIZE, z: chunk.z * ECOLOGY_CHUNK_SIZE, size: ECOLOGY_CHUNK_SIZE };
  return tileDistanceSquared(tile, x, z);
}

export function worldTileSurfaceWeight(
  data: WorldTileData,
  tile: WorldTile,
  worldX: number,
  worldZ: number,
  tags: readonly VisualZoneTag[]
): number {
  const gridX = THREE.MathUtils.clamp((worldX - tile.x) / tile.size * (data.resolution - 1), 0, data.resolution - 1);
  const gridZ = THREE.MathUtils.clamp((worldZ - tile.z) / tile.size * (data.resolution - 1), 0, data.resolution - 1);
  const x0 = Math.floor(gridX), z0 = Math.floor(gridZ);
  const x1 = Math.min(data.resolution - 1, x0 + 1), z1 = Math.min(data.resolution - 1, z0 + 1);
  const tx = gridX - x0, tz = gridZ - z0;
  const ocean = interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.ocean);
  const freshWater = interpolateTileScalar(data.freshWaterWeights, data.resolution, x0, z0, x1, z1, tx, tz);
  const freshWaterCover = THREE.MathUtils.smoothstep(freshWater, 0.9, 1);
  const freshWaterShore = THREE.MathUtils.smoothstep(freshWater, 0.4, 0.72);
  const freshWaterBank = freshWaterShore
    * (1 - THREE.MathUtils.smoothstep(freshWater, 0.84, 1));
  const height = interpolateTileScalar(data.heights, data.resolution, x0, z0, x1, z1, tx, tz);
  const metresPerCell = tile.size / Math.max(1, data.resolution - 1);
  const slopeX0 = Math.min(x0, data.resolution - 2), slopeX1 = slopeX0 + 1;
  const slopeZ0 = Math.min(z0, data.resolution - 2), slopeZ1 = slopeZ0 + 1;
  const slopeTx = gridX - slopeX0, slopeTz = gridZ - slopeZ0;
  const height00 = data.heights[slopeZ0 * data.resolution + slopeX0];
  const height10 = data.heights[slopeZ0 * data.resolution + slopeX1];
  const height01 = data.heights[slopeZ1 * data.resolution + slopeX0];
  const height11 = data.heights[slopeZ1 * data.resolution + slopeX1];
  const slopeX = THREE.MathUtils.lerp(height10 - height00, height11 - height01, slopeTz) / metresPerCell;
  const slopeZ = THREE.MathUtils.lerp(height01 - height00, height11 - height10, slopeTx) / metresPerCell;
  const steepRock = THREE.MathUtils.smoothstep(Math.hypot(slopeX, slopeZ), 0.28, 0.72) * (1 - ocean);
  // Low inland riverbanks can share the ocean height band; keep that coastal
  // sand from outlining every freshwater channel as a continuous pale stripe.
  const beach = worldCoastalSandWeight(height, ocean)
    * (1 - freshWaterShore);
  let weight = 0;
  for (const tag of tags) {
    if (tag === 'dry') {
      weight = Math.max(weight,
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.desert)
          * (1 - Math.max(freshWaterCover, freshWaterBank * 0.42)));
    } else if (tag === 'sand') {
      weight = Math.max(
        weight,
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.desert) * (1 - freshWaterCover),
        beach
      );
    } else if (tag === 'rocky') {
      weight = Math.max(
        weight,
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.mountains),
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.snow) * 0.35,
        steepRock * (1 - freshWaterShore)
      );
    } else if (tag === 'snow') {
      weight = Math.max(weight, interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.snow));
    } else if (tag === 'grass') {
      weight = Math.max(
        weight,
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.grassland)
          * (1 - steepRock * 0.72) * (1 - Math.max(freshWaterCover, freshWaterBank * 0.32)),
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.forest)
          * (1 - steepRock * 0.72) * (1 - Math.max(freshWaterCover, freshWaterBank * 0.32))
      );
    } else if (tag === 'forest') {
      weight = Math.max(
        weight,
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.forest)
          * (1 - steepRock * 0.72) * (1 - Math.max(freshWaterCover, freshWaterBank * 0.32))
      );
    } else if (tag === 'water') {
      weight = Math.max(weight, ocean, freshWater);
    } else if (tag === 'lowland') {
      weight = Math.max(
        weight,
        ocean,
        freshWater,
        interpolateTileBiome(data, x0, z0, x1, z1, tx, tz, BIOME_CHANNEL.grassland)
      );
    }
  }
  return THREE.MathUtils.clamp(weight, 0, 1);
}

export function worldCoastalSandWeight(height: number, oceanWeight: number): number {
  const shore = THREE.MathUtils.smoothstep(oceanWeight, 0.12, 0.45);
  const lowGround = 1 - THREE.MathUtils.smoothstep(height, 2, 8);
  return shore * lowGround;
}

function interpolateTileScalar(
  values: Float32Array,
  resolution: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  tx: number,
  tz: number
): number {
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(values[z0 * resolution + x0], values[z0 * resolution + x1], tx),
    THREE.MathUtils.lerp(values[z1 * resolution + x0], values[z1 * resolution + x1], tx),
    tz
  );
}

function interpolateTileBiome(
  data: WorldTileData,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  tx: number,
  tz: number,
  channel: number
): number {
  const channels = WORLD_BIOMES.length;
  const topLeft = data.weights[(z0 * data.resolution + x0) * channels + channel];
  const topRight = data.weights[(z0 * data.resolution + x1) * channels + channel];
  const bottomLeft = data.weights[(z1 * data.resolution + x0) * channels + channel];
  const bottomRight = data.weights[(z1 * data.resolution + x1) * channels + channel];
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(topLeft, topRight, tx),
    THREE.MathUtils.lerp(bottomLeft, bottomRight, tx),
    tz
  );
}

function clipSegment(
  start: [number, number], end: [number, number], minX: number, minZ: number, maxX: number, maxZ: number
): [[number, number], [number, number]] | null {
  const dx = end[0] - start[0], dz = end[1] - start[1];
  let low = 0, high = 1;
  for (const [p, q] of [[-dx, start[0] - minX], [dx, maxX - start[0]], [-dz, start[1] - minZ], [dz, maxZ - start[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const ratio = q / p;
    if (p < 0) low = Math.max(low, ratio); else high = Math.min(high, ratio);
    if (low > high) return null;
  }
  return [[start[0] + dx * low, start[1] + dz * low], [start[0] + dx * high, start[1] + dz * high]];
}

interface ClippedRoadFragment {
  points: Array<[number, number]>;
  distanceOffset: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

function clipPolylineToRect(
  points: Array<[number, number]>,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  closed: boolean
): ClippedRoadFragment[] {
  const fragments: ClippedRoadFragment[] = [];
  let current: ClippedRoadFragment | null = null;
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1], end = points[index];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const clipped = clipSegment(start, end, minX, minZ, maxX, maxZ);
    if (clipped) {
      const startsLater = Math.hypot(clipped[0][0] - start[0], clipped[0][1] - start[1]) > 1e-5;
      const endsEarlier = Math.hypot(clipped[1][0] - end[0], clipped[1][1] - end[1]) > 1e-5;
      const joinsCurrent = current && pointsNear(current.points[current.points.length - 1], clipped[0]);
      if (!joinsCurrent) {
        if (current) fragments.push(current);
        current = {
          points: [clipped[0], clipped[1]],
          distanceOffset: distance + Math.hypot(clipped[0][0] - start[0], clipped[0][1] - start[1]),
          continuesBefore: closed || index > 1 || startsLater,
          continuesAfter: closed || index < points.length - 1 || endsEarlier
        };
      } else {
        if (!pointsNear(current!.points[current!.points.length - 1], clipped[1])) current!.points.push(clipped[1]);
        current!.continuesAfter = closed || index < points.length - 1 || endsEarlier;
      }
    } else if (current) {
      fragments.push(current);
      current = null;
    }
    distance += length;
  }
  if (current) fragments.push(current);
  return fragments.filter(fragment => fragment.points.length >= 2);
}

function pointsNear(left: [number, number], right: [number, number]): boolean {
  return Math.hypot(left[0] - right[0], left[1] - right[1]) <= 1e-5;
}

function localSceneArt(plan: SceneArtPlan | null, map: EditableMap, tile: WorldTile): SceneArtPlan | null {
  if (!plan) return null;
  const zoneIds = new Set(map.visualSemantics.zones.map(zone => zone.id));
  const objectIds = new Set(map.objects.map(object => object.id));
  const centerX = tile.x + tile.size / 2;
  const centerZ = tile.z + tile.size / 2;
  return {
    colors: plan.colors.filter(field => !field.zoneId || zoneIds.has(field.zoneId)).map(field => ({
      ...field,
      center: [field.center[0] - centerX, field.center[1] - centerZ]
    })),
    lights: plan.lights.filter(light => objectIds.has(light.objectId) && (!light.targetId || objectIds.has(light.targetId))),
    surfaces: plan.surfaces.filter(surface => objectIds.has(surface.objectId)),
    wet: plan.wet.filter(wet => zoneIds.has(wet.zoneId))
  };
}

function offsetWorldWaterBindings(root: THREE.Object3D, x: number, z: number): void {
  root.traverse(object => {
    const shore = object.userData.waterShore as { center?: [number, number]; worldSpace?: boolean } | undefined;
    if (shore?.worldSpace !== false && shore?.center) shore.center = [shore.center[0] + x, shore.center[1] + z];
    const ocean = object.userData.waterOceanTerrain as { center?: [number, number]; splashPoints?: Array<[number, number]> } | undefined;
    if (ocean?.center) ocean.center = [ocean.center[0] + x, ocean.center[1] + z];
    if (ocean?.splashPoints) ocean.splashPoints = ocean.splashPoints.map(point => [point[0] + x, point[1] + z]);
  });
}

function worldFocusFromCamera(camera: THREE.Camera, sample: (x: number, z: number) => { height: number }): { x: number; z: number } {
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const ground = sample(camera.position.x, camera.position.z).height;
  const height = Math.max(0, camera.position.y - ground);
  const projectionBlend = THREE.MathUtils.smoothstep(-direction.y, 0.02, 0.22);
  const maxDistance = THREE.MathUtils.clamp(height * 4, 256, 3_000);
  let rayDistance = direction.y < -0.001 ? (ground - camera.position.y) / direction.y : 0;
  for (let iteration = 0; iteration < 3 && direction.y < -0.001; iteration += 1) {
    rayDistance = THREE.MathUtils.clamp(rayDistance, 0, maxDistance);
    const x = camera.position.x + direction.x * rayDistance;
    const z = camera.position.z + direction.z * rayDistance;
    rayDistance = (sample(x, z).height - camera.position.y) / direction.y;
  }
  const distance = THREE.MathUtils.clamp(rayDistance, 0, maxDistance) * projectionBlend;
  return {
    x: camera.position.x + direction.x * distance,
    z: camera.position.z + direction.z * distance
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function normalizedReconcileRequest(
  x: number,
  z: number,
  distance: number,
  previous: ReconcileRequest | null = null
): ReconcileRequest {
  const next = {
    x: Math.round(x / 64) * 64,
    z: Math.round(z / 64) * 64,
    distance: distance > CONTENT_DISTANCE_LIMIT
      ? Math.round(distance / 500) * 500
      : Math.max(50, Math.round(distance / 100) * 100)
  };
  if (previous) {
    if (Math.abs(x - previous.x) < 128) next.x = previous.x;
    if (Math.abs(z - previous.z) < 128) next.z = previous.z;
    if (Math.abs(distance - previous.distance) < 200) next.distance = previous.distance;
  }
  return next;
}

function sameReconcileRequest(left: ReconcileRequest | null, right: ReconcileRequest | null): boolean {
  return Boolean(left && right && left.x === right.x && left.z === right.z && left.distance === right.distance);
}

export function worldOceanAnchor(size: number, focusX: number, focusZ: number): { x: number; z: number } {
  return size <= CONTENT_DISTANCE_LIMIT ? { x: 0, z: 0 } : { x: focusX, z: focusZ };
}

function applyWorldOceanFloor(
  heights: Float32Array,
  tile: WorldTile,
  resolution: number,
  coast: OceanCoastField
): void {
  for (let index = 0; index < heights.length; index += 1) {
    if (heights[index] > coast.level) continue;
    const x = tile.x + index % resolution / (resolution - 1) * tile.size;
    const z = tile.z + Math.floor(index / resolution) / (resolution - 1) * tile.size;
    heights[index] = Math.min(heights[index], sampleCoastGrid(coast, x, z));
  }
}

export function worldGrassLayers(data: WorldTileData, tile: WorldTile): MapGrassLayer[] {
  const densities = Array.from({ length: data.resolution * data.resolution }, (_, index) => {
    const x = tile.x + index % data.resolution / Math.max(1, data.resolution - 1) * tile.size;
    const z = tile.z + Math.floor(index / data.resolution) / Math.max(1, data.resolution - 1) * tile.size;
    const grass = worldTileSurfaceWeight(data, tile, x, z, ['grass', 'forest']);
    const blocked = Math.max(
      worldTileSurfaceWeight(data, tile, x, z, ['sand']),
      worldTileSurfaceWeight(data, tile, x, z, ['rocky'])
    );
    return grass * (1 - blocked) * 0.72;
  });
  if (!densities.some(density => density > 0.01)) return [];
  return [{
    id: 'world-ground-cover', name: 'World ground cover', visible: true,
    seed: stringSeed(tileKey(tile)), resolutionX: data.resolution, resolutionZ: data.resolution,
    densities, preset: 'meadow', height: 0.82, mix: { short: 0.82, tall: 0.15, flowers: 0.03 }
  }];
}

export function worldGrassChunkBudget(residentChunks: number): number {
  return Math.min(
    WORLD_GRASS_CHUNK_INSTANCE_BUDGET,
    Math.max(1, Math.floor(WORLD_GRASS_RESIDENT_INSTANCE_BUDGET / Math.max(1, residentChunks)))
  );
}

function worldGrassStyle(style: RuntimeGrassStyle, chunkBudget: number): RuntimeGrassStyle {
  return { ...style, maxInstances: Math.min(style.maxInstances, chunkBudget) };
}

function reconcileRequestKey(request: ReconcileRequest): string {
  return `${request.x}:${request.z}:${request.distance}`;
}

export function worldBuildPaintIntervals(
  buildMs: number,
  minimumPaints = 1,
  mountFrameMs = 0,
  maximumPaints = WORLD_STREAM_MAX_RECOVERY_PAINTS
): number {
  return Math.max(
    minimumPaints,
    Math.min(
      maximumPaints,
      Math.ceil(Math.max(0, buildMs, mountFrameMs) / WORLD_STREAM_BUILD_FRAME_BUDGET_MS)
    )
  );
}

function yieldWorldBuild(
  buildMs: number,
  minimumPaints: number,
  maximumPaints = WORLD_STREAM_MAX_RECOVERY_PAINTS
): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return; }
    let painted = 0;
    let firstPaintAt = 0;
    let targetPaints = minimumPaints;
    const afterPaint = (paintAt: number): void => {
      painted += 1;
      if (painted === 1) firstPaintAt = paintAt;
      // The first rendered frame pays the mounted geometry and texture uploads,
      // so its interval can be more expensive than the preceding CPU build.
      if (painted === 2) {
        targetPaints = worldBuildPaintIntervals(buildMs, minimumPaints, paintAt - firstPaintAt, maximumPaints);
      }
      if (painted < targetPaints) requestAnimationFrame(afterPaint);
      else setTimeout(resolve, 0);
    };
    requestAnimationFrame(afterPaint);
  });
}
