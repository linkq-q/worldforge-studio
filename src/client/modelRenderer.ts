import * as THREE from 'three';
import { enforceReadableFoliageColors } from '../shared/modelColorPolicy';
import { MODEL_API_BASE } from '../shared/protocol';
import { resolveModelZFighting } from './modelZFighting';

export interface MotionDelta {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number] | null;
}

export interface MotionPlan {
  _duration: number;
  _loop?: boolean;
  [partId: string]: unknown;
}

export interface MotionLookups {
  getPart: (id: string) => MotionPart | undefined;
  getChildren: (id: string) => MotionPart[];
}

export interface MotionPart {
  id: string;
  parent?: string;
  isGroup: boolean;
  offset: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
}

export interface ModelRuntime {
  buildGeometry: (type: string, params: Record<string, unknown>) => THREE.BufferGeometry;
  evaluateMotion: (
    plan: MotionPlan,
    duration: number,
    time: number,
    lookups?: MotionLookups
  ) => Record<string, MotionDelta>;
}

export interface BuiltModelGroup {
  group: THREE.Group;
  objects: Map<string, THREE.Object3D>;
  runtime: ModelRuntime;
  motionLookups: MotionLookups;
}

interface ModelNode {
  id: string;
  parent?: string;
  tags?: unknown[];
  transform?: {
    pos?: [number, number, number];
    quat?: [number, number, number, number];
    scale?: [number, number, number];
  };
  mesh?: {
    type: string;
    params?: Record<string, unknown>;
    color?: number;
    material?: {
      color?: number;
      roughness?: number;
      metalness?: number;
      opacity?: number;
      transparent?: boolean;
      flatShading?: boolean;
    };
  };
}

interface ModelJson {
  nodes?: ModelNode[];
}

let runtimePromise: Promise<ModelRuntime> | null = null;

export async function buildModelGroup(modelJson: unknown): Promise<THREE.Group> {
  return (await buildModelGroupWithNodes(modelJson)).group;
}

export async function buildModelGroupWithNodes(modelJson: unknown): Promise<BuiltModelGroup> {
  const group = new THREE.Group();
  const zFighting = resolveModelZFighting(modelJson);
  const data = enforceReadableFoliageColors(zFighting.modelJson) as ModelJson;
  group.userData.zFightingStats = zFighting.stats;
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  if (nodes.length === 0) {
    group.add(makeFallbackProp());
    enableObjectShadows(group);
    return { group, objects: new Map(), runtime: fallbackRuntime, motionLookups: emptyMotionLookups };
  }

  const runtime = await loadRuntime();
  const objects = new Map<string, THREE.Object3D>();
  for (const node of nodes) {
    const object = node.mesh
      ? new THREE.Mesh(safeBuildGeometry(runtime, node.mesh.type, node.mesh.params ?? {}), makeMaterial(node.mesh))
      : new THREE.Group();
    object.name = node.id;
    object.userData.nodeId = node.id;
    if (Array.isArray(node.tags)) object.userData.materialTags = structuredClone(node.tags);
    const transform = node.transform ?? {};
    const pos = transform.pos ?? [0, 0, 0];
    object.position.set(pos[0], pos[1], pos[2]);
    if (transform.quat) object.quaternion.set(transform.quat[0], transform.quat[1], transform.quat[2], transform.quat[3]);
    if (transform.scale && transform.scale.every((value) => value > 0)) {
      object.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
    }
    objects.set(node.id, object);
  }

  const motionParts = new Map<string, MotionPart>();
  const childParts = new Map<string, MotionPart[]>();
  for (const node of nodes) {
    const object = objects.get(node.id);
    if (!object) continue;
    const part: MotionPart = {
      id: node.id,
      parent: node.parent,
      isGroup: !node.mesh,
      offset: { x: object.position.x, y: object.position.y, z: object.position.z },
      position: { x: object.position.x, y: object.position.y, z: object.position.z },
      rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
      quaternion: { x: object.quaternion.x, y: object.quaternion.y, z: object.quaternion.z, w: object.quaternion.w }
    };
    motionParts.set(node.id, part);
    if (node.parent) {
      const siblings = childParts.get(node.parent) ?? [];
      siblings.push(part);
      childParts.set(node.parent, siblings);
    }
  }
  const motionLookups: MotionLookups = {
    getPart: (id) => motionParts.get(id),
    getChildren: (id) => childParts.get(id) ?? []
  };

  for (const node of nodes) {
    const object = objects.get(node.id);
    if (!object) continue;
    const parent = node.parent ? objects.get(node.parent) : null;
    if (parent) parent.add(object);
    else group.add(object);
  }

  centerGroup(group);
  group.userData.materialTagSource = data;
  enableObjectShadows(group);
  return { group, objects, runtime, motionLookups };
}

