import * as THREE from 'three';
import {
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPAWN_OBJECT_ID,
  SUN_OBJECT_ID,
  getMapBounds,
  getPlayerSpawnYaw,
  getSpawnPoints,
  getSunPosition,
  normalizeMap,
  sampleTerrainHeight,
  terrainIndex,
  terrainPointAt,
  type EditableMap,
  type MapAsset,
  type MapObject,
  type MapPaintStroke,
  type MapSurface,
  type MapWaterBody
} from '../shared/map';
import { buildModelGroup } from './modelRenderer';
import { buildMapPrimitiveBatches } from './mapPrimitiveBatching';
import { terrainVertexColor } from './terrainAppearance';
import { buildMapGrassField, deriveContactAwareGrassMap } from './mapGrassRenderer';
import { combinedGrassDensity } from '../shared/mapGrass';
import {
  DEFAULT_RUNTIME_GRASS_STYLE,
  type RuntimeGrassStyle,
} from '../shared/renderPlan';
import type { RuntimeIndex } from '@voxel-studio/render-runtime';
import type { MapPrimitiveBatchStats } from './mapPrimitiveBatching';
import type { Vec3 } from '../shared/protocol';
import { buildMapLocalLights } from './mapLocalLights';

export interface RenderedMapDebugStats extends MapPrimitiveBatchStats {
  grassLayers: number;
  grassBlades: number;
  grassFlowers: number;
  grassDrawCalls: number;
}

export interface RenderedMap {
  group: THREE.Group;
  modelsRoot: THREE.Group;
  runtimeIndex: RuntimeIndex;
  objectGroups: Map<string, THREE.Group>;
  pickables: THREE.Object3D[];
  syncObjectTransform: (objectId: string) => void;
  update: (deltaTime: number, camera: THREE.Camera, maxDistance: number) => void;
  restoreMaterialEffects: () => void;
  syncMaterialEnvironment: (environmentMap: THREE.Texture | null) => void;
  getRuntimeBatchMeshes: () => THREE.Object3D[];
  setGrassStyle: (style: RuntimeGrassStyle) => void;
  interactGrass: (position: Vec3, elapsedSeconds: number) => void;
  clearGrassInteraction: () => void;
  getDebugStats: () => RenderedMapDebugStats;
  /**
   * Rebuilds only the grass field and the terrain tint that follows it. Grass
   * edits touch nothing else, so they must not pay for a whole scene rebuild.
   */
  refreshGrass: (map: EditableMap) => void;
  /**
   * Rebuilds only the terrain mesh — geometry, vertex colours and the painted
   * surface texture — plus the grass that rides on it. Paint and terrain
   * strokes touch nothing else, so they must not pay for asset re-batching.
   */
  refreshTerrain: (map: EditableMap) => void;
  dispose: () => void;
}

export interface MapRenderOptions {
  editorHelpers?: boolean;
  scene?: THREE.Scene;
}

