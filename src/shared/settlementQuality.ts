import { getMapObjectVisualAabbs, type EditableMap, type MapObjectAabb } from './map';
import { mapGuidePolyline, sampleMapGuide, type MapGuide } from './mapGuide';
import type { VisualZoneRegion } from './visualDirection';

export type SettlementQualityIssueCode =
  | 'settlement.building-coverage-low'
  | 'settlement.frontage-low'
  | 'settlement.unassigned-open-space'
  | 'roadside.route-unbound';

export interface SettlementQualityIssue {
  code: SettlementQualityIssueCode;
  message: string;
  actual: number;
  expected: number;
  objectIds?: string[];
}

export interface SettlementQualityMetrics {
  hasSettlement: boolean;
  buildingCoverage: number | null;
  frontageCoverage: number | null;
  unassignedOpenSpace: number | null;
  unboundRoadsideCount: number;
  settlementGuideCount: number;
  buildingCount: number;
}

export interface SettlementQualityReport {
  metrics: SettlementQualityMetrics;
  issues: SettlementQualityIssue[];
}

const BUILDING_SEMANTIC = /\b(?:building|house|home|shop|store|hall|tower|inn|hut|barn|cottage|school|church|temple|warehouse|workshop)\b|建筑|房屋|民居|住宅|商店|店铺|大厅|会馆|塔楼|旅店|客栈|小屋|谷仓|学校|教堂|寺庙|仓库|工坊|厢房|园门/i;
const ROADSIDE_SEMANTIC = /\b(?:streetlight|lamp\s*post|lamp|lantern|bench|sign|signpost|bollard|barrier|guardrail)\b|路灯|灯柱|灯笼|长椅|座椅|路牌|标牌|护栏|路桩/i;
const GRID_SIZE = 28;

export function isSettlementBuildingSemantic(value: string): boolean {
  return BUILDING_SEMANTIC.test(value);
}

export function isRoadsideSemantic(value: string): boolean {
  return ROADSIDE_SEMANTIC.test(value);
}

/** Deterministic, render-independent quality signals for authored settlements. */
export function evaluateSettlementQuality(map: EditableMap): SettlementQualityReport {
  const settlementGuides = map.guides.filter((guide) => guide.tags.includes('settlement'));
  const objectBounds = aggregateBounds(getMapObjectVisualAabbs(map));
  const assets = new Map((map.assets ?? []).map((asset) => [asset.id, asset]));
  const semantic = (object: EditableMap['objects'][number]): string => {
    const asset = object.assetId ? assets.get(object.assetId) : undefined;
    return [object.name, asset?.name, asset?.prompt, ...(asset?.tags ?? [])].filter(Boolean).join(' ');
  };
  const buildingObjects = map.objects.filter((object) => isSettlementBuildingSemantic(semantic(object)) && objectBounds.has(object.id));
  const roadsideObjects = map.objects.filter((object) => isRoadsideSemantic(semantic(object)));
  const unboundRoadside = roadsideObjects.filter((object) => !isBoundToGuide(object, map.guides));

  if (settlementGuides.length === 0) {
    return {
      metrics: {
        hasSettlement: false,
        buildingCoverage: null,
        frontageCoverage: null,
        unassignedOpenSpace: null,
        unboundRoadsideCount: unboundRoadside.length,
        settlementGuideCount: 0,
        buildingCount: buildingObjects.length
      },
      issues: unboundRoadsideIssue(unboundRoadside)
    };
  }

  const hull = convexHull(settlementGuides.flatMap((guide) => mapGuidePolyline(guide)));
  const bounds = polygonBounds(hull);
  const cells: Array<{ x: number; z: number; row: number; column: number }> = [];
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const x = bounds.minX + (column + 0.5) * (bounds.maxX - bounds.minX) / GRID_SIZE;
      const z = bounds.minZ + (row + 0.5) * (bounds.maxZ - bounds.minZ) / GRID_SIZE;
      if (pointInPolygon(x, z, hull)) cells.push({ x, z, row, column });
    }
  }
  const buildingBounds = buildingObjects.flatMap((object) => {
    const value = objectBounds.get(object.id);
    return value ? [value] : [];
  });
  const covered = cells.filter((cell) => buildingBounds.some((box) => pointInBox(cell.x, cell.z, box, 0))).length;
  const buildingCoverage = ratio(covered, cells.length);
  const frontageSamples = settlementGuides.flatMap((guide) => sampleMapGuide(guide, { spacing: 2 }));
  const frontageCovered = frontageSamples.filter((sample) => buildingBounds.some((box) => (
    distanceToBox(sample.x, sample.z, box) <= 5
  ))).length;
  const frontageCoverage = ratio(frontageCovered, frontageSamples.length);

  const assigned = new Set(cells.filter((cell) => (
    buildingBounds.some((box) => pointInBox(cell.x, cell.z, box, 3))
    || settlementGuides.some((guide) => distanceToGuide(cell.x, cell.z, guide) <= guide.width / 2 + 0.5)
    || map.visualSemantics.zones.some((zone) => zone.tags.includes('clear') && pointInZone(cell.x, cell.z, zone.region, zone.center, zone.radius))
  )).map((cell) => `${cell.row}:${cell.column}`));
  const unassignedOpenSpace = (cells.length - assigned.size) / Math.max(1, cells.length);

  const issues: SettlementQualityIssue[] = [];
  if (buildingCoverage < 0.25) issues.push({
    code: 'settlement.building-coverage-low',
    message: `聚落建筑覆盖率仅 ${percent(buildingCoverage)}，目标至少为 25%。`,
    actual: buildingCoverage,
    expected: 0.25
  });
  if (frontageCoverage < 0.55) issues.push({
    code: 'settlement.frontage-low',
    message: `街道有效建筑界面仅覆盖 ${percent(frontageCoverage)}，目标至少为 55%。`,
    actual: frontageCoverage,
    expected: 0.55
  });
  if (unassignedOpenSpace > 0.10) issues.push({
    code: 'settlement.unassigned-open-space',
    message: `未分配用途的空地约占聚落 ${percent(unassignedOpenSpace)}，目标不超过 10%。`,
    actual: unassignedOpenSpace,
    expected: 0.10
  });
  issues.push(...unboundRoadsideIssue(unboundRoadside));
  return {
    metrics: {
      hasSettlement: true,
      buildingCoverage,
      frontageCoverage,
      unassignedOpenSpace,
      unboundRoadsideCount: unboundRoadside.length,
      settlementGuideCount: settlementGuides.length,
      buildingCount: buildingObjects.length
    },
    issues
  };
}

