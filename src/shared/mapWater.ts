import {
  TERRAIN_MIN_HEIGHT,
  terrainIndex,
  terrainPointAt,
  type EditableMap,
  type MapWaterBody
} from './map';

/** Bank run in metres per metre of depth. Lower means a steeper basin wall. */
const SHORE_SLOPE = 1.5;
/** Keeps the carved shoreline just under the water plane so the rim has no seam. */
const SHORE_RIM = 0.05;

/**
 * Sinks a lake basin into the height field so the water plane sits inside the
 * terrain instead of hovering over it. Idempotent: every grid point is clamped
 * down to a ceiling derived purely from the lake polygon, so re-running after a
 * level or width change never digs progressively deeper. Shrinking or deleting a
 * lake leaves the basin behind as ordinary terrain.
 */
export function carveWaterBasinInPlace(map: EditableMap, water: MapWaterBody): void {
  // ponytail: lakes only. Rivers need a per-segment height profile before a
  // trench makes sense — a flat trench under a sloped river is worse than none.
  if (water.type !== 'lake' || water.points.length < 3) return;

  const terrain = map.terrain;
  const [boxWidth, , boxDepth] = map.box.size;
  const top = water.level - SHORE_RIM;
  const bottom = Math.max(TERRAIN_MIN_HEIGHT, water.level - water.depth);
  const shore = Math.max(0.5, water.depth * SHORE_SLOPE);

  const xs = water.points.map((point) => point[0]);
  const zs = water.points.map((point) => point[1]);
  const minX = gridFloor(Math.min(...xs), boxWidth, terrain.resolutionX);
  const maxX = gridCeil(Math.max(...xs), boxWidth, terrain.resolutionX);
  const minZ = gridFloor(Math.min(...zs), boxDepth, terrain.resolutionZ);
  const maxZ = gridCeil(Math.max(...zs), boxDepth, terrain.resolutionZ);

  for (let zIndex = minZ; zIndex <= maxZ; zIndex += 1) {
    for (let xIndex = minX; xIndex <= maxX; xIndex += 1) {
      const world = terrainPointAt(map, xIndex, zIndex);
      if (!pointInPolygon(world[0], world[2], water.points)) continue;
      const t = Math.min(1, polygonEdgeDistance(world[0], world[2], water.points) / shore);
      const ceiling = top + (bottom - top) * (t * t * (3 - 2 * t));
      const index = terrainIndex(terrain, xIndex, zIndex);
      terrain.heights[index] = Math.min(terrain.heights[index] ?? 0, ceiling);
    }
  }
}

export function isNearWater(map: EditableMap, x: number, z: number, padding: number): boolean {
  return map.waterBodies.some((water) => {
    if (water.type === 'river') {
      const safeDistance = Math.max(0, water.width / 2 + padding);
      return water.points.slice(1).some((point, index) =>
        distanceToSegment(x, z, water.points[index], point) <= safeDistance
      );
    }
    if (pointInPolygon(x, z, water.points)) return true;
    return polygonEdgeDistance(x, z, water.points) <= padding;
  });
}

function polygonEdgeDistance(x: number, z: number, points: Array<[number, number]>): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    closest = Math.min(
      closest,
      distanceToSegment(x, z, points[index], points[(index + 1) % points.length])
    );
  }
  return closest;
}

function pointInPolygon(x: number, z: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [xi, zi] = points[index];
    const [xj, zj] = points[previous];
    if ((zi > z) !== (zj > z)
      && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(
  x: number,
  z: number,
  start: [number, number],
  end: [number, number]
): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= 0.000001) return Math.hypot(x - start[0], z - start[1]);
  const t = Math.min(1, Math.max(0, ((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared));
  return Math.hypot(x - (start[0] + t * dx), z - (start[1] + t * dz));
}

function gridFloor(world: number, extent: number, resolution: number): number {
  return Math.max(0, Math.floor(((world + extent / 2) / extent) * (resolution - 1)));
}

function gridCeil(world: number, extent: number, resolution: number): number {
  return Math.min(resolution - 1, Math.ceil(((world + extent / 2) / extent) * (resolution - 1)));
}
