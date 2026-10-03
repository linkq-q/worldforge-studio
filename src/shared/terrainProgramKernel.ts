import { thermalErodeInPlace, carveDrainageInPlace } from './terrainErosion';

/** This module and terrainErosion are compiled into a fresh worker VM, without host callbacks. */
export function createTerrainProgramApi(seed: number, size: number, resolution: number) {
  let heights = new Array<number>(resolution * resolution).fill(0);
  const observations: Array<{label: string; min: number; max: number; samples: number[]}> = [];
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const ease = (t: number) => t * t * (3 - 2 * t);
  const hash = (x: number, z: number) => {
    let v = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ seed;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967295 * 2 - 1;
  };
  const noise = (x: number, z: number, wavelength = 50, octaves = 1): number => {
    if (!(wavelength > 0) || !Number.isInteger(octaves) || octaves < 1 || octaves > 8) throw new Error('invalid_noise');
    let sum = 0, norm = 0, amplitude = 1;
    for (let o = 0; o < octaves; o++) {
      const px = x / wavelength, pz = z / wavelength;
      const ix = Math.floor(px), iz = Math.floor(pz), tx = ease(px - ix), tz = ease(pz - iz);
      sum += amplitude * mix(mix(hash(ix, iz), hash(ix + 1, iz), tx), mix(hash(ix, iz + 1), hash(ix + 1, iz + 1), tx), tz);
      norm += amplitude; amplitude *= 0.5; wavelength *= 0.5;
    }
    return sum / norm;
  };
  const sample = (x: number, z: number) => {
    const px = clamp((x / size + 0.5) * (resolution - 1), 0, resolution - 1);
    const pz = clamp((z / size + 0.5) * (resolution - 1), 0, resolution - 1);
    const ix = Math.min(resolution - 2, Math.floor(px)), iz = Math.min(resolution - 2, Math.floor(pz));
    const i = iz * resolution + ix;
    return mix(mix(heights[i], heights[i + 1], px - ix), mix(heights[i + resolution], heights[i + resolution + 1], px - ix), pz - iz);
  };
  const map = (fn: (x: number, z: number, height: number) => number) => {
    const next = new Array<number>(heights.length);
    for (let z = 0; z < resolution; z++) for (let x = 0; x < resolution; x++) {
      const i = z * resolution + x;
      const h = fn((x / (resolution - 1) - 0.5) * size, (z / (resolution - 1) - 0.5) * size, heights[i]);
      if (!Number.isFinite(h) || Math.abs(h) > 500) throw new Error('terrain_height_out_of_range');
      next[i] = h;
    }
    heights = next;
  };
  type ProfilePoint = [number, number, number, number];
  const profile = (points: ProfilePoint[], valley: boolean, slope: number, base: number) => {
    if (!Array.isArray(points) || points.length < 2 || points.length > 256
      || !points.every(p => Array.isArray(p) && p.length === 4 && p.every(Number.isFinite) && p[3] > 0)
      || !Number.isFinite(slope) || slope <= 0 || !Number.isFinite(base)) throw new Error('invalid_terrain_profile');
    map((x, z, original) => {
      let h = original;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1], dx = b[0] - a[0], dz = b[1] - a[1];
        const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / Math.max(1e-9, dx * dx + dz * dz), 0, 1);
        const d = Math.hypot(x - mix(a[0], b[0], t), z - mix(a[1], b[1], t));
        const elevation = mix(a[2], b[2], t), width = mix(a[3], b[3], t);
        if (valley) h = Math.min(h, elevation + Math.max(0, d - width / 2) * slope);
        else if (d < width) h = Math.max(h, base + (elevation - base) * (1 - d / width) ** 1.6);
      }
      return h;
    });
  };
  const erode = (options: {iterations?: number; thermal?: number; drainage?: number; talus?: number} = {}) => {
    const {iterations = 8, thermal = 0.3, drainage = 0.4, talus = 35} = options;
    if (!Number.isInteger(iterations) || iterations < 0 || iterations > 40
      || ![thermal, drainage].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
      || !Number.isFinite(talus) || talus < 5 || talus > 80) throw new Error('invalid_terrain_erosion');
    const field = {terrain: {heights, resolutionX: resolution, resolutionZ: resolution}, box: {size: [size, 501, size] as [number, number, number]}};
    thermalErodeInPlace(field, iterations, talus, thermal, -500);
    for (let i = 0; i < iterations; i++) if (drainage > 0) carveDrainageInPlace(field, drainage, -500);
    heights = field.terrain.heights;
  };
  const inspect = (label: string, points: Array<[number, number]> = []) => {
    if (typeof label !== 'string' || label.length > 120 || observations.length >= 32
      || !Array.isArray(points) || points.length > 256
      || !points.every(p => p.length === 2 && p.every(Number.isFinite))) throw new Error('invalid_terrain_inspection');
    let min = Infinity, max = -Infinity;
    for (const h of heights) {min = Math.min(min, h); max = Math.max(max, h);}
    const report = {label, min, max, samples: points.map(p => sample(p[0], p[1]))};
    observations.push(report);
    return {...report, samples: [...report.samples]};
  };
  return {seed, size, resolution, noise, map, sample, inspect, erode,
    ridge: (points: ProfilePoint[], options: {base?: number} = {}) => profile(points, false, 1, options.base ?? 0),
    channel: (points: ProfilePoint[], options: {bankSlope?: number} = {}) => profile(points, true, options.bankSlope ?? 0.7, 0),
    result: () => ({heights, observations})};
}
