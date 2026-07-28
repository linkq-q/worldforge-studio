export type Vec3 = [number, number, number];

export const PLAYER_MOVE_SPEED = 4.2;
export const PLAYER_SPRINT_MULTIPLIER = 1.6;
export const SPECTATOR_MOVE_SPEED = 8;
export const PLAYER_JUMP_HEIGHT_MULTIPLIER = 1.5;
export const PLAYER_JUMP_SPEED = 6.5 * Math.sqrt(PLAYER_JUMP_HEIGHT_MULTIPLIER);
export const PLAYER_GRAVITY = 18;

export const DEFAULT_INPUT: InputState = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  up: false,
  down: false,
  sprint: false,
  yaw: 0,
  pitch: 0
};

export const MODEL_API_BASE = 'https://voxel-studio-backend.zeabur.app';
export const MODEL_PROVIDERS = ['fireworks', 'glm', 'gpt', 'deepseek'] as const;

export interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  sprint: boolean;
  yaw: number;
  pitch: number;
}

export interface ModelJobState {
  status: 'queued' | 'running' | 'stage' | 'success' | 'error' | 'cancelled';
  stage?: string;
  message?: string;
}
