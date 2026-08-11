import { sampleTerrainHeight, type EditableMap } from './map';

export function terrainSlopeDegrees(map: EditableMap, x: number, z: number): number {
  const stepX = map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1);
  const stepZ = map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1);
  const riseX = (
    sampleTerrainHeight(map, x + stepX, z)
    - sampleTerrainHeight(map, x - stepX, z)
  ) / (2 * stepX);
  const riseZ = (
    sampleTerrainHeight(map, x, z + stepZ)
    - sampleTerrainHeight(map, x, z - stepZ)
  ) / (2 * stepZ);
  return Math.atan(Math.hypot(riseX, riseZ)) * 180 / Math.PI;
}

export function terrainFootprintSlopeDegrees(
  map: EditableMap,
  x: number,
  z: number,
  footprintRadius: number
): number {
  const stepX = map.box.size[0] / Math.max(1, map.terrain.resolutionX - 1);
  const stepZ = map.box.size[2] / Math.max(1, map.terrain.resolutionZ - 1);
  const radius = Math.max(0.1, footprintRadius, Math.min(stepX, stepZ) * 0.75);
  const directions = [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]
  ] as const;
  const samples = directions.map(([dx, dz]) => ({
    x: x + dx * radius,
    z: z + dz * radius
  }));
  const heights = samples.map((sample) => sampleTerrainHeight(map, sample.x, sample.z));
  const localSlope = Math.max(...samples.map((sample) => terrainSlopeDegrees(map, sample.x, sample.z)));
  const reliefSlope = Math.atan((Math.max(...heights) - Math.min(...heights)) / (2 * radius)) * 180 / Math.PI;
  return Math.max(localSlope, reliefSlope);
}