export async function buildEditableMapGroup(input: EditableMap, options: MapRenderOptions = {}): Promise<RenderedMap> {
  const map = normalizeMap(input);
  const root = new THREE.Group();
  root.name = `map:${map.id}`;
  const modelsRoot = new THREE.Group();
  modelsRoot.name = 'modelsRoot';
  modelsRoot.userData.isModelRoot = true;
  root.add(modelsRoot);
  const pickables: THREE.Object3D[] = [];
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));

  let grassMap = deriveContactAwareGrassMap(map);
  const terrain = buildTerrain(map);
  applyTerrainGrassTint(terrain, grassMap, DEFAULT_RUNTIME_GRASS_STYLE);
  root.add(terrain);
  pickables.push(terrain);

  // Grass is rebuilt on its own, so it keeps its own map snapshot and style.
  let grassStyle = DEFAULT_RUNTIME_GRASS_STYLE;
  let materialElapsedSeconds = 0;
  let grass = buildMapGrassField(grassMap);
  if (grass) root.add(grass.group);

  const rebuildGrass = (next: EditableMap): void => {
    grassMap = deriveContactAwareGrassMap(next);
    grass?.dispose();
    grass = buildMapGrassField(grassMap, grassStyle);
    if (grass) root.add(grass.group);
    applyTerrainGrassTint(terrain, grassMap, grassStyle);
  };

  modelsRoot.add(buildStructuredWaterGroup(map));
  const objectGroups = createObjectGroups(map);
  if (options.editorHelpers) {
    const playerSpawnGroup = buildPlayerSpawnGroup(map);
    const sunGroup = buildSunGroup(map);
    root.add(playerSpawnGroup, sunGroup);
    objectGroups.set(PLAYER_SPAWN_OBJECT_ID, playerSpawnGroup);
    objectGroups.set(SUN_OBJECT_ID, sunGroup);
  }
  for (const object of map.objects) {
    const group = objectGroups.get(object.id);
    if (!group) continue;
    const parent = object.parentId ? objectGroups.get(object.parentId) : null;
    if (parent && parent !== group) parent.add(group);
    else modelsRoot.add(group);
  }
  modelsRoot.updateMatrixWorld(true);
  const instancing = await buildMapPrimitiveBatches(map.objects.flatMap((object) => {
    const asset = object.visible && object.assetId ? assets.get(object.assetId) : undefined;
    const objectGroup = objectGroups.get(object.id);
    return asset && objectGroup
      ? [{ objectId: object.id, objectGroup, asset, assetTags: deriveAssetTags(asset) }]
      : [];
  }), {
    scene: options.scene ?? new THREE.Scene(),
    modelsRoot,
    materialTagPolicy: map.materialTagPolicy
  });
  modelsRoot.add(instancing.root);
  await populateObjectVisuals(map, assets, objectGroups, instancing.handledObjectIds);
  const localLights = buildMapLocalLights(map, objectGroups);
  root.add(localLights.group);
  for (const group of objectGroups.values()) {
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child.userData.editorHelper !== true) pickables.push(child);
    });
  }
  pickables.push(...instancing.pickables);

  return {
    group: root,
    modelsRoot,
    runtimeIndex: instancing.runtimeIndex,
    objectGroups,
    pickables,
    syncObjectTransform: instancing.syncObjectTransform,
    update: (deltaTime, camera, maxDistance) => {
      materialElapsedSeconds += deltaTime;
      grass?.update(deltaTime);
      instancing.updateCulling(camera, maxDistance);
      instancing.updateMaterialEffects(materialElapsedSeconds);
      localLights.update(camera);
    },
    restoreMaterialEffects: instancing.restoreMaterialEffects,
    syncMaterialEnvironment: instancing.syncEnvironment,
    getRuntimeBatchMeshes: instancing.getBatchMeshes,
    setGrassStyle: (style) => {
      grassStyle = style;
      grass?.setStyle(style);
      applyTerrainGrassTint(terrain, grassMap, style);
    },
    interactGrass: (position, elapsedSeconds) => grass?.interact(position, elapsedSeconds),
    clearGrassInteraction: () => grass?.clearInteraction(),
    getDebugStats: () => {
      const grassStats = grass?.getStats() ?? { layerCount: 0, bladeCount: 0, flowerCount: 0, drawCalls: 0 };
      return {
        ...instancing.getStats(),
        grassLayers: grassStats.layerCount,
        grassBlades: grassStats.bladeCount,
        grassFlowers: grassStats.flowerCount,
        grassDrawCalls: grassStats.drawCalls
      };
    },
    refreshGrass: rebuildGrass,
    refreshTerrain: (next) => {
      terrain.geometry.dispose();
      terrain.geometry = buildTerrainGeometry(next);
      // Keep the live material so an applied render scheme survives the swap.
      const material = terrain.material as THREE.MeshStandardMaterial;
      material.map?.dispose();
      material.map = createSurfaceTexture(next, 'terrain');
      material.needsUpdate = true;
      // Blades sample terrain height, so they have to follow the new surface.
      rebuildGrass(next);
    },
    dispose: () => {
      grass?.dispose();
      instancing.dispose();
      disposeObject(root);
    }
  };
}

function applyTerrainGrassTint(mesh: THREE.Mesh, map: EditableMap, style: RuntimeGrassStyle): void {
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  const colors = geometry.getAttribute('color') as THREE.BufferAttribute;
  const grassColor = new THREE.Color(style.groundColor);
  const rootColor = new THREE.Color(style.rootColor);
  grassColor.lerp(rootColor, 0.58);
  const color = new THREE.Color();
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const base = terrainVertexColor(map, x, y, z);
    color.setRGB(base[0], base[1], base[2]);
    const isSurface = y >= sampleTerrainHeight(map, x, z) - 0.05;
    if (style.groundTint && isSurface) {
      const density = combinedGrassDensity(map, x, z);
      const transition = density * density * (3 - 2 * density);
      color.lerp(grassColor, transition * style.groundTintStrength);
    }
    colors.setXYZ(index, color.r, color.g, color.b);
  }
  colors.needsUpdate = true;
}

