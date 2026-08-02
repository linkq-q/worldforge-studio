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
import { buildMapGrassField } from './mapGrassRenderer';
import { combinedGrassDensity } from '../shared/mapGrass';
import {
  DEFAULT_RUNTIME_GRASS_STYLE,
  type RuntimeGrassStyle,
} from '../shared/renderPlan';
import type { RuntimeIndex } from '@voxel-studio/render-runtime';

export interface RenderedMap {
  group: THREE.Group;
  modelsRoot: THREE.Group;
  runtimeIndex: RuntimeIndex;
  objectGroups: Map<string, THREE.Group>;
  pickables: THREE.Object3D[];
  syncObjectTransform: (objectId: string) => void;
  update: (deltaTime: number, camera: THREE.Camera, maxDistance: number) => void;
  setGrassStyle: (style: RuntimeGrassStyle) => void;
  dispose: () => void;
}

export interface MapRenderOptions {
  editorHelpers?: boolean;
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

  const terrain = buildTerrain(map);
  applyTerrainGrassTint(terrain, map, DEFAULT_RUNTIME_GRASS_STYLE);
  root.add(terrain);
  pickables.push(terrain);

  const grass = buildMapGrassField(map);
  if (grass) root.add(grass.group);

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
  }));
  modelsRoot.add(instancing.root);
  await populateObjectVisuals(map, assets, objectGroups, instancing.handledObjectIds);
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
      grass?.update(deltaTime);
      instancing.updateCulling(camera, maxDistance);
    },
    setGrassStyle: (style) => {
      grass?.setStyle(style);
      applyTerrainGrassTint(terrain, map, style);
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
  const color = new THREE.Color();
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const base = terrainVertexColor(map, x, y, z);
    color.setRGB(base[0], base[1], base[2]);
    const isSurface = y >= sampleTerrainHeight(map, x, z) - 0.05;
    if (style.groundTint && isSurface) {
      color.lerp(grassColor, combinedGrassDensity(map, x, z) * style.groundTintStrength);
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
  for (const water of map.waterBodies) {
    const geometry = water.type === 'lake'
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
    mesh.position.y = water.level;
    mesh.renderOrder = 8;
    mesh.userData.waterBodyId = water.id;
    mesh.userData.waterBodyType = water.type;
    mesh.userData.isWater = true;
    mesh.userData.skipShaderApply = true;
    mesh.userData.materialTags = ['water', water.type, water.id];
    mesh.userData.assetTags = ['water', water.type];
    group.add(mesh);
  }
  return group;
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
  const points = cleanWaterPoints(input);
  const vertices: number[] = [];
  const halfWidth = width / 2;
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next[0] - previous[0];
    const dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const offsetX = -dz / length * halfWidth;
    const offsetZ = dx / length * halfWidth;
    vertices.push(
      points[index][0] + offsetX, 0, points[index][1] + offsetZ,
      points[index][0] - offsetX, 0, points[index][1] - offsetZ
    );
  }
  const indices: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
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
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
