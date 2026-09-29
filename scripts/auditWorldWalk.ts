import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPlannedWorldSampler, validateWorldBundle, type TownBuilding, type WorldBundle } from '../src/shared/worldPlanning';

type Point = [number, number];
interface WorldRoute { id: string; width: number; points: Point[] }
interface Violation { kind: string; id: string; x?: number; z?: number; value?: number }

const source = resolve(process.argv[2] ?? 'scripts/fixtures/oasis-world.json');
const output = process.argv[3] ? resolve(process.argv[3]) : undefined;
const bundle = validateWorldBundle(JSON.parse(await readFile(source, 'utf8')) as WorldBundle);
const sample = createPlannedWorldSampler(bundle.plan, bundle.patches);
const routes: WorldRoute[] = bundle.plan.roads.map(road => ({ id: road.id, width: road.width, points: road.points }));
for (const patch of bundle.patches) {
  const town = bundle.plan.towns.find(candidate => candidate.id === patch.townId)!;
  routes.push(...patch.streets.map(street => ({
    id: patch.townId + '/' + street.id, width: street.width,
    points: street.points.map(point => [point[0] + town.center[0], point[1] + town.center[1]])
  })));
}

const roadViolations: Violation[] = [];
let roadSamples = 0, wetRoadSamples = 0, maxLongitudinalSlope = 0, maxCrossSlope = 0;
for (const route of routes) for (let segment = 1; segment < route.points.length; segment++) {
  const a = route.points[segment - 1], b = route.points[segment];
  const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
  const nx = -dz / length, nz = dx / length, steps = Math.max(1, Math.ceil(length));
  let previousHeight: number | undefined;
  for (let step = 0; step <= steps; step++) {
    const t = step / steps, x = a[0] + dx * t, z = a[1] + dz * t, spacing = length / steps;
    const cross = [-route.width / 2, 0, route.width / 2].map(offset => sample(x + nx * offset, z + nz * offset));
    roadSamples++;
    if (cross.some(point => point.waterLevel !== null)) {
      wetRoadSamples++;
      if (roadViolations.length < 32) roadViolations.push({ kind: 'water', id: route.id, x, z });
    }
    const heights = cross.map(point => point.height), crossSlope = (Math.max(...heights) - Math.min(...heights)) / route.width;
    maxCrossSlope = Math.max(maxCrossSlope, crossSlope);
    if (crossSlope > 0.5 && roadViolations.length < 32) roadViolations.push({ kind: 'cross-slope', id: route.id, x, z, value: crossSlope });
    if (previousHeight !== undefined) {
      const slope = Math.abs(heights[1] - previousHeight) / spacing;
      maxLongitudinalSlope = Math.max(maxLongitudinalSlope, slope);
      if (slope > 0.5 && roadViolations.length < 32) roadViolations.push({ kind: 'longitudinal-slope', id: route.id, x, z, value: slope });
    }
    previousHeight = heights[1];
  }
}

const parent = new Map<string, string>();
const pointKey = (point: Point) => Math.round(point[0] * 1e6) + ',' + Math.round(point[1] * 1e6);
const find = (key: string): string => {
  const current = parent.get(key);
  if (!current) { parent.set(key, key); return key; }
  if (current === key) return key;
  const root = find(current); parent.set(key, root); return root;
};
for (const route of routes) for (let i = 1; i < route.points.length; i++) {
  const a = find(pointKey(route.points[i - 1])), b = find(pointKey(route.points[i]));
  if (a !== b) parent.set(b, a);
}
const roadComponents = new Set([...parent.keys()].map(find)).size;

