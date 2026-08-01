export const MODEL_GENERATION_MODES = [
  { key: 'standard', label: 'PRO' },
  { key: 'lite', label: 'LITE' },
  { key: 'voxel', label: 'VOXEL' },
  { key: 'voxel-pro', label: 'VOXEL-PRO' },
  { key: 'curve', label: 'CURVE' },
  { key: 'wire', label: 'WIRE' },
  { key: 'math', label: 'MATH' }
] as const;

export type ModelGenerationMode = typeof MODEL_GENERATION_MODES[number]['key'];

const MODE_KEYS = new Set<string>(MODEL_GENERATION_MODES.map((mode) => mode.key));

export function normalizeModelGenerationMode(value: unknown, fallback: ModelGenerationMode = 'voxel'): ModelGenerationMode {
  return typeof value === 'string' && MODE_KEYS.has(value)
    ? value as ModelGenerationMode
    : fallback;
}
