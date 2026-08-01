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
