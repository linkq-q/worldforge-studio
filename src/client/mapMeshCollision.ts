import * as THREE from 'three';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';
import {
  getMapBounds,
  getMapObjectAabbs,
  getRoomShellAabbs,
  terrainPointAt,
  type EditableMap,
  type MapObject,
  type MapObjectAabb
} from '../shared/map';
import type { Vec3 } from '../shared/protocol';
import { safeModelScale } from './modelRenderer';

export type CollisionMeshKind = 'terrain' | 'boundary' | 'scene' | 'dynamic';

export interface CollisionMeshInstance {
  id: string;
  kind: CollisionMeshKind;
  geometry: THREE.BufferGeometry;
  bvh: MeshBVH;
  bounds: THREE.Box3;
  triangleCount: number;
}

export interface CapsuleContact {
  meshId: string;
  kind: CollisionMeshKind;
  normal: Vec3;
  depth: number;
}

export interface CapsuleMoveResult {
  position: Vec3;
  grounded: boolean;
  hitCeiling: boolean;
  contacts: CapsuleContact[];
}

export interface CollisionRayHit {
  distance: number;
  meshId: string;
  kind: CollisionMeshKind;
  point: Vec3;
  normal: Vec3;
}

interface ModelNode {
  id?: string;
  parent?: string;
  transform?: {
    pos?: Vec3;
    quat?: [number, number, number, number];
    scale?: Vec3;
  };
  mesh?: {
    type?: string;
    params?: Record<string, unknown>;
  };
}

interface ModelJson {
  nodes?: ModelNode[];
}

const GRID_CELL_SIZE = 4;
const CAPSULE_EPSILON = 0.000001;
const WALKABLE_NORMAL_Y = Math.cos(30 * Math.PI / 180);
const IDENTITY_MATRIX = new THREE.Matrix4();
const MODEL_GEOMETRY_CACHE = new WeakMap<object, THREE.BufferGeometry>();
const MAP_WORLD_CACHE_LIMIT = 4;
const MAP_WORLD_CACHE = new Map<string, MeshCollisionWorld>();
const CAPSULE_EJECTION_DIRECTIONS = [
  ...Array.from({ length: 16 }, (_, index) => {
    const angle = index / 16 * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
  }),
  new THREE.Vector3(0, 1, 0),
  ...Array.from({ length: 8 }, (_, index) => {
    const angle = index / 8 * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle), 0.65, Math.sin(angle)).normalize();
  })
];
const CLOSED_MESH_INSIDE_DIRECTIONS = [
  new THREE.Vector3(0.912731, 0.371391, 0.173217).normalize(),
  new THREE.Vector3(-0.238619, 0.824993, 0.512773).normalize(),
  new THREE.Vector3(0.341879, -0.193117, 0.919622).normalize()
];

/**
 * Client/viewer collision world: an XZ broad-phase grid around per-mesh BVHs.
 * The dependency-free map-core keeps its AABB bake for servers and planning.
 */
export class MeshCollisionWorld {
  readonly instances: CollisionMeshInstance[];
  private readonly cells = new Map<string, number[]>();
  private readonly globalIndices: number[] = [];

  constructor(instances: readonly CollisionMeshInstance[] = []) {
    this.instances = [...instances];
    this.rebuildIndex();
  }

  withInstances(instances: readonly CollisionMeshInstance[]): MeshCollisionWorld {
    return new MeshCollisionWorld([...this.instances, ...instances]);
  }

  queryBounds(bounds: THREE.Box3, kinds?: ReadonlySet<CollisionMeshKind>): CollisionMeshInstance[] {
    if (bounds.isEmpty()) return [];
    const startX = Math.floor(bounds.min.x / GRID_CELL_SIZE);
    const endX = Math.floor(bounds.max.x / GRID_CELL_SIZE);
    const startZ = Math.floor(bounds.min.z / GRID_CELL_SIZE);
    const endZ = Math.floor(bounds.max.z / GRID_CELL_SIZE);
    const cellCount = (endX - startX + 1) * (endZ - startZ + 1);
    const indices = new Set<number>(this.globalIndices);

    if (!Number.isFinite(cellCount) || cellCount > 4096) {
      for (let index = 0; index < this.instances.length; index += 1) indices.add(index);
    } else {
      for (let z = startZ; z <= endZ; z += 1) {
        for (let x = startX; x <= endX; x += 1) {
          for (const index of this.cells.get(`${x},${z}`) ?? []) indices.add(index);
        }
      }
    }

    return [...indices]
      .map((index) => this.instances[index])
      .filter((instance): instance is CollisionMeshInstance => Boolean(instance)
        && (!kinds || kinds.has(instance.kind))
        && instance.bounds.intersectsBox(bounds));
  }

