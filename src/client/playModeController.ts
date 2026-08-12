import * as THREE from 'three';
import {
  getMapPlayerMetrics,
  getMapCollisionBake,
  getPlayerSpawnYaw,
  getSpawnPoints,
  movePlayerPositionForMap,
  resolvePlayerPositionForMap,
  stepPlayerVerticalMotionForMap,
  type EditableMap,
  type MapWaterBody
} from '../shared/map';
import { movementDelta } from '../shared/math';
import { isPointInsideWaterBody } from '../shared/mapWater';
import type { InputState, Vec3 } from '../shared/protocol';

const WATER_SPEED_SCALE = 0.62;

export interface PlayMotionState {
  position: Vec3;
  velocityY: number;
  grounded: boolean;
  wading: boolean;
  waterBodyId: string | null;
}

export interface PlayModeControllerOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  getMap: () => EditableMap | null;
  onActiveChange: (active: boolean) => void;
  onInteraction: (position: Vec3, speed: number, waterBodyId: string | null) => void;
}

export class PlayModeController {
  private active = false;
  private lockAcquired = false;
  private readonly keys = new Set<string>();
  private jumpRequested = false;
  private yaw = 0;
  private pitch = 0;
  private state: PlayMotionState | null = null;
  private savedCamera: { position: THREE.Vector3; quaternion: THREE.Quaternion; up: THREE.Vector3 } | null = null;

  constructor(private readonly options: PlayModeControllerOptions) {
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    options.canvas.addEventListener('click', this.onCanvasClick);
  }

  get isActive(): boolean {
    return this.active;
  }

  enter(): boolean {
    const map = this.options.getMap();
    if (!map || this.active) return false;
    const spawn = getSpawnPoints(map)[0];
    const obstacles = getMapCollisionBake(map);
    this.state = {
      position: resolvePlayerPositionForMap(spawn, map, obstacles),
      velocityY: 0,
      grounded: true,
      wading: false,
      waterBodyId: null
    };
    this.yaw = getPlayerSpawnYaw(map);
    this.pitch = 0;
    this.savedCamera = {
      position: this.options.camera.position.clone(),
      quaternion: this.options.camera.quaternion.clone(),
      up: this.options.camera.up.clone()
    };
    this.active = true;
    this.lockAcquired = false;
    this.syncCamera();
    this.options.onActiveChange(true);
    void this.options.canvas.requestPointerLock();
    return true;
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.lockAcquired = false;
    this.keys.clear();
    this.jumpRequested = false;
    if (document.pointerLockElement === this.options.canvas) document.exitPointerLock();
    if (this.savedCamera) {
      this.options.camera.position.copy(this.savedCamera.position);
      this.options.camera.quaternion.copy(this.savedCamera.quaternion);
      this.options.camera.up.copy(this.savedCamera.up);
    }
    this.savedCamera = null;
    this.state = null;
    this.options.onActiveChange(false);
  }

  update(deltaTime: number): void {
    const map = this.options.getMap();
    if (!this.active || !this.state || !map || document.pointerLockElement !== this.options.canvas) return;
    const input = this.inputState();
    const before = this.state.position;
    this.state = stepPlayMotion(this.state, input, deltaTime, this.jumpRequested, map);
    this.jumpRequested = false;
    this.syncCamera();
    const speed = deltaTime > 0
      ? Math.hypot(this.state.position[0] - before[0], this.state.position[2] - before[2]) / deltaTime
      : 0;
    this.options.onInteraction(this.state.position, speed, this.state.waterBodyId);
  }

  private inputState(): InputState {
    return {
      forward: this.keys.has('KeyW'),
      backward: this.keys.has('KeyS'),
      left: this.keys.has('KeyA'),
      right: this.keys.has('KeyD'),
      up: false,
      down: false,
      sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      yaw: this.yaw,
      pitch: this.pitch
    };
  }

  private syncCamera(): void {
    if (!this.state) return;
    const map = this.options.getMap();
    if (!map) return;
    const { eyeHeight } = getMapPlayerMetrics(map);
    this.options.camera.position.set(
      this.state.position[0],
      this.state.position[1] + eyeHeight,
      this.state.position[2]
    );
    this.options.camera.rotation.order = 'YXZ';
    this.options.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.active) return;
    if (event.code === 'Escape') {
      this.exit();
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.code === 'Space' && !event.repeat) this.jumpRequested = true;
    if (!PLAY_KEYS.has(event.code)) return;
    this.keys.add(event.code);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (!this.active || !PLAY_KEYS.has(event.code)) return;
    this.keys.delete(event.code);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.active || document.pointerLockElement !== this.options.canvas) return;
    this.yaw -= event.movementX * 0.0022;
    this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * 0.0022, -Math.PI / 2 + 0.08, Math.PI / 2 - 0.08);
  };

  private onPointerLockChange = (): void => {
    if (!this.active) return;
    if (document.pointerLockElement === this.options.canvas) {
      this.lockAcquired = true;
    } else if (this.lockAcquired) {
      this.exit();
    }
  };

  private onCanvasClick = (): void => {
    if (this.active && document.pointerLockElement !== this.options.canvas) void this.options.canvas.requestPointerLock();
  };
}

export function stepPlayMotion(
  current: PlayMotionState,
  input: InputState,
  deltaTime: number,
  jumpRequested: boolean,
  map: EditableMap
): PlayMotionState {
  const dt = Math.min(0.05, Math.max(0, Number(deltaTime) || 0));
  const obstacles = getMapCollisionBake(map);
  let delta = movementDelta(input, dt);
  if (current.wading) delta = [delta[0] * WATER_SPEED_SCALE, delta[1], delta[2] * WATER_SPEED_SCALE];
  const moved = movePlayerPositionForMap(current.position, delta, map, obstacles, {
    velocity: current.velocityY,
    jumpRequested,
    duration: dt
  });
  const vertical = stepPlayerVerticalMotionForMap(
    [moved[0], current.position[1], moved[2]],
    current.velocityY,
    dt,
    jumpRequested,
    map,
    obstacles
  );
  const position: Vec3 = [moved[0], vertical.y, moved[2]];
  const water = waterAt(map, position[0], position[2]);
  const wading = Boolean(water && water.level > position[1] + 0.08);
  return {
    position,
    velocityY: vertical.velocity,
    grounded: vertical.grounded,
    wading,
    waterBodyId: wading ? water!.id : null
  };
}

function waterAt(map: EditableMap, x: number, z: number): MapWaterBody | null {
  return map.waterBodies.find((water) => isPointInsideWaterBody(water, x, z, map)) ?? null;
}

const PLAY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space']);
