import { access, readFile, writeFile } from 'node:fs/promises';
import { createWorldSampler } from '../src/shared/worldTerrain';
import { generateWorldSettlement, type WorldSettlementOptions } from '../src/shared/worldSettlement';
import type { TownPatch, WorldPlan } from '../src/shared/worldPlanning';

type SavedConstruction = {
  mode: 'construct-whitebox';
  bundle: { plan: WorldPlan; patches: TownPatch[] };
  draft: { settlements: Array<{ townId: string; options: WorldSettlementOptions }> };
  diagnostics: Array<{ townId: string; planningIssues: string[] }>;
  assetSources: unknown[];
};

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath || sourcePath === outputPath) {
  throw new Error('usage: tsx scripts/rebuildWhiteboxConstructionPreview.ts <saved-response.json> <new-preview.json>');
}
try { await access(outputPath); throw new Error(`refusing to overwrite ${outputPath}`); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

const source = JSON.parse(await readFile(sourcePath, 'utf8')) as SavedConstruction;
if (source.mode !== 'construct-whitebox' || !source.bundle?.plan || !Array.isArray(source.draft?.settlements)
  || !Array.isArray(source.diagnostics) || !Array.isArray(source.assetSources)) {
  throw new Error('saved construct-whitebox response required');
}

const diagnostics = new Map(source.diagnostics.map(item => [item.townId, item.planningIssues.filter(issue =>
  !issue.startsWith('construction_unrealized:') && !issue.startsWith('base_construction_unrealized:'))]));
const issue = (townId: string, value: string) => diagnostics.set(townId, [...diagnostics.get(townId) ?? [], value]);
const sample = createWorldSampler(source.bundle.plan.recipe), patches: TownPatch[] = [];
for (const settlement of source.draft.settlements) {
  try { patches.push(generateWorldSettlement(source.bundle.plan, settlement.townId, sample, settlement.options)); }
  catch (error) {
    issue(settlement.townId, `algorithm_preview_unrealized:${error instanceof Error ? error.message : String(error)}`);
  }
}

const result = {
  ...source,
  bundle: { ...source.bundle, patches },
  diagnostics: [...diagnostics].map(([townId, planningIssues]) => ({ townId, planningIssues })),
  algorithmPreview: {
    source: sourcePath,
    paidCalls: 0,
    note: 'Replayed saved base settlement options only; transient public-building requirements are not stored in the response.'
  }
};
await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf8');
process.stdout.write(JSON.stringify({ outputPath, paidCalls: 0, patches: patches.map(patch => ({
  townId: patch.townId, streets: patch.streets.length, buildings: patch.buildings.length
})), diagnostics: result.diagnostics }, null, 2));