  raycastFirst(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    kinds?: ReadonlySet<CollisionMeshKind>
  ): CollisionRayHit | null {
    const dir = new THREE.Vector3(...direction);
    if (dir.lengthSq() <= 1e-12 || maxDistance <= 0) return null;
    dir.normalize();
    const start = new THREE.Vector3(...origin);
    const end = start.clone().addScaledVector(dir, maxDistance);
    const query = new THREE.Box3().setFromPoints([start, end]).expandByScalar(CAPSULE_EPSILON);
    const ray = new THREE.Ray(start, dir);
    let closest: CollisionRayHit | null = null;

    for (const instance of this.queryBounds(query, kinds)) {
      const hit = instance.bvh.raycastFirst(ray, THREE.DoubleSide, 0, closest?.distance ?? maxDistance);
      if (!hit || hit.distance < 0 || hit.distance > maxDistance) continue;
      if (closest && hit.distance >= closest.distance) continue;
      const normal = hit.face?.normal?.clone() ?? dir.clone().negate();
      if (normal.lengthSq() <= 1e-12) normal.copy(dir).negate();
      normal.normalize();
      closest = {
        distance: hit.distance,
        meshId: instance.id,
        kind: instance.kind,
        point: [hit.point.x, hit.point.y, hit.point.z],
        normal: [normal.x, normal.y, normal.z]
      };
    }
    return closest;
  }

  moveCapsule(
    position: Vec3,
    delta: Vec3,
    radius: number,
    height: number,
    options: { maxStep?: number; groundProbe?: number; kinds?: ReadonlySet<CollisionMeshKind> } = {}
  ): CapsuleMoveResult {
    const safeRadius = Math.max(0.01, radius);
    const safeHeight = Math.max(safeRadius * 2, height);
    const movement = new THREE.Vector3(...delta);
    const maxStep = Math.max(0.025, options.maxStep ?? safeRadius * 0.35);
    const steps = Math.max(1, Math.ceil(movement.length() / maxStep));
    const step = movement.multiplyScalar(1 / steps);
    const current = new THREE.Vector3(...position);
    const contacts: CapsuleContact[] = [];
    let grounded = false;
    let hitCeiling = false;

    for (let index = 0; index < steps; index += 1) {
      current.add(step);
      const resolved = this.resolveCapsule(current, safeRadius, safeHeight, options.kinds, step);
      current.copy(resolved.position);
      contacts.push(...resolved.contacts);
      grounded ||= resolved.grounded;
      hitCeiling ||= resolved.hitCeiling;
    }

    const groundProbe = Math.max(0, options.groundProbe ?? 0.065);
    if (!grounded && groundProbe > 0 && delta[1] <= CAPSULE_EPSILON) {
      const probeStart = current.clone().add(new THREE.Vector3(0, -groundProbe, 0));
      const probe = this.resolveCapsule(
        probeStart,
        safeRadius,
        safeHeight,
        options.kinds,
        new THREE.Vector3(0, -1, 0)
      );
      if (probe.grounded && probe.position.y >= current.y - groundProbe - CAPSULE_EPSILON) {
        current.copy(probe.position);
        contacts.push(...probe.contacts);
        grounded = true;
      }
    }

    return {
      position: [current.x, current.y, current.z],
      grounded,
      hitCeiling,
      contacts
    };
  }

