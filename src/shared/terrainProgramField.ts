export const TERRAIN_PROGRAM_MIN_RESOLUTION = 33;
export const TERRAIN_PROGRAM_MAX_RESOLUTION = 513;
export const TERRAIN_PROGRAM_DEFAULT_RESOLUTION = 257;

/** At most 263169 samples. Never clamp a requested precision or resample a saved field. */
export function validateTerrainProgramResolution(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < TERRAIN_PROGRAM_MIN_RESOLUTION) {
    throw new Error('invalid_terrain_program_resolution');
  }
  if (value > TERRAIN_PROGRAM_MAX_RESOLUTION) throw new Error('terrain_program_resolution_out_of_budget');
  return value;
}

/** Compiled once on the server; clients sample data and never execute the source. */
export interface TerrainProgramField {
  version: 1;
  source: string;
  resolution: number;
  heights: number[];
  /** Absent in legacy fields; never infer a revision from an inspection label. */
  terrainRevision?: number;
  observations: Array<{label: string; min: number; max: number; samples: number[];
    points?: Array<[number, number]>; terrainRevision?: number}>;
}

export function validateTerrainProgramField(value: TerrainProgramField): TerrainProgramField {
  if (!value || value.version !== 1 || typeof value.source !== 'string' || !value.source.trim()
    || value.source.length > 60000 || !Number.isInteger(value.resolution)
    || value.resolution < TERRAIN_PROGRAM_MIN_RESOLUTION || value.resolution > TERRAIN_PROGRAM_MAX_RESOLUTION
    || !Array.isArray(value.heights)
    || value.heights.length !== value.resolution ** 2
    || !value.heights.every(h => Number.isFinite(h) && h >= -500 && h <= 500)
    || value.terrainRevision !== undefined && (!Number.isSafeInteger(value.terrainRevision) || value.terrainRevision < 0)
    || !Array.isArray(value.observations) || value.observations.length > 32
    || !value.observations.every(o => o && typeof o.label === 'string' && o.label.length <= 120
      && Number.isFinite(o.min) && Number.isFinite(o.max) && Array.isArray(o.samples)
      && o.samples.length <= 256 && o.samples.every(Number.isFinite)
      && (o.points === undefined || Array.isArray(o.points) && o.points.length === o.samples.length
        && o.points.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)))
      && (o.terrainRevision === undefined || Number.isSafeInteger(o.terrainRevision) && o.terrainRevision >= 0
        && (value.terrainRevision === undefined || o.terrainRevision <= value.terrainRevision)))) {
    throw new Error('invalid_terrain_program_field');
  }
  return {version: 1, source: value.source, resolution: value.resolution, heights: [...value.heights],
    ...(value.terrainRevision === undefined ? {} : {terrainRevision: value.terrainRevision}),
    observations: value.observations.map(o => ({...o, samples: [...o.samples],
      ...(o.points === undefined ? {} : {points: o.points.map(point => [...point] as [number, number])})}))};
}

export function sampleTerrainProgramField(field: TerrainProgramField, size: number, x: number, z: number): number {
  const n = field.resolution;
  const gx = Math.max(0, Math.min(n - 1, (x / size + 0.5) * (n - 1)));
  const gz = Math.max(0, Math.min(n - 1, (z / size + 0.5) * (n - 1)));
  const ix = Math.min(n - 2, Math.floor(gx)), iz = Math.min(n - 2, Math.floor(gz));
  const tx = gx - ix, tz = gz - iz, i = iz * n + ix;
  return (field.heights[i] * (1 - tx) + field.heights[i + 1] * tx) * (1 - tz)
    + (field.heights[i + n] * (1 - tx) + field.heights[i + n + 1] * tx) * tz;
}
