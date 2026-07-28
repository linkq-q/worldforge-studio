import { rayAabbIntersection, sub } from './math';
import type { Vec3 } from './protocol';

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export type ColliderCandidateRank = 'volume' | 'height' | 'planArea';

export interface ModelColliderBox extends Aabb {
  sourceNodeId?: string;
}

export interface ModelColliderPlan {
  version: 1;
  boxes: ModelColliderBox[];
  sourceMeshCount: number;
  candidateCount: number;
  fallbackUsed: boolean;
}

export interface ModelColliderProfile {
  maxBoxes: number;
  minVolume: number;
  minPlanArea: number;
  minHeight: number;
  minExtent: number;
  rankBy: ColliderCandidateRank;
  fallbackToBounds: boolean;
  padding: number;
}

export const MAP_ASSET_COLLIDER_PROFILE: ModelColliderProfile = {
  maxBoxes: 12,
  minVolume: 0.08,
  minPlanArea: 0.04,
  minHeight: 0.1,
  minExtent: 0.08,
  rankBy: 'volume',
  fallbackToBounds: true,
  padding: 0
};

export const PLAYER_MODEL_COLLIDER_PROFILE: ModelColliderProfile = {
  maxBoxes: 18,
  minVolume: 0.04,
  minPlanArea: 0.025,
  minHeight: 0.08,
  minExtent: 0.06,
  rankBy: 'volume',
  fallbackToBounds: true,
  padding: 0.12
};

interface ModelNode {
  id?: string;
  parent?: string;
  transform?: {
    pos?: Vec3;
    quat?: Quat;
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

interface ModelMeshBounds {
  bounds: Aabb;
  sourceNodeId?: string;
}

type Quat = [number, number, number, number];

interface NodeTransform {
  pos: Vec3;
  quat: Quat;
  scale: Vec3;
}

const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
const IDENTITY_TRANSFORM: NodeTransform = {
  pos: [0, 0, 0],
  quat: IDENTITY_QUAT,
  scale: [1, 1, 1]
};
const HITBOX_PADDING = 0.12;
const MIN_HALF_EXTENT_XZ = 0.18;
const MIN_HEIGHT = 0.28;
const FALLBACK_BOUNDS: Aabb = {
  min: [-0.6, 0, -0.6],
  max: [0.6, 1.2, 0.6]
};

export function calculateModelHitBounds(modelJson: unknown): Aabb {
  const { rawBounds } = collectModelMeshBounds(modelJson);
  if (!rawBounds) return cloneBounds(expandHitBounds(FALLBACK_BOUNDS));
  return expandHitBounds(normalizeLikeClient(rawBounds));
}

export function buildModelColliderPlan(
  modelJson: unknown,
  profile: ModelColliderProfile = MAP_ASSET_COLLIDER_PROFILE
): ModelColliderPlan {
  const collected = collectModelMeshBounds(modelJson);
  const assetBounds = collected.rawBounds ?? FALLBACK_BOUNDS;
  const candidates = collected.meshes
    .map((mesh) => ({ ...mesh, bounds: normalizeChildLikeClient(mesh.bounds, assetBounds) }))
    .map((mesh) => {
      const size = boundsSize(mesh.bounds);
      return {
        ...mesh,
        volume: size[0] * size[1] * size[2],
        planArea: size[0] * size[2],
        height: size[1],
        minHorizontalExtent: Math.min(size[0], size[2])
      };
    })
    .filter((candidate) => candidate.minHorizontalExtent >= profile.minExtent
      && candidate.height >= profile.minHeight
      && candidate.volume >= profile.minVolume
      && candidate.planArea >= profile.minPlanArea);

  const selected = [...candidates]
    .sort((a, b) => candidateRank(b, profile.rankBy) - candidateRank(a, profile.rankBy)
      || String(a.sourceNodeId ?? '').localeCompare(String(b.sourceNodeId ?? '')))
    .slice(0, Math.max(1, Math.round(profile.maxBoxes)));
  let fallbackUsed = false;
  if (selected.length === 0 && profile.fallbackToBounds) {
    selected.push({
      bounds: normalizeLikeClient(assetBounds),
      sourceNodeId: 'asset-bounds',
      volume: 0,
      planArea: 0,
      height: 0,
      minHorizontalExtent: 0
    });
    fallbackUsed = true;
  }

  return {
    version: 1,
    boxes: selected.map((candidate) => ({
      ...expandBounds(candidate.bounds, profile.padding),
      sourceNodeId: candidate.sourceNodeId
    })),
    sourceMeshCount: collected.meshes.length,
    candidateCount: candidates.length,
    fallbackUsed
  };
}

export function normalizeModelColliderPlan(
  value: unknown,
  modelJson: unknown,
  profile: ModelColliderProfile = MAP_ASSET_COLLIDER_PROFILE
): ModelColliderPlan {
  const data = value as Partial<ModelColliderPlan> | null | undefined;
  const boxes = Array.isArray(data?.boxes)
    ? data.boxes.map(sanitizeColliderBox).filter((box): box is ModelColliderBox => Boolean(box))
    : [];
  if (data?.version !== 1 || boxes.length === 0) return buildModelColliderPlan(modelJson, profile);
  return {
    version: 1,
    boxes: boxes.slice(0, Math.max(1, Math.round(profile.maxBoxes))),
    sourceMeshCount: Math.max(0, Math.round(finiteNumber(data?.sourceMeshCount, boxes.length))),
    candidateCount: Math.max(boxes.length, Math.round(finiteNumber(data?.candidateCount, boxes.length))),
    fallbackUsed: data?.fallbackUsed === true
  };
}

export function modelColliderBoundingVolume(plan: ModelColliderPlan): number {
  const boxes = plan.boxes.filter((box) => [...box.min, ...box.max].every(Number.isFinite));
  if (boxes.length === 0) return 1;
  const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], box.min[axis]);
      max[axis] = Math.max(max[axis], box.max[axis]);
    }
  }
  const size = boundsSize({ min, max });
  return Math.max(0.000001, size[0] * size[1] * size[2]);
}

