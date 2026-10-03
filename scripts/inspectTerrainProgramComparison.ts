import {readFile,writeFile} from 'node:fs/promises';
import {createWorldSampler, createWorldTerrainEvidence} from '../src/shared/worldTerrain';
import {observeWorldAbsoluteTerrainBrushes} from '../src/server/worldWhiteboxGeneration';
const root = 'output/playwright/terrain-program-20261003/';
const result: Record<string,unknown> = {};
for (const name of ['recipe','program']) {
  const {plan} = JSON.parse(await readFile(root+name+'-bundle.json','utf8'));
  const sample = createWorldSampler(plan.recipe);
  const evidence = createWorldTerrainEvidence(plan.recipe);
  result[name] = {heightRangeMetres:evidence.heightRange.map(h=>h*evidence.heightUnit),
    brushObservations:observeWorldAbsoluteTerrainBrushes(plan.recipe),
    programObservations:plan.recipe.terrainProgram?.observations,
    mainValley: name === 'recipe' ? [[-210,-219],[-171,-177],[-141,-132],[-111,-92],[-65,-55],[-23,-7],[27,37],[76,84],[120,139],[172,191],[226,246]]
      .map(([x,z])=>({x,z,height:sample(x,z).height,side20:sample(x+14.142,z-14.142).height,sideMinus20:sample(x-14.142,z+14.142).height})) : undefined};
}
await writeFile(root+'analysis.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