  resolveCapsule(
    position: THREE.Vector3,
    radius: number,
    height: number,
    kinds?: ReadonlySet<CollisionMeshKind>,
    preferredDirection = new THREE.Vector3()
  ): { position: THREE.Vector3; grounded: boolean; hitCeiling: boolean; contacts: CapsuleContact[] } {
    const current = position.clone();
    const contacts: CapsuleContact[] = [];
    let grounded = false;
    let hitCeiling = false;

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const segment = capsuleSegment(current, radius, height);
      const capsuleBounds = new THREE.Box3()
        .setFromPoints([segment.start, segment.end])
        .expandByScalar(radius + CAPSULE_EPSILON);
      const containmentBounds = new THREE.Box3()
        .setFromPoints([segment.start, segment.end])
        .expandByScalar(Math.max(0, radius - CAPSULE_EPSILON * 2));
      let deepest: { instance: CollisionMeshInstance; normal: THREE.Vector3; depth: number } | null = null;

      for (const instance of this.queryBounds(capsuleBounds, kinds)) {
        let surfaceContact: { normal: THREE.Vector3; depth: number } | null = null;
        instance.bvh.shapecast({
          intersectsBounds: (box) => box.intersectsBox(capsuleBounds),
          intersectsTriangle: (triangle) => {
            const contact = capsuleTriangleContact(segment, radius, triangle, preferredDirection);
            if (contact && (!surfaceContact || contact.depth > surfaceContact.depth)) surfaceContact = contact;
            return false;
          }
        });
        const instanceContact = surfaceContact
          ?? (instance.kind === 'scene' && instance.bounds.containsBox(containmentBounds)
            ? capsuleContainedMeshContact(segment, radius, instance.bvh)
            : null);
        if (instanceContact && (!deepest || instanceContact.depth > deepest.depth)) {
          deepest = { instance, ...instanceContact };
        }
      }

      if (!deepest) break;
      const verticalOnly = Math.abs(preferredDirection.x) <= CAPSULE_EPSILON
        && Math.abs(preferredDirection.z) <= CAPSULE_EPSILON
        && Math.abs(preferredDirection.y) > CAPSULE_EPSILON;
      const verticalSurface = Math.abs(deepest.normal.y) >= 0.45;
      if (verticalOnly && verticalSurface) {
        current.y += (deepest.depth + CAPSULE_EPSILON) / deepest.normal.y;
      } else {
        current.addScaledVector(deepest.normal, deepest.depth + CAPSULE_EPSILON);
      }
      contacts.push({
        meshId: deepest.instance.id,
        kind: deepest.instance.kind,
        normal: [deepest.normal.x, deepest.normal.y, deepest.normal.z],
        depth: deepest.depth
      });
      grounded ||= deepest.normal.y >= WALKABLE_NORMAL_Y;
      hitCeiling ||= deepest.normal.y <= -WALKABLE_NORMAL_Y;
    }

    return { position: current, grounded, hitCeiling, contacts };
  }

  dispose(): void {
    for (const instance of this.instances) instance.geometry.dispose();
  }

  private rebuildIndex(): void {
    this.cells.clear();
    this.globalIndices.length = 0;
    this.instances.forEach((instance, index) => {
      const startX = Math.floor(instance.bounds.min.x / GRID_CELL_SIZE);
      const endX = Math.floor(instance.bounds.max.x / GRID_CELL_SIZE);
      const startZ = Math.floor(instance.bounds.min.z / GRID_CELL_SIZE);
      const endZ = Math.floor(instance.bounds.max.z / GRID_CELL_SIZE);
      const cellCount = (endX - startX + 1) * (endZ - startZ + 1);
      if (!Number.isFinite(cellCount) || cellCount > 1024) {
        this.globalIndices.push(index);
        return;
      }
      for (let z = startZ; z <= endZ; z += 1) {
        for (let x = startX; x <= endX; x += 1) {
          const key = `${x},${z}`;
          const values = this.cells.get(key) ?? [];
          values.push(index);
          this.cells.set(key, values);
        }
      }
    });
  }
}

export function getMapMeshCollisionWorld(map: EditableMap): MeshCollisionWorld {
  const key = mapCollisionCacheKey(map);
  const cached = MAP_WORLD_CACHE.get(key);
  if (cached) return cached;
  const world = buildMapMeshCollisionWorld(map);
  MAP_WORLD_CACHE.set(key, world);
  if (MAP_WORLD_CACHE.size > MAP_WORLD_CACHE_LIMIT) {
    const oldestKey = MAP_WORLD_CACHE.keys().next().value as string | undefined;
    if (oldestKey) {
      MAP_WORLD_CACHE.get(oldestKey)?.dispose();
      MAP_WORLD_CACHE.delete(oldestKey);
    }
  }
  return world;
}