export function modelVolumeAtScale(plan: ModelColliderPlan, scale: number): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return modelColliderBoundingVolume(plan) * safeScale ** 3;
}

export function modelScaleForVolume(plan: ModelColliderPlan, volume: number): number {
  const safeVolume = Number.isFinite(volume) && volume > 0 ? volume : modelColliderBoundingVolume(plan);
  return Math.cbrt(safeVolume / modelColliderBoundingVolume(plan));
}

export function rayModelHitboxIntersection(
  origin: Vec3,
  direction: Vec3,
  modelPosition: Vec3,
  rotationY: number,
  modelScale: number,
  modelJson: unknown,
  colliderPlan?: ModelColliderPlan | null
): number | null {
  const scaleValue = Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 1;
  const plan = colliderPlan?.version === 1 && colliderPlan.boxes.length > 0
    ? colliderPlan
    : buildModelColliderPlan(modelJson, PLAYER_MODEL_COLLIDER_PROFILE);
  const localOrigin = scaleVec3(rotateY(sub(origin, modelPosition), -rotationY), 1 / scaleValue);
  const localDirection = rotateY(direction, -rotationY);
  let closest: number | null = null;
  for (const box of plan.boxes) {
    const distance = rayAabbIntersection(localOrigin, localDirection, box.min, box.max);
    if (distance !== null && (closest === null || distance < closest)) closest = distance;
  }
  return closest === null ? null : closest * scaleValue;
}

export function modelColliderWorldAabbs(
  colliderPlan: ModelColliderPlan,
  modelPosition: Vec3,
  rotationY: number,
  modelScale: number
): Aabb[] {
  const scaleValue = Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 1;
  return colliderPlan.boxes.map((box) => {
    let min: Vec3 = [Infinity, Infinity, Infinity];
    let max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const corner of boundsCorners(box)) {
      const scaled: Vec3 = [corner[0] * scaleValue, corner[1] * scaleValue, corner[2] * scaleValue];
      const rotated = rotateY(scaled, rotationY);
      const world: Vec3 = [
        rotated[0] + modelPosition[0],
        rotated[1] + modelPosition[1],
        rotated[2] + modelPosition[2]
      ];
      min = [Math.min(min[0], world[0]), Math.min(min[1], world[1]), Math.min(min[2], world[2])];
      max = [Math.max(max[0], world[0]), Math.max(max[1], world[1]), Math.max(max[2], world[2])];
    }
    return { min, max };
  });
}

/**
 * Returns representative points on the actual collider boxes instead of a
 * single point at the model origin. Keeping the points on each box (rather
 * than on one combined AABB) avoids counting empty space between model parts.
 */
