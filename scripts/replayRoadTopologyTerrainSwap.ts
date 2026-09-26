import { readFileSync, writeFileSync } from 'node:fs';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { executeMapCodePlan } from '../src/server/mapCodePlanner';

const file = 'scripts/roadTopologyStudy.json';
const study = JSON.parse(readFileSync(file, 'utf8')) as {
  fixtures: Array<{ id: string; seed: number; amplitude: number; roughness: number; direction: number }>;
  runs: Array<{ fixture: string; repeat: number; arm: string; status: string; code?: string; counterfactual?: unknown }>
};
for (const run of study.runs) {
  if (run.status !== 'saved' || !run.code || run.counterfactual) continue;
  const original = study.fixtures.find(item => item.id === run.fixture)!;
  const other = study.fixtures.find(item => item.id !== run.fixture)!;
  const map = createEmptyMap(`terrain-swap-${run.fixture}`, `swap-${run.fixture}`, [96, 16, 96], 'voxel', 'outdoor');
  map.seed = original.seed;
  const swapped = applyMapOperations(map, [{
    type: 'terrain.generate', preset: 'valley', amplitude: other.amplitude,
    roughness: other.roughness, direction: other.direction, seed: original.seed
  }]);
  try {
    const suggestion = executeMapCodePlan(run.code, swapped, [], {
      scope: 'scene', promptMode: 'standard', legacyApis: false, spatialPolicy: 'diagnose', maxNewAssets: 16
    });
    const result = applyMapOperations(swapped, suggestion.operations);
    const roads = result.guides.map(guide => ({ id: guide.id, width: guide.width, points: guide.points }));
    let total = 0, aligned = 0;
    for (const road of roads) for (let index = 1; index < road.points.length; index++) {
      const dx = road.points[index][0] - road.points[index - 1][0];
      const dz = road.points[index][1] - road.points[index - 1][1];
      const length = Math.hypot(dx, dz);
      total += length;
      if (Math.min(Math.abs(dx), Math.abs(dz)) <= length * Math.sin(Math.PI / 18)) aligned += length;
    }
    run.counterfactual = {
      terrain: other.id, roads,
      objects: result.objects.map(object => ({ name: object.name, position: object.transform.position })),
      axisShare: total ? Math.round(aligned / total * 100) : 0,
      terrainHeights: swapped.terrain.heights
    };
    console.log(`SWAP ${run.fixture}/${run.repeat}/${run.arm} roads=${roads.length}`);
  } catch (error) {
    run.counterfactual = { terrain: other.id, error: error instanceof Error ? error.message : String(error) };
    console.error(`SWAP_FAILED ${run.fixture}/${run.repeat}/${run.arm} ${(run.counterfactual as { error: string }).error}`);
  }
  writeFileSync(file, JSON.stringify(study, null, 2) + '\n');
}
