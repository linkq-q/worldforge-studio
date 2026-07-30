import {
  getMapBounds,
  getMapObjectAabbs,
  sampleTerrainHeight,
  type EditableMap,
  type MapAsset
} from './map';

export interface MapScatterPlan {
  assetIds: string[];
  region: {
    kind: 'circle';
    x: number;
    z: number;
    r: number;
  };
  density: number;
  avoidWater: number;
  maxSlope: number;
  minSpacing: number;
  scaleRange: [number, number];
  seed: number;
}

export interface MapScatterPlacement {
  id: string;
  assetId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  scale: number;
}

interface OccupiedCircle {
  x: number;
  z: number;
  radius: number;
}

export function expandMapScatter(
  map: EditableMap,
  plan: MapScatterPlan,
  assets: readonly MapAsset[],
  maxCount: number,
  idPrefix = 'scatter'
): MapScatterPlacement[] {
  if (maxCount <= 0 || plan.assetIds.length === 0) return [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const selectedAssets = plan.assetIds
    .map((assetId) => assetById.get(assetId))
    .filter((asset): asset is MapAsset => Boolean(asset));
  if (selectedAssets.length === 0) return [];

  const random = mulberry32(plan.seed);
  const bounds = getMapBounds(map);
  const density = clamp(plan.density, 0.0001, 1);
  const minSpacing = clamp(plan.minSpacing, 0.1, Math.max(map.box.size[0], map.box.size[2]));
  const cellSize = Math.max(minSpacing, Math.sqrt(1 / density));
  const regionRadius = clamp(plan.region.r, cellSize / 2, Math.min(map.box.size[0], map.box.size[2]) / 2);
  const minScale = clamp(Math.min(...plan.scaleRange), 0.1, 8);
  const maxScale = clamp(Math.max(...plan.scaleRange), minScale, 8);
  const occupied = existingOccupiedCircles(map);
  const accepted: MapScatterPlacement[] = [];
  const minGridX = Math.floor((plan.region.x - regionRadius) / cellSize);
  const maxGridX = Math.ceil((plan.region.x + regionRadius) / cellSize);
  const minGridZ = Math.floor((plan.region.z - regionRadius) / cellSize);
  const maxGridZ = Math.ceil((plan.region.z + regionRadius) / cellSize);
  let candidateIndex = 0;

  for (let gridZ = minGridZ; gridZ <= maxGridZ && accepted.length < maxCount; gridZ += 1) {
    for (let gridX = minGridX; gridX <= maxGridX && accepted.length < maxCount; gridX += 1) {
      const x = (gridX + 0.15 + random() * 0.7) * cellSize;
      const z = (gridZ + 0.15 + random() * 0.7) * cellSize;
      const asset = selectedAssets[Math.floor(random() * selectedAssets.length)];
      const scale = minScale + (maxScale - minScale) * random();
      const footprintRadius = assetFootprintRadius(asset) * scale;
      candidateIndex += 1;

      if (Math.hypot(x - plan.region.x, z - plan.region.z) > regionRadius) continue;
      if (x < bounds.minX + footprintRadius || x > bounds.maxX - footprintRadius) continue;
      if (z < bounds.minZ + footprintRadius || z > bounds.maxZ - footprintRadius) continue;
      if (isNearWater(map, x, z, Math.max(0, plan.avoidWater))) continue;
      if (terrainSlopeDegrees(map, x, z) > clamp(plan.maxSlope, 0, 89)) continue;
      if (occupied.some((item) =>
        Math.hypot(x - item.x, z - item.z) < Math.max(minSpacing, footprintRadius + item.radius)
      )) continue;

      accepted.push({
        id: `${idPrefix}-${candidateIndex}`,
        assetId: asset.id,
        name: asset.name,
        x,
        y: sampleTerrainHeight(map, x, z),
        z,
        rotationY: random() * Math.PI * 2,
        scale
      });
      occupied.push({ x, z, radius: footprintRadius });
    }
  }
  return accepted;
}

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

export function isNearWater(map: EditableMap, x: number, z: number, padding: number): boolean {
  return map.waterBodies.some((water) => {
    if (water.type === 'river') {
      const safeDistance = Math.max(0, water.width / 2 + padding);
      return water.points.slice(1).some((point, index) =>
        distanceToSegment(x, z, water.points[index], point) <= safeDistance
      );
    }
    if (pointInPolygon(x, z, water.points)) return true;
    return water.points.some((point, index) =>
      distanceToSegment(x, z, point, water.points[(index + 1) % water.points.length]) <= padding
    );
  });
}

function existingOccupiedCircles(map: EditableMap): OccupiedCircle[] {
  return getMapObjectAabbs(map).map((box) => ({
    x: (box.min[0] + box.max[0]) / 2,
    z: (box.min[2] + box.max[2]) / 2,
    radius: Math.hypot(box.max[0] - box.min[0], box.max[2] - box.min[2]) / 2
  }));
}

function assetFootprintRadius(asset: MapAsset): number {
  const boxes = asset.colliderPlan?.boxes ?? [];
  if (boxes.length === 0) return 0.5;
  return Math.max(0.1, ...boxes.map((box) => Math.max(
    Math.abs(box.min[0]),
    Math.abs(box.max[0]),
    Math.abs(box.min[2]),
    Math.abs(box.max[2])
  )));
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
  const t = clamp(((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared, 0, 1);
  return Math.hypot(x - (start[0] + t * dx), z - (start[1] + t * dz));
}

function mulberry32(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