export function modelColliderVisibilityPoints(
  colliderPlan: ModelColliderPlan,
  modelPosition: Vec3,
  rotationY: number,
  modelScale: number,
  maxBoxes = 10
): Vec3[] {
  const scaleValue = Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 1;
  const boxes = colliderPlan.boxes
    .filter((box) => [...box.min, ...box.max].every(Number.isFinite))
    .sort((a, b) => boxVolume(b) - boxVolume(a))
    .slice(0, Math.max(1, Math.round(maxBoxes)));
  const points: Vec3[] = [];
  for (const box of boxes) {
    const center: Vec3 = [
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2
    ];
    const localPoints: Vec3[] = [
      center,
      [box.min[0], center[1], center[2]],
      [box.max[0], center[1], center[2]],
      [center[0], box.min[1], center[2]],
      [center[0], box.max[1], center[2]],
      [center[0], center[1], box.min[2]],
      [center[0], center[1], box.max[2]]
    ];
    for (const point of localPoints) {
      const rotated = rotateY(scaleVec3(point, scaleValue), rotationY);
      points.push([
        rotated[0] + modelPosition[0],
        rotated[1] + modelPosition[1],
        rotated[2] + modelPosition[2]
      ]);
    }
  }
  return points;
}

function collectModelMeshBounds(modelJson: unknown): { meshes: ModelMeshBounds[]; rawBounds: Aabb | null } {
  const data = modelJson as ModelJson;
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  const nodeById = new Map<string, ModelNode>();
  for (const node of nodes) {
    if (typeof node.id === 'string' && node.id) nodeById.set(node.id, node);
  }

  const transformCache = new Map<ModelNode, NodeTransform>();
  const visiting = new Set<ModelNode>();
  const meshes: ModelMeshBounds[] = [];
  let rawBounds: Aabb | null = null;
  for (const node of nodes) {
    if (!node.mesh) continue;
    const localBounds = localMeshBounds(node.mesh.type ?? 'box', node.mesh.params ?? {});
    const transform = worldTransformFor(node, nodeById, transformCache, visiting);
    let meshBounds: Aabb | null = null;
    for (const corner of boundsCorners(localBounds)) {
      const point = transformPoint(corner, transform);
      meshBounds = includePoint(meshBounds, point);
      rawBounds = includePoint(rawBounds, point);
    }
    if (meshBounds) meshes.push({ bounds: meshBounds, sourceNodeId: node.id });
  }
  return { meshes, rawBounds };
}

function candidateRank(
  candidate: { volume: number; height: number; planArea: number },
  rankBy: ColliderCandidateRank
): number {
  if (rankBy === 'height') return candidate.height;
  if (rankBy === 'planArea') return candidate.planArea;
  return candidate.volume;
}

function normalizeChildLikeClient(bounds: Aabb, assetBounds: Aabb): Aabb {
  const centerX = (assetBounds.min[0] + assetBounds.max[0]) / 2;
  const centerZ = (assetBounds.min[2] + assetBounds.max[2]) / 2;
  return {
    min: [bounds.min[0] - centerX, bounds.min[1] - assetBounds.min[1], bounds.min[2] - centerZ],
    max: [bounds.max[0] - centerX, bounds.max[1] - assetBounds.min[1], bounds.max[2] - centerZ]
  };
}

function boundsSize(bounds: Aabb): Vec3 {
  return [
    Math.max(0, bounds.max[0] - bounds.min[0]),
    Math.max(0, bounds.max[1] - bounds.min[1]),
    Math.max(0, bounds.max[2] - bounds.min[2])
  ];
}

function boxVolume(bounds: Aabb): number {
  const size = boundsSize(bounds);
  return size[0] * size[1] * size[2];
}

function expandBounds(bounds: Aabb, padding: number): Aabb {
  const safePadding = Math.max(0, finiteNumber(padding, 0));
  return {
    min: [bounds.min[0] - safePadding, bounds.min[1] - safePadding, bounds.min[2] - safePadding],
    max: [bounds.max[0] + safePadding, bounds.max[1] + safePadding, bounds.max[2] + safePadding]
  };
}

function sanitizeColliderBox(value: unknown): ModelColliderBox | null {
  const data = value as Partial<ModelColliderBox> | null | undefined;
  const min = strictVec3(data?.min);
  const max = strictVec3(data?.max);
  if (!min || !max || max[0] <= min[0] || max[1] <= min[1] || max[2] <= min[2]) return null;
  return {
    min,
    max,
    sourceNodeId: typeof data?.sourceNodeId === 'string' && data.sourceNodeId ? data.sourceNodeId : undefined
  };
}

function strictVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const vector: Vec3 = [Number(value[0]), Number(value[1]), Number(value[2])];
  return vector.every(Number.isFinite) ? vector : null;
}

function worldTransformFor(
  node: ModelNode,
  nodeById: Map<string, ModelNode>,
  cache: Map<ModelNode, NodeTransform>,
  visiting: Set<ModelNode>
): NodeTransform {
  const cached = cache.get(node);
  if (cached) return cached;
  if (visiting.has(node)) return localTransform(node);

  visiting.add(node);
  const local = localTransform(node);
  const parent = typeof node.parent === 'string' ? nodeById.get(node.parent) : undefined;
  const transform = parent
    ? composeTransform(worldTransformFor(parent, nodeById, cache, visiting), local)
    : local;
  visiting.delete(node);
  cache.set(node, transform);
  return transform;
}

function localTransform(node: ModelNode): NodeTransform {
  const transform = node.transform ?? {};
  return {
    pos: validVec3(transform.pos, [0, 0, 0]),
    quat: validQuat(transform.quat, IDENTITY_QUAT),
    scale: positiveVec3(transform.scale, [1, 1, 1])
  };
}

function composeTransform(parent: NodeTransform, local: NodeTransform): NodeTransform {
  return {
    pos: addVec3(parent.pos, rotateByQuat(mulVec3(parent.scale, local.pos), parent.quat)),
    quat: normalizeQuat(multiplyQuat(parent.quat, local.quat)),
    scale: mulVec3(parent.scale, local.scale)
  };
}

function transformPoint(point: Vec3, transform: NodeTransform): Vec3 {
  return addVec3(transform.pos, rotateByQuat(mulVec3(transform.scale, point), transform.quat));
}

function normalizeLikeClient(bounds: Aabb): Aabb {
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  return {
    min: [bounds.min[0] - centerX, 0, bounds.min[2] - centerZ],
    max: [bounds.max[0] - centerX, Math.max(0, bounds.max[1] - bounds.min[1]), bounds.max[2] - centerZ]
  };
}

function expandHitBounds(bounds: Aabb): Aabb {
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  const halfX = Math.max((bounds.max[0] - bounds.min[0]) / 2, MIN_HALF_EXTENT_XZ);
  const halfZ = Math.max((bounds.max[2] - bounds.min[2]) / 2, MIN_HALF_EXTENT_XZ);
  const height = Math.max(bounds.max[1] - bounds.min[1], MIN_HEIGHT);
  return {
    min: [centerX - halfX - HITBOX_PADDING, 0, centerZ - halfZ - HITBOX_PADDING],
    max: [centerX + halfX + HITBOX_PADDING, height + HITBOX_PADDING, centerZ + halfZ + HITBOX_PADDING]
  };
}

function localMeshBounds(type: string, params: Record<string, unknown>): Aabb {
  const num = (key: string, fallback: number) => finiteNumber(params[key], fallback);
  switch (type) {
    case 'box':
    case 'wedge': {
      const width = Math.max(0.01, num('width', 1));
      const height = Math.max(0.01, num('height', 1));
      const depth = Math.max(0.01, num('depth', 1));
      return centeredBounds(width / 2, height / 2, depth / 2);
    }
    case 'sphere':
    case 'icosahedron':
    case 'dodecahedron':
    case 'octahedron': {
      const radius = Math.max(0.01, num('radius', 1));
      return centeredBounds(radius, radius, radius);
    }
    case 'cylinder': {
      const radius = Math.max(Math.abs(num('radiusTop', 1)), Math.abs(num('radiusBottom', 1)), 0.01);
      return centeredBounds(radius, Math.max(0.01, num('height', 1)) / 2, radius);
    }
    case 'cone': {
      const radius = Math.max(0.01, Math.abs(num('radius', 1)));
      return centeredBounds(radius, Math.max(0.01, num('height', 1)) / 2, radius);
    }
    case 'torus': {
      const radius = Math.max(0.01, Math.abs(num('radius', 1)));
      const tube = Math.max(0.01, Math.abs(num('tube', 0.3)));
      return centeredBounds(radius + tube, tube, radius + tube);
    }
    case 'tri':
      return vertexBounds([
        validVec3(params.a, [0, 0, 0]),
        validVec3(params.b, [1, 0, 0]),
        validVec3(params.c, [0, 1, 0])
      ], Math.max(0, num('d', 0)) / 2);
    case 'patch':
      return patchBounds(params.vertices, Math.max(0, num('d', 0)) / 2);
    default:
      return centeredBounds(0.5, 0.5, 0.5);
  }
}