const buildingViolations: Violation[] = [];
let buildingCount = 0, wetBuildings = 0, maxFootprintRelief = 0, maxRadius3Relief = 0;
function rotatedPoint(building: TownBuilding, center: Point, localX: number, localZ: number): Point {
  const angle = building.rotation ?? 0, c = Math.cos(angle), s = Math.sin(angle);
  return [center[0] + localX * c - localZ * s, center[1] + localX * s + localZ * c];
}
for (const patch of bundle.patches) {
  const town = bundle.plan.towns.find(candidate => candidate.id === patch.townId)!;
  for (const building of patch.buildings) {
    buildingCount++;
    const center: Point = [town.center[0] + building.x, town.center[1] + building.z];
    const footprint: Point[] = [];
    for (const x of [-building.width / 2, 0, building.width / 2]) for (const z of [-building.depth / 2, 0, building.depth / 2]) {
      footprint.push(rotatedPoint(building, center, x, z));
    }
    const radius3: Point[] = [center, ...Array.from({ length: 8 }, (_, index): Point => {
      const angle = index * Math.PI / 4;
      return [center[0] + Math.cos(angle) * 3, center[1] + Math.sin(angle) * 3];
    })];
    const footprintSamples = footprint.map(point => sample(point[0], point[1]));
    const radiusSamples = radius3.map(point => sample(point[0], point[1]));
    const footprintRelief = Math.max(...footprintSamples.map(point => point.height)) - Math.min(...footprintSamples.map(point => point.height));
    const radiusRelief = Math.max(...radiusSamples.map(point => point.height)) - Math.min(...radiusSamples.map(point => point.height));
    maxFootprintRelief = Math.max(maxFootprintRelief, footprintRelief);
    maxRadius3Relief = Math.max(maxRadius3Relief, radiusRelief);
    if ([...footprintSamples, ...radiusSamples].some(point => point.waterLevel !== null)) {
      wetBuildings++;
      if (buildingViolations.length < 32) buildingViolations.push({ kind: 'water', id: patch.townId + '/' + building.id, x: center[0], z: center[1] });
    }
    if (footprintRelief > 0.05 && buildingViolations.length < 32) {
      buildingViolations.push({ kind: 'footprint-relief', id: patch.townId + '/' + building.id, x: center[0], z: center[1], value: footprintRelief });
    }
    if (radiusRelief > 1.5 && buildingViolations.length < 32) {
      buildingViolations.push({ kind: 'radius-3-relief', id: patch.townId + '/' + building.id, x: center[0], z: center[1], value: radiusRelief });
    }
  }
}

let checksum = 0;
for (let i = 0; i < 1000; i++) checksum += sample((i * 73 % bundle.plan.recipe.size) - bundle.plan.recipe.size / 2,
  (i * 151 % bundle.plan.recipe.size) - bundle.plan.recipe.size / 2).height;
const benchmarkSamples = 100000, started = performance.now();
for (let i = 0; i < benchmarkSamples; i++) checksum += sample((i * 73 % bundle.plan.recipe.size) - bundle.plan.recipe.size / 2,
  (i * 151 % bundle.plan.recipe.size) - bundle.plan.recipe.size / 2).height;
const elapsedMs = performance.now() - started;

const report = {
  fixture: source,
  ok: roadComponents === 1 && wetRoadSamples === 0 && maxLongitudinalSlope <= 0.5 && maxCrossSlope <= 0.5
    && wetBuildings === 0 && maxFootprintRelief <= 0.05 && maxRadius3Relief <= 1.5,
  thresholds: { roadSampleSpacing: 1, maxLongitudinalSlope: 0.5, maxCrossSlope: 0.5, maxFootprintRelief: 0.05, maxRadius3Relief: 1.5 },
  features: { towns: bundle.plan.towns.length, worldRoads: bundle.plan.roads.length,
    townStreets: bundle.patches.reduce((sum, patch) => sum + patch.streets.length, 0), buildings: buildingCount },
  roads: { routeCount: routes.length, sampleCount: roadSamples, connectedComponents: roadComponents,
    wetSampleCount: wetRoadSamples, maxLongitudinalSlope, maxCrossSlope, violations: roadViolations },
  buildings: { count: buildingCount, wetBuildingCount: wetBuildings, maxFootprintRelief, maxRadius3Relief, violations: buildingViolations },
  samplerCpu: { samples: benchmarkSamples, elapsedMs, microsecondsPerSample: elapsedMs * 1000 / benchmarkSamples, checksum }
};
const json = JSON.stringify(report, null, 2) + '\n';
if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, json); }
process.stdout.write(json);
if (!report.ok) process.exitCode = 1;
