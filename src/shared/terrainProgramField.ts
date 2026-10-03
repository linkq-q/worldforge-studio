/** Compiled once on the server; clients sample data and never execute the source. */
export interface TerrainProgramField {
  version: 1;
  source: string;
  resolution: number;
  heights: number[];
  observations: Array<{label: string; min: number; max: number; samples: number[]}>;
}

export function validateTerrainProgramField(value: TerrainProgramField): TerrainProgramField {
  if (!value || value.version !== 1 || typeof value.source !== 'string' || !value.source.trim()
    || value.source.length > 60000 || !Number.isInteger(value.resolution)
    || value.resolution < 33 || value.resolution > 257 || !Array.isArray(value.heights)
    || value.heights.length !== value.resolution ** 2
    || !value.heights.every(h => Number.isFinite(h) && h >= -500 && h <= 500)
    || !Array.isArray(value.observations) || value.observations.length > 32
    || !value.observations.every(o => o && typeof o.label === 'string' && o.label.length <= 120
      && Number.isFinite(o.min) && Number.isFinite(o.max) && Array.isArray(o.samples)
      && o.samples.length <= 256 && o.samples.every(Number.isFinite))) {
    throw new Error('invalid_terrain_program_field');
  }
  return {version: 1, source: value.source, resolution: value.resolution, heights: [...value.heights],
    observations: value.observations.map(o => ({...o, samples: [...o.samples]}))};
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