function safeBuildGeometry(runtime: ModelRuntime, type: string, params: Record<string, unknown>): THREE.BufferGeometry {
  try {
    return runtime.buildGeometry(type, params);
  } catch {
    return buildFallbackGeometry(type, params);
  }
}

export function tintObject(object: THREE.Object3D, color: number, opacity = 1, depthTest = true): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (material?.color) material.color.setHex(color);
    material.opacity = opacity;
    material.transparent = opacity < 1;
    material.depthTest = depthTest;
    material.needsUpdate = true;
  });
}

const REVEAL_HIGHLIGHT_MAX_OPACITY = 0.5;
const REVEAL_HIGHLIGHT_OVERLAY = 'revealHighlightOverlay';
const revealHighlightOverlays = new WeakMap<THREE.Mesh, THREE.Mesh>();

export function setRevealHighlight(object: THREE.Object3D, enabled: boolean, pulse = 0.5): void {
  const opacity = clamp01(pulse) * REVEAL_HIGHLIGHT_MAX_OPACITY;
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.userData[REVEAL_HIGHLIGHT_OVERLAY] !== true) meshes.push(mesh);
  });

  for (const mesh of meshes) {
    let overlay = revealHighlightOverlays.get(mesh);
    if (!enabled) {
      if (!overlay) continue;
      mesh.remove(overlay);
      disposeRevealHighlightOverlay(overlay);
      revealHighlightOverlays.delete(mesh);
      continue;
    }

    if (!overlay) {
      const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const highlightMaterials = sourceMaterials.map(() => new THREE.MeshBasicMaterial({
        color: 0xff2020,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false
      }));
      overlay = new THREE.Mesh(
        mesh.geometry,
        Array.isArray(mesh.material) ? highlightMaterials : highlightMaterials[0]
      );
      overlay.name = '__reveal-highlight-overlay__';
      overlay.userData[REVEAL_HIGHLIGHT_OVERLAY] = true;
      overlay.renderOrder = 9_000;
      overlay.raycast = () => {};
      mesh.add(overlay);
      revealHighlightOverlays.set(mesh, overlay);
    }

    const materials = Array.isArray(overlay.material) ? overlay.material : [overlay.material];
    for (const material of materials) material.opacity = opacity;
  }
}

function disposeRevealHighlightOverlay(overlay: THREE.Mesh): void {
  const materials = Array.isArray(overlay.material) ? overlay.material : [overlay.material];
  for (const material of materials) material.dispose();
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}

export function enableObjectShadows(object: THREE.Object3D): void {
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

async function loadRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= (async () => {
    try {
      const mod = await import(/* @vite-ignore */ `${MODEL_API_BASE}/api/templates/module.js`);
      return mod.create({ THREE }) as ModelRuntime;
    } catch {
      return fallbackRuntime;
    }
  })();
  return runtimePromise;
}

const fallbackRuntime: ModelRuntime = {
  buildGeometry: buildFallbackGeometry,
  evaluateMotion: evaluateFallbackMotion
};

/**
 * Keeps the bundled avatar animations working when the optional remote model
 * runtime cannot be loaded. The generated player motions currently use these
 * three templates, so they must never depend on network availability.
 */