function patchBounds(vertices: unknown, thickness: number): Aabb {
  if (!Array.isArray(vertices)) return centeredBounds(0.5, 0.5, 0.5);
  const points: Vec3[] = [];
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    points.push([
      finiteNumber(vertices[index], 0),
      finiteNumber(vertices[index + 1], 0),
      finiteNumber(vertices[index + 2], 0)
    ]);
  }
  return points.length > 0 ? vertexBounds(points, thickness) : centeredBounds(0.5, 0.5, 0.5);
}

function vertexBounds(points: Vec3[], thickness: number): Aabb {
  let bounds: Aabb | null = null;
  for (const point of points) bounds = includePoint(bounds, point);
  const box = bounds ?? centeredBounds(0.5, 0.5, 0.5);
  const expand = Math.max(thickness, 0.02);
  return {
    min: [box.min[0] - expand, box.min[1] - expand, box.min[2] - expand],
    max: [box.max[0] + expand, box.max[1] + expand, box.max[2] + expand]
  };
}

function centeredBounds(x: number, y: number, z: number): Aabb {
  return { min: [-x, -y, -z], max: [x, y, z] };
}

function boundsCorners(bounds: Aabb): Vec3[] {
  const corners: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push([x, y, z]);
    }
  }
  return corners;
}

function includePoint(bounds: Aabb | null, point: Vec3): Aabb {
  if (!bounds) return { min: [...point], max: [...point] };
  return {
    min: [
      Math.min(bounds.min[0], point[0]),
      Math.min(bounds.min[1], point[1]),
      Math.min(bounds.min[2], point[2])
    ],
    max: [
      Math.max(bounds.max[0], point[0]),
      Math.max(bounds.max[1], point[1]),
      Math.max(bounds.max[2], point[2])
    ]
  };
}

function rotateY(vector: Vec3, yaw: number): Vec3 {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return [
    vector[0] * cos + vector[2] * sin,
    vector[1],
    -vector[0] * sin + vector[2] * cos
  ];
}

function rotateByQuat(vector: Vec3, quat: Quat): Vec3 {
  const [x, y, z, w] = quat;
  const tx = 2 * (y * vector[2] - z * vector[1]);
  const ty = 2 * (z * vector[0] - x * vector[2]);
  const tz = 2 * (x * vector[1] - y * vector[0]);
  return [
    vector[0] + w * tx + (y * tz - z * ty),
    vector[1] + w * ty + (z * tx - x * tz),
    vector[2] + w * tz + (x * ty - y * tx)
  ];
}

function multiplyQuat(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
}

function normalizeQuat(quat: Quat): Quat {
  const length = Math.hypot(quat[0], quat[1], quat[2], quat[3]);
  if (length <= 0.00001) return IDENTITY_QUAT;
  return [quat[0] / length, quat[1] / length, quat[2] / length, quat[3] / length];
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function mulVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

function scaleVec3(vector: Vec3, amount: number): Vec3 {
  return [vector[0] * amount, vector[1] * amount, vector[2] * amount];
}

function validVec3(value: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0]),
    finiteNumber(value[1], fallback[1]),
    finiteNumber(value[2], fallback[2])
  ];
}

function positiveVec3(value: unknown, fallback: Vec3): Vec3 {
  const vector = validVec3(value, fallback);
  return [
    vector[0] > 0 ? vector[0] : fallback[0],
    vector[1] > 0 ? vector[1] : fallback[1],
    vector[2] > 0 ? vector[2] : fallback[2]
  ];
}

function validQuat(value: unknown, fallback: Quat): Quat {
  if (!Array.isArray(value) || value.length < 4) return [...fallback];
  return normalizeQuat([
    finiteNumber(value[0], fallback[0]),
    finiteNumber(value[1], fallback[1]),
    finiteNumber(value[2], fallback[2]),
    finiteNumber(value[3], fallback[3])
  ]);
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function cloneBounds(bounds: Aabb): Aabb {
  return { min: [...bounds.min], max: [...bounds.max] };
}
