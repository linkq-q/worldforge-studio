import { TERRAIN_MIN_HEIGHT } from './map';

interface ErosionField { terrain: {heights: number[]; resolutionX: number; resolutionZ: number}; box: {size: [number, number, number]} }

export function thermalErodeInPlace(
  map: ErosionField,
  iterations: number,
  talusDegrees: number,
  strength: number,
  floorHeight = TERRAIN_MIN_HEIGHT
): void {
  if (strength <= 0) return;
  const terrain = map.terrain;
  const width = terrain.resolutionX;
  const depth = terrain.resolutionZ;
  const stepX = map.box.size[0] / Math.max(1, width - 1);
  const stepZ = map.box.size[2] / Math.max(1, depth - 1);
  const neighbors = [
    [-1, 0, stepX], [1, 0, stepX], [0, -1, stepZ], [0, 1, stepZ],
    [-1, -1, Math.hypot(stepX, stepZ)], [1, -1, Math.hypot(stepX, stepZ)],
    [-1, 1, Math.hypot(stepX, stepZ)], [1, 1, Math.hypot(stepX, stepZ)]
  ] as const;
  const tangent = Math.tan(talusDegrees * Math.PI / 180);
  const maxHeight = map.box.size[1] - 0.05;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const delta = new Float64Array(terrain.heights.length);
    for (let z = 1; z < depth - 1; z += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = z * width + x;
        const height = terrain.heights[index] ?? 0;
        let target = -1;
        let excess = 0;
        for (const [dx, dz, distance] of neighbors) {
          const other = (z + dz) * width + x + dx;
          const candidate = height - (terrain.heights[other] ?? 0) - tangent * distance;
          if (candidate > excess) {
            excess = candidate;
            target = other;
          }
        }
        if (target < 0) continue;
        const transfer = excess * strength * 0.22;
        delta[index] -= transfer;
        delta[target] += transfer;
      }
    }
    for (let index = 0; index < terrain.heights.length; index += 1) {
      terrain.heights[index] = clamp(
        (terrain.heights[index] ?? 0) + delta[index],
        floorHeight,
        maxHeight
      );
    }
  }
}

