import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createEmptyMap } from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import { buildMapCodePlannerSystemPrompt, generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import { MapStore } from '../src/server/mapStore';

const output = 'scripts/roadTopologyStudy.json';
const prompt = '生成一座山谷里的密集石屋村庄。需要住宅、公共建筑、公共聚集处、多条相连街巷和周边自然环境。村庄应有丰富的空间层次，建筑和道路适应起伏地形，人能够沿地面连续步行游览。';
const skiPrompt = '在现有雪山起伏地形上生成可步行游览的石屋村庄。让住宅、公共场所和通路因可建坡度、不同标高和地形遮挡形成自然的组团；在合适的地面安排房屋，并用必要的地基、坡道或台阶处理建筑入口与道路的高差。不要为了密集或弯曲而牺牲实际可走性。';
const fixtures = [
  { id: 'broad-valley', seed: 2077257521, amplitude: 7, roughness: 0.28, direction: 0 },
  { id: 'diagonal-valley', seed: 2077257522, amplitude: 11, roughness: 0.44, direction: 57 },
  { id: 'ski-relief', seed: 2876401359, sourceMapId: 'map-6ab5b068-3dc3-45fb' }
] as const;
const weak = 'When terrain or water affects a settlement, declare it before reading candidate sites with api.environmentSample. Compare a bounded set of plausible road and building arrangements against actual slope, water and usable space; let the request and those observations determine whether the result is regular or organic. Continuous fields may bias natural cover, while buildings still need access and footprint checks. Where repeated plots or structures benefit from a shared rule, make that rule conditional on frontage, terrain and neighbors rather than subdividing the whole map by default. Re-sample after local terrain changes that affect later decisions.';
const current = weak.replace('declare it before reading candidate sites', 'read the supplied terrain before comparing candidate sites');
const topology = 'Read the supplied terrain with api.environmentSample before planning roads. Before emitting routes, construct at least two bounded candidate road networks that differ in which entrances, public places and building clusters connect; translating, rotating, jittering or slightly bending one network does not make another candidate. Compare those networks using sampled slope, viable building footprints, likely grading and walking access. Choose the network that fits this terrain and the requested settlement, then derive buildings and local grading from that choice. A straight, regular plan is valid when its site and use justify it; curvature is not a goal. Continuous fields may bias natural cover, while buildings still need access and footprint checks.';
const qualitative = 'Read the supplied terrain with api.environmentSample before planning roads. Before emitting routes, construct at least two bounded candidate road networks that differ in which entrances, public places and building clusters connect; translating, rotating, jittering or slightly bending one network does not make another candidate. Use actual slope, viable building footprints, likely grading and walking access to rule out unsuitable networks, then choose from the remaining forms by the settlement\'s purpose and spatial rhythm. Do not make a weighted scalar score, maximize parcel count or reward road density. A straight, regular plan is valid when its site and use justify it; curvature is not a goal. Continuous fields may bias natural cover, while buildings still need access and footprint checks.';
const fixedTerrain = '\n## Fixed terrain experiment\nThe input map already has a persisted base terrain. Keep it: do not call api.terrain or api.modifyTerrain. Sample this existing heightfield before choosing routes. Local sculptTerrain and rampTerrain may follow the chosen arrangement. This rule is the same in every experimental arm.\n';
type Road = { id: string; width: number; points: number[][] };
type Run = { fixture: string; repeat: number; arm: 'current' | 'topology' | 'qualitative'; status: 'queued' | 'saved' | 'failed'; code?: string; error?: string; failedAttempts?: string[]; retryPromptClarified?: boolean; functions?: string[]; diagnostics?: unknown[]; roads?: Road[]; objects?: Array<{ name: string; position: number[] }>; axisShare?: number; terrainRelief?: number; terrainHeights?: number[] };
const runOrder = fixtures.flatMap(fixture => [1, 2].flatMap(repeat => (['current', 'topology', 'qualitative'] as const).map(arm => ({ fixture: fixture.id, repeat, arm, status: 'queued' as const }))));
const ledger: { prompt: string; fixtures: typeof fixtures; runs: Run[] } = existsSync(output)
  ? JSON.parse(readFileSync(output, 'utf8'))
  : { prompt, fixtures, runs: runOrder };
ledger.fixtures = fixtures;
for (const candidate of runOrder) {
  if (!ledger.runs.some(run => run.fixture === candidate.fixture && run.repeat === candidate.repeat && run.arm === candidate.arm)) {
    ledger.runs.push(candidate);
  }
}
for (const run of ledger.runs) {
  if (run.status === 'failed' && run.error) {
    if (run.failedAttempts?.at(-1) !== run.error) run.failedAttempts = [...(run.failedAttempts ?? []), run.error];
    if (run.failedAttempts.length < 2) {
      run.status = 'queued';
      delete run.error;
    }
  }
}
const save = () => writeFileSync(output, JSON.stringify(ledger, null, 2) + '\n');
const skiTerrain = (await new MapStore().loadMap('map-6ab5b068-3dc3-45fb')).terrain;
const mapFor = (id: string) => {
  const fixture = fixtures.find(item => item.id === id);
  if (!fixture) throw new Error(`unknown_fixture:${id}`);
  const map = createEmptyMap(fixture.id, `fixture-${fixture.id}`, [96, 16, 96], 'voxel', 'outdoor');
  map.seed = fixture.seed;
  if ('sourceMapId' in fixture) return applyMapOperations(map, [{ type: 'terrain.set', terrain: skiTerrain }]);
  return applyMapOperations(map, [{
    type: 'terrain.generate', preset: 'valley', amplitude: fixture.amplitude,
    roughness: fixture.roughness, direction: fixture.direction, seed: fixture.seed
  }]);
};
const axisShare = (roads: Road[]) => {
  let total = 0, aligned = 0;
  for (const road of roads) for (let index = 1; index < road.points.length; index++) {
    const dx = road.points[index][0] - road.points[index - 1][0];
    const dz = road.points[index][1] - road.points[index - 1][1];
    const length = Math.hypot(dx, dz);
    total += length;
    if (Math.min(Math.abs(dx), Math.abs(dz)) <= length * Math.sin(Math.PI / 18)) aligned += length;
  }
  return total ? Math.round(aligned / total * 100) : 0;
};
let processed = 0;
const limit = Number(process.argv[2] ?? 8);
for (const run of ledger.runs) {
  if (run.status !== 'queued' || processed >= limit) continue;
  processed++;
  const label = `${run.fixture}/${run.repeat}/${run.arm}`;
  const map = mapFor(run.fixture);
  const runPrompt = run.fixture === 'ski-relief' ? skiPrompt : prompt;
  const basePrompt = buildMapCodePlannerSystemPrompt(map, [], 0, 16, 'scene', 'generate', runPrompt, [], 'standard');
  if (!basePrompt.includes(weak)) throw new Error('terrain_prompt_drifted');
  run.retryPromptClarified = run.fixture === 'ski-relief' && Boolean(run.failedAttempts?.length);
  const systemPrompt = basePrompt.replace(weak, run.arm === 'current' ? current : run.arm === 'topology' ? topology : qualitative)
    + fixedTerrain
    + (run.retryPromptClarified ? '\n## API numeric boundary\nFor api.rampTerrain, softness and strength are both fractions from 0 to 1 inclusive. A value above 1 invalidates the entire plan.\n' : '');
  let lastProgress = '';
  try {
    console.log(`START ${label}`);
    const suggestion = await generateMapCodeSuggestion(runPrompt, map, [], {
      provider: 'gpt', scope: 'scene', promptMode: 'standard', revisionMode: 'first-pass',
      spatialPolicy: 'diagnose', minNewAssets: 0, maxNewAssets: 16,
      reuseExistingAssets: false, discoveryOnly: true, systemPromptOverride: systemPrompt,
      validateCode: code => {
        run.code = code;
        if (/\bapi\.(?:terrain|modifyTerrain)\s*\(/.test(code)) throw new Error('fixed_terrain_protocol_violation');
      },
      onProgress: event => {
        if (event.label !== lastProgress) console.log(`${label} ${lastProgress = event.label}`);
      }
    });
    const result = applyMapOperations(map, suggestion.operations);
    run.code = suggestion.codePlan?.code;
    run.functions = suggestion.codePlan?.functions;
    run.diagnostics = suggestion.diagnostics;
    run.roads = result.guides.map(guide => ({ id: guide.id, width: guide.width, points: guide.points }));
    run.objects = result.objects.map(object => ({ name: object.name, position: object.transform.position }));
    run.axisShare = axisShare(run.roads);
    run.terrainRelief = Math.max(...map.terrain.heights) - Math.min(...map.terrain.heights);
    run.terrainHeights = map.terrain.heights;
    run.status = 'saved';
    delete run.error;
    console.log(`SAVED ${label} roads=${run.roads.length} objects=${run.objects.length} axis=${run.axisShare}%`);
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    run.failedAttempts = [...(run.failedAttempts ?? []), run.error];
    console.error(`FAILED ${label} ${run.error}`);
  }
  save();
}
console.log(`STUDY ${ledger.runs.filter(run => run.status === 'saved').length}/${ledger.runs.length} saved, ${ledger.runs.filter(run => run.status === 'failed').length} failed`);