function buildTerrain(map: EditableMap): THREE.Mesh {
  const geometry = buildTerrainGeometry(map);
  const texture = createSurfaceTexture(map, 'terrain');
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    roughness: 0.92,
    vertexColors: true,
    side: THREE.FrontSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.surface = 'terrain';
  return mesh;
}

export function buildStructuredWaterGroup(map: EditableMap): THREE.Group {
  const group = new THREE.Group();
  group.name = 'waterBodies';
  group.userData.isStructuredWaterRoot = true;
  for (const waters of groupConnectedWaterBodies(map.waterBodies)) {
    const water = waters[0];
    const shore = createCompositeWaterShoreBinding(waters);
    const isComposite = waters.length > 1;
    const geometry = isComposite
      ? buildCompositeWaterGeometry(shore.size)
      : water.type === 'lake'
        ? buildLakeGeometry(water.points)
        : buildRiverGeometry(water.points, water.width);
    const material = new THREE.MeshStandardMaterial({
      color: 0x4f96a8,
      transparent: true,
      opacity: 0.82,
      roughness: 0.28,
      metalness: 0.04,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `water:${water.id}`;
    mesh.position.set(
      isComposite ? shore.center[0] : 0,
      waters.reduce((sum, candidate) => sum + candidate.level, 0) / waters.length,
      isComposite ? shore.center[1] : 0
    );
    mesh.renderOrder = 8;
    mesh.userData.waterBodyId = water.id;
    mesh.userData.waterBodyIds = waters.map((candidate) => candidate.id);
    mesh.userData.waterBodyType = waters.every((candidate) => candidate.type === water.type)
      ? water.type
      : 'mixed';
    mesh.userData.isWater = true;
    mesh.userData.skipShaderApply = true;
    mesh.userData.excludeFromPlanarReflection = true;
    mesh.userData.materialTags = [
      'water',
      ...new Set(waters.flatMap((candidate) => [candidate.type, candidate.id]))
    ];
    mesh.userData.assetTags = ['water', ...new Set(waters.map((candidate) => candidate.type))];
    mesh.userData.waterShore = { ...shore, worldSpace: !isComposite };
    group.add(mesh);
  }
  return group;
}

interface WaterShoreBinding {
  texture: THREE.DataTexture;
  center: [number, number];
  size: number;
  worldSpace?: boolean;
}

function groupConnectedWaterBodies(waters: readonly MapWaterBody[]): MapWaterBody[][] {
  const boundaries = waters.map(waterBoundary);
  const parents = waters.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  for (let left = 0; left < waters.length; left += 1) {
    for (let right = left + 1; right < waters.length; right += 1) {
      if (Math.abs(waters[left].level - waters[right].level) > 0.05) continue;
      if (!waterBoundariesTouch(boundaries[left], boundaries[right])) continue;
      parents[find(right)] = find(left);
    }
  }
  const groups = new Map<number, MapWaterBody[]>();
  for (let index = 0; index < waters.length; index += 1) {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(waters[index]);
    groups.set(root, group);
  }
  return [...groups.values()];
}

function createCompositeWaterShoreBinding(waters: readonly MapWaterBody[]): WaterShoreBinding {
  const boundaries = waters.map(waterBoundary);
  const points = boundaries.flat();
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minZ = Math.min(...points.map((point) => point[1]));
  const maxZ = Math.max(...points.map((point) => point[1]));
  const center: [number, number] = [(minX + maxX) / 2, (minZ + maxZ) / 2];
  const size = Math.max(1, maxX - minX, maxZ - minZ) * 1.12;
  const resolution = THREE.MathUtils.clamp(THREE.MathUtils.ceilPowerOfTwo(size * 4), 128, 512);
  const inside = new Uint8Array(resolution * resolution);
  const data = new Uint8Array(resolution * resolution);
  for (let row = 0; row < resolution; row += 1) {
    const v = (row + 0.5) / resolution;
    const z = center[1] + (0.5 - v) * size;
    for (let column = 0; column < resolution; column += 1) {
      const u = (column + 0.5) / resolution;
      const x = center[0] + (u - 0.5) * size;
      if (boundaries.some((boundary) => pointInPolygon(x, z, boundary))) {
        inside[row * resolution + column] = 1;
      }
    }
  }
  const distances = distanceFromOutside(inside, resolution);
  let maxDistance = 0;
  for (let index = 0; index < distances.length; index += 1) {
    if (inside[index]) maxDistance = Math.max(maxDistance, distances[index]);
  }
  const distanceScale = maxDistance > 0 ? 255 / maxDistance : 0;
  for (let index = 0; index < data.length; index += 1) {
    if (inside[index]) data[index] = Math.round(Math.min(255, distances[index] * distanceScale));
  }
  const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.UnsignedByteType);
  texture.name = `water-shore:${waters[0]?.id ?? 'empty'}+${waters.length}`;
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, center, size };
}

