import * as THREE from 'three';
import type { EditableMap } from '../shared/map';

const COPLANAR_NORMAL_DOT = 0.9999;
const COPLANAR_DISTANCE_EPSILON = 0.0001;
const COPLANAR_OVERLAP_EPSILON = 0.0001;
export const MODEL_Z_FIGHTING_OFFSET = 0.01;

interface ModelNode {
  id: string;
  parent?: string;
  transform?: {
    pos?: [number, number, number];
    quat?: [number, number, number, number];
    scale?: [number, number, number];
  };
  mesh?: {
    type?: string;
    params?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

interface ModelJson {
  nodes?: ModelNode[];
  [key: string]: unknown;
}

interface PrimitiveBase {
  node: ModelNode;
  matrixWorld: THREE.Matrix4;
  parentMatrixWorld: THREE.Matrix4;
  volume: number;
  color: number | null;
}

interface BoxPrimitive extends PrimitiveBase {
  type: 'box';
  width: number;
  height: number;
  depth: number;
}

interface CylinderPrimitive extends PrimitiveBase {
  type: 'cylinder';
  radiusTop: number;
  radiusBottom: number;
  height: number;
}

interface ConePrimitive extends PrimitiveBase {
  type: 'cone';
  radius: number;
  height: number;
}

interface WedgePrimitive extends PrimitiveBase {
  type: 'wedge';
  width: number;
  height: number;
  depth: number;
}

type PrimitiveEntry = BoxPrimitive | CylinderPrimitive | ConePrimitive | WedgePrimitive;

interface RectFace {
  type: 'rect';
  normal: THREE.Vector3;
  center: THREE.Vector3;
  corners: THREE.Vector3[];
}

interface CircleFace {
  type: 'circle';
  normal: THREE.Vector3;
  center: THREE.Vector3;
  radius: number;
}

type PrimitiveFace = RectFace | CircleFace;

export interface ModelZFightingStats {
  entries: number;
  pairChecks: number;
  resolvedPairs: number;
  adjustedNodes: number;
}

export interface ModelZFightingResult {
  modelJson: unknown;
  stats: ModelZFightingStats;
}

export interface MapZFightingResult {
  map: EditableMap;
  stats: ModelZFightingStats & { adjustedAssets: number };
}

/**
 * Ports 3d-generate's coplanar-face micro-offset pass to model JSON so the
 * correction survives WorldForge's InstancedMesh/BatchedMesh compilation.
 * The source model is never mutated; an unchanged model is returned by
 * reference when no overlapping coplanar faces are found.
 *
 * Only faces whose normals point the SAME direction can visibly z-fight:
 * opposite-facing contacts (decal bottom against base top) are backface-culled
 * or occluded, and nudging them buries authored layered details (e.g. the room
 * carpet's motif boxes sinking under its base slabs). Pairs whose meshes share
 * one resolved color flicker invisibly and are likewise left alone, since
 * separating a same-color stack by MODEL_Z_FIGHTING_OFFSET can submerge thin
 * overlays sitting on top of it.
 */
export function resolveModelZFighting(modelJson: unknown): ModelZFightingResult {
  const emptyStats = (): ModelZFightingStats => ({
    entries: 0,
    pairChecks: 0,
    resolvedPairs: 0,
    adjustedNodes: 0
  });
  if (!isRecord(modelJson)) return { modelJson, stats: emptyStats() };
  const data = modelJson as ModelJson;
  if (!Array.isArray(data.nodes)) return { modelJson, stats: emptyStats() };

  const nodes = data.nodes.filter(isModelNode);
  const entries = collectPrimitiveEntries(nodes);
  const stats: ModelZFightingStats = {
    entries: entries.length,
    pairChecks: 0,
    resolvedPairs: 0,
    adjustedNodes: 0
  };
  if (entries.length < 2) return { modelJson, stats };

  const worldOffsets = new Map<ModelNode, THREE.Vector3>();
  for (let index = 0; index < entries.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      const first = entries[index];
      const second = entries[otherIndex];
      stats.pairChecks += 1;
      // 同色共面闪烁不可见;移动它们只会把叠在上面的薄装饰层埋掉(房间地毯案例)。
      if (first.color !== null && first.color === second.color) continue;
      const overlap = detectCoplanarOverlap(first, second);
      if (!overlap) continue;

      const smaller = first.volume <= second.volume ? first : second;
      const normal = smaller === first ? overlap.normalA : overlap.normalB;
      const offset = worldOffsets.get(smaller.node) ?? new THREE.Vector3();
      offset.addScaledVector(normal, MODEL_Z_FIGHTING_OFFSET);
      worldOffsets.set(smaller.node, offset);
      stats.resolvedPairs += 1;
    }
  }
  if (worldOffsets.size === 0) return { modelJson, stats };

  const entryByNode = new Map(entries.map((entry) => [entry.node, entry]));
  const adjustedNodes = data.nodes.map((node) => {
    const worldOffset = worldOffsets.get(node);
    const entry = entryByNode.get(node);
    if (!worldOffset || !entry) return node;
    const inverseParentBasis = new THREE.Matrix3()
      .setFromMatrix4(entry.parentMatrixWorld)
      .invert();
    const localOffset = worldOffset.clone().applyMatrix3(inverseParentBasis);
    const position = readPosition(node.transform?.pos);
    return {
      ...node,
      transform: {
        ...(node.transform ?? {}),
        pos: [
          position[0] + localOffset.x,
          position[1] + localOffset.y,
          position[2] + localOffset.z
        ] as [number, number, number]
      }
    };
  });
  stats.adjustedNodes = worldOffsets.size;
  return { modelJson: { ...data, nodes: adjustedNodes }, stats };
}

/** Applies the model pass only to a render copy, leaving map/collider truth untouched. */
export function resolveMapModelZFighting(map: EditableMap): MapZFightingResult {
  let entries = 0;
  let pairChecks = 0;
  let resolvedPairs = 0;
  let adjustedNodes = 0;
  let adjustedAssets = 0;
  let changed = false;
  const assets = map.assets?.map((asset) => {
    const result = resolveModelZFighting(asset.modelJson);
    entries += result.stats.entries;
    pairChecks += result.stats.pairChecks;
    resolvedPairs += result.stats.resolvedPairs;
    adjustedNodes += result.stats.adjustedNodes;
    if (result.modelJson === asset.modelJson) return asset;
    changed = true;
    adjustedAssets += 1;
    return { ...asset, modelJson: result.modelJson };
  });
  return {
    map: changed ? { ...map, assets } : map,
    stats: { entries, pairChecks, resolvedPairs, adjustedNodes, adjustedAssets }
  };
}

function collectPrimitiveEntries(nodes: ModelNode[]): PrimitiveEntry[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const worldMatrices = new Map<ModelNode, THREE.Matrix4>();
  const parentMatrices = new Map<ModelNode, THREE.Matrix4>();
  const visiting = new Set<ModelNode>();

  const worldMatrixFor = (node: ModelNode): THREE.Matrix4 => {
    const cached = worldMatrices.get(node);
    if (cached) return cached;
    const local = localMatrixFor(node);
    const parent = node.parent ? nodesById.get(node.parent) : undefined;
    if (!parent || visiting.has(node)) {
      parentMatrices.set(node, new THREE.Matrix4());
      worldMatrices.set(node, local);
      return local;
    }
    visiting.add(node);
    const parentWorld = worldMatrixFor(parent);
    visiting.delete(node);
    parentMatrices.set(node, parentWorld);
    const world = parentWorld.clone().multiply(local);
    worldMatrices.set(node, world);
    return world;
  };

  const entries: PrimitiveEntry[] = [];
  for (const node of nodes) {
    const mesh = node.mesh;
    if (!mesh) continue;
    const params = mesh.params ?? {};
    const matrixWorld = worldMatrixFor(node);
    const parentMatrixWorld = parentMatrices.get(node) ?? new THREE.Matrix4();
    const color = resolveNodeColor(node);
    if (mesh.type === 'box') {
      const width = dimension(params.width);
      const height = dimension(params.height);
      const depth = dimension(params.depth);
      entries.push({
        node,
        type: 'box',
        width,
        height,
        depth,
        volume: width * height * depth,
        matrixWorld,
        parentMatrixWorld,
        color
      });
    } else if (mesh.type === 'cylinder') {
      const radius = numberOr(params.radiusTop ?? params.radius, 1);
      const height = dimension(params.height);
      entries.push({
        node,
        type: 'cylinder',
        radiusTop: radius,
        radiusBottom: radius,
        height,
        volume: Math.PI * radius * radius * height,
        matrixWorld,
        parentMatrixWorld,
        color
      });
    } else if (mesh.type === 'cone') {
      const radius = dimension(params.radius);
      const height = dimension(params.height);
      entries.push({
        node,
        type: 'cone',
        radius,
        height,
        volume: Math.PI * radius * radius * height / 3,
        matrixWorld,
        parentMatrixWorld,
        color
      });
    } else if (mesh.type === 'wedge') {
      const width = dimension(params.width);
      const height = dimension(params.height);
      const depth = dimension(params.depth);
      entries.push({
        node,
        type: 'wedge',
        width,
        height,
        depth,
        volume: width * height * depth / 2,
        matrixWorld,
        parentMatrixWorld,
        color
      });
    }
  }
  return entries;
}

function detectCoplanarOverlap(
  first: PrimitiveEntry,
  second: PrimitiveEntry
): { normalA: THREE.Vector3; normalB: THREE.Vector3 } | null {
  const facesA = worldFaces(first);
  const facesB = worldFaces(second);
  for (const faceA of facesA) {
    for (const faceB of facesB) {
      // 仅同向共面才会真正闪面;反向贴合面(装饰底面贴基座顶面)被背面剔除/遮挡,
      // 若按反向法线推移动会把薄装饰层压进基座(房间地毯图案消失的直接原因)。
      if (faceA.normal.dot(faceB.normal) < COPLANAR_NORMAL_DOT) continue;
      const distance = Math.abs(faceB.normal.dot(
        new THREE.Vector3().subVectors(faceA.center, faceB.center)
      ));
      if (distance > COPLANAR_DISTANCE_EPSILON) continue;
      if (facesOverlap2D(faceA, faceB)) {
        return { normalA: faceA.normal.clone(), normalB: faceB.normal.clone() };
      }
    }
  }
  return null;
}

function worldFaces(entry: PrimitiveEntry): PrimitiveFace[] {
  if (entry.type === 'box') return boxWorldFaces(entry);
  const rotation = new THREE.Matrix4().extractRotation(entry.matrixWorld);
  const worldPosition = new THREE.Vector3().setFromMatrixPosition(entry.matrixWorld);
  if (entry.type === 'cylinder') {
    const along = new THREE.Vector3(0, 1, 0).applyMatrix4(rotation).normalize();
    const halfHeight = entry.height / 2;
    return [
      {
        type: 'circle',
        normal: along.clone(),
        center: worldPosition.clone().addScaledVector(along, halfHeight),
        radius: entry.radiusTop
      },
      {
        type: 'circle',
        normal: along.clone().negate(),
        center: worldPosition.clone().addScaledVector(along, -halfHeight),
        radius: entry.radiusBottom
      }
    ];
  }
  if (entry.type === 'cone') {
    const tip = new THREE.Vector3(0, 1, 0).applyMatrix4(rotation).normalize();
    return [{
      type: 'circle',
      normal: tip.clone().negate(),
      center: worldPosition.clone().addScaledVector(tip, -entry.height / 2),
      radius: entry.radius
    }];
  }
  return wedgeWorldFaces(entry, rotation);
}

function boxWorldFaces(entry: BoxPrimitive): RectFace[] {
  const halfWidth = entry.width / 2;
  const halfHeight = entry.height / 2;
  const halfDepth = entry.depth / 2;
  const rotation = new THREE.Matrix4().extractRotation(entry.matrixWorld);
  const faces = [
    { normal: [1, 0, 0], center: [halfWidth, 0, 0], corners: [[halfWidth, halfHeight, halfDepth], [halfWidth, halfHeight, -halfDepth], [halfWidth, -halfHeight, halfDepth], [halfWidth, -halfHeight, -halfDepth]] },
    { normal: [-1, 0, 0], center: [-halfWidth, 0, 0], corners: [[-halfWidth, halfHeight, halfDepth], [-halfWidth, halfHeight, -halfDepth], [-halfWidth, -halfHeight, halfDepth], [-halfWidth, -halfHeight, -halfDepth]] },
    { normal: [0, 1, 0], center: [0, halfHeight, 0], corners: [[halfWidth, halfHeight, halfDepth], [halfWidth, halfHeight, -halfDepth], [-halfWidth, halfHeight, halfDepth], [-halfWidth, halfHeight, -halfDepth]] },
    { normal: [0, -1, 0], center: [0, -halfHeight, 0], corners: [[halfWidth, -halfHeight, halfDepth], [halfWidth, -halfHeight, -halfDepth], [-halfWidth, -halfHeight, halfDepth], [-halfWidth, -halfHeight, -halfDepth]] },
    { normal: [0, 0, 1], center: [0, 0, halfDepth], corners: [[halfWidth, halfHeight, halfDepth], [halfWidth, -halfHeight, halfDepth], [-halfWidth, halfHeight, halfDepth], [-halfWidth, -halfHeight, halfDepth]] },
    { normal: [0, 0, -1], center: [0, 0, -halfDepth], corners: [[halfWidth, halfHeight, -halfDepth], [halfWidth, -halfHeight, -halfDepth], [-halfWidth, halfHeight, -halfDepth], [-halfWidth, -halfHeight, -halfDepth]] }
  ];
  return faces.map((face) => rectFace(face, entry.matrixWorld, rotation));
}

function wedgeWorldFaces(entry: WedgePrimitive, rotation: THREE.Matrix4): RectFace[] {
  const halfWidth = entry.width / 2;
  const halfHeight = entry.height / 2;
  const halfDepth = entry.depth / 2;
  const faces = [
    { normal: [0, -1, 0], center: [0, -halfHeight, 0], corners: [[halfWidth, -halfHeight, halfDepth], [halfWidth, -halfHeight, -halfDepth], [-halfWidth, -halfHeight, halfDepth], [-halfWidth, -halfHeight, -halfDepth]] },
    { normal: [0, 0, -1], center: [0, 0, -halfDepth], corners: [[halfWidth, halfHeight, -halfDepth], [halfWidth, -halfHeight, -halfDepth], [-halfWidth, halfHeight, -halfDepth], [-halfWidth, -halfHeight, -halfDepth]] },
    { normal: [halfHeight, halfWidth, 0], center: [0, 0, 0], corners: [[-halfWidth, halfHeight, halfDepth], [-halfWidth, halfHeight, -halfDepth], [halfWidth, -halfHeight, halfDepth], [halfWidth, -halfHeight, -halfDepth]] },
    { normal: [-1, 0, 0], center: [-halfWidth, 0, 0], corners: [[-halfWidth, halfHeight, halfDepth], [-halfWidth, halfHeight, -halfDepth], [-halfWidth, -halfHeight, halfDepth]] },
    { normal: [0, 0, 1], center: [0, 0, halfDepth], corners: [[halfWidth, halfHeight, halfDepth], [halfWidth, -halfHeight, halfDepth], [-halfWidth, halfHeight, halfDepth], [-halfWidth, -halfHeight, halfDepth]] }
  ];
  return faces.map((face) => rectFace(face, entry.matrixWorld, rotation));
}

function rectFace(
  face: { normal: number[]; center: number[]; corners: number[][] },
  matrixWorld: THREE.Matrix4,
  rotation: THREE.Matrix4
): RectFace {
  return {
    type: 'rect',
    normal: new THREE.Vector3(face.normal[0], face.normal[1], face.normal[2]).applyMatrix4(rotation).normalize(),
    center: new THREE.Vector3(face.center[0], face.center[1], face.center[2]).applyMatrix4(matrixWorld),
    corners: face.corners.map((corner) => (
      new THREE.Vector3(corner[0], corner[1], corner[2]).applyMatrix4(matrixWorld)
    ))
  };
}

function facesOverlap2D(first: PrimitiveFace, second: PrimitiveFace): boolean {
  if (first.type === 'circle' && second.type === 'circle') {
    return first.center.distanceTo(second.center)
      <= first.radius + second.radius + COPLANAR_OVERLAP_EPSILON;
  }
  if (first.type === 'circle' && second.type === 'rect') {
    return circleRectOverlap2D(first, second, first.normal);
  }
  if (first.type === 'rect' && second.type === 'circle') {
    return circleRectOverlap2D(second, first, first.normal);
  }
  if (first.type !== 'rect' || second.type !== 'rect') return false;
  return rectsOverlap2D(first.corners, second.corners, first.normal);
}

function circleRectOverlap2D(circle: CircleFace, rect: RectFace, planeNormal: THREE.Vector3): boolean {
  const [u, v] = planeAxes(planeNormal);
  const projected = rect.corners.map((corner) => ({ u: corner.dot(u), v: corner.dot(v) }));
  const circleU = circle.center.dot(u);
  const circleV = circle.center.dot(v);
  const minU = Math.min(...projected.map((point) => point.u));
  const maxU = Math.max(...projected.map((point) => point.u));
  const minV = Math.min(...projected.map((point) => point.v));
  const maxV = Math.max(...projected.map((point) => point.v));
  const closestU = Math.max(minU, Math.min(circleU, maxU));
  const closestV = Math.max(minV, Math.min(circleV, maxV));
  return Math.hypot(circleU - closestU, circleV - closestV)
    <= circle.radius + COPLANAR_OVERLAP_EPSILON;
}

function rectsOverlap2D(
  cornersA: THREE.Vector3[],
  cornersB: THREE.Vector3[],
  planeNormal: THREE.Vector3
): boolean {
  const [u, v] = planeAxes(planeNormal);
  const projectedA = cornersA.map((corner) => ({ u: corner.dot(u), v: corner.dot(v) }));
  const projectedB = cornersB.map((corner) => ({ u: corner.dot(u), v: corner.dot(v) }));
  const edges = [
    edgeBetween(projectedA[0], projectedA[1]),
    edgeBetween(projectedA[0], projectedA[2]),
    edgeBetween(projectedB[0], projectedB[1]),
    edgeBetween(projectedB[0], projectedB[2])
  ];
  const axes = edges.flatMap((edge) => {
    const length = Math.hypot(edge.u, edge.v);
    return length < COPLANAR_OVERLAP_EPSILON
      ? []
      : [{ u: -edge.v / length, v: edge.u / length }];
  });
  for (const axis of axes) {
    const projectionA = projectedA.map((point) => point.u * axis.u + point.v * axis.v);
    const projectionB = projectedB.map((point) => point.u * axis.u + point.v * axis.v);
    if (
      Math.max(...projectionA) < Math.min(...projectionB) - COPLANAR_OVERLAP_EPSILON
      || Math.max(...projectionB) < Math.min(...projectionA) - COPLANAR_OVERLAP_EPSILON
    ) return false;
  }
  return true;
}

function planeAxes(normal: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const u = Math.abs(normal.y) < COPLANAR_NORMAL_DOT
    ? new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize()
    : new THREE.Vector3().crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize();
  return [u, new THREE.Vector3().crossVectors(normal, u)];
}

function edgeBetween(
  first: { u: number; v: number },
  second: { u: number; v: number }
): { u: number; v: number } {
  return { u: second.u - first.u, v: second.v - first.v };
}

/** Best-effort display color for the same-color z-fight skip; mirrors the batcher's material color fallback. */
function resolveNodeColor(node: ModelNode): number | null {
  const mesh = node.mesh as { material?: { color?: unknown }; color?: unknown } | undefined;
  const value = mesh?.material?.color ?? mesh?.color;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function localMatrixFor(node: ModelNode): THREE.Matrix4 {
  const position = readPosition(node.transform?.pos);
  const quaternion = readQuaternion(node.transform?.quat);
  const scale = readScale(node.transform?.scale);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion(...quaternion),
    new THREE.Vector3(...scale)
  );
}

function readPosition(value: unknown): [number, number, number] {
  return readTuple3(value, [0, 0, 0]);
}

function readScale(value: unknown): [number, number, number] {
  const scale = readTuple3(value, [1, 1, 1]);
  return scale.every((component) => component > 0) ? scale : [1, 1, 1];
}

function readQuaternion(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length < 4) return [0, 0, 0, 1];
  return [
    numberOr(value[0], 0),
    numberOr(value[1], 0),
    numberOr(value[2], 0),
    numberOr(value[3], 1)
  ];
}

function readTuple3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    numberOr(value[0], fallback[0]),
    numberOr(value[1], fallback[1]),
    numberOr(value[2], fallback[2])
  ];
}

function dimension(value: unknown): number {
  return numberOr(value, 1) || 1;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModelNode(value: unknown): value is ModelNode {
  return isRecord(value) && typeof value.id === 'string';
}
