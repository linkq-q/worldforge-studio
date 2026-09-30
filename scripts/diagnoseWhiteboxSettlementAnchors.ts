import { readFile } from 'node:fs/promises';
import { createWorldSampler } from '../src/shared/worldTerrain';
import { generateWorldSettlement } from '../src/shared/worldSettlement';
import type { WorldPlan } from '../src/shared/worldPlanning';
import { materializeWorldWhiteboxConstruction } from '../src/server/worldWhiteboxGeneration';

const [sourcePath] = process.argv.slice(2);
if (!sourcePath) throw new Error('usage: tsx scripts/diagnoseWhiteboxSettlementAnchors.ts <saved-map.json>');

const saved = JSON.parse(await readFile(sourcePath, 'utf8')) as { world?: { bundle?: { plan?: WorldPlan } } };
const whiteboxPlan = saved.world?.bundle?.plan;
if (!whiteboxPlan?.whitebox || !whiteboxPlan.settlementPlan || !whiteboxPlan.featureGraph) {
  throw new Error('saved whitebox map required');
}

const construction = whiteboxPlan.settlementPlan.settlements.map(settlement => {
  const role = settlement.role.toLowerCase();
  const city = /civic|market|district|quay|dock|harbor|moderate density/.test(role);
  const density = /sparse|scattered/.test(role) ? 0.22
    : /small|loose/.test(role) ? 0.32
      : /compact|working frontage/.test(role) ? 0.78
        : /moderate density/.test(role) ? 0.65 : 0.5;
  return { id: settlement.id, name: settlement.id, kind: city ? 'city' : 'village', pattern: 'organic', density,
    ...(/quay|dock|waterfront|harbor/.test(role) ? { waterfrontBias: 0.95 } : {}), publicBuildings: [] };
});
const materialized = materializeWorldWhiteboxConstruction(JSON.stringify({ towns: construction, ecology: [], assets: [] }), {
  mode: 'construct-whitebox', whiteboxPlan, generateAssets: false, assetGenerationLimit: 0, repairAttempts: 0
});
const sample = createWorldSampler(materialized.plan.recipe);
const anchors = new Map(whiteboxPlan.featureGraph.anchors.map(anchor => [anchor.id, anchor]));
const diagnostics = new Map(materialized.diagnostics.map(item => [item.townId, [...item.planningIssues]]));
const results = materialized.settlements.map(settlement => {
  const intent = whiteboxPlan.settlementPlan!.settlements.find(item => item.id === settlement.townId)!;
  const anchor = anchors.get(intent.anchorId)!;
  const surface = sample(anchor.position[0], anchor.position[1]);
  try {
    const patch = generateWorldSettlement(materialized.plan, settlement.townId, sample, settlement.options);
    return { townId: settlement.townId, anchor: anchor.position, height: surface.height, waterLevel: surface.waterLevel,
      anchorOnWater: surface.waterLevel !== null && surface.waterLevel > surface.height + 0.05,
      options: settlement.options, streets: patch.streets.length, buildings: patch.buildings.length };
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    diagnostics.set(settlement.townId, [...diagnostics.get(settlement.townId) ?? [], `construction_unrealized:${code}`]);
    return { townId: settlement.townId, anchor: anchor.position, height: surface.height, waterLevel: surface.waterLevel,
      anchorOnWater: surface.waterLevel !== null && surface.waterLevel > surface.height + 0.05,
      options: settlement.options, streets: 0, buildings: 0, error: code };
  }
});

process.stdout.write(JSON.stringify({ sourcePath, paidCalls: 0,
  assumptions: 'Role-derived city/village density probe with no public buildings or assets.',
  totals: { streets: results.reduce((sum, item) => sum + item.streets, 0),
    buildings: results.reduce((sum, item) => sum + item.buildings, 0) },
  settlements: results,
  diagnostics: [...diagnostics].map(([townId, planningIssues]) => ({ townId, planningIssues }))
}, null, 2));