function buildCompositeWaterGeometry(size: number): THREE.BufferGeometry {
  const segments = THREE.MathUtils.clamp(Math.ceil(size / 4), 8, 32);
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function waterBoundary(water: MapWaterBody): Array<[number, number]> {
  return water.type === 'lake'
    ? cleanWaterPoints(water.points)
    : riverBoundaryPoints(water.points, water.width);
}

function waterBoundariesTouch(
  left: readonly [number, number][],
  right: readonly [number, number][]
): boolean {
  const leftX = left.map((point) => point[0]);
  const leftZ = left.map((point) => point[1]);
  const rightX = right.map((point) => point[0]);
  const rightZ = right.map((point) => point[1]);
  if (Math.max(...leftX) < Math.min(...rightX) || Math.max(...rightX) < Math.min(...leftX)
    || Math.max(...leftZ) < Math.min(...rightZ) || Math.max(...rightZ) < Math.min(...leftZ)) {
    return false;
  }
  if (left.some(([x, z]) => pointInPolygon(x, z, right))
    || right.some(([x, z]) => pointInPolygon(x, z, left))) {
    return true;
  }
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const a = left[leftIndex];
    const b = left[(leftIndex + 1) % left.length];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const c = right[rightIndex];
      const d = right[(rightIndex + 1) % right.length];
      if (segmentsTouch(a, b, c, d)) return true;
    }
  }
  return false;
}

function segmentsTouch(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number]
): boolean {
  const cross = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]) => (
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  );
  const onSegment = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]) => (
    Math.abs(cross(p, q, r)) <= 1e-6
    && r[0] >= Math.min(p[0], q[0]) - 1e-6 && r[0] <= Math.max(p[0], q[0]) + 1e-6
    && r[1] >= Math.min(p[1], q[1]) - 1e-6 && r[1] <= Math.max(p[1], q[1]) + 1e-6
  );
  const ac = cross(a, b, c);
  const ad = cross(a, b, d);
  const ca = cross(c, d, a);
  const cb = cross(c, d, b);
  return ((ac > 0 && ad < 0) || (ac < 0 && ad > 0))
    && ((ca > 0 && cb < 0) || (ca < 0 && cb > 0))
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function distanceFromOutside(inside: Uint8Array, resolution: number): Float32Array {
  const distances = new Float32Array(inside.length);
  const diagonal = Math.SQRT2;
  for (let index = 0; index < inside.length; index += 1) {
    distances[index] = inside[index] ? Number.POSITIVE_INFINITY : 0;
  }
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const index = row * resolution + column;
      if (!inside[index]) continue;
      if (column > 0) distances[index] = Math.min(distances[index], distances[index - 1] + 1);
      if (row > 0) distances[index] = Math.min(distances[index], distances[index - resolution] + 1);
      if (column > 0 && row > 0) distances[index] = Math.min(distances[index], distances[index - resolution - 1] + diagonal);
      if (column + 1 < resolution && row > 0) distances[index] = Math.min(distances[index], distances[index - resolution + 1] + diagonal);
    }
  }
  for (let row = resolution - 1; row >= 0; row -= 1) {
    for (let column = resolution - 1; column >= 0; column -= 1) {
      const index = row * resolution + column;
      if (!inside[index]) continue;
      if (column + 1 < resolution) distances[index] = Math.min(distances[index], distances[index + 1] + 1);
      if (row + 1 < resolution) distances[index] = Math.min(distances[index], distances[index + resolution] + 1);
      if (column + 1 < resolution && row + 1 < resolution) distances[index] = Math.min(distances[index], distances[index + resolution + 1] + diagonal);
      if (column > 0 && row + 1 < resolution) distances[index] = Math.min(distances[index], distances[index + resolution - 1] + diagonal);
    }
  }
  return distances;
}