export function carveDrainageInPlace(map: ErosionField, strength: number, floorHeight = TERRAIN_MIN_HEIGHT): void {
  const terrain = map.terrain;
  const width = terrain.resolutionX;
  const depth = terrain.resolutionZ;
  const cellCount = width * depth;
  const stepX = map.box.size[0] / Math.max(1, width - 1);
  const stepZ = map.box.size[2] / Math.max(1, depth - 1);
  const flowTo = new Int32Array(cellCount * 8).fill(-1);
  const flowFraction = new Float32Array(cellCount * 8);
  const flowDistance = new Float64Array(cellCount);
  const accumulation = new Float64Array(cellCount).fill(stepX * stepZ);
  const neighbors = [
    [-1, 0, stepX], [1, 0, stepX], [0, -1, stepZ], [0, 1, stepZ],
    [-1, -1, Math.hypot(stepX, stepZ)], [1, -1, Math.hypot(stepX, stepZ)],
    [-1, 1, Math.hypot(stepX, stepZ)], [1, 1, Math.hypot(stepX, stepZ)]
  ] as const;

  for (let z = 1; z < depth - 1; z += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = z * width + x;
      const height = terrain.heights[index] ?? 0;
      let total = 0;
      for (let direction = 0; direction < neighbors.length; direction += 1) {
        const [dx, dz, distance] = neighbors[direction];
        const other = (z + dz) * width + x + dx;
        const otherHeight = terrain.heights[other] ?? 0;
        const slope = (height - otherHeight) / distance;
        if (slope <= 0) continue;
        const slot = index * 8 + direction;
        flowTo[slot] = other;
        flowFraction[slot] = slope ** 4;
        total += flowFraction[slot];
      }
      if (total <= 0) continue;
      for (let direction = 0; direction < neighbors.length; direction += 1) {
        const slot = index * 8 + direction;
        if (flowTo[slot] < 0) continue;
        flowFraction[slot] /= total;
        flowDistance[index] += flowFraction[slot] * neighbors[direction][2];
      }
    }
  }

  const descending = Array.from({ length: cellCount }, (_, index) => index)
    .sort((left, right) => (terrain.heights[right] ?? 0) - (terrain.heights[left] ?? 0) || left - right);
  for (const index of descending) {
    for (let direction = 0; direction < neighbors.length; direction += 1) {
      const slot = index * 8 + direction;
      const target = flowTo[slot];
      if (target >= 0) accumulation[target] += accumulation[index] * flowFraction[slot];
    }
  }

  // Stream-power incision: drainage area increases erosion; flat sinks and
  // open boundaries remain outlets. This is not a sediment-transport solver.
  // Solve downstream first so an upstream sample cannot cut below its receiver.
  const spreadCuts = width >= 5 && depth >= 5;
  const before = Float64Array.from(terrain.heights);
  const cuts = new Float64Array(cellCount);
  const channelMask = new Float64Array(cellCount);
  const cellArea = stepX * stepZ;
  const rawChannelMask = accumulation.map((area) => smoothstep(2, 24, area / cellArea));
  for (let z = 1; z < depth - 1; z += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = z * width + x;
      channelMask[index] = (rawChannelMask[index] * 8
        + (rawChannelMask[index - 1] + rawChannelMask[index + 1]
          + rawChannelMask[index - width] + rawChannelMask[index + width]) * 2
        + rawChannelMask[index - width - 1] + rawChannelMask[index - width + 1]
        + rawChannelMask[index + width - 1] + rawChannelMask[index + width + 1]) / 20;
    }
  }
  let floor = Number.POSITIVE_INFINITY;
  for (const height of before) floor = Math.min(floor, height);
  for (let order = descending.length - 1; order >= 0; order -= 1) {
    const index = descending[order];
    const height = terrain.heights[index] ?? 0;
    if (flowDistance[index] <= 0 || height <= 0) continue;
    let receiver = 0;
    for (let direction = 0; direction < neighbors.length; direction += 1) {
      const slot = index * 8 + direction;
      const target = flowTo[slot];
      if (target >= 0) receiver += flowFraction[slot] * Math.max(0, terrain.heights[target] ?? 0);
    }
    const incision = strength * 0.35 * Math.sqrt(accumulation[index]) / flowDistance[index];
    const target = (height + incision * receiver) / (1 + incision);
    // Sparse headwaters need a shallow, broad cut; established channels can
    // retain the deeper folds that shape the mountain's middle and lower slopes.
    const maximumCut = spreadCuts
      ? Math.min(stepX, stepZ) * strength * (0.45 + 1.15 * channelMask[index])
      : Number.POSITIVE_INFINITY;
    cuts[index] = Math.min(maximumCut, Math.max(0, height - target));
    terrain.heights[index] = height - cuts[index];
  }
  if (!spreadCuts) return;

  // Widen deeper channels over several samples so their banks do not turn
  // into a one-cell comb. Only cuts are filtered; the original relief stays.
  const wideWeights = [1, 6, 15, 20, 15, 6, 1];
  for (let z = 1; z < depth - 1; z += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = z * width + x;
      if (before[index] <= 0) {
        terrain.heights[index] = before[index];
        continue;
      }
      const spread = (cuts[index] * 8
        + (cuts[index - 1] + cuts[index + 1] + cuts[index - width] + cuts[index + width]) * 2
        + cuts[index - width - 1] + cuts[index - width + 1]
        + cuts[index + width - 1] + cuts[index + width + 1]) / 20;
      let wide = spread;
      if (x >= 3 && x < width - 3 && z >= 3 && z < depth - 3) {
        wide = 0;
        for (let dz = -3; dz <= 3; dz += 1) {
          for (let dx = -3; dx <= 3; dx += 1) {
            wide += cuts[index + dz * width + dx] * wideWeights[dz + 3] * wideWeights[dx + 3];
          }
        }
        wide /= 4096;
      }
      const cut = lerp(spread, wide, channelMask[index]);
      terrain.heights[index] = Math.max(floorHeight, floor, before[index] - cut);
    }
  }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / ((edge1 - edge0) || Number.EPSILON), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
