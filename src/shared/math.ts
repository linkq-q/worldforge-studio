import {
  PLAYER_GRAVITY,
  PLAYER_JUMP_SPEED,
  PLAYER_MOVE_SPEED,
  PLAYER_SPRINT_MULTIPLIER,
  SPECTATOR_MOVE_SPEED,
  type InputState,
  type Vec3
} from './protocol';

export const MAX_PITCH = Math.PI / 2 - 0.08;
const EPSILON = 0.00001;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function wrapAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function clampPitch(pitch: number): number {
  return clamp(Number.isFinite(pitch) ? pitch : 0, -MAX_PITCH, MAX_PITCH);
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (len <= EPSILON) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function scale(v: Vec3, amount: number): Vec3 {
  return [v[0] * amount, v[1] * amount, v[2] * amount];
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

export function forwardFromYawPitch(yaw: number, pitch = 0): Vec3 {
  const safeYaw = wrapAngle(yaw);
  const safePitch = clampPitch(pitch);
  const cp = Math.cos(safePitch);
  return normalize([-Math.sin(safeYaw) * cp, Math.sin(safePitch), -Math.cos(safeYaw) * cp]);
}

export function planarForwardFromYaw(yaw: number): Vec3 {
  const safeYaw = wrapAngle(yaw);
  return normalize([-Math.sin(safeYaw), 0, -Math.cos(safeYaw)]);
}

export function rightFromYaw(yaw: number): Vec3 {
  const safeYaw = wrapAngle(yaw);
  return [Math.cos(safeYaw), 0, -Math.sin(safeYaw)];
}

export function movementDelta(input: InputState, dt: number, spectating = false): Vec3 {
  if (!Number.isFinite(dt) || dt <= 0) return [0, 0, 0];
  const forward = spectating
    ? forwardFromYawPitch(input.yaw, input.pitch)
    : planarForwardFromYaw(input.yaw);
  const right = rightFromYaw(input.yaw);
  let move: Vec3 = [0, 0, 0];
  if (input.forward) move = [move[0] + forward[0], move[1] + forward[1], move[2] + forward[2]];
  if (input.backward) move = [move[0] - forward[0], move[1] - forward[1], move[2] - forward[2]];
  if (input.right) move = [move[0] + right[0], move[1], move[2] + right[2]];
  if (input.left) move = [move[0] - right[0], move[1], move[2] - right[2]];
  if (spectating && input.up) move[1] += 1;
  if (spectating && input.down) move[1] -= 1;

  const direction = normalize(move);
  const speed = (spectating ? SPECTATOR_MOVE_SPEED : PLAYER_MOVE_SPEED)
    * (!spectating && input.sprint ? PLAYER_SPRINT_MULTIPLIER : 1);
  return [direction[0] * speed * dt, direction[1] * speed * dt, direction[2] * speed * dt];
}

export interface VerticalMotionState {
  y: number;
  velocity: number;
  grounded: boolean;
}

export function stepVerticalMotion(
  currentY: number,
  groundY: number,
  velocity: number,
  dt: number,
  jumpRequested: boolean
): VerticalMotionState {
  const safeGround = Number.isFinite(groundY) ? groundY : 0;
  const safeY = Number.isFinite(currentY) ? Math.max(currentY, safeGround) : safeGround;
  if (!Number.isFinite(dt) || dt <= 0) {
    return { y: safeY, velocity: Number.isFinite(velocity) ? velocity : 0, grounded: safeY <= safeGround + 0.001 };
  }

  const wasGrounded = safeY <= safeGround + 0.001 && (!Number.isFinite(velocity) || velocity <= 0);
  let nextVelocity = Number.isFinite(velocity) ? velocity : 0;
  if (wasGrounded) nextVelocity = jumpRequested ? PLAYER_JUMP_SPEED : 0;
  const nextY = safeY + nextVelocity * dt - 0.5 * PLAYER_GRAVITY * dt * dt;
  nextVelocity -= PLAYER_GRAVITY * dt;
  if (nextY <= safeGround) return { y: safeGround, velocity: 0, grounded: true };
  return { y: nextY, velocity: nextVelocity, grounded: false };
}

export function raySphereIntersection(origin: Vec3, direction: Vec3, center: Vec3, radius: number): number | null {
  if (length(direction) <= EPSILON) return null;
  const dir = normalize(direction);
  const oc = sub(origin, center);
  const b = 2 * dot(oc, dir);
  const c = dot(oc, oc) - radius * radius;
  const discriminant = b * b - 4 * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const t1 = (-b - root) / 2;
  const t2 = (-b + root) / 2;
  if (t1 >= 0) return t1;
  if (t2 >= 0) return t2;
  return null;
}

export function rayAabbIntersection(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3): number | null {
  if (length(direction) <= EPSILON) return null;
  const dir = normalize(direction);
  let tMin = -Infinity;
  let tMax = Infinity;

  for (let axis = 0; axis < 3; axis += 1) {
    const d = dir[axis];
    if (Math.abs(d) < 0.00001) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (min[axis] - origin[axis]) * inv;
    let t2 = (max[axis] - origin[axis]) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  if (tMax < 0) return null;
  return tMin >= 0 ? tMin : tMax;
}

export function isTargetInView(origin: Vec3, yaw: number, pitch: number, target: Vec3, fovDegrees = 70, maxDistance = 28): boolean {
  const toTarget = sub(target, origin);
  const dist = length(toTarget);
  if (dist > maxDistance) return false;
  const forward = forwardFromYawPitch(yaw, pitch);
  const alignment = dot(forward, normalize(toTarget));
  return alignment >= Math.cos((fovDegrees * Math.PI / 180) / 2);
}