function unboundRoadsideIssue(objects: EditableMap['objects']): SettlementQualityIssue[] {
  return objects.length === 0 ? [] : [{
    code: 'roadside.route-unbound',
    message: `有 ${objects.length} 个路灯或沿路设施未绑定有效路线，或距离来源路线过远。`,
    actual: objects.length,
    expected: 0,
    objectIds: objects.map((object) => object.id)
  }];
}

function isBoundToGuide(object: EditableMap['objects'][number], guides: readonly MapGuide[]): boolean {
  if (!object.sourceGuideId) return false;
  const guide = guides.find((candidate) => candidate.id === object.sourceGuideId);
  if (!guide) return false;
  return distanceToGuide(object.transform.position[0], object.transform.position[2], guide)
    <= guide.width / 2 + 3;
}

function aggregateBounds(boxes: readonly MapObjectAabb[]): Map<string, MapObjectAabb> {
  const result = new Map<string, MapObjectAabb>();
  for (const box of boxes) {
    const current = result.get(box.objectId);
    if (!current) {
      result.set(box.objectId, { objectId: box.objectId, min: [...box.min], max: [...box.max] });
      continue;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      current.min[axis] = Math.min(current.min[axis], box.min[axis]);
      current.max[axis] = Math.max(current.max[axis], box.max[axis]);
    }
  }
  return result;
}

function distanceToGuide(x: number, z: number, guide: MapGuide): number {
  const points = mapGuidePolyline(guide);
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    closest = Math.min(closest, distanceToSegment(x, z, points[index - 1], points[index]));
  }
  return closest;
}

function distanceToSegment(x: number, z: number, start: [number, number], end: [number, number]): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared)) : 0;
  return Math.hypot(x - (start[0] + dx * t), z - (start[1] + dz * t));
}

function pointInZone(
  x: number,
  z: number,
  region: VisualZoneRegion | undefined,
  center: [number, number],
  radius: number
): boolean {
  if (!region) return Math.hypot(x - center[0], z - center[1]) <= radius;
  if (region.kind === 'circle') return Math.hypot(x - region.x, z - region.z) <= region.radius;
  if (region.kind === 'polygon') return pointInPolygon(x, z, region.points);
  return region.points.slice(1).some((point, index) => distanceToSegment(x, z, region.points[index], point) <= region.width / 2);
}

function pointInBox(x: number, z: number, box: MapObjectAabb, padding: number): boolean {
  return x >= box.min[0] - padding && x <= box.max[0] + padding
    && z >= box.min[2] - padding && z <= box.max[2] + padding;
}

function distanceToBox(x: number, z: number, box: MapObjectAabb): number {
  return Math.hypot(
    Math.max(box.min[0] - x, 0, x - box.max[0]),
    Math.max(box.min[2] - z, 0, z - box.max[2])
  );
}

function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...new Map(points.map((point) => [`${point[0]}:${point[1]}`, point])).values()]
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (sorted.length <= 2) return sorted;
  const cross = (origin: [number, number], a: [number, number], b: [number, number]) => (
    (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
  );
  const half = (source: Array<[number, number]>) => {
    const result: Array<[number, number]> = [];
    for (const point of source) {
      while (result.length >= 2 && cross(result[result.length - 2], result[result.length - 1], point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function polygonBounds(points: Array<[number, number]>): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return {
    minX: Math.min(...points.map((point) => point[0])),
    maxX: Math.max(...points.map((point) => point[0])),
    minZ: Math.min(...points.map((point) => point[1])),
    maxZ: Math.max(...points.map((point) => point[1]))
  };
}

function pointInPolygon(x: number, z: number, points: Array<[number, number]>): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const current = points[index];
    const prior = points[previous];
    if ((current[1] > z) !== (prior[1] > z)
      && x < (prior[0] - current[0]) * (z - current[1]) / (prior[1] - current[1]) + current[0]) inside = !inside;
  }
  return inside;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