function buildLakeGeometry(input: MapWaterBody['points']): THREE.BufferGeometry {
  const points = cleanWaterPoints(input);
  const vertices = points.flatMap(([x, z]) => [x, 0, z]);
  const contour = points.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const indices: number[] = [];
  for (const [a, b, c] of faces) pushUpwardTriangle(indices, vertices, a, b, c);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildRiverGeometry(input: MapWaterBody['points'], width: number): THREE.BufferGeometry {
  const edges = riverEdgePairs(input, width);
  const vertices: number[] = [];
  for (const edge of edges) vertices.push(edge.left[0], 0, edge.left[1], edge.right[0], 0, edge.right[1]);
  const indices: number[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const left = index * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    pushUpwardTriangle(indices, vertices, left, nextLeft, right);
    pushUpwardTriangle(indices, vertices, right, nextLeft, nextRight);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function riverBoundaryPoints(input: MapWaterBody['points'], width: number): Array<[number, number]> {
  const edges = riverEdgePairs(input, width);
  return [
    ...edges.map((edge) => edge.left),
    ...edges.slice().reverse().map((edge) => edge.right)
  ];
}

function riverEdgePairs(input: MapWaterBody['points'], width: number): Array<{
  left: [number, number];
  right: [number, number];
}> {
  const points = cleanWaterPoints(input);
  const halfWidth = width / 2;
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next[0] - previous[0];
    const dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const offsetX = -dz / length * halfWidth;
    const offsetZ = dx / length * halfWidth;
    return {
      left: [point[0] + offsetX, point[1] + offsetZ],
      right: [point[0] - offsetX, point[1] - offsetZ]
    };
  });
}

function pointInPolygon(x: number, z: number, points: readonly [number, number][]): boolean {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current, current += 1) {
    const a = points[current];
    const b = points[previous];
    if ((a[1] > z) !== (b[1] > z)
      && x < (b[0] - a[0]) * (z - a[1]) / ((b[1] - a[1]) || Number.EPSILON) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function cleanWaterPoints(points: MapWaterBody['points']): MapWaterBody['points'] {
  return points.filter((point, index) => (
    index === 0
    || point[0] !== points[index - 1][0]
    || point[1] !== points[index - 1][1]
  ));
}

function pushUpwardTriangle(
  indices: number[],
  vertices: number[],
  a: number,
  b: number,
  c: number
): void {
  const ax = vertices[b * 3] - vertices[a * 3];
  const az = vertices[b * 3 + 2] - vertices[a * 3 + 2];
  const bx = vertices[c * 3] - vertices[a * 3];
  const bz = vertices[c * 3 + 2] - vertices[a * 3 + 2];
  if (az * bx - ax * bz >= 0) indices.push(a, b, c);
  else indices.push(a, c, b);
}

function buildTerrainGeometry(map: EditableMap): THREE.BufferGeometry {
  const terrain = map.terrain;
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let z = 0; z < terrain.resolutionZ; z += 1) {
    for (let x = 0; x < terrain.resolutionX; x += 1) {
      const point = terrainPointAt(map, x, z);
      vertices.push(point[0], point[1], point[2]);
      uvs.push(x / (terrain.resolutionX - 1), z / (terrain.resolutionZ - 1));
    }
  }

  for (let z = 0; z < terrain.resolutionZ - 1; z += 1) {
    for (let x = 0; x < terrain.resolutionX - 1; x += 1) {
      const a = terrainIndex(terrain, x, z);
      const b = terrainIndex(terrain, x + 1, z);
      const c = terrainIndex(terrain, x, z + 1);
      const d = terrainIndex(terrain, x + 1, z + 1);
      if ((x + z) % 2 === 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, c, d, a, d, b);
    }
  }

  addBorderSides(vertices, uvs, indices, map);
  const colors: number[] = [];
  for (let index = 0; index < vertices.length; index += 3) {
    colors.push(...terrainVertexColor(map, vertices[index], vertices[index + 1], vertices[index + 2]));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addBorderSides(vertices: number[], uvs: number[], indices: number[], map: EditableMap): void {
  const terrain = map.terrain;
  // Carved lake basins push heights below zero, so the skirt has to reach the
  // lowest point on the map instead of always stopping at y=0.
  const base = terrain.heights.reduce((lowest, height) => Math.min(lowest, height), 0);
  for (let x = 0; x < terrain.resolutionX - 1; x += 1) {
    addSideToBase(vertices, uvs, indices, map, base, terrainPointAt(map, x, 0), terrainPointAt(map, x + 1, 0));
    addSideToBase(vertices, uvs, indices, map, base, terrainPointAt(map, x, terrain.resolutionZ - 1), terrainPointAt(map, x + 1, terrain.resolutionZ - 1));
  }
  for (let z = 0; z < terrain.resolutionZ - 1; z += 1) {
    addSideToBase(vertices, uvs, indices, map, base, terrainPointAt(map, 0, z), terrainPointAt(map, 0, z + 1));
    addSideToBase(vertices, uvs, indices, map, base, terrainPointAt(map, terrain.resolutionX - 1, z), terrainPointAt(map, terrain.resolutionX - 1, z + 1));
  }
}

function addSideToBase(vertices: number[], uvs: number[], indices: number[], map: EditableMap, base: number, a: number[], b: number[]): void {
  if (a[1] - base < 0.08 && b[1] - base < 0.08) return;
  addQuad(
    vertices,
    uvs,
    indices,
    map,
    [a[0], a[1], a[2]],
    [b[0], b[1], b[2]],
    [a[0], base, a[2]],
    [b[0], base, b[2]]
  );
}

function addQuad(
  vertices: number[],
  uvs: number[],
  indices: number[],
  map: EditableMap,
  p0: number[],
  p1: number[],
  p2: number[],
  p3: number[]
): void {
  const index = vertices.length / 3;
  vertices.push(...p0, ...p1, ...p2, ...p3);
  for (const point of [p0, p1, p2, p3]) {
    const [u, v] = terrainUv(map, point[0], point[2]);
    uvs.push(u, v);
  }
  indices.push(index, index + 2, index + 1, index + 1, index + 2, index + 3);
}

function terrainUv(map: EditableMap, x: number, z: number): [number, number] {
  const bounds = getMapBounds(map);
  return [
    (x - bounds.minX) / (bounds.maxX - bounds.minX),
    (z - bounds.minZ) / (bounds.maxZ - bounds.minZ)
  ];
}

function createObjectGroups(map: EditableMap): Map<string, THREE.Group> {
  const groups = new Map<string, THREE.Group>();
  for (const object of map.objects) {
    const group = new THREE.Group();
    group.name = object.name;
    group.userData.mapObjectId = object.id;
    applyObjectTransform(group, object);
    groups.set(object.id, group);
  }
  return groups;
}

async function populateObjectVisuals(
  map: EditableMap,
  assets: Map<string, MapAsset>,
  groups: Map<string, THREE.Group>,
  handledObjectIds: Set<string>
): Promise<void> {
  const templates = new Map<string, { group: THREE.Group; used: boolean }>();
  for (const object of map.objects) {
    if (!object.visible || handledObjectIds.has(object.id)) continue;
    const group = groups.get(object.id);
    if (!group) continue;
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    if (asset) group.userData.assetTags = deriveAssetTags(asset);
    const visual = asset?.modelJson
      ? await takeAssetVisual(asset, templates)
      : buildFallbackObject();
    visual.traverse((child) => {
      child.userData.mapObjectId = object.id;
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    group.add(visual);
  }
}

async function takeAssetVisual(
  asset: MapAsset,
  templates: Map<string, { group: THREE.Group; used: boolean }>
): Promise<THREE.Group> {
  let entry = templates.get(asset.id);
  if (!entry) {
    entry = { group: await buildModelGroup(asset.modelJson), used: false };
    templates.set(asset.id, entry);
  }
  if (!entry.used) {
    entry.used = true;
    return entry.group;
  }
  return cloneAssetVisual(entry.group);
}

function cloneAssetVisual(template: THREE.Group): THREE.Group {
  const clone = template.clone(true);
  clone.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((material) => material.clone())
      : mesh.material.clone();
  });
  return clone;
}

function deriveAssetTags(asset: MapAsset): string[] {
  const source = `${asset.name} ${asset.prompt}`.toLowerCase();
  const tags = new Set<string>([asset.id, ...(asset.tags ?? [])]);
  for (const token of source.split(/[^a-z0-9_-]+/).filter((item) => item.length > 2)) tags.add(token.slice(0, 48));
  const semantic: Array<[RegExp, string[]]> = [
    [/(树|tree|forest)/i, ['tree', 'vegetation']],
    [/(石|岩|rock|stone)/i, ['rock', 'stone']],
    [/(草|花|植被|grass|flower|plant)/i, ['vegetation']],
    [/(建筑|房|屋|building|house)/i, ['building']],
    [/(金属|metal)/i, ['metal']],
    [/(水|湖|河|water|lake|river)/i, ['water']]
  ];
  for (const [pattern, values] of semantic) {
    if (pattern.test(source)) values.forEach((value) => tags.add(value));
  }
  return [...tags].slice(0, 24);
}

function applyObjectTransform(group: THREE.Group, object: MapObject): void {
  const { position, rotation, scale, size } = object.transform;
  group.position.set(position[0], position[1], position[2]);
  group.rotation.set(rotation[0], rotation[1], rotation[2]);
  group.scale.set(scale[0] * size[0], scale[1] * size[1], scale[2] * size[2]);
}

function buildFallbackObject(): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x7f8a85, roughness: 0.78, flatShading: true })
  );
  mesh.position.y = 0.5;
  group.add(mesh);
  return group;
}