function mapCollisionCacheKey(map: EditableMap): string {
  const assets = (map.assets ?? [])
    .map((asset) => `${asset.id}:${asset.updatedAt}`)
    .sort()
    .join(',');
  return `${map.id}:${map.version}:${map.updatedAt}:${assets}`;
}

export function buildMapMeshCollisionWorld(map: EditableMap): MeshCollisionWorld {
  const instances: CollisionMeshInstance[] = [];

  const terrain = buildTerrainCollisionGeometry(map);
  instances.push(createCollisionMeshInstance('__terrain__', 'terrain', terrain));
  terrain.dispose();

  const boundary = buildBoundaryCollisionGeometry(map);
  instances.push(createCollisionMeshInstance('__map_boundary__', 'boundary', boundary));
  boundary.dispose();

  const shell = collisionGeometryFromBoxes(getRoomShellAabbs(map));
  if (shell) {
    instances.push(createCollisionMeshInstance('__map_shell__', 'boundary', shell));
    shell.dispose();
  }

  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const matrices = getObjectWorldMatrices(map);
  const proxyIds = new Set(map.objects
    .filter((object) => object.visible
      && object.behavior?.locomotion !== 'air'
      && (Boolean(object.foundation) || !object.assetId || !assets.get(object.assetId)?.modelJson))
    .map((object) => object.id));
  const proxyBoxes = groupBoxesByObject(getMapObjectAabbs(map).filter((box) => proxyIds.has(box.objectId)));

  for (const object of map.objects) {
    if (!object.visible || object.behavior?.locomotion === 'air') continue;
    const matrix = matrices.get(object.id);
    if (!matrix) continue;
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    if (!object.foundation && asset?.modelJson) {
      instances.push(createModelCollisionInstance(`map:${object.id}`, 'scene', asset.modelJson, matrix));
      continue;
    }
    const geometry = collisionGeometryFromBoxes(proxyBoxes.get(object.id) ?? []);
    if (!geometry) continue;
    instances.push(createCollisionMeshInstance(`map:${object.id}`, 'scene', geometry));
    geometry.dispose();
  }

  return new MeshCollisionWorld(instances);
}

export function createCollisionMeshInstance(
  id: string,
  kind: CollisionMeshKind,
  sourceGeometry: THREE.BufferGeometry,
  transform = IDENTITY_MATRIX
): CollisionMeshInstance {
  const geometry = sourceGeometry.clone();
  if (!transform.equals(IDENTITY_MATRIX)) geometry.applyMatrix4(transform);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox?.clone() ?? new THREE.Box3();
  const bvh = new MeshBVH(geometry, { targetLeafSize: 12, setBoundingBox: true });
  return {
    id,
    kind,
    geometry,
    bvh,
    bounds,
    triangleCount: geometry.index ? geometry.index.count / 3 : geometry.getAttribute('position').count / 3
  };
}

export function createModelCollisionInstance(
  id: string,
  kind: CollisionMeshKind,
  modelJson: unknown,
  transform = IDENTITY_MATRIX
): CollisionMeshInstance {
  return createCollisionMeshInstance(id, kind, getModelCollisionGeometry(modelJson), transform);
}

export function getModelCollisionGeometry(modelJson: unknown): THREE.BufferGeometry {
  if (typeof modelJson === 'object' && modelJson !== null) {
    const cached = MODEL_GEOMETRY_CACHE.get(modelJson);
    if (cached) return cached;
    const geometry = buildModelCollisionGeometry(modelJson);
    MODEL_GEOMETRY_CACHE.set(modelJson, geometry);
    return geometry;
  }
  return buildModelCollisionGeometry(modelJson);
}