export function evaluateFallbackMotion(
  plan: MotionPlan,
  duration: number,
  time: number
): Record<string, MotionDelta> {
  const pose: Record<string, MotionDelta> = {};
  const safeDuration = Math.max(0.01, finiteNumber(duration, plan._duration || 1));
  const safeTime = Math.max(0, finiteNumber(time, 0));

  for (const [partId, rawTracks] of Object.entries(plan)) {
    if (partId.startsWith('_') || !isRecord(rawTracks)) continue;
    const position: [number, number, number] = [0, 0, 0];
    const rotation: [number, number, number] = [0, 0, 0];
    let hasPosition = false;
    let hasRotation = false;

    for (const track of motionTrackList(rawTracks.bounce)) {
      const axis = axisIndex(track.axis, 1);
      const amplitude = finiteNumber(track.amplitude, 0.2);
      const frequency = finiteNumber(track.frequency, 1 / safeDuration);
      const phase = finiteNumber(track.phase, 0);
      const cycle = safeTime * frequency + phase;
      position[axis] += amplitude * (0.5 - Math.cos(cycle * Math.PI * 2) * 0.5);
      hasPosition = true;
    }

    for (const template of ['swing', 'sway'] as const) {
      for (const track of motionTrackList(rawTracks[template])) {
        const axis = axisIndex(track.axis);
        const amplitude = finiteNumber(track.amplitude, 0.25);
        const frequency = finiteNumber(track.frequency, 1 / safeDuration);
        const phase = finiteNumber(track.phase, 0);
        rotation[axis] += Math.sin((safeTime * frequency + phase) * Math.PI * 2) * amplitude;
        hasRotation = true;
      }
    }

    for (const template of ['pointTo', 'tilt'] as const) {
      for (const track of motionTrackList(rawTracks[template])) {
        const axis = axisIndex(track.axis);
        rotation[axis] += THREE.MathUtils.degToRad(finiteNumber(track.angle, 0));
        hasRotation = true;
      }
    }

    for (const track of motionTrackList(rawTracks.slide)) {
      const axis = axisIndex(track.axis);
      const distance = finiteNumber(track.distance, 0.2);
      const frequency = finiteNumber(track.frequency, 1 / safeDuration);
      const phase = finiteNumber(track.phase, 0);
      position[axis] += Math.sin((safeTime * frequency + phase) * Math.PI * 2) * distance;
      hasPosition = true;
    }

    for (const track of motionTrackList(rawTracks.impulse)) {
      const axis = axisIndex(track.axis);
      const amplitude = finiteNumber(track.amplitude, 0.2);
      const progress = Math.min(1, safeTime / safeDuration);
      const envelope = Math.sin(progress * Math.PI) * Math.exp(-progress * 1.6);
      position[axis] += amplitude * envelope;
      hasPosition = true;
    }

    if (hasPosition || hasRotation) {
      pose[partId] = {
        ...(hasPosition ? { position } : {}),
        ...(hasRotation ? { rotation } : {})
      };
    }
  }
  return pose;
}

function axisIndex(value: unknown, fallback: 0 | 1 | 2 = 0): 0 | 1 | 2 {
  if (value === 'y') return 1;
  if (value === 'z') return 2;
  if (value === 'x') return 0;
  return fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function motionTrackList(value: unknown): Record<string, unknown>[] {
  if (isRecord(value)) return [value];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

const emptyMotionLookups: MotionLookups = {
  getPart: () => undefined,
  getChildren: () => []
};

function makeMaterial(mesh: NonNullable<ModelNode['mesh']>): THREE.MeshStandardMaterial {
  const mat = mesh.material ?? {};
  const color = mat.color ?? mesh.color ?? 0x8b8f8d;
  const zeroThickness = (mesh.type === 'tri' || mesh.type === 'patch') && Number(mesh.params?.d ?? 0) <= 0;
  return new THREE.MeshStandardMaterial({
    color,
    roughness: mat.roughness ?? 0.72,
    metalness: mat.metalness ?? 0.04,
    opacity: mat.opacity ?? 1,
    transparent: mat.transparent === true || (mat.opacity ?? 1) < 1,
    flatShading: mat.flatShading !== false,
    side: zeroThickness ? THREE.DoubleSide : THREE.FrontSide
  });
}

function buildFallbackGeometry(type: string, params: Record<string, unknown>): THREE.BufferGeometry {
  const num = (key: string, fallback: number) => Number(params[key] ?? fallback);
  switch (type) {
    case 'box':
      return new THREE.BoxGeometry(num('width', 1), num('height', 1), num('depth', 1));
    case 'sphere':
      return new THREE.SphereGeometry(num('radius', 1), num('widthSegments', 8), num('heightSegments', 6));
    case 'cylinder':
      return new THREE.CylinderGeometry(num('radiusTop', 1), num('radiusBottom', 1), num('height', 1), num('radialSegments', 8));
    case 'cone':
      return new THREE.ConeGeometry(num('radius', 1), num('height', 1), num('radialSegments', 8));
    case 'torus':
      return new THREE.TorusGeometry(num('radius', 1), num('tube', 0.3), num('radialSegments', 8), num('tubularSegments', 12));
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(num('radius', 1), num('detail', 0));
    case 'dodecahedron':
      return new THREE.DodecahedronGeometry(num('radius', 1), num('detail', 0));
    case 'octahedron':
      return new THREE.OctahedronGeometry(num('radius', 1), num('detail', 0));
    default:
      return new THREE.BoxGeometry(1, 1, 1);
  }
}

function makeFallbackProp(): THREE.Object3D {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
    new THREE.MeshStandardMaterial({ color: 0xa8794b, flatShading: true, roughness: 0.8 })
  );
  body.position.y = 0.6;
  group.add(body);
  return group;
}

function centerGroup(group: THREE.Group): void {
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  group.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
}