function buildPlayerSpawnGroup(map: EditableMap): THREE.Group {
  const spawn = getSpawnPoints(map)[0];
  const group = new THREE.Group();
  group.name = '场景参考点';
  group.userData.skipShaderApply = true;
  group.userData.skipNormalDepthPrePass = true;
  group.userData.isEditorObject = true;
  group.position.set(spawn[0], spawn[1], spawn[2]);
  group.rotation.y = getPlayerSpawnYaw(map);
  group.userData.mapObjectId = PLAYER_SPAWN_OBJECT_ID;

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER_RADIUS, Math.max(0.01, PLAYER_HEIGHT - PLAYER_RADIUS * 2), 8, 16),
    new THREE.MeshStandardMaterial({
      color: 0x7bc8ff,
      emissive: 0x1d5f78,
      emissiveIntensity: 0.35,
      roughness: 0.45,
      transparent: true,
      opacity: 0.72
    })
  );
  body.position.y = PLAYER_HEIGHT / 2;

  const footprint = new THREE.Mesh(
    new THREE.RingGeometry(PLAYER_RADIUS * 1.08, PLAYER_RADIUS * 1.38, 40),
    new THREE.MeshBasicMaterial({
      color: 0xd8ef75,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      depthWrite: false
    })
  );
  footprint.rotation.x = -Math.PI / 2;
  footprint.position.y = 0.025;

  const forward = new THREE.Mesh(
    new THREE.ConeGeometry(PLAYER_RADIUS * 0.28, PLAYER_RADIUS * 0.55, 20),
    new THREE.MeshBasicMaterial({ color: 0xd8ef75, transparent: true, opacity: 0.9 })
  );
  forward.rotation.x = Math.PI / 2;
  forward.position.set(0, PLAYER_HEIGHT * 0.78, -PLAYER_RADIUS * 1.25);

  group.add(body, footprint, forward);
  group.traverse((child) => {
    child.userData.mapObjectId = PLAYER_SPAWN_OBJECT_ID;
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return group;
}

function buildSunGroup(map: EditableMap): THREE.Group {
  const position = getSunPosition(map);
  const group = new THREE.Group();
  group.name = '太阳';
  group.userData.skipShaderApply = true;
  group.userData.skipNormalDepthPrePass = true;
  group.userData.isEditorObject = true;
  group.position.set(position[0], position[1], position[2]);
  group.userData.mapObjectId = SUN_OBJECT_ID;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.65, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xffd66b })
  );
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(1.05, 24, 16),
    new THREE.MeshBasicMaterial({
      color: 0xfff0b8,
      transparent: true,
      opacity: 0.24,
      depthWrite: false
    })
  );
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(1.25, 1.38, 40),
    new THREE.MeshBasicMaterial({
      color: 0xffe28a,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.62,
      depthWrite: false
    })
  );
  halo.rotation.x = Math.PI / 2;

  group.add(glow, sphere, halo);
  group.traverse((child) => {
    child.userData.mapObjectId = SUN_OBJECT_ID;
  });
  return group;
}