export function buildModelCollisionGeometry(modelJson: unknown): THREE.BufferGeometry {
  const data = modelJson as ModelJson;
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const byId = new Map(nodes
    .filter((node): node is ModelNode & { id: string } => typeof node.id === 'string' && node.id.length > 0)
    .map((node) => [node.id, node]));
  const matrices = new Map<ModelNode, THREE.Matrix4>();
  const visiting = new Set<ModelNode>();
  const vertices: number[] = [];

  const worldMatrix = (node: ModelNode): THREE.Matrix4 => {
    const cached = matrices.get(node);
    if (cached) return cached;
    if (visiting.has(node)) return localNodeMatrix(node);
    visiting.add(node);
    const local = localNodeMatrix(node);
    const parent = typeof node.parent === 'string' ? byId.get(node.parent) : undefined;
    const result = parent ? worldMatrix(parent).clone().multiply(local) : local;
    visiting.delete(node);
    matrices.set(node, result);
    return result;
  };

  for (const node of nodes) {
    if (!node.mesh) continue;
    const primitive = buildModelPrimitiveGeometry(node.mesh.type ?? 'box', node.mesh.params ?? {});
    appendGeometryTriangles(vertices, primitive, worldMatrix(node));
    primitive.dispose();
  }

  if (vertices.length === 0) {
    const fallback = new THREE.BoxGeometry(1.2, 1.2, 1.2);
    appendGeometryTriangles(vertices, fallback, new THREE.Matrix4().makeTranslation(0, 0.6, 0));
    fallback.dispose();
  }

  const geometry = geometryFromVertices(vertices);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (bounds && !bounds.isEmpty()) {
    geometry.translate(
      -(bounds.min.x + bounds.max.x) / 2,
      -bounds.min.y,
      -(bounds.min.z + bounds.max.z) / 2
    );
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function buildTerrainCollisionGeometry(map: EditableMap): THREE.BufferGeometry {
  const terrain = map.terrain;
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let z = 0; z < terrain.resolutionZ; z += 1) {
    for (let x = 0; x < terrain.resolutionX; x += 1) vertices.push(...terrainPointAt(map, x, z));
  }
  for (let z = 0; z < terrain.resolutionZ - 1; z += 1) {
    for (let x = 0; x < terrain.resolutionX - 1; x += 1) {
      const a = z * terrain.resolutionX + x;
      const b = a + 1;
      const c = a + terrain.resolutionX;
      const d = c + 1;
      if ((x + z) % 2 === 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, c, d, a, d, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildBoundaryCollisionGeometry(map: EditableMap): THREE.BufferGeometry {
  const bounds = getMapBounds(map);
  const minY = map.terrain.heights.reduce(
    (minimum, height) => Number.isFinite(height) ? Math.min(minimum, height) : minimum,
    0
  );
  const points: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => points.push(...a, ...b, ...c, ...a, ...c, ...d);
  quad([bounds.minX, minY, bounds.minZ], [bounds.maxX, minY, bounds.minZ], [bounds.maxX, bounds.maxY, bounds.minZ], [bounds.minX, bounds.maxY, bounds.minZ]);
  quad([bounds.maxX, minY, bounds.maxZ], [bounds.minX, minY, bounds.maxZ], [bounds.minX, bounds.maxY, bounds.maxZ], [bounds.maxX, bounds.maxY, bounds.maxZ]);
  quad([bounds.minX, minY, bounds.maxZ], [bounds.minX, minY, bounds.minZ], [bounds.minX, bounds.maxY, bounds.minZ], [bounds.minX, bounds.maxY, bounds.maxZ]);
  quad([bounds.maxX, minY, bounds.minZ], [bounds.maxX, minY, bounds.maxZ], [bounds.maxX, bounds.maxY, bounds.maxZ], [bounds.maxX, bounds.maxY, bounds.minZ]);
  quad([bounds.minX, bounds.maxY, bounds.minZ], [bounds.maxX, bounds.maxY, bounds.minZ], [bounds.maxX, bounds.maxY, bounds.maxZ], [bounds.minX, bounds.maxY, bounds.maxZ]);
  return geometryFromVertices(points);
}

function getObjectWorldMatrices(map: EditableMap): Map<string, THREE.Matrix4> {
  const byId = new Map(map.objects.map((object) => [object.id, object]));
  const cache = new Map<string, THREE.Matrix4>();
  const visiting = new Set<string>();
  const matrixFor = (object: MapObject): THREE.Matrix4 => {
    const cached = cache.get(object.id);
    if (cached) return cached;
    const local = objectLocalMatrix(object);
    if (visiting.has(object.id)) return local;
    visiting.add(object.id);
    const parent = object.parentId ? byId.get(object.parentId) : undefined;
    const world = parent && parent.id !== object.id ? matrixFor(parent).clone().multiply(local) : local;
    visiting.delete(object.id);
    cache.set(object.id, world);
    return world;
  };
  for (const object of map.objects) matrixFor(object);
  return cache;
}

function objectLocalMatrix(object: MapObject): THREE.Matrix4 {
  const transform = object.transform;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...transform.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...transform.rotation, 'XYZ')),
    new THREE.Vector3(
      transform.scale[0] * transform.size[0],
      transform.scale[1] * transform.size[1],
      transform.scale[2] * transform.size[2]
    )
  );
}

function collisionGeometryFromBoxes(boxes: readonly MapObjectAabb[]): THREE.BufferGeometry | null {
  if (boxes.length === 0) return null;
  const vertices: number[] = [];
  for (const box of boxes) {
    const geometry = boxGeometryFromBounds(box.min, box.max);
    appendGeometryTriangles(vertices, geometry, IDENTITY_MATRIX);
    geometry.dispose();
  }
  return geometryFromVertices(vertices);
}

function groupBoxesByObject(boxes: readonly MapObjectAabb[]): Map<string, MapObjectAabb[]> {
  const grouped = new Map<string, MapObjectAabb[]>();
  for (const box of boxes) {
    const values = grouped.get(box.objectId) ?? [];
    values.push(box);
    grouped.set(box.objectId, values);
  }
  return grouped;
}

function boxGeometryFromBounds(min: Vec3, max: Vec3): THREE.BufferGeometry {
  const size = new THREE.Vector3(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const center = new THREE.Vector3(
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2
  );
  return new THREE.BoxGeometry(size.x, size.y, size.z).translate(center.x, center.y, center.z);
}

function capsuleSegment(position: THREE.Vector3, radius: number, height: number): THREE.Line3 {
  const bottom = position.clone().add(new THREE.Vector3(0, radius, 0));
  const top = position.clone().add(new THREE.Vector3(0, Math.max(radius, height - radius), 0));
  return new THREE.Line3(bottom, top);
}

function capsuleTriangleContact(
  segment: THREE.Line3,
  radius: number,
  triangle: ExtendedTriangle,
  preferredDirection: THREE.Vector3
): { normal: THREE.Vector3; depth: number } | null {
  const trianglePoint = new THREE.Vector3();
  const capsulePoint = new THREE.Vector3();
  const distance = triangle.closestPointToSegment(segment, trianglePoint, capsulePoint);
  if (!Number.isFinite(distance) || distance >= radius - CAPSULE_EPSILON) return null;
  const normal = capsulePoint.sub(trianglePoint);
  if (normal.lengthSq() > 1e-12) {
    normal.normalize();
  } else {
    triangle.getNormal(normal);
    const center = segment.getCenter(new THREE.Vector3());
    const side = center.sub(trianglePoint).dot(normal);
    if (Math.abs(side) > 1e-8) {
      if (side < 0) normal.negate();
    } else if (preferredDirection.lengthSq() > 1e-12 && normal.dot(preferredDirection) > 0) {
      normal.negate();
    } else if (normal.y < 0 && Math.abs(normal.y) > 0.5) {
      normal.negate();
    }
  }
  return { normal, depth: radius - distance };
}

function capsuleContainedMeshContact(
  segment: THREE.Line3,
  radius: number,
  bvh: MeshBVH
): { normal: THREE.Vector3; depth: number } | null {
  const samples = [
    segment.start,
    segment.at(0.25, new THREE.Vector3()),
    segment.getCenter(new THREE.Vector3()),
    segment.at(0.75, new THREE.Vector3()),
    segment.end
  ];
  let best: { normal: THREE.Vector3; depth: number } | null = null;
  for (const sample of samples) {
    if (!pointInsideClosedMesh(sample, bvh)) continue;
    for (const direction of CAPSULE_EJECTION_DIRECTIONS) {
      const hit = bvh.raycastFirst(new THREE.Ray(sample, direction), THREE.DoubleSide, CAPSULE_EPSILON);
      if (!hit || !Number.isFinite(hit.distance)) continue;
      const depth = hit.distance + radius;
      if (!best || depth < best.depth) best = { normal: direction, depth };
    }
  }
  return best ? { normal: best.normal.clone(), depth: best.depth } : null;
}

function pointInsideClosedMesh(point: THREE.Vector3, bvh: MeshBVH): boolean {
  let insideVotes = 0;
  for (const direction of CLOSED_MESH_INSIDE_DIRECTIONS) {
    const hits = bvh.raycast(new THREE.Ray(point, direction), THREE.DoubleSide)
      .filter((hit) => hit.distance > CAPSULE_EPSILON);
    let winding = 0;
    for (const hit of hits) {
      const facing = hit.face?.normal.dot(direction) ?? 0;
      if (facing > 0.0000001) winding += 1;
      else if (facing < -0.0000001) winding -= 1;
    }
    if (winding !== 0) insideVotes += 1;
  }
  return insideVotes >= 2;
}

function localNodeMatrix(node: ModelNode): THREE.Matrix4 {
  const transform = node.transform ?? {};
  const position = validVector(transform.pos, [0, 0, 0]);
  const quaternion = validQuaternion(transform.quat);
  const scale = safeModelScale(validPositiveArrayVector(transform.scale, [1, 1, 1]));
  return new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(...scale));
}

function appendGeometryTriangles(target: number[], geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = source.getAttribute('position');
  const point = new THREE.Vector3();
  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index).applyMatrix4(matrix);
    target.push(point.x, point.y, point.z);
  }
  if (source !== geometry) source.dispose();
}

