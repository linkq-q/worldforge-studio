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

export interface RenderedMap {
  group: THREE.Group;
  modelsRoot: THREE.Group;
  objectGroups: Map<string, THREE.Group>;
  pickables: THREE.Object3D[];
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

  const box = buildBoxSurfaces(map);
  root.add(box.group);
  pickables.push(...box.pickables);

  const terrain = buildTerrain(map);
  root.add(terrain);
  pickables.push(terrain);

  modelsRoot.add(buildStructuredWaterGroup(map));
  const objectGroups = await buildObjectGroups(map, assets);
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
  for (const group of objectGroups.values()) {
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) pickables.push(child);
    });
  }

  return {
    group: root,
    modelsRoot,
    objectGroups,
    pickables,
    dispose: () => disposeObject(root)
  };
}

function buildBoxSurfaces(map: EditableMap): { group: THREE.Group; pickables: THREE.Object3D[] } {
  const bounds = getMapBounds(map);
  const [width, height, depth] = map.box.size;
  const group = new THREE.Group();
  const pickables: THREE.Object3D[] = [];

  const ceiling = makeSurfaceMesh('ceiling', new THREE.PlaneGeometry(width, depth), map);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, height, 0);
  group.add(ceiling);
  pickables.push(ceiling);

  const north = makeSurfaceMesh('north', new THREE.PlaneGeometry(width, height), map);
  north.position.set(0, height / 2, bounds.minZ);
  group.add(north);
  pickables.push(north);

  const south = makeSurfaceMesh('south', new THREE.PlaneGeometry(width, height), map);
  south.rotation.y = Math.PI;
  south.position.set(0, height / 2, bounds.maxZ);
  group.add(south);
  pickables.push(south);

  const east = makeSurfaceMesh('east', new THREE.PlaneGeometry(depth, height), map);
  east.rotation.y = -Math.PI / 2;
  east.position.set(bounds.maxX, height / 2, 0);
  group.add(east);
  pickables.push(east);

  const west = makeSurfaceMesh('west', new THREE.PlaneGeometry(depth, height), map);
  west.rotation.y = Math.PI / 2;
  west.position.set(bounds.minX, height / 2, 0);
  group.add(west);
  pickables.push(west);

  return { group, pickables };
}

function makeSurfaceMesh(surface: MapSurface, geometry: THREE.BufferGeometry, map: EditableMap): THREE.Mesh {
  const texture = createSurfaceTexture(map, surface);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: surface === 'ceiling' ? 0.52 : 0.28,
    roughness: 0.88,
    // The enclosure is visible from inside but does not block the editor camera outside the map.
    side: THREE.FrontSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.userData.surface = surface;
  return mesh;
}

function buildTerrain(map: EditableMap): THREE.Mesh {
  const geometry = buildTerrainGeometry(map);
  const texture = createSurfaceTexture(map, 'terrain');
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: 0.16,
    roughness: 0.92,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
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
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addBorderSides(vertices: number[], uvs: number[], indices: number[], map: EditableMap): void {
  const terrain = map.terrain;
  for (let x = 0; x < terrain.resolutionX - 1; x += 1) {
    addSideToBase(vertices, uvs, indices, map, terrainPointAt(map, x, 0), terrainPointAt(map, x + 1, 0));
    addSideToBase(vertices, uvs, indices, map, terrainPointAt(map, x, terrain.resolutionZ - 1), terrainPointAt(map, x + 1, terrain.resolutionZ - 1));
  }
  for (let z = 0; z < terrain.resolutionZ - 1; z += 1) {
    addSideToBase(vertices, uvs, indices, map, terrainPointAt(map, 0, z), terrainPointAt(map, 0, z + 1));
    addSideToBase(vertices, uvs, indices, map, terrainPointAt(map, terrain.resolutionX - 1, z), terrainPointAt(map, terrain.resolutionX - 1, z + 1));
  }
}

function addSideToBase(vertices: number[], uvs: number[], indices: number[], map: EditableMap, a: number[], b: number[]): void {
  if (a[1] < 0.08 && b[1] < 0.08) return;
  addQuad(
    vertices,
    uvs,
    indices,
    map,
    [a[0], a[1], a[2]],
    [b[0], b[1], b[2]],
    [a[0], 0, a[2]],
    [b[0], 0, b[2]]
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

async function buildObjectGroups(map: EditableMap, assets: Map<string, MapAsset>): Promise<Map<string, THREE.Group>> {
  const groups = new Map<string, THREE.Group>();
  for (const object of map.objects) {
    const group = new THREE.Group();
    group.name = object.name;
    group.userData.mapObjectId = object.id;
    applyObjectTransform(group, object);
    if (object.visible) {
      const asset = object.assetId ? assets.get(object.assetId) : undefined;
      if (asset) group.userData.assetTags = deriveAssetTags(asset);
      const visual = asset?.modelJson ? await buildModelGroup(asset.modelJson) : buildFallbackObject();
      visual.traverse((child) => {
        child.userData.mapObjectId = object.id;
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      group.add(visual);
    }
    groups.set(object.id, group);
  }
  return groups;
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
  ctx.fillStyle = surface === 'terrain' ? map.box.colors.floor : map.box.colors[surface as keyof typeof map.box.colors];
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
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const maybe = material as THREE.MeshStandardMaterial;
      maybe.map?.dispose();
      material.dispose();
    }
  });
}
