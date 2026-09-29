import * as THREE from 'three';
import { movementDelta } from '../shared/math';
import type { InputState } from '../shared/protocol';
import type { WorldSample } from '../shared/worldTerrain';
import type { MeshCollisionWorld } from './mapMeshCollision';
import type { WorldBuildingCollider } from './worldContent';

const PLAYER_RADIUS = .4;
const PLAYER_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
const PLAY_FOV = 70;

export interface WorldWalkState { x: number; y: number; z: number; yaw: number; pitch: number; wading: boolean }
export interface WorldWalkOptions {
  size: number;
  sample: (x: number, z: number) => WorldSample;
  colliders: readonly WorldBuildingCollider[];
  meshCollision?: MeshCollisionWorld;
}

function hitsCollider(x: number, z: number, collider: WorldBuildingCollider): boolean {
  const dx = x - collider.x, dz = z - collider.z, cos = Math.cos(collider.rotation), sin = Math.sin(collider.rotation);
  const localX = dx * cos - dz * sin, localZ = dx * sin + dz * cos;
  return Math.abs(localX) < collider.width / 2 + PLAYER_RADIUS && Math.abs(localZ) < collider.depth / 2 + PLAYER_RADIUS;
}

function terrainMoveAllowed(from: WorldWalkState, x: number, z: number, sample: (x: number, z: number) => WorldSample): boolean {
  const distance = Math.hypot(x - from.x, z - from.z);
  if (distance <= 1e-6) return true;
  const next = sample(x, z).height;
  return Number.isFinite(next) && next - from.y <= Math.max(.45, distance * 1.2);
}

export function stepWorldWalk(
  state: WorldWalkState,
  input: Pick<InputState, 'forward' | 'backward' | 'left' | 'right' | 'sprint'>,
  deltaTime: number,
  options: WorldWalkOptions
): WorldWalkState {
  const delta = movementDelta({ ...input, up: false, down: false, yaw: state.yaw, pitch: state.pitch }, Math.min(.05, Math.max(0, deltaTime)));
  const half = options.size / 2 - PLAYER_RADIUS;
  let x = state.x, z = state.z;
  const tryAxis = (nextX: number, nextZ: number) => {
    const boundedX = THREE.MathUtils.clamp(nextX, -half, half), boundedZ = THREE.MathUtils.clamp(nextZ, -half, half);
    if (terrainMoveAllowed(state, boundedX, boundedZ, options.sample)
      && !options.colliders.some(collider => hitsCollider(boundedX, boundedZ, collider))) { x = boundedX; z = boundedZ; }
  };
  tryAxis(x + delta[0], z); tryAxis(x, z + delta[2]);
  if (options.meshCollision && (x !== state.x || z !== state.z)) {
    const moved = options.meshCollision.moveCapsule([state.x, state.y, state.z], [x - state.x, 0, z - state.z], PLAYER_RADIUS, PLAYER_HEIGHT, { groundProbe: 0 });
    x = THREE.MathUtils.clamp(moved.position[0], -half, half); z = THREE.MathUtils.clamp(moved.position[2], -half, half);
  }
  const point = options.sample(x, z), waterLevel = point.waterLevel;
  return { ...state, x, y: point.height, z, wading: waterLevel !== null && waterLevel > point.height + .18 };
}

export class WorldWalkController {
  private active = false;
  private lockAcquired = false;
  private keys = new Set<string>();
  private state?: WorldWalkState;
  private saved?: { position: THREE.Vector3; quaternion: THREE.Quaternion; up: THREE.Vector3; fov: number };

  constructor(private readonly options: {
    canvas: HTMLCanvasElement;
    camera: THREE.PerspectiveCamera;
    getWorld: () => WorldWalkOptions | undefined;
    onActiveChange: (active: boolean) => void;
    onMove: (state: WorldWalkState, speed: number) => void;
  }) {
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    options.canvas.addEventListener('click', this.onCanvasClick);
  }