function geometryFromVertices(vertices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function buildModelPrimitiveGeometry(type: string, params: Record<string, unknown>): THREE.BufferGeometry {
  const num = (key: string, fallback: number) => finiteNumber(params[key], fallback);
  switch (type) {
    case 'box':
      return new THREE.BoxGeometry(num('width', 1) || 1, num('height', 1) || 1, num('depth', 1) || 1);
    case 'sphere':
      return new THREE.SphereGeometry(num('radius', 1) || 1, integerParam(params.widthSegments, 8, 3), integerParam(params.heightSegments, 6, 2));
    case 'cylinder':
      return new THREE.CylinderGeometry(
        finiteNumber(params.radiusTop, 1),
        finiteNumber(params.radiusBottom, 1),
        num('height', 1) || 1,
        integerParam(params.radialSegments, 8, 3)
      );
    case 'cone':
      return new THREE.ConeGeometry(num('radius', 1) || 1, num('height', 1) || 1, integerParam(params.radialSegments, 8, 3));
    case 'torus': {
      const geometry = new THREE.TorusGeometry(
        num('radius', 1) || 1,
        num('tube', 0.3) || 0.3,
        integerParam(params.radialSegments, 8, 3),
        integerParam(params.tubularSegments, 12, 3)
      );
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    }
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(num('radius', 1) || 1, integerParam(params.detail, 0, 0));
    case 'dodecahedron':
      return new THREE.DodecahedronGeometry(num('radius', 1) || 1, integerParam(params.detail, 0, 0));
    case 'octahedron':
      return new THREE.OctahedronGeometry(num('radius', 1) || 1, integerParam(params.detail, 0, 0));
    case 'wedge': {
      const width = num('width', 1) || 1;
      const height = num('height', 1) || 1;
      const depth = num('depth', 1) || 1;
      const shape = new THREE.Shape();
      shape.moveTo(-width / 2, -height / 2);
      shape.lineTo(width / 2, -height / 2);
      shape.lineTo(-width / 2, height / 2);
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, { steps: 1, depth, bevelEnabled: false });
      geometry.translate(0, 0, -depth / 2);
      geometry.computeVertexNormals();
      return geometry;
    }
    case 'tri':
      return buildTriangleGeometry(params);
    case 'patch':
      return buildPatchGeometry(params);
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function buildTriangleGeometry(params: Record<string, unknown>): THREE.BufferGeometry {
  const a = validArrayVector(params.a, [0, 0, 0]);
  const b = validArrayVector(params.b, [1, 0, 0]);
  const c = validArrayVector(params.c, [0, 1, 0]);
  const thickness = Math.max(0, finiteNumber(params.d, 0));
  if (thickness <= 0) return geometryFromVertices([...a, ...b, ...c]);

  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const vc = new THREE.Vector3(...c);
  const normal = new THREE.Vector3().crossVectors(vb.clone().sub(va), vc.clone().sub(va)).normalize();
  const offset = normal.multiplyScalar(thickness / 2);
  const fa = va.clone().add(offset);
  const fb = vb.clone().add(offset);
  const fc = vc.clone().add(offset);
  const ba = va.clone().sub(offset);
  const bb = vb.clone().sub(offset);
  const bc = vc.clone().sub(offset);
  return geometryFromVertices([
    fa, fb, fc, ba, bc, bb,
    fa, ba, fb, fb, ba, bb,
    fb, bb, fc, fc, bb, bc,
    fc, bc, fa, fa, bc, ba
  ].flatMap((point) => [point.x, point.y, point.z]));
}

function buildPatchGeometry(params: Record<string, unknown>): THREE.BufferGeometry {
  const vertices = Array.isArray(params.vertices)
    ? params.vertices.map((value) => finiteNumber(value, 0))
    : [];
  const vertexCount = Math.floor(vertices.length / 3);
  if (vertexCount < 3) return new THREE.BoxGeometry(1, 1, 1);
  const thickness = Math.max(0, finiteNumber(params.d, 0));
  if (thickness <= 0) return geometryFromVertices(vertices);

  const v0 = new THREE.Vector3(vertices[0], vertices[1], vertices[2]);
  const v1 = new THREE.Vector3(vertices[3], vertices[4], vertices[5]);
  const v2 = new THREE.Vector3(vertices[6], vertices[7], vertices[8]);
  const normal = new THREE.Vector3().crossVectors(v1.clone().sub(v0), v2.clone().sub(v0));
  if (normal.lengthSq() < 1e-10) normal.set(0, 1, 0);
  else normal.normalize();
  const offset = normal.multiplyScalar(thickness / 2);
  const front: number[] = [];
  const back: number[] = [];
  for (let index = 0; index < vertexCount; index += 1) {
    const point = new THREE.Vector3(vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]);
    const frontPoint = point.clone().add(offset);
    const backPoint = point.clone().sub(offset);
    front.push(frontPoint.x, frontPoint.y, frontPoint.z);
    back.push(backPoint.x, backPoint.y, backPoint.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...front, ...back], 3));
  const indices: number[] = [];
  for (let index = 1; index < vertexCount - 1; index += 1) indices.push(0, index, index + 1);
  for (let index = 1; index < vertexCount - 1; index += 1) indices.push(vertexCount, vertexCount + index + 1, vertexCount + index);
  for (let index = 0; index < vertexCount; index += 1) {
    const next = (index + 1) % vertexCount;
    indices.push(index, next, vertexCount + next, index, vertexCount + next, vertexCount + index);
  }
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function integerParam(value: unknown, fallback: number, minimum: number): number {
  return Math.max(minimum, Math.round(finiteNumber(value, fallback)));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function validArrayVector(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [finiteNumber(value[0], fallback[0]), finiteNumber(value[1], fallback[1]), finiteNumber(value[2], fallback[2])];
}

function validPositiveArrayVector(value: unknown, fallback: Vec3): Vec3 {
  const vector = validArrayVector(value, fallback);
  return [
    vector[0] > 0 ? vector[0] : fallback[0],
    vector[1] > 0 ? vector[1] : fallback[1],
    vector[2] > 0 ? vector[2] : fallback[2]
  ];
}

function validVector(value: unknown, fallback: Vec3): THREE.Vector3 {
  return new THREE.Vector3(...validArrayVector(value, fallback));
}

function validQuaternion(value: unknown): THREE.Quaternion {
  if (!Array.isArray(value) || value.length < 4) return new THREE.Quaternion();
  const quaternion = new THREE.Quaternion(
    finiteNumber(value[0], 0),
    finiteNumber(value[1], 0),
    finiteNumber(value[2], 0),
    finiteNumber(value[3], 1)
  );
  return quaternion.lengthSq() > 1e-12 ? quaternion.normalize() : new THREE.Quaternion();
}
