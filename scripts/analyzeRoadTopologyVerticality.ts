import { readFileSync, writeFileSync } from 'node:fs';
import { createEmptyMap, sampleTerrainHeight, type EditableMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import { MapStore } from '../src/server/mapStore';

const file = 'scripts/roadTopologyStudy.json';
const study = JSON.parse(readFileSync(file, 'utf8')) as {
  fixtures: Array<{ id: string; seed: number; amplitude?: number; roughness?: number; direction?: number; sourceMapId?: string }>;
  runs: Array<{ fixture: string; repeat: number; arm: string; status: string; code?: string; verticality?: unknown }>;
};
const store = new MapStore();
const sourceTerrain = (await store.loadMap('map-6ab5b068-3dc3-45fb')).terrain;
const mapFor = (id: string) => {
  const fixture = study.fixtures.find(item => item.id === id)!;
  const map = createEmptyMap(fixture.id, `fixture-${fixture.id}`, [96, 16, 96], 'voxel', 'outdoor');
  map.seed = fixture.seed;
  return fixture.sourceMapId
    ? applyMapOperations(map, [{ type: 'terrain.set', terrain: sourceTerrain }])
    : applyMapOperations(map, [{ type: 'terrain.generate', preset: 'valley', amplitude: fixture.amplitude,
      roughness: fixture.roughness, direction: fixture.direction, seed: fixture.seed }]);
};
const round = (value: number) => Math.round(value * 100) / 100;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2);
};
const structure = (name: string) => !/地基|基座|台阶|挡墙|平台|步道/i.test(name)
  && /住宅|石屋|民居|木屋|茅屋|会堂|礼堂|旅舍|驿舍|教堂|工坊|客栈|仓库|会馆|礼拜堂|议事堂|钟堂|house|hall|chapel|inn/i.test(name);
const pointSegmentDistance = (x: number, z: number, a: number[], b: number[]) => {
  const dx = b[0] - a[0], dz = b[1] - a[1], squared = dx * dx + dz * dz;
  const t = squared ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / squared)) : 0;
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
};
const nearestRoad = (x: number, z: number, map: EditableMap) => {
  let best = Infinity;
  for (const guide of map.guides) for (let i = 1; i < guide.points.length; i++)
    best = Math.min(best, pointSegmentDistance(x, z, guide.points[i - 1], guide.points[i]));
  return best;
};
for (const run of study.runs) {
  if (run.status !== 'saved' || !run.code) continue;
  try {
    const base = mapFor(run.fixture);
    const runPrompt = run.fixture === 'ski-relief'
      ? '在现有雪山起伏地形上生成可步行游览的石屋村庄。让住宅、公共场所和通路因可建坡度、不同标高和地形遮挡形成自然的组团；在合适的地面安排房屋，并用必要的地基、坡道或台阶处理建筑入口与道路的高差。不要为了密集或弯曲而牺牲实际可走性。'
      : '生成一座山谷里的密集石屋村庄。需要住宅、公共建筑、公共聚集处、多条相连街巷和周边自然环境。村庄应有丰富的空间层次，建筑和道路适应起伏地形，人能够沿地面连续步行游览。';
    const suggestion = await generateMapCodeSuggestion(runPrompt, base, [], {
      provider: 'gpt', scope: 'scene', promptMode: 'standard', revisionMode: 'first-pass',
      spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 16,
      reuseExistingAssets: false, discoveryOnly: true, approvedCode: run.code
    });
    const result = applyMapOperations(base, suggestion.operations);
    const requirements = new Map((suggestion.codePlan?.assetRequirements ?? []).map(item => [item.key, item]));
    const requirementFor = (assetId: string | null) => assetId?.startsWith('code-asset://')
      ? requirements.get(assetId.slice('code-asset://'.length).split('/')[0]) : undefined;
    const buildings = result.objects.filter(object => structure(object.name) || structure(requirementFor(object.assetId)?.name ?? ''));
    const details = buildings.map(object => {
      const [x, y, z] = object.transform.position;
      const requirement = requirementFor(object.assetId);
      const unitSize = object.transform.size.every(value => Math.abs(value - 1) < 0.001);
      const [sx, , sz] = unitSize && requirement?.dimensions ? requirement.dimensions : object.transform.size;
      const [kx, , kz] = object.transform.scale;
      const width = Math.abs(sx * kx), depth = Math.abs(sz * kz);
      const yaw = object.transform.rotation[1];
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const corners = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([ix, iz]) => {
        const px = ix * width / 2, pz = iz * depth / 2;
        return [x + px * c - pz * s, z + px * s + pz * c];
      });
      const originalHeights = corners.map(([cx, cz]) => sampleTerrainHeight(base, cx, cz));
      const finalHeights = corners.map(([cx, cz]) => sampleTerrainHeight(result, cx, cz));
      return {
        name: object.name === '程序化物体' ? requirement?.name ?? object.name : object.name,
        x: round(x), y: round(y), z: round(z), size: [round(width), round(depth)],
        centerGround: round(sampleTerrainHeight(result, x, z)),
        originalFootprintRelief: round(Math.max(...originalHeights) - Math.min(...originalHeights)),
        finalFootprintRelief: round(Math.max(...finalHeights) - Math.min(...finalHeights)),
        highestGroundAboveOrigin: round(Math.max(...finalHeights) - y),
        nearestRoad: round(nearestRoad(x, z, result)),
        foundation: Boolean(object.foundation)
      };
    });
    const heights = details.map(item => item.centerGround);
    run.verticality = {
      buildings: details.length, centerElevationRange: heights.length ? round(Math.max(...heights) - Math.min(...heights)) : null,
      elevationBands2m: new Set(heights.map(height => Math.floor(height / 2))).size,
      medianOriginalFootprintRelief: median(details.map(item => item.originalFootprintRelief)),
      medianFinalFootprintRelief: median(details.map(item => item.finalFootprintRelief)),
      footprintReliefAbove1m: details.filter(item => item.finalFootprintRelief > 1).length,
      highestGroundAboveOriginAbove05m: details.filter(item => item.highestGroundAboveOrigin > 0.5).length,
      medianDistanceToRoad: median(details.map(item => item.nearestRoad)),
      moreThan8mFromRoad: details.filter(item => item.nearestRoad > 8).length,
      foundations: details.filter(item => item.foundation).length,
      details
    };
    console.log(`${run.fixture}/${run.repeat}/${run.arm} buildings=${details.length} elevation=${(run.verticality as {centerElevationRange:number}).centerElevationRange}m`);
  } catch (error) {
    run.verticality = { error: error instanceof Error ? error.message : String(error) };
    console.error(`${run.fixture}/${run.repeat}/${run.arm} VERTICALITY_FAILED`);
  }
  writeFileSync(file, JSON.stringify(study, null, 2) + '\n');
}
