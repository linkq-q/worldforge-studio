import { sampleTerrainHeight, type EditableMap } from '../src/shared/map';
import type { MapOperation } from '../src/shared/mapOperations';

export function checkGentleSkiSlope(map: EditableMap, operations: readonly MapOperation[]) {
  const heights = map.terrain.heights;
  const relief = Math.max(...heights) - Math.min(...heights);
  const routes = operations.flatMap(operation =>
    operation.type === 'terrain.surface' && operation.surface === 'snow' && operation.region.kind === 'path'
      ? [operation.region.points]
      : []);
  const slopes = routes.map(points => {
    const samples = points.flatMap(([x, z], index) => {
      if (index === 0) return [[x, z]];
      const [startX, startZ] = points[index - 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x - startX, z - startZ) / 8));
      return Array.from({ length: steps }, (_, step) => [
        startX + (x - startX) * (step + 1) / steps,
        startZ + (z - startZ) * (step + 1) / steps
      ]);
    });
    let length = 0;
    let maxGrade = 0;
    for (let index = 1; index < samples.length; index++) {
      const [x0, z0] = samples[index - 1];
      const [x1, z1] = samples[index];
      const distance = Math.hypot(x1 - x0, z1 - z0);
      if (distance === 0) continue;
      length += distance;
      maxGrade = Math.max(maxGrade,
        Math.abs(sampleTerrainHeight(map, x1, z1) - sampleTerrainHeight(map, x0, z0)) / distance);
    }
    const [firstX, firstZ] = samples[0] ?? [0, 0];
    const [lastX, lastZ] = samples.at(-1) ?? [0, 0];
    return { length, drop: Math.abs(sampleTerrainHeight(map, firstX, firstZ)
      - sampleTerrainHeight(map, lastX, lastZ)), maxGrade };
  });
  return {
    relief,
    slopes,
    valid: relief >= 18 && slopes.some(slope => slope.length >= 50
      && slope.drop >= 12 && slope.maxGrade <= 0.45)
  };
}
