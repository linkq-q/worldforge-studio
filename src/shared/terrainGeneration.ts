import { TERRAIN_MIN_HEIGHT, type EditableMap } from './map';

export const TERRAIN_GENERATION_PRESETS = ['plain', 'hills', 'valley', 'island', 'canyon'] as const;
export type TerrainGenerationPreset = typeof TERRAIN_GENERATION_PRESETS[number];

export interface TerrainGenerationParams {
  preset: TerrainGenerationPreset;
  seed: number;
  amplitude: number;
  roughness: number;
}

export function normalizeTerrainGenerationParams(value: unknown, map: EditableMap): TerrainGenerationParams {
  if (!value || typeof value !== 'object') throw new Error('invalid_terrain_generation');
  const input = value as Record<string, unknown>;
  if (!TERRAIN_GENERATION_PRESETS.includes(input.preset as TerrainGenerationPreset)) {
    throw new Error('invalid_terrain_generation');
  }
  const preset = input.preset as TerrainGenerationPreset;
  const defaultAmplitude = preset === 'plain' ? 0 : map.box.size[1] * 0.42;
  return {
    preset,
    seed: normalizeSeed(input.seed, map.seed),
    amplitude: clamp(finiteNumber(input.amplitude, defaultAmplitude), 0, map.box.size[1] - 0.05),
    roughness: clamp(finiteNumber(input.roughness, 0.55), 0, 1)
  };
}

export function generateTerrainInPlace(map: EditableMap, value: unknown): TerrainGenerationParams {
  const params = normalizeTerrainGenerationParams(value, map);
  const terrain = map.terrain;
  const maxHeight = map.box.size[1] - 0.05;
  const rotateAxis = (params.seed & 1) === 1;

  for (let z = 0; z < terrain.resolutionZ; z += 1) {
    const nz = z / Math.max(1, terrain.resolutionZ - 1) * 2 - 1;
    for (let x = 0; x < terrain.resolutionX; x += 1) {
      const nx = x / Math.max(1, terrain.resolutionX - 1) * 2 - 1;
      const axis = rotateAxis ? nz : nx;
      const crossAxis = rotateAxis ? nx : nz;
      const noise = fbm((nx + 1) * 1.7, (nz + 1) * 1.7, params.seed, params.roughness);
      const detail = (noise + 1) / 2;
      let height = 0;

      switch (params.preset) {
        case 'plain':
          height = 0;
          break;
        case 'hills':
          height = params.amplitude * (0.12 + detail * 0.78);
          break;
        case 'valley': {
          const valleyAxis = Math.abs(axis + noise * 0.16);
          height = params.amplitude * (0.08 + Math.pow(valleyAxis, 1.55) * 0.72 + detail * 0.12);
          break;
        }
        case 'island': {
          const radius = Math.min(1.25, Math.hypot(nx, nz));
          const falloff = smoothstep(1.08, 0.16, radius);
          height = params.amplitude * (falloff * (0.55 + detail * 0.38) - (1 - falloff) * 0.08);
          break;
        }
        case 'canyon': {
          const wanderingAxis = Math.abs(axis + noise * 0.2 + Math.sin(crossAxis * 2.4) * 0.06);
          const wall = smoothstep(0.12, 0.52, wanderingAxis);
          height = params.amplitude * (0.06 + wall * 0.82 + detail * 0.08);
          break;
        }
      }
      terrain.heights[z * terrain.resolutionX + x] = clamp(height, TERRAIN_MIN_HEIGHT, maxHeight);
    }
  }
  return params;
}

function fbm(x: number, z: number, seed: number, roughness: number): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  const gain = 0.34 + roughness * 0.28;
  const lacunarity = 1.8 + roughness * 0.7;
  for (let octave = 0; octave < 4; octave += 1) {
    value += valueNoise(x * frequency, z * frequency, seed + octave * 1013) * amplitude;
    total += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return total > 0 ? value / total : 0;
}

function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  const a = hashNoise(x0, z0, seed);
  const b = hashNoise(x0 + 1, z0, seed);
  const c = hashNoise(x0, z0 + 1, seed);
  const d = hashNoise(x0 + 1, z0 + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

function hashNoise(x: number, z: number, seed: number): number {
  let value = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 69069);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return ((value ^ value >>> 16) >>> 0) / 2147483647.5 - 1;
}

function normalizeSeed(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) >>> 0 : fallback >>> 0;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