  get isActive(): boolean { return this.active; }
  get position(): THREE.Vector3 | undefined { return this.state ? new THREE.Vector3(this.state.x, this.state.y, this.state.z) : undefined; }

  enter(x: number, z: number, yaw = 0): boolean {
    const world = this.options.getWorld(); if (!world || this.active) return false;
    const point = world.sample(x, z);
    this.state = { x, y: point.height, z, yaw, pitch: 0, wading: false };
    this.saved = { position: this.options.camera.position.clone(), quaternion: this.options.camera.quaternion.clone(), up: this.options.camera.up.clone(), fov: this.options.camera.fov };
    this.active = true; this.lockAcquired = false; this.options.camera.fov = PLAY_FOV; this.options.camera.updateProjectionMatrix();
    this.syncCamera(); this.options.onActiveChange(true); void this.options.canvas.requestPointerLock(); return true;
  }

  exit(): void {
    if (!this.active) return;
    this.active = false; this.lockAcquired = false; this.keys.clear();
    if (document.pointerLockElement === this.options.canvas) document.exitPointerLock();
    if (this.saved) {
      this.options.camera.position.copy(this.saved.position); this.options.camera.quaternion.copy(this.saved.quaternion);
      this.options.camera.up.copy(this.saved.up); this.options.camera.fov = this.saved.fov; this.options.camera.updateProjectionMatrix();
    }
    this.saved = undefined; this.state = undefined; this.options.onActiveChange(false);
  }

  update(deltaTime: number): void {
    const world = this.options.getWorld();
    if (!this.active || !this.state || !world || document.pointerLockElement !== this.options.canvas) return;
    const before = this.state;
    this.state = stepWorldWalk(this.state, {
      forward: this.keys.has('KeyW'), backward: this.keys.has('KeyS'), left: this.keys.has('KeyA'), right: this.keys.has('KeyD'),
      sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
    }, deltaTime, world);
    this.syncCamera();
    this.options.onMove(this.state, deltaTime > 0 ? Math.hypot(this.state.x - before.x, this.state.z - before.z) / deltaTime : 0);
  }

  dispose(): void {
    this.exit(); window.removeEventListener('keydown', this.onKeyDown, { capture: true }); window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    window.removeEventListener('mousemove', this.onMouseMove); document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.options.canvas.removeEventListener('click', this.onCanvasClick);
  }

  private syncCamera(): void {
    if (!this.state) return;
    this.options.camera.position.set(this.state.x, this.state.y + EYE_HEIGHT, this.state.z);
    this.options.camera.rotation.order = 'YXZ'; this.options.camera.rotation.set(this.state.pitch, this.state.yaw, 0);
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.active) return;
    if (event.code === 'Escape') { this.exit(); event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (!WORLD_WALK_KEYS.has(event.code)) return;
    this.keys.add(event.code); event.preventDefault(); event.stopImmediatePropagation();
  };
  private onKeyUp = (event: KeyboardEvent) => {
    if (!this.active || !WORLD_WALK_KEYS.has(event.code)) return;
    this.keys.delete(event.code); event.preventDefault(); event.stopImmediatePropagation();
  };
  private onMouseMove = (event: MouseEvent) => {
    if (!this.active || !this.state || document.pointerLockElement !== this.options.canvas) return;
    this.state.yaw -= event.movementX * .0022;
    this.state.pitch = THREE.MathUtils.clamp(this.state.pitch - event.movementY * .0022, -Math.PI / 2 + .08, Math.PI / 2 - .08);
  };
  private onPointerLockChange = () => {
    if (!this.active) return;
    if (document.pointerLockElement === this.options.canvas) this.lockAcquired = true; else if (this.lockAcquired) this.exit();
  };
  private onCanvasClick = () => {
    if (this.active && document.pointerLockElement !== this.options.canvas) void this.options.canvas.requestPointerLock();
  };
}

const WORLD_WALK_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight']);