function createSurfaceTexture(map: EditableMap, surface: MapSurface): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 768;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  // Vertex colors own the terrain palette; a neutral base keeps paint strokes
  // and the editor grid from multiplying the surface darker.
  ctx.fillStyle = surface === 'terrain' ? '#ffffff' : map.box.colors[surface as keyof typeof map.box.colors];
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (surface === 'terrain') drawSemanticTerrainSurface(ctx, map, canvas.width, canvas.height);
  drawSubtleGrid(ctx, canvas.width, canvas.height);
  for (const stroke of map.paintStrokes) {
    if (stroke.surface !== surface && !(surface === 'terrain' && stroke.surface === 'floor')) continue;
    drawStroke(ctx, stroke, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

const SEMANTIC_SURFACE_COLORS = {
  grass: '#dceab7',
  forest: '#b5cda0',
  water: '#a8c8bd',
  lowland: '#bdcfb8',
  dry: '#dfc692',
  settlement: '#d7c5a6',
  rocky: '#c3c0b2'
} as const;

function drawSemanticTerrainSurface(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  width: number,
  height: number
): void {
  for (const zone of map.visualSemantics.zones) {
    const tag = [...zone.tags].reverse().find((item) => item in SEMANTIC_SURFACE_COLORS);
    if (!tag) continue;
    const center = surfaceCanvasPoint(map, zone.center, width, height);
    const radiusX = zone.radius / map.box.size[0] * width;
    const radiusY = zone.radius / map.box.size[2] * height;
    const opacity = Math.min(0.24, 0.08 + zone.intensity * 0.12);
    ctx.save();
    ctx.translate(center[0], center[1]);
    ctx.scale(Math.max(0.001, radiusX), Math.max(0.001, radiusY));
    const gradient = ctx.createRadialGradient(0, 0, 0.05, 0, 0, 1);
    gradient.addColorStop(0, withOpacity(SEMANTIC_SURFACE_COLORS[tag], opacity));
    gradient.addColorStop(0.72, withOpacity(SEMANTIC_SURFACE_COLORS[tag], opacity * 0.78));
    gradient.addColorStop(1, withOpacity(SEMANTIC_SURFACE_COLORS[tag], 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  for (const water of map.waterBodies) drawWetShore(ctx, map, water, width, height);
}

function drawWetShore(
  ctx: CanvasRenderingContext2D,
  map: EditableMap,
  water: MapWaterBody,
  width: number,
  height: number
): void {
  const points = water.points.map((point) => surfaceCanvasPoint(map, point, width, height));
  if (points.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]));
  if (water.type === 'lake') ctx.closePath();
  const pixelsPerMetre = (width / map.box.size[0] + height / map.box.size[2]) * 0.5;
  ctx.strokeStyle = 'rgba(88, 91, 70, 0.16)';
  ctx.lineWidth = Math.max(3, (water.type === 'river' ? water.width + 1.8 : 2.4) * pixelsPerMetre);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(164, 151, 109, 0.14)';
  ctx.lineWidth = Math.max(2, (water.type === 'river' ? water.width + 0.7 : 1.1) * pixelsPerMetre);
  ctx.stroke();
  ctx.restore();
}

function surfaceCanvasPoint(
  map: EditableMap,
  point: readonly [number, number],
  width: number,
  height: number
): [number, number] {
  return [
    (point[0] / map.box.size[0] + 0.5) * width,
    (0.5 - point[1] / map.box.size[2]) * height
  ];
}

function drawSubtleGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += width / 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += height / 16) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: MapPaintStroke, width: number, height: number): void {
  const x = stroke.uv[0] * width;
  const y = (1 - stroke.uv[1]) * height;
  const radius = Math.max(4, stroke.size * 18);
  const inner = radius * (1 - stroke.softness);
  const gradient = ctx.createRadialGradient(x, y, inner, x, y, radius);
  gradient.addColorStop(0, withOpacity(stroke.color, stroke.opacity));
  gradient.addColorStop(1, withOpacity(stroke.color, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function withOpacity(color: string, opacity: number): string {
  const hex = color.replace('#', '');
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

function disposeObject(object: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) {
      materials.add(material);
      const maybe = material as THREE.MeshStandardMaterial;
      if (maybe.map) textures.add(maybe.map);
    }
    const shore = mesh.userData.waterShore as { texture?: THREE.Texture } | undefined;
    if (shore?.texture?.isTexture) textures.add(shore.texture);
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
