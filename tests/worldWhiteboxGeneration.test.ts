import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auditWorldWhiteboxSettlementConstruction, generateApprovedWorldAssets, generateWorld, type WorldAssetRequest } from '../src/server/worldGeneration';
import { executeWorldWhitebox, generateWorldWhitebox,
  hasAccessibleOceanShore, materializeWorldWhiteboxConstruction, parseWorldWhiteboxInitialPlan, parseWorldWhiteboxSpatialPlan,
  validateWorldWhiteboxConstructionRequest, validateWorldWhiteboxRequest } from '../src/server/worldWhiteboxGeneration';
import type { MapStore } from '../src/server/mapStore';
import { validateTownPatch, validateWorldPlan, worldPlanKey, type TownPatch, type WorldPlan } from '../src/shared/worldPlanning';
import { generateWorldSettlement } from '../src/shared/worldSettlement';
import { createWorldSampler, createWorldTerrainEvidence, validateWorldRecipe, type WorldRecipe } from '../src/shared/worldTerrain';

const mocks = vi.hoisted(() => ({ llmChat: vi.fn(), generateModel: vi.fn(), recordGenerationTrace: vi.fn() }));
vi.mock('../src/server/modelApi', async importOriginal => ({
  ...await importOriginal<typeof import('../src/server/modelApi')>(), llmChat: mocks.llmChat, generateModel: mocks.generateModel
}));
vi.mock('../src/server/generationTrace', () => ({ recordGenerationTrace: mocks.recordGenerationTrace }));

const prompt = 'A volcanic bay with a harbor town, bridge, ruins, farms, and a quiet crater trail';
const request = { mode: 'whitebox' as const, prompt, seed: 74, size: 500 as const, generateAssets: false as const };

function originalPlan(): WorldPlan {
  return {
    version: 1 as const, id: 'volcanic-bay', revision: 1, prompt, whitebox: true as const,
    recipe: { version: 1 as const, seed: 74, size: 500, reliefProfile: 'compact' as const,
      constraints: [{ region: 'center' as const, biome: 'grassland' as const },
        { region: 'west' as const, biome: 'ocean' as const },
        { region: 'north' as const, biome: 'mountains' as const }],
      landforms: [{ center: [0, -125], radius: [65, 70], height: 42 }] },
    ecology: [], towns: [], roads: [],
    concept: { premise: 'A working volcanic bay', themes: ['trade', 'ruins'], experience: 'Cross the estuary, climb to the crater' },
    featureGraph: {
      regions: [
        { id: 'bay', kind: 'coast', name: 'Bay', center: [0, 60], radius: 100 },
        { id: 'crater', kind: 'volcano', name: 'Crater', center: [0, -125], radius: 70 },
        { id: 'hinterland', kind: 'farmland', name: 'Fields', center: [130, 80], radius: 65 }
      ],
      paths: [
        { id: 'harbor-road', kind: 'road', name: 'Harbor road', points: [[-70, 60], [0, 50], [130, 80]], width: 5 },
        { id: 'crater-trail', kind: 'trail', name: 'Crater trail', points: [[0, 50], [0, -125]], width: 2 }
      ],
      anchors: [
        { id: 'harbor', kind: 'settlement', position: [-70, 60], regionId: 'bay' },
        { id: 'bridge', kind: 'crossing', position: [0, 50], regionId: 'bay' },
        { id: 'farm', kind: 'settlement', position: [130, 80], regionId: 'hinterland' },
        { id: 'ruins', kind: 'ruins', position: [0, -125], regionId: 'crater' }
      ],
      relations: [{ fromId: 'harbor', toId: 'bridge', kind: 'trade access' },
        { fromId: 'bridge', toId: 'farm', kind: 'food route' }]
    },
    settlementPlan: { settlements: [{ id: 'port-town', anchorId: 'harbor', role: 'dense waterfront, civic core, looser uphill homes' },
      { id: 'farm-hamlet', anchorId: 'farm', role: 'sparse working farms' }] },
    mobilityPlan: { routes: [{ id: 'trade', pathId: 'harbor-road', mode: 'cart road and bridge', connects: ['harbor', 'bridge', 'farm'] },
      { id: 'ascent', pathId: 'crater-trail', mode: 'foot trail', connects: ['bridge', 'ruins'] }] },
    explorationPlan: { pointsOfInterest: [{ id: 'port', anchorId: 'harbor', purpose: 'Start and trade' },
      { id: 'crossing', anchorId: 'bridge', purpose: 'Cross estuary' },
      { id: 'old-city', anchorId: 'ruins', purpose: 'Explore ruins' }],
      sequence: ['port', 'crossing', 'old-city'] },
    intentionalEmptyAreas: [{ id: 'quiet-crater', regionId: 'crater', purpose: 'A quiet volcanic ascent before the ruins' }]
  };
}

function dryTerrainResponse(plan: WorldPlan): string {
  const { waterBodies: _waterBodies, ...terrain } = plan.recipe;
  return JSON.stringify({ terrain });
}

function spatialPlanResponse(plan: WorldPlan, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ plan: {
    id: plan.id,
    waterBodies: plan.recipe.waterBodies ?? [],
    concept: plan.concept,
    featureGraph: plan.featureGraph,
    settlementPlan: plan.settlementPlan,
    mobilityPlan: plan.mobilityPlan,
    explorationPlan: plan.explorationPlan,
    intentionalEmptyAreas: plan.intentionalEmptyAreas,
    ...extra
  } });
}

function v3HawaiiDryTerrain(): WorldRecipe {
  return {
    version: 1, seed: 20261001, size: 500, reliefProfile: 'compact', heightScale: 0.035,
    constraints: [
      { region: 'west', biome: 'ocean' }, { region: 'east', biome: 'ocean' },
      { region: 'north', biome: 'ocean' }, { region: 'south', biome: 'ocean' },
      { region: 'center', biome: 'mountains' }
    ],
    landforms: [
      { center: [0, 0], radius: [215, 205], height: 8 },
      { center: [-55, 35], radius: [145, 110], height: 7 },
      { center: [55, -35], radius: [125, 135], height: 15 },
      { center: [78, -48], radius: [62, 68], height: 24 },
      { center: [-92, -8], radius: [58, 95], height: 11 },
      { center: [25, 92], radius: [90, 58], height: 5 }
    ],
    terrainBrushes: [
      { id: 'caldera-crater', mode: 'crater', region: { kind: 'circle', center: [78, -48], radius: 48 },
        depth: 14, rimHeight: 7, feather: 12 },
      { id: 'harbour-terrace', mode: 'raise',
        region: { kind: 'path', points: [[-190, 62], [-145, 47], [-105, 40], [-70, 35]], width: 48 },
        amount: 2, feather: 14 },
      { id: 'river-valley', mode: 'lower',
        region: { kind: 'path', points: [[18, -122], [0, -92], [-18, -58], [-5, -25], [-48, 8], [-92, 38], [-137, 58]], width: 24 },
        amount: 3.5, feather: 18 },
      { id: 'ridge-walk', mode: 'raise',
        region: { kind: 'path', points: [[-118, 46], [-82, 18], [-45, -18], [-2, -48], [42, -65], [78, -48]], width: 30 },
        amount: 2.5, feather: 20 }
    ],
    biomePatches: [
      { id: 'leeward-town-grass', region: { kind: 'path', points: [[-190, 62], [-150, 48], [-108, 40], [-72, 35]], width: 78 }, biome: 'grassland', feather: 16 },
      { id: 'rainforest-gully', region: { kind: 'path', points: [[18, -116], [0, -86], [-14, -56], [-46, -18], [-88, 22], [-132, 54]], width: 62 }, biome: 'forest', feather: 20 },
      { id: 'lava-slope', region: { kind: 'path', points: [[-14, -8], [25, -38], [67, -67], [112, -101]], width: 70 }, biome: 'mountains', feather: 12 },
      { id: 'coastal-sand', region: { kind: 'path', points: [[-216, 76], [-182, 70], [-145, 66], [-112, 62]], width: 30 }, biome: 'grassland', feather: 10 },
      { id: 'crater-interior', region: { kind: 'circle', center: [78, -48], radius: 34 }, biome: 'mountains', feather: 8 }
    ]
  };
}

function buildablePlan(): WorldPlan {
  return {
    version: 1, id: 'buildable-whitebox', revision: 1, prompt: 'A compact woodland market village', whitebox: true,
    recipe: { version: 1, seed: 91, size: 500, reliefProfile: 'compact', heightScale: 0.02,
      constraints: [{ region: 'center', biome: 'grassland' }],
      landforms: [{ center: [0, 0], radius: [180, 180], height: 12 }] },
    ecology: [], towns: [], roads: [],
    concept: { premise: 'A market in a woodland clearing', themes: ['trade'], experience: 'Arrive through the grove' },
    featureGraph: {
      regions: [{ id: 'village-region', kind: 'settlement', name: 'Market clearing', center: [0, 0], radius: 80 }],
      paths: [{ id: 'arrival-path', kind: 'road', name: 'Arrival road', points: [[-120, 0], [0, 0], [120, 0]], width: 5 }],
      anchors: [{ id: 'village-anchor', kind: 'settlement', position: [0, 0], regionId: 'village-region' }],
      relations: []
    },
    settlementPlan: { settlements: [{ id: 'market-village', anchorId: 'village-anchor', role: 'homes around a working market' }] },
    mobilityPlan: { routes: [{ id: 'arrival-route', pathId: 'arrival-path', mode: 'cart road', connects: ['village-anchor'] }] },
    explorationPlan: { pointsOfInterest: [{ id: 'market', anchorId: 'village-anchor', purpose: 'trade' }], sequence: ['market'] },
    intentionalEmptyAreas: []
  };
}

function harborPlan(): WorldPlan {
  const plan = buildablePlan();
  plan.id = 'coastal-harbor';
  plan.prompt = 'A compact harbor town built out from the coast';
  plan.recipe = { version: 1, seed: 74, size: 500, reliefProfile: 'compact', heightScale: 0.02,
    constraints: [{ region: 'center', biome: 'grassland' }, { region: 'west', biome: 'ocean' }] };
  plan.featureGraph!.regions[0] = { id: 'harbor-region', kind: 'coast', name: 'Harbor coast', center: [-70, 60], radius: 80 };
  plan.featureGraph!.paths[0] = { id: 'harbor-road', kind: 'road', name: 'Harbor road', points: [[-70, 60], [100, 60]], width: 5 };
  plan.featureGraph!.anchors[0] = { id: 'dock-anchor', kind: 'harbor', position: [-70, 60], regionId: 'harbor-region' };
  plan.settlementPlan!.settlements[0] = { id: 'port-town', anchorId: 'dock-anchor', role: 'port-quays and uphill homes' };
  plan.mobilityPlan!.routes[0] = { id: 'harbor-route', pathId: 'harbor-road', mode: 'cart road', connects: ['dock-anchor'] };
  plan.explorationPlan = { pointsOfInterest: [{ id: 'port', anchorId: 'dock-anchor', purpose: 'trade' }], sequence: ['port'] };
  return plan;
}

function districtPlan(): WorldPlan {
  const plan = buildablePlan();
  plan.id = 'leeward-port-districts';
  plan.prompt = 'One leeward port town with civic, fishing, residential and garden quarters';
  plan.featureGraph = {
    regions: [
      { id: 'civic-region', kind: 'settlement_district', name: 'Leeward Port · Civic', center: [0, 0], radius: 30 },
      { id: 'fishing-region', kind: 'settlement_district', name: 'Leeward Port · Fishing', center: [40, 0], radius: 30 },
      { id: 'home-region', kind: 'settlement_district', name: 'Leeward Port · Homes', center: [0, 40], radius: 30 },
      { id: 'garden-region', kind: 'settlement_edge', name: 'Leeward Port · Gardens', center: [225, 225], radius: 25 }
    ],
    paths: [],
    anchors: [
      { id: 'civic-anchor', kind: 'settlement_district', position: [0, 0], regionId: 'civic-region' },
      { id: 'fishing-anchor', kind: 'settlement_district', position: [40, 0], regionId: 'fishing-region' },
      { id: 'home-anchor', kind: 'settlement_district', position: [0, 40], regionId: 'home-region' },
      { id: 'garden-anchor', kind: 'settlement_edge', position: [225, 225], regionId: 'garden-region' }
    ],
    relations: []
  };
  plan.settlementPlan = { settlements: [
    { id: 'civic-quarter', anchorId: 'civic-anchor', role: 'civic district serving the whole port town' },
    { id: 'fishing-quarter', anchorId: 'fishing-anchor', role: 'working waterfront district of the same town' },
    { id: 'home-quarter', anchorId: 'home-anchor', role: 'residential district of the same town' },
    { id: 'garden-quarter', anchorId: 'garden-anchor', role: 'sparse garden edge, not a second town' }
  ] };
  plan.mobilityPlan = { routes: [] };
  plan.explorationPlan = { pointsOfInterest: [], sequence: [] };
  return plan;
}

function unifiedDistrictPlan(): WorldPlan {
  const plan = buildablePlan();
  plan.id = 'unified-leeward-port';
  plan.prompt = 'One 150 person port town with working, civic, residential and garden districts';
  plan.featureGraph = {
    regions: [
      { id: 'civic-region', kind: 'settlement_district', name: 'Civic core', center: [0, 0], radius: 24 },
      { id: 'working-region', kind: 'settlement_district', name: 'Working harbor', center: [-55, -15], radius: 22 },
      { id: 'residential-region', kind: 'settlement_district', name: 'Uphill homes', center: [40, 35], radius: 28 },
      { id: 'garden-region', kind: 'settlement_edge', name: 'Garden edge', center: [-10, 75], radius: 25 }
    ],
    paths: [
      { id: 'quay-lane', kind: 'road', name: 'Quay lane', points: [[0, 0], [105, -10], [-55, -15]],
        curve: 'polyline', width: 4 },
      { id: 'home-lane', kind: 'road', name: 'Home lane', points: [[0, 0], [18, 20], [40, 35]],
        curve: 'polyline', width: 3.5 },
      { id: 'garden-lane', kind: 'path', name: 'Garden lane', points: [[40, 35], [12, 57], [-10, 75]],
        curve: 'polyline', width: 2.5 }
    ],
    anchors: [
      { id: 'civic-anchor', kind: 'town_centre', position: [0, 0], regionId: 'civic-region' },
      { id: 'working-anchor', kind: 'working_district', position: [-55, -15], regionId: 'working-region' },
      { id: 'residential-anchor', kind: 'residential_district', position: [40, 35], regionId: 'residential-region' },
      { id: 'garden-anchor', kind: 'settlement_edge', position: [-10, 75], regionId: 'garden-region' }
    ],
    relations: []
  };
  plan.settlementPlan = { settlements: [{
    id: 'leeward-port', anchorId: 'civic-anchor', role: 'one connected fishing settlement',
    districts: [
      { anchorId: 'civic-anchor', kind: 'civic', density: 0.9 },
      { anchorId: 'working-anchor', kind: 'working', density: 0.8 },
      { anchorId: 'residential-anchor', kind: 'residential', density: 0.65 },
      { anchorId: 'garden-anchor', kind: 'edge', density: 0.25 }
    ]
  }] };
  plan.mobilityPlan = { routes: [
    { id: 'quay-route', pathId: 'quay-lane', mode: 'local lane', connects: ['civic-anchor', 'working-anchor'] },
    { id: 'home-route', pathId: 'home-lane', mode: 'local lane', connects: ['civic-anchor', 'residential-anchor'] },
    { id: 'garden-route', pathId: 'garden-lane', mode: 'walking path', connects: ['residential-anchor', 'garden-anchor'] }
  ] };
  plan.explorationPlan = { pointsOfInterest: [], sequence: [] };
  return plan;
}

function districtExpansion() {
  return {
    towns: ['civic', 'fishing', 'home', 'garden'].map(id => ({
      id: `${id}-quarter`, name: `Leeward Port · ${id}`, kind: 'village', pattern: 'organic', density: 0.45,
      publicBuildings: []
    })),
    ecology: [], assets: []
  };
}

function constructionExpansion(assetCount = 0) {
  const assets: WorldAssetRequest[] = Array.from({ length: assetCount }, (_, index) => ({
    key: `asset-${index + 1}`, name: `Asset ${index + 1}`, role: index === 1 ? 'tree' : 'house',
    prompt: `Direct visible model ${index + 1}`, strategy: 'single',
    ...(index === 1 ? { ecologyKind: 'broadleaf', ecologyRuleId: 'grove' } : {})
  }));
  return {
    towns: [{ id: 'market-village', name: 'Market Village', kind: 'village', pattern: 'organic', density: 0.45,
      population: undefined as number | undefined,
      publicBuildings: [] as Array<{ id: string; use: string; width: number; depth: number; height: number;
        assetKey?: string; siting?: 'central' | 'waterfront' | 'gateway' | 'high-ground' }> }],
    ecology: [{ id: 'grove', kind: 'broadleaf', biome: 'grassland', density: 0.2, spacing: 14,
      maxSlope: 35, scale: [0.8, 1.2] }],
    assets
  };
}

describe('whitebox world generation', () => {
  beforeEach(() => { mocks.llmChat.mockReset(); mocks.generateModel.mockReset(); mocks.recordGenerationTrace.mockReset(); });

  it('keeps the whitebox request small and rejects asset generation or retries', () => {
    expect(validateWorldWhiteboxRequest(request)).toMatchObject({ size: 500, generateAssets: false, repairAttempts: 0 });
    expect(() => validateWorldWhiteboxRequest({ ...request, generateAssets: true })).toThrow();
    expect(() => validateWorldWhiteboxRequest({ ...request, repairAttempts: 1 })).toThrow();
  });

  it('uses one GPT call and preserves the raw first plan through observation and final output', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: originalPlan() }));
    const result = await generateWorld(request, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'whitebox') throw new Error('expected_whitebox_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.llmChat.mock.calls.map(([, options]) => options.traceStage))
      .toEqual(['world.whitebox.initial-plan']);
    expect(mocks.llmChat.mock.calls.every(([, options]) => options.provider === 'gpt')).toBe(true);
    expect(mocks.llmChat.mock.calls[0][1].maxAttempts).toBe(1);
    expect(result.paidCallCount).toBe(1);
    expect(result.mode).toBe('whitebox');
    expect(result.bundle.patches).toEqual([]);
    expect(result.assetSources).toEqual([]);
    expect(result.initialPlan).toEqual(result.finalPlan);
    expect(result.observation.scope).toBe('executed');
    expect(result.observation.pointsOfInterest.realizedCount).toBe(3);
    expect(result.adjustment).toEqual({
      decision: 'keep', applied: false, skipped: true, reason: 'raw_first_call_preserved'
    });
  });

  it('completes one 500m prompt in three first-pass GPT stages and at most three direct DeepSeek calls', async () => {
    const plan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(dryTerrainResponse(plan))
      .mockResolvedValueOnce(spatialPlanResponse(plan))
      .mockResolvedValueOnce(JSON.stringify(constructionExpansion(3)));
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    let id = 0;
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: `complete-${++id}` })) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: true, repairAttempts: 0 }, store);

    if (!('mode' in result) || result.mode !== 'generate-complete') throw new Error('expected_complete_world_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(3);
    expect(mocks.llmChat.mock.calls.map(([, options]) => options.traceStage))
      .toEqual(['world.whitebox.terrain-plan', 'world.whitebox.spatial-plan', 'world.whitebox.construction']);
    expect(mocks.llmChat.mock.calls.every(([, options]) => options.provider === 'gpt' && options.maxAttempts === 1)).toBe(true);
    const spatialInput = JSON.parse(mocks.llmChat.mock.calls[1][0][1].content);
    expect(spatialInput.dryTerrain).toEqual(plan.recipe);
    expect(spatialInput.terrainEvidence).toMatchObject({ resolution: 21, heightUnit: 0.1, slopeUnit: 1 });
    expect(spatialInput.terrainEvidence.buildingSiteScores).toHaveLength(21);
    expect(mocks.llmChat.mock.calls[1][0][0].content).toContain('buildingSiteScores');
    expect(mocks.llmChat.mock.calls[0][0][0].content).toContain('Reserve connected dry, gently sloped land');
    expect(mocks.llmChat.mock.calls[0][0][0].content).toContain('Terrain brushes execute in listed order');
    expect(mocks.llmChat.mock.calls[1][0][0].content).toContain('Do not downgrade a named town');
    expect(mocks.llmChat.mock.calls[1][0][0].content).toContain('coordinate values must be JSON numbers');
    expect(mocks.llmChat.mock.calls[2][0][0].content).toContain('do not rename a biome-specific asset');
    expect(JSON.parse(mocks.llmChat.mock.calls[2][0][1].content).whiteboxPlan).toEqual(result.initialPlan);
    expect(mocks.generateModel).toHaveBeenCalledTimes(3);
    expect(mocks.generateModel.mock.calls.every(([, options]) => options.providers?.join() === 'deepseek')).toBe(true);
    expect(result.paidCallCount).toBe(6);
    expect(result.originalTerrainDraft).toEqual(plan.recipe);
    expect(result.originalPlan).toEqual(JSON.parse(spatialPlanResponse(plan)).plan);
    expect(result.initialPlan).toEqual(result.finalPlan);
    expect(result.adjustment).toEqual({ decision: 'keep', applied: false, skipped: true,
      reason: 'raw_first_call_preserved' });
  });

  it('honours disabled asset generation in the complete flow', async () => {
    const plan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(dryTerrainResponse(plan))
      .mockResolvedValueOnce(spatialPlanResponse(plan))
      .mockResolvedValueOnce(JSON.stringify(constructionExpansion()));

    const result = await generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: false, repairAttempts: 0 }, {} as MapStore);

    if (!('mode' in result) || result.mode !== 'generate-complete') throw new Error('expected_complete_world_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(3);
    expect(mocks.generateModel).not.toHaveBeenCalled();
    expect(result.paidCallCount).toBe(3);
  });

  it('honours a smaller complete-flow DeepSeek budget without a repair pass', async () => {
    const plan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(dryTerrainResponse(plan))
      .mockResolvedValueOnce(spatialPlanResponse(plan))
      .mockResolvedValueOnce(JSON.stringify(constructionExpansion(2)));
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    let id = 0;
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: `capped-${++id}` })) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: true, assetGenerationLimit: 2, repairAttempts: 0 }, store);

    if (!('mode' in result) || result.mode !== 'generate-complete') throw new Error('expected_complete_world_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(3);
    expect(mocks.generateModel).toHaveBeenCalledTimes(2);
    expect(result.paidCallCount).toBe(5);
  });

  it('rejects a fourth complete-flow asset before any DeepSeek call', async () => {
    const plan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(dryTerrainResponse(plan))
      .mockResolvedValueOnce(spatialPlanResponse(plan))
      .mockResolvedValueOnce(JSON.stringify(constructionExpansion(4)));

    await expect(generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: true, repairAttempts: 0 }, {} as MapStore))
      .rejects.toThrow('world_whitebox_asset_generation_limit');
    expect(mocks.llmChat).toHaveBeenCalledTimes(3);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('samples deterministic compact dry-terrain evidence including a coast that crosses the map boundary', () => {
    const plan = originalPlan();
    const evidence = createWorldTerrainEvidence(validateWorldRecipe(plan.recipe));
    expect(evidence).toEqual(createWorldTerrainEvidence(plan.recipe));
    expect(evidence.resolution).toBe(21);
    expect(evidence.samples).toHaveLength(21);
    expect(evidence.samples.every(row => row.length === 21
      && row.every(([height, slope]) => Number.isInteger(height) && Number.isInteger(slope)))).toBe(true);
    expect(evidence.buildingSiteScores).toHaveLength(21);
    expect(evidence.buildingSiteScores.every(row => row.length === 21
      && row.every(score => Number.isInteger(score) && score >= 0 && score <= 4))).toBe(true);
    expect(evidence.buildingSiteScores.flat().some(score => score > 0)).toBe(true);
    expect(evidence.buildingSiteScores.flat().some(score => score === 0)).toBe(true);
    expect(evidence.boundaryCrossings.length).toBeGreaterThan(0);
  });

  it('exposes the v3 river source, intervening rise and sea outlet before spatial planning', () => {
    const recipe = validateWorldRecipe(v3HawaiiDryTerrain());
    const sample = createWorldSampler(recipe);
    const river = [[18, -118], [8, -96], [-12, -77], [-4, -53], [-22, -34],
      [-48, -13], [-63, 10], [-91, 29], [-122, 46], [-151, 61]] as Array<[number, number]>;
    const heights = river.map(([x, z]) => sample(x, z).height);
    expect(heights[0]).toBeCloseTo(1.18, 2);
    expect(Math.max(...heights)).toBeCloseTo(17.09, 2);
    expect(heights.at(-1)).toBeCloseTo(-2.01, 2);
    const evidence = createWorldTerrainEvidence(recipe);
    const sourceColumn = Math.round((18 - evidence.origin[0]) / evidence.step);
    const sourceRow = Math.round((-118 - evidence.origin[1]) / evidence.step);
    const gridX = evidence.origin[0] + sourceColumn * evidence.step;
    const gridZ = evidence.origin[1] + sourceRow * evidence.step;
    expect(evidence.samples[sourceRow][sourceColumn][0] * evidence.heightUnit)
      .toBeCloseTo(sample(gridX, gridZ).height, 1);
    expect(evidence.shoreline.flat().some(([x, z]) => Math.hypot(x + 151, z - 61) < evidence.step * 2)).toBe(true);
  });

  it('composes the spatial plan onto the exact dry terrain and rejects terrain fields from Stage 2', () => {
    const source = originalPlan();
    source.recipe.heightScale = 0.08;
    source.recipe.terrainBrushes = [{ id: 'dry-ridge', mode: 'raise',
      region: { kind: 'path', points: [[-80, -40], [20, -80]], width: 18 }, amount: 6, feather: 12 }];
    source.recipe.biomePatches = [{ id: 'ridge-snow',
      region: { kind: 'circle', center: [0, -125], radius: 35 }, biome: 'snow', feather: 10 }];
    const dryRecipe = validateWorldRecipe(source.recipe);
    dryRecipe.constraints.sort((a, b) => a.region.localeCompare(b.region));
    const result = parseWorldWhiteboxSpatialPlan(spatialPlanResponse(source), request, dryRecipe);
    const { waterBodies: _waterBodies, ...actualDryTerrain } = result.plan.recipe;
    expect(actualDryTerrain).toEqual(dryRecipe);
    expect(result.rawPlan).toEqual(JSON.parse(spatialPlanResponse(source)).plan);
    expect(() => parseWorldWhiteboxSpatialPlan(spatialPlanResponse(source, { recipe: dryRecipe }), request, dryRecipe))
      .toThrow('world_unknown_staged_spatial_field:recipe');
  });

  it('keeps authored local terrain refinements in the first spatial plan', () => {
    const source = originalPlan();
    const dryRecipe = validateWorldRecipe(source.recipe);
    const refinement = { id: 'river-mouth-grade', mode: 'grade' as const,
      region: { kind: 'path' as const, points: [[-80, 20], [-120, 40], [-155, 55]] as Array<[number, number]>, width: 20 },
      heights: [4, 2, 0], feather: 12 };
    const result = parseWorldWhiteboxSpatialPlan(spatialPlanResponse(source,
      { terrainRefinements: [refinement] }), request, dryRecipe);
    expect(result.plan.recipe.terrainBrushes).toEqual([expect.objectContaining(refinement)]);
    expect(dryRecipe.terrainBrushes).toBeUndefined();
    expect((result.rawPlan as { terrainRefinements: unknown[] }).terrainRefinements).toEqual([refinement]);
  });

  it('retains settlement population in the spatial whitebox and rejects invalid counts', () => {
    const source = originalPlan();
    source.settlementPlan!.settlements[0].population = 240;
    const dryRecipe = validateWorldRecipe(source.recipe);
    const result = parseWorldWhiteboxSpatialPlan(spatialPlanResponse(source), request, dryRecipe);
    expect(result.plan.settlementPlan!.settlements[1].population).toBe(240);
    expect((result.rawPlan as WorldPlan).settlementPlan!.settlements[0].population).toBe(240);
    source.settlementPlan!.settlements[0].population = 240.5;
    expect(() => parseWorldWhiteboxSpatialPlan(spatialPlanResponse(source), request, dryRecipe))
      .toThrow('world_invalid_settlement_population');
  });

  it('preserves a first-call follow route while ignoring its inapplicable grade hint', () => {
    const source = originalPlan();
    source.mobilityPlan!.routes[0].construction = { terrain: 'follow', maxGrade: 0.08 };
    const result = parseWorldWhiteboxSpatialPlan(spatialPlanResponse(source), request,
      validateWorldRecipe(source.recipe));
    expect((result.rawPlan as WorldPlan).mobilityPlan?.routes[0].construction?.maxGrade).toBe(0.08);
    expect(result.plan.mobilityPlan?.routes.find(route => route.id === source.mobilityPlan!.routes[0].id)
      ?.construction).toEqual({ terrain: 'follow' });
    expect(result.technicalNormalizations).toContain('mobilityPlan.routes[0].follow_max_grade_ignored');
    source.mobilityPlan!.routes[0].construction.maxGrade = 0.9;
    expect(() => parseWorldWhiteboxSpatialPlan(spatialPlanResponse(source), request,
      validateWorldRecipe(source.recipe))).toThrow('world_unexpected_route_max_grade');
  });

  it('keeps complete generation fixed at 500m with zero repair attempts', async () => {
    const plan = buildablePlan();
    await expect(generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 600, generateAssets: false, repairAttempts: 0 }, {} as MapStore))
      .rejects.toThrow('invalid_complete_world_generation_request');
    await expect(generateWorld({ mode: 'generate-complete', prompt: plan.prompt, seed: plan.recipe.seed,
      size: 500, generateAssets: false, repairAttempts: 1 }, {} as MapStore))
      .rejects.toThrow('invalid_complete_world_generation_request');
    expect(mocks.llmChat).not.toHaveBeenCalled();
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('keeps seven public functions in a substantial town independently of asset slots', () => {
    const expansion = constructionExpansion();
    expansion.towns[0].publicBuildings = Array.from({ length: 7 }, (_, index) => ({
      id: `civic-${index + 1}`, use: `public service ${index + 1}`,
      width: 8, depth: 8, height: 6, siting: 'central'
    }));
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(buildablePlan()), generateAssets: false,
      assetGenerationLimit: 0, repairAttempts: 0
    });
    expect(result.towns[0].publicBuildings).toHaveLength(7);
  });

  it('previews proposed asset families and building footprints without generating a model', async () => {
    const expansion = constructionExpansion(1);
    expansion.towns[0].publicBuildings = [{ id: 'school', use: 'village school', width: 8, depth: 8,
      height: 6, assetKey: 'asset-1', siting: 'central' }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(),
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(result.draft.assets).toEqual([expect.objectContaining({ key: 'asset-1' })]);
    expect(result.plannedBuildings).toEqual([expect.objectContaining({
      id: 'school', width: 8, depth: 8, height: 6, placed: true
    })]);
    expect(result.assetSources).toEqual([]);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('generates only the approved preview assets without replanning or moving whiteboxes', async () => {
    const expansion = constructionExpansion(1);
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const preview = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(),
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in preview) || preview.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    const originalBundle = structuredClone(preview.bundle);
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: 'approved-model' })) } as unknown as MapStore;
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    const result = await generateApprovedWorldAssets({ mode: 'generate-approved-world-assets', bundle: preview.bundle,
      assets: preview.draft.assets }, store);
    expect(result.assetSources).toEqual([expect.objectContaining({ id: 'asset-1', assetId: 'approved-model' })]);
    expect(result.paidCallCount).toBe(1);
    expect(preview.bundle).toEqual(originalBundle);
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.generateModel).toHaveBeenCalledTimes(1);
  });

  it('does not generate an unplaced landmark from an approved whitebox', async () => {
    const expansion = constructionExpansion(1);
    expansion.assets.push({ key: 'unplaced-hall', name: 'Hall', role: 'landmark',
      prompt: 'A hall with no approved site', strategy: 'single' });
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const preview = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(),
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in preview) || preview.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: 'approved-model' })) } as unknown as MapStore;
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    const result = await generateApprovedWorldAssets({ mode: 'generate-approved-world-assets', bundle: preview.bundle,
      assets: preview.draft.assets }, store);
    expect(result.assetSources.map(asset => asset.id)).toEqual(['asset-1']);
    expect(mocks.generateModel).toHaveBeenCalledTimes(1);
  });

  it('loads a first-call prose siting as a visible technical normalization without retrying', () => {
    const expansion = JSON.parse(JSON.stringify(constructionExpansion()));
    expansion.towns[0].publicBuildings = [
      { id: 'market', use: 'town meeting hall', width: 10, depth: 8, height: 6,
        assetKey: 'market', siting: 'Front onto the shared gathering space near the quay-lane junction.' },
      { id: 'fish-hall', use: 'fish exchange', width: 9, depth: 7, height: 5,
        assetKey: 'fish-hall', siting: 'Place on the dry inner-shore terrace beside the route.' }
    ];
    expansion.assets.push(
      { key: 'market', name: 'Market hall', role: 'landmark', prompt: 'Market hall', strategy: 'single' },
      { key: 'fish-hall', name: 'Fish hall', role: 'landmark', prompt: 'Fish hall', strategy: 'single' }
    );
    const raw = JSON.stringify(expansion);
    const result = materializeWorldWhiteboxConstruction(raw, {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(buildablePlan()),
      generateAssets: true, assetGenerationLimit: 2, repairAttempts: 0
    });
    expect(result.towns[0].publicBuildings.map(building => building.siting)).toEqual(['central', 'waterfront']);
    expect(result.diagnostics.flatMap(item => item.planningIssues)).toEqual(expect.arrayContaining([
      'siting_prose_normalized:market:central', 'siting_prose_normalized:fish-hall:waterfront'
    ]));
    expect(JSON.stringify(expansion)).toBe(raw);
  });

  it('asks the first call to co-design playable 500m terrain, coast, anchors and routes with valid schema', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: originalPlan() }));
    await generateWorldWhitebox(request);
    const systemPrompt = mocks.llmChat.mock.calls[0][0][0].content;
    expect(systemPrompt).toContain('terrain, coastline, buildable settlement anchors and routes together');
    expect(systemPrompt).toContain('heightScale around 0.08..0.15');
    expect(systemPrompt).toContain('strong ocean constraints may use about 0.02..0.04');
    expect(systemPrompt).toContain('Ocean is terrain below 0');
    expect(systemPrompt).toContain("mode:'crater'");
    expect(systemPrompt).toContain('Use crater, not a circular lower brush, for a volcanic crater on a mound');
    expect(systemPrompt).toContain('depth lowers central floor below pre-brush sampled rim');
    expect(systemPrompt).toContain('north is negative Z');
    expect(systemPrompt).toContain('do not fake a bay or harbour with a round lake');
    expect(systemPrompt).toContain('every patch needs a unique id and a bounded shape');
    expect(systemPrompt).toContain('Biome-patch feather is a transition distance in world metres, not a 0..1 softness ratio');
    expect(systemPrompt).toContain("surfaceMode:'terrain-fit'");
    expect(systemPrompt).toContain('Terrain-fit rivers have no levels');
    expect(systemPrompt).toContain("Only explicitly engineered canals or fixed-height waterworks may use surfaceMode:'authored'");
    expect(systemPrompt).toContain('never omit surfaceMode for a new river');
    expect(systemPrompt).toContain("mode:'raise'|'lower',region:{kind:'circle'");
    expect(systemPrompt).toContain("{kind:'path',points:[[x,z],...],width}");
    expect(systemPrompt).toContain("districts?:[{anchorId,kind:'working'|'civic'|'residential'|'edge',density:0..1}]");
    expect(systemPrompt).toContain("construction?:{terrain:'follow'|'grade'");
    expect(systemPrompt).toContain('Trace river centerlines through plausible low ground');
    expect(systemPrompt).toContain('long straight chord across hills reads like a canal');
    expect(systemPrompt).toContain('lateral swings of roughly several channel widths');
    expect(systemPrompt).toContain('artificial canals and steep mountain streams may be straighter exceptions');
    expect(systemPrompt).toContain('gentle downstream slope');
    expect(systemPrompt).toContain('meeting terrain and outlet compatible');
    expect(systemPrompt).toContain('Stop a river centerline at its first shoreline crossing');
    expect(systemPrompt).toContain('A natural river needs a dry inland source and dry banks before its first ocean contact');
    expect(systemPrompt).toContain('never underwater');
    expect(systemPrompt).toContain('a connected, gently sloped shore-working terrace');
    expect(systemPrompt).toContain('without an intentionally authored crossing');
    expect(systemPrompt).toContain('Show the whole inhabited footprint of a requested town');
    expect(systemPrompt).toContain('A settlement is one distinct inhabited destination, never one district');
    expect(systemPrompt).toContain('if the user asks for one town, return exactly one settlement');
    expect(systemPrompt).toContain('Reserve extra settlements for genuinely separate destinations');
    expect(systemPrompt).toContain('do not promote them to separate settlementPlan entries');
    expect(systemPrompt).toContain('Leave contiguous dry plots beside, rather than inside, road junctions');
    expect(systemPrompt).toContain('Keep ordinary routes human-scale relative to nearby buildings');
    expect(systemPrompt).toContain('ecology, towns and roads must be empty arrays');
  });

  it('preserves a model prompt echo in the raw plan while using the request-owned prompt for loading', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan: { ...originalPlan(), prompt: 'shortened echo' } }));
    const result = await generateWorldWhitebox(request);
    expect((result.originalPlan as {prompt: string}).prompt).toBe('shortened echo');
    expect(result.initialPlan.prompt).toBe(prompt);
    expect(result.observation.technicalNormalizations).toEqual(['request_prompt_echo']);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.whitebox.request-echo-normalized',
      { received: 'shortened echo', expected: prompt });
  });

  it('preserves detailed settlement roles and intentional return visits in a first-call journey', async () => {
    const plan = originalPlan();
    const role = 'A working harbor district with dry access to the quay, civic terrace and upper homes. '.repeat(4);
    plan.settlementPlan!.settlements[0].role = role;
    plan.explorationPlan!.sequence = ['port', 'crossing', 'port', 'old-city'];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ plan }));
    const result = await generateWorldWhitebox(request);
    expect(result.finalPlan.settlementPlan!.settlements.find(item => item.id === 'port-town')?.role).toBe(role);
    expect(result.finalPlan.explorationPlan!.sequence).toEqual(['port', 'crossing', 'port', 'old-city']);
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
  });

  it('loads a raw first-call whitebox with 0.6 shoreline variation and schema aliases without changing its semantic layout', () => {
    const source = originalPlan();
    const riverPath = { kind: 'path', points: [[0, 0], [30, 30]], width: 8 };
    const raw = { ...source, recipe: { ...source.recipe,
      waterBodies: [
        { id: 'bay', type: 'lake', region: { kind: 'circle', center: [0, 0], radius: 40 },
          levels: [0], depth: 8, shorelineIrregularity: 0.6 },
        { id: 'river', type: 'river', path: riverPath, levels: [5, 0] }
      ],
      biomePatches: [{ region: 'north', biome: 'mountains' }, { region: 'northeast', biome: 'scree' }]
    },
    towns: [{ id: 'port', anchorId: 'harbor', role: 'working harbor' }],
    roads: [{ id: 'road', pathId: 'harbor-road', character: 'busy quay' }],
    ecology: [{ id: 'grove', regionId: 'bay', character: 'wind-shaped trees' }] };
    const result = parseWorldWhiteboxInitialPlan(JSON.stringify({ plan: raw }), request);
    expect(result.rawPlan).toEqual(raw);
    expect(result.plan.recipe.waterBodies?.[0].shorelineIrregularity).toBe(0.6);
    expect(result.plan.recipe.waterBodies?.[1]).toMatchObject({ region: riverPath, depth: 1.5 });
    expect(result.plan.recipe.constraints).toContainEqual({ region: 'northeast', biome: 'mountains' });
    expect(result.plan.featureGraph?.anchors.map(anchor => anchor.id).sort())
      .toEqual(source.featureGraph!.anchors.map(anchor => anchor.id).sort());
    expect(result.plan.towns).toEqual([]);
    expect(result.technicalNormalizations).toContain('towns_semantic_notes_only');
  });

  it('samples creative terrain without applying density or realism gates', () => {
    const plan = originalPlan();
    plan.featureGraph!.paths[0].curve = 'catmull-rom';
    plan.explorationPlan!.pointsOfInterest = [];
    plan.explorationPlan!.sequence = [];
    const result = executeWorldWhitebox(plan);
    expect(result.execution.pointsOfInterest).toEqual([]);
    expect(result.execution.paths?.find(path => path.id === 'harbor-road')?.curve).toBe('catmull-rom');
    expect(result.surfaceFacts.heightRange.every(Number.isFinite)).toBe(true);
  });

  it('accepts a bounded no-repair construction asset budget', () => {
    const valid = { mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 };
    expect(validateWorldWhiteboxConstructionRequest(valid)).toMatchObject({
      mode: 'construct-whitebox', generateAssets: true, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(validateWorldWhiteboxConstructionRequest({ ...valid, assetGenerationLimit: 2 }).assetGenerationLimit).toBe(2);
    expect(() => validateWorldWhiteboxConstructionRequest({ ...valid, assetGenerationLimit: -1 })).toThrow('invalid_world_whitebox_construction_request');
    expect(() => validateWorldWhiteboxConstructionRequest({ ...valid, assetGenerationLimit: 1.5 })).toThrow('invalid_world_whitebox_construction_request');
    expect(() => validateWorldWhiteboxConstructionRequest({ ...valid, assetGenerationLimit: 4 })).toThrow('invalid_world_whitebox_construction_request');
    expect(() => validateWorldWhiteboxConstructionRequest({ ...valid, repairAttempts: 1 })).toThrow('invalid_world_whitebox_construction_request');
  });

  it('carries an optional Stage 2 population into the constructed town while accepting legacy omissions', () => {
    const populated = constructionExpansion();
    populated.towns[0].population = 150;
    const request = { mode: 'construct-whitebox' as const, whiteboxPlan: validateWorldPlan(buildablePlan()),
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0 as const };
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(populated), request);
    const legacy = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), request);

    expect(result.towns[0].population).toBe(150);
    expect(result.plan.towns[0].population).toBe(150);
    expect(legacy.plan.towns[0].population).toBeUndefined();
  });

  it('keeps the approved spatial population when construction suggests a different count', () => {
    const source = buildablePlan();
    source.settlementPlan!.settlements[0].population = 240;
    const expansion = constructionExpansion();
    expansion.towns[0].population = 150;
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(source),
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.towns[0].population).toBe(150);
    expect(result.plan.towns[0].population).toBe(240);
    expect(result.diagnostics.find(item => item.townId === result.plan.towns[0].id)?.planningIssues)
      .toContain('settlement_population_changed_after_spatial_plan');
  });

  it('materializes one populated town across authored districts without turning internal routes into ports', () => {
    const expansion = constructionExpansion();
    expansion.towns[0] = { ...expansion.towns[0], id: 'leeward-port', name: 'Leeward Port', population: 150 };
    const source = validateWorldPlan(unifiedDistrictPlan());
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan: source,
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });

    expect(result.plan.towns).toHaveLength(1);
    expect(result.plan.towns[0]).toMatchObject({ id: 'leeward-port', population: 150, radius: 100, ports: [],
      districts: [
        { anchorId: 'civic-anchor', kind: 'civic', offset: [0, 0], radius: 24, density: 0.9 },
        { anchorId: 'garden-anchor', kind: 'edge', offset: [-10, 75], radius: 25, density: 0.25 },
        { anchorId: 'residential-anchor', kind: 'residential', offset: [40, 35], radius: 28, density: 0.65 },
        { anchorId: 'working-anchor', kind: 'working', offset: [-55, -15], radius: 22, density: 0.8 }
      ]
    });
    expect(result.plan.roads).toHaveLength(3);
    expect(result.plan.roads.every(road => road.tags.includes('town-internal') && road.tags.includes('local_street'))).toBe(true);
    expect(result.plan.roads.some(road => road.id.startsWith('whitebox-access-'))).toBe(false);
    expect(result.plan.settlementPlan).toEqual(source.settlementPlan);
  });

  it('retains near-boundary districts in one construction core instead of dropping their intent', () => {
    const source = unifiedDistrictPlan();
    const shift: [number, number] = [-133, 48];
    for (const region of source.featureGraph!.regions) region.center = [region.center[0] + shift[0], region.center[1] + shift[1]];
    for (const anchor of source.featureGraph!.anchors) anchor.position = [anchor.position[0] + shift[0], anchor.position[1] + shift[1]];
    for (const path of source.featureGraph!.paths) path.points = path.points.map(([x, z]) => [x + shift[0], z + shift[1]]);
    const expansion = constructionExpansion();
    expansion.towns[0] = { ...expansion.towns[0], id: 'leeward-port', name: 'Leeward Port', population: 150 };

    const result = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(source),
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    const town = result.plan.towns[0];
    expect(town.districts).toHaveLength(4);
    expect(town.districts?.every(district => Math.max(
      Math.abs(district.offset[0]) + district.radius,
      Math.abs(district.offset[1]) + district.radius
    ) <= town.radius)).toBe(true);
    expect(result.diagnostics.find(item => item.townId === town.id)?.planningIssues
      .some(issue => issue.startsWith('settlement_district_outside_core:'))).not.toBe(true);
    const base = createWorldSampler(result.plan.recipe);
    const flat = (x: number, z: number) => ({ ...base(x, z), height: 10, waterLevel: null, waterBodyId: null });
    const patch = generateWorldSettlement(result.plan, town.id, flat, {
      kind: 'village', pattern: 'organic', density: 0.65
    });
    expect(patch.buildings.filter(building => building.use === 'home' || building.use === 'farmhouse').length)
      .toBeGreaterThanOrEqual(25);
    for (const district of town.districts ?? []) {
      expect(patch.buildings.some(building => Math.hypot(
        building.x - district.offset[0], building.z - district.offset[1]
      ) <= district.radius)).toBe(true);
    }
  });

  it('keeps the in-map half of a district whose authored region crosses the world edge', () => {
    const source = unifiedDistrictPlan();
    source.featureGraph!.regions.push({ id: 'outer-region', kind: 'settlement_edge', name: 'Outer fields',
      center: [225, 0], radius: 50 });
    source.featureGraph!.anchors.push({ id: 'outer-anchor', kind: 'settlement_edge',
      position: [225, 0], regionId: 'outer-region' });
    source.settlementPlan!.settlements[0].districts!.push({ anchorId: 'outer-anchor', kind: 'edge', density: 0.3 });
    const expansion = constructionExpansion();
    expansion.towns[0] = { ...expansion.towns[0], id: 'leeward-port', population: 150 };
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(source), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0
    });
    const town = result.plan.towns[0];
    expect(town.districts?.find(district => district.anchorId === 'outer-anchor')?.radius).toBe(50);
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('settlement_district_world_edge_overlap:outer-anchor');
    const patch = { townId: town.id, worldKey: worldPlanKey(result.plan), summary: 'Outer field inside the map',
      streets: [], buildings: [{ id: 'outer-home', x: 180, z: 0, width: 5, depth: 7, height: 5, use: 'farmhouse' }]
    } as TownPatch;
    expect(validateTownPatch(result.plan, patch).buildings).toHaveLength(1);
    patch.buildings[0].x = 252;
    expect(() => validateTownPatch(result.plan, patch)).toThrow('world_building_outside');
  });

  it('grows one connected 150 person patch through radial density bands in its expanded district envelope', async () => {
    const expansion = constructionExpansion();
    expansion.towns[0] = { ...expansion.towns[0], id: 'leeward-port', name: 'Leeward Port', population: 150 };
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: unifiedDistrictPlan(),
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');

    expect(result.bundle.plan.towns).toHaveLength(1);
    expect(result.bundle.patches).toHaveLength(1);
    const town = result.bundle.plan.towns[0], patch = result.bundle.patches[0];
    expect(patch.townId).toBe('leeward-port');
    expect(patch.buildings.filter(building => building.use === 'home' || building.use === 'farmhouse')).toHaveLength(30);
    expect(() => validateTownPatch(result.bundle.plan, patch)).not.toThrow();
    const ringCounts = [0, 0, 0];
    for (const building of patch.buildings) {
      const radius = Math.hypot(building.x, building.z) / town.radius;
      ringCounts[radius < 0.4 ? 0 : radius < 0.68 ? 1 : 2]++;
    }
    expect(ringCounts.every(count => count > 0)).toBe(true);
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('reports an infeasible authored grade without rewriting the construction plan', async () => {
    const plan = buildablePlan();
    plan.recipe.waterBodies = [{ id: 'ridge-lake', type: 'lake',
      region: { kind: 'circle', center: [150, 160], radius: 12 }, levels: [20], depth: 3 }];
    plan.featureGraph!.regions.push({ id: 'ridge-region', kind: 'highland', name: 'Outer ridge',
      center: [180, 160], radius: 20 });
    plan.featureGraph!.paths.push({ id: 'ridge-grade-path', kind: 'road', name: 'Outer ridge grade',
      points: [[120, 160], [180, 160]], width: 4 });
    plan.featureGraph!.anchors.push({ id: 'ridge-anchor', kind: 'lookout', position: [180, 160],
      regionId: 'ridge-region' });
    plan.mobilityPlan!.routes.push({ id: 'ridge-grade', pathId: 'ridge-grade-path', mode: 'cart road',
      connects: ['ridge-anchor'], construction: { terrain: 'grade', maxGrade: 0.1 } });
    const original = validateWorldPlan(plan);
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(constructionExpansion()));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: original,
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');

    expect(result.bundle.plan.recipe).toEqual(original.recipe);
    expect(result.bundle.plan.mobilityPlan).toEqual(original.mobilityPlan);
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('world_route_grade_crosses_water:ridge-grade:water');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
  });

  it('diagnoses a sparse populated whitebox patch with existing coverage and population audits', () => {
    const expansion = constructionExpansion();
    expansion.towns[0].population = 150;
    const materialized = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(buildablePlan()),
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    const sparsePatch = {
      townId: 'market-village', worldKey: 'sparse-populated-village', summary: 'Only three homes survived', streets: [],
      buildings: [0, 1, 2].map(index => ({ id: `home-${index}`, x: index, z: 0, width: 5, depth: 7,
        height: 5, use: 'home' }))
    } as TownPatch;

    const diagnostics = auditWorldWhiteboxSettlementConstruction(materialized.plan, materialized.towns,
      materialized.settlements, [sparsePatch]);
    expect(diagnostics.find(item => item.townId === 'market-village')?.planningIssues).toEqual(expect.arrayContaining([
      'underbuilt_settlement', 'clustered_settlement', 'population_underbuilt'
    ]));
  });

  it('reports each authored district that still has no ordinary buildings without rejecting the patch', () => {
    const expansion = constructionExpansion();
    expansion.towns[0] = { ...expansion.towns[0], id: 'leeward-port', population: 150 };
    const materialized = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(unifiedDistrictPlan()), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0
    });
    const patch = { townId: 'leeward-port', worldKey: 'district-audit', summary: 'Only the wharf was built', streets: [],
      buildings: [{ id: 'wharf-home', x: -55, z: -15, width: 5, depth: 7, height: 5, use: 'home' }]
    } as TownPatch;
    const issues = auditWorldWhiteboxSettlementConstruction(materialized.plan, materialized.towns,
      materialized.settlements, [patch])[0].planningIssues;
    expect(issues).toContain('district_unbuilt:civic-anchor');
    expect(issues).toContain('district_unbuilt:residential-anchor');
    expect(issues).toContain('district_unbuilt:garden-anchor');
    expect(issues).not.toContain('district_unbuilt:working-anchor');
  });

  it('derives town ports only where a connected whitebox route reaches the dry town boundary', () => {
    const whiteboxPlan = validateWorldPlan(buildablePlan());
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.plan.towns[0].ports).toEqual([
      { id: 'whitebox-port-1-1-1', guideId: 'whitebox-access-1-1-1', position: [-80, 0], width: 5 },
      { id: 'whitebox-port-1-1-2', guideId: 'whitebox-access-1-1-2', position: [80, 0], width: 5 }
    ]);
    expect(result.plan.towns[0].districts).toBeUndefined();
    expect(result.plan.roads.find(road => road.id === 'arrival-route')?.points)
      .toEqual(whiteboxPlan.featureGraph!.paths[0].points);
    for (const port of result.plan.towns[0].ports) {
      const road = result.plan.roads.find(candidate => candidate.id === port.guideId)!;
      expect([road.points[0], road.points.at(-1)]).toContainEqual(port.position);
    }
    expect(result.plan.featureGraph).toEqual(whiteboxPlan.featureGraph);
    expect(result.plan.recipe).toEqual(whiteboxPlan.recipe);
    expect(result.plan.roads.find(road => road.id === 'arrival-route')?.curve).toBe('polyline');
  });

  it('preserves an explicitly authored curved whitebox route through construction', () => {
    const source = buildablePlan();
    source.featureGraph!.paths[0].curve = 'catmull-rom';
    const whiteboxPlan = validateWorldPlan(source);
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });

    expect(result.plan.featureGraph!.paths[0].curve).toBe('catmull-rom');
    expect(result.plan.roads.find(road => road.id === 'arrival-route')?.curve).toBe('catmull-rom');
    expect(result.plan.roads.find(road => road.id === 'arrival-route')?.points)
      .toEqual(whiteboxPlan.featureGraph!.paths[0].points);
  });

  it('diagnoses disconnected and wet route approaches instead of inventing town ports', () => {
    const disconnected = buildablePlan();
    disconnected.featureGraph!.paths[0].points = [[120, 120], [180, 180]];
    const disconnectedPlan = validateWorldPlan(disconnected);
    const absent = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan: disconnectedPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(absent.plan.towns[0].ports).toEqual([]);
    expect(absent.diagnostics.flatMap(item => item.planningIssues))
      .toContain('route_settlement_disconnected:arrival-route:market-village');

    const wet = buildablePlan();
    wet.recipe.waterBodies = [{ id: 'east-gate-water', type: 'lake',
      region: { kind: 'circle', center: [80, 0], radius: 8 }, levels: [20], depth: 3 }];
    const wetPlan = validateWorldPlan(wet);
    const dryOnly = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan: wetPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(dryOnly.plan.towns[0].ports).toEqual([
      { id: 'whitebox-port-1-1-1', guideId: 'whitebox-access-1-1-1', position: [-80, 0], width: 5 }
    ]);
    expect(dryOnly.diagnostics.flatMap(item => item.planningIssues))
      .toContain('route_settlement_port_on_water:arrival-route:market-village');
  });

  it('targets the sea when a planned harbor can reach sampled ocean shoreline', () => {
    const whiteboxPlan = validateWorldPlan(harborPlan());
    const expansion = constructionExpansion();
    expansion.towns[0].id = 'port-town';
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan, generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.plan.towns[0].targetWaterBodyId).toBe('sea');
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .not.toContain('maritime_settlement_no_accessible_ocean_shore');
  });

  it('retains a separate harbor anchor when the town-centre role only says fishing town', () => {
    const plan = harborPlan();
    plan.featureGraph!.anchors[0].kind = 'town-center';
    plan.featureGraph!.anchors.push({ id: 'working-harbor', kind: 'working-harbor',
      position: [-105, 60], regionId: 'harbor-region' });
    plan.settlementPlan!.settlements[0].role = 'working fishing town';
    const expansion = constructionExpansion();
    expansion.towns[0].id = 'port-town';
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(expansion), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(plan),
      generateAssets: false, assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.plan.towns[0].targetWaterBodyId).toBe('sea');
  });

  it('detects a narrow sea inlet in the square town core beyond the old radial probe', () => {
    const land = createWorldSampler(buildablePlan().recipe);
    const sample = (x: number, z: number) => {
      const sea = x < -86 && z < -86;
      return { ...land(x, z), height: sea ? -3 : 12, waterLevel: sea ? 0 : null, waterBodyId: null };
    };
    expect(hasAccessibleOceanShore(sample, [0, 0], 100)).toBe(true);
  });

  it('keeps an inland river port from pretending it has a sea landing', () => {
    const inland = buildablePlan();
    inland.featureGraph!.anchors[0].kind = 'harbor';
    inland.settlementPlan!.settlements[0].role = 'river port-quays and market homes';
    inland.recipe.waterBodies = [{ id: 'market-river', type: 'river',
      region: { kind: 'path', points: [[-160, 30], [160, 30]], width: 12 },
      levels: [5, 5], depth: 3 }];
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(inland), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.plan.towns[0].targetWaterBodyId).toBeUndefined();
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .not.toContain('maritime_settlement_no_accessible_ocean_shore');
  });

  it('diagnoses a planned maritime harbor when no ocean shore is reachable', () => {
    const inland = buildablePlan();
    inland.featureGraph!.anchors[0].kind = '海港';
    inland.settlementPlan!.settlements[0].role = '码头、集市与居民区';
    const result = materializeWorldWhiteboxConstruction(JSON.stringify(constructionExpansion()), {
      mode: 'construct-whitebox', whiteboxPlan: validateWorldPlan(inland), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0
    });
    expect(result.plan.towns[0].targetWaterBodyId).toBeUndefined();
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('maritime_settlement_no_accessible_ocean_shore');
  });

  it('constructs the saved whitebox with one non-retrying GPT call and preserves every semantic coordinate', async () => {
    const whiteboxPlan = buildablePlan();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(constructionExpansion()));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan, generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.llmChat.mock.calls[0][1]).toMatchObject({ provider: 'gpt', maxAttempts: 1,
      traceStage: 'world.whitebox.construction' });
    const systemPrompt = mocks.llmChat.mock.calls[0][0][0].content as string;
    expect(systemPrompt).toContain("siting?:'central'|'waterfront'|'gateway'|'high-ground'");
    expect(systemPrompt).toContain('population?:integer');
    expect(systemPrompt).toContain("Copy each settlement's population");
    expect(systemPrompt).toContain('Choose public-building assets by their actual measured silhouette');
    expect(systemPrompt).toContain('publicBuildings:[{id,use,width,depth,height,assetKey?');
    expect(systemPrompt).toContain('visible whitebox footprint without spending an asset slot');
    expect(systemPrompt).toContain("role:'house'|'shop'|'workshop'|'tree'|'landmark'");
    expect(systemPrompt).toContain('Do not put width, depth, height or use directly on an asset object.');
    expect(mocks.generateModel).not.toHaveBeenCalled();
    expect(result.paidCallCount).toBe(1);
    expect(result.originalPlan).toEqual(whiteboxPlan);
    expect(result.bundle.plan.recipe).toEqual(whiteboxPlan.recipe);
    expect(result.bundle.plan.featureGraph).toEqual(whiteboxPlan.featureGraph);
    expect(result.bundle.plan.mobilityPlan).toEqual(whiteboxPlan.mobilityPlan);
    expect(result.bundle.plan.roads[0].points).toEqual(whiteboxPlan.featureGraph!.paths[0].points);
    expect(result.bundle.plan.towns[0].center).toEqual(whiteboxPlan.featureGraph!.anchors[0].position);
    expect(result.bundle.patches[0].buildings.length).toBeGreaterThan(0);
    expect(result.bundle.patches[0].streets.some(street => street.tags.includes('port'))).toBe(true);
  });

  it('keeps a dry town when one derived external port cannot reach its street network', async () => {
    const whiteboxPlan = buildablePlan();
    whiteboxPlan.recipe.waterBodies = [{ id: 'east-cut', type: 'river',
      region: { kind: 'path', points: [[60, -100], [60, 100]], width: 12 },
      levels: [20, 20], depth: 3 }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(constructionExpansion()));

    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan, generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');

    const patch = result.bundle.patches[0];
    expect(patch.buildings.length).toBeGreaterThan(0);
    expect(result.bundle.plan.towns[0].ports.map(port => port.id)).toEqual(['whitebox-port-1-1-1']);
    expect(patch.streets.some(street => street.id.includes('whitebox-port-1-1-2'))).toBe(false);
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('port_connection_unrealized:whitebox-port-1-1-2');
    expect(result.originalPlan).toEqual(whiteboxPlan);
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
  });

  it('keeps feasible public buildings when one authored waterfront landmark has no site', async () => {
    const whiteboxPlan = buildablePlan();
    const expansion = constructionExpansion();
    expansion.towns[0].publicBuildings = [
      { id: 'civic-market', use: 'market hall', width: 8, depth: 7, height: 7,
        assetKey: 'civic-kit', siting: 'central' },
      { id: 'fishing-cooperative', use: 'fishing cooperative', width: 8, depth: 6, height: 6,
        assetKey: 'civic-kit', siting: 'waterfront' }
    ];
    expansion.assets = [{ key: 'civic-kit', name: 'Civic kit', role: 'landmark', prompt: 'Civic building', strategy: 'single' }];
    const rawExpansion = JSON.stringify(expansion);
    mocks.llmChat.mockResolvedValueOnce(rawExpansion);
    mocks.generateModel.mockResolvedValueOnce({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: 'saved-civic-kit' })) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan, generateAssets: true,
      assetGenerationLimit: 1, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');

    const publicIds = result.bundle.patches[0].buildings.filter(building => building.assetKey === 'civic-kit')
      .map(building => building.id);
    expect(publicIds).toContain('civic-market');
    expect(publicIds).not.toContain('fishing-cooperative');
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('public_building_unrealized:fishing-cooperative:no_waterfront_site');
    expect(result.originalPlan).toEqual(whiteboxPlan);
    expect(expansion.towns[0].publicBuildings).toHaveLength(2);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.whitebox.construction.raw', { content: rawExpansion });
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('keeps every authored public building when the complete landmark layout is feasible', async () => {
    const expansion = constructionExpansion();
    expansion.towns[0].publicBuildings = [
      { id: 'civic-school', use: 'school', width: 9, depth: 8, height: 6,
        assetKey: 'civic-kit', siting: 'central' },
      { id: 'civic-service-house', use: 'service house', width: 8, depth: 7, height: 6,
        assetKey: 'civic-kit', siting: 'central' }
    ];
    expansion.assets = [{ key: 'civic-kit', name: 'Civic kit', role: 'landmark', prompt: 'Civic building', strategy: 'single' }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    mocks.generateModel.mockResolvedValueOnce({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: 'saved-civic-kit' })) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 1, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');

    expect(result.bundle.patches[0].buildings.filter(building => building.assetKey === 'civic-kit')
      .map(building => building.id)).toEqual(['civic-school', 'civic-service-house']);
    expect(result.diagnostics.flatMap(item => 'planningIssues' in item ? item.planningIssues ?? [] : [])
      .filter(issue => issue.startsWith('public_building_unrealized:'))).toEqual([]);
  }, 10_000);

  it('uses a Stage 2 population of 150 as the ordinary housing target', async () => {
    const expansion = constructionExpansion();
    expansion.towns[0].population = 150;
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');

    expect(result.bundle.plan.towns[0].population).toBe(150);
    expect(result.bundle.patches[0].buildings.filter(building => building.use === 'home' || building.use === 'farmhouse'))
      .toHaveLength(30);
    expect(result.diagnostics.flatMap(item => 'planningIssues' in item ? item.planningIssues ?? [] : []))
      .not.toContain('population_underbuilt');
  });

  it('reports an infeasible authored road grade without rejecting or repairing the first-call plan', async () => {
    const plan = buildablePlan();
    plan.mobilityPlan!.routes[0].construction = { terrain: 'grade', maxGrade: 0.02 };
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(constructionExpansion()));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: plan, generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');

    expect(result.originalPlan).toEqual(plan);
    expect(result.diagnostics.flatMap(item => 'planningIssues' in item ? item.planningIssues ?? [] : []))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^world_route_grade_infeasible:arrival-route:/)]));
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
  });

  it('diagnoses overlapping town districts while constructing a viable map-edge quarter', async () => {
    const plan = districtPlan();
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(districtExpansion()));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: plan, generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');

    const issues = result.diagnostics.flatMap(item => 'planningIssues' in item ? item.planningIssues ?? [] : []);
    expect(issues).toContain('possible_settlement_district_split:civic-quarter:fishing-quarter');
    expect(result.diagnostics.find(item => 'townId' in item && item.townId === 'garden-quarter')?.planningIssues)
      .not.toContain('settlement_patch_missing');
    expect(result.bundle.plan.settlementPlan?.settlements).toHaveLength(4);
    expect(result.bundle.patches.some(patch => patch.townId === 'garden-quarter')).toBe(true);
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('hard-rejects construction output that tries to rewrite the saved whitebox', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify({ ...constructionExpansion(), recipe: { size: 1000 } }));
    await expect(generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore)).rejects.toThrow('world_unknown_whitebox_construction_field');
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('keeps an unbound public building and its access street as a whitebox', async () => {
    const expansion = constructionExpansion();
    expansion.towns[0].publicBuildings = [{ id: 'school', use: 'village school', width: 8, depth: 8, height: 6,
      assetKey: 'school', siting: 'central' }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    const patch = result.bundle.patches[0];
    expect(patch.buildings.some(building => building.assetKey === 'school')).toBe(true);
    expect(patch.streets.some(street => street.id === 'market-village-landmark-school')).toBe(true);
    expect(patch.summary).toMatch(new RegExp(`; ${patch.streets.length} roads and ${patch.buildings.length} buildings$`));
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('explicit_asset_unbound:school:school');
  });

  it('plans a public whitebox without consuming a DeepSeek asset slot', async () => {
    const initial = constructionExpansion();
    const expansion = { ...initial, towns: [{ ...initial.towns[0], publicBuildings: [{
      id: 'civic-hall', use: 'civic hall', width: 8, depth: 7, height: 7, siting: 'central'
    }] }] };
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(),
      generateAssets: false, assetGenerationLimit: 0, repairAttempts: 0 }, {} as MapStore);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    const hall = result.bundle.patches[0].buildings.find(building => building.id === 'civic-hall');
    expect(hall).toMatchObject({ use: 'civic hall' });
    expect(hall?.assetKey).toBeUndefined();
    expect(mocks.generateModel).not.toHaveBeenCalled();
    expect(result.paidCallCount).toBe(1);
  });

  it('normalizes one unique reusable asset id alias to its semantic request key', async () => {
    const expansion = constructionExpansion();
    expansion.towns[0].publicBuildings = [{ id: 'school', use: 'village school', width: 8, depth: 8, height: 6,
      assetKey: 'existing-school', siting: 'central' }];
    expansion.assets = [{ key: 'island-school', name: 'Island school', role: 'landmark', prompt: 'Reuse the school',
      dimensions: [8, 6, 8], strategy: 'single', existingAssetId: 'existing-school' }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const asset = { id: 'existing-school', name: 'Island school', prompt: 'A village school', tags: ['landmark'],
      mode: 'voxel-pro', modelJson: { format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {
        width: 8, height: 6, depth: 8 } } }] } };
    const store = { loadAsset: vi.fn().mockResolvedValue(asset) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0, reusableAssetIds: ['existing-school'] }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    const issues = result.diagnostics.flatMap(item =>
      'planningIssues' in item ? item.planningIssues ?? [] : [],
    );
    expect(result.bundle.patches[0].buildings.find(building => building.id === 'school')?.assetKey).toBe('island-school');
    expect(issues).toContain('asset_key_normalized:school:existing-school->island-school');
    expect(issues.some(issue => issue.startsWith('explicit_asset_unbound:school:'))).toBe(false);
    expect(result.assetSources).toEqual([]);
    expect(result.draft.assets).toEqual([expect.objectContaining({ key: 'island-school', existingAssetId: 'existing-school' })]);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('leaves an ambiguous reusable asset id alias unbound and diagnostic', async () => {
    const expansion = constructionExpansion();
    expansion.towns[0].publicBuildings = [{ id: 'school', use: 'village school', width: 8, depth: 8, height: 6,
      assetKey: 'existing-school', siting: 'central' }];
    expansion.assets = ['school-a', 'school-b'].map(key => ({ key, name: key, role: 'landmark' as const,
      prompt: `Reuse ${key}`, dimensions: [8, 6, 8] as [number, number, number], strategy: 'single' as const,
      existingAssetId: 'existing-school' }));
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const asset = { id: 'existing-school', name: 'Island school', prompt: 'A village school', tags: ['landmark'],
      mode: 'voxel-pro', modelJson: { format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {
        width: 8, height: 6, depth: 8 } } }] } };
    const store = { loadAsset: vi.fn().mockResolvedValue(asset) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: false,
      assetGenerationLimit: 3, repairAttempts: 0, reusableAssetIds: ['existing-school'] }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    const issues = result.diagnostics.flatMap(item =>
      'planningIssues' in item ? item.planningIssues ?? [] : [],
    );
    expect(result.bundle.patches[0].buildings.some(building => building.id === 'school')).toBe(true);
    expect(issues).toContain('explicit_asset_unbound:school:existing-school');
    expect(issues.some(issue => issue.startsWith('asset_key_normalized:school:'))).toBe(false);
    expect(result.assetSources).toEqual([]);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('caps construction at three direct DeepSeek assets and reports the paid attempts', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(constructionExpansion(3)));
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    let id = 0;
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: `saved-${++id}` })) } as unknown as MapStore;
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(mocks.generateModel).toHaveBeenCalledTimes(3);
    expect(mocks.generateModel.mock.calls.every(([, options]) => options.providers?.join() === 'deepseek')).toBe(true);
    expect(result.assetSources).toHaveLength(3);
    expect(result.paidCallCount).toBe(4);

    mocks.llmChat.mockReset().mockResolvedValueOnce(JSON.stringify(constructionExpansion(4)));
    mocks.generateModel.mockReset();
    await expect(generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, store)).rejects.toThrow('world_whitebox_asset_generation_limit');
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('does not pay for a requested landmark when its town has no realized building', async () => {
    const expansion = constructionExpansion(1);
    expansion.assets.push({ key: 'unused-cooperative', name: 'Fishing Cooperative', role: 'landmark',
      prompt: 'A coastal cooperative for an unbuilt harbor', strategy: 'single' });
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    mocks.generateModel.mockResolvedValue({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] });
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: 'saved-house' })) } as unknown as MapStore;

    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 2, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(mocks.generateModel).toHaveBeenCalledTimes(1);
    expect(result.paidCallCount).toBe(2);
    expect(result.draft.assets.map(asset => asset.key)).toEqual(['asset-1', 'unused-cooperative']);
    expect(result.assetSources?.map(asset => asset.id)).toEqual(['asset-1']);
  });

  it('rejects assembly requests before any paid asset generation', async () => {
    const expansion = constructionExpansion(1);
    expansion.assets[0].strategy = 'assembly';
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    await expect(generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, {} as MapStore)).rejects.toThrow('world_whitebox_direct_asset_required');
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('reuses supplied assets without spending the three-call DeepSeek budget', async () => {
    const expansion = constructionExpansion();
    expansion.assets = [{ key: 'house', name: 'Existing house', role: 'house', prompt: 'Reuse it',
      strategy: 'single', existingAssetId: 'existing-house' }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    const asset = { id: 'existing-house', name: 'Existing house', prompt: 'A market house', tags: ['house'],
      mode: 'voxel-pro', modelJson: { format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {
        width: 8, height: 7, depth: 9 } } }] } };
    const store = { loadAsset: vi.fn().mockResolvedValue(asset), saveAsset: vi.fn() } as unknown as MapStore;
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0, reusableAssetIds: ['existing-house'] }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(result.paidCallCount).toBe(1);
    expect(result.assetSources).toEqual([expect.objectContaining({ assetId: 'existing-house', provider: 'existing' })]);
    expect(mocks.generateModel).not.toHaveBeenCalled();
  });

  it('counts a failed DeepSeek request and returns the raw construction with diagnostics instead of repairing it', async () => {
    const expansion = constructionExpansion(1);
    expansion.towns[0].publicBuildings = [{ id: 'school', use: 'village school', width: 8, depth: 8, height: 6,
      assetKey: 'asset-1', siting: 'central' }];
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(expansion));
    mocks.generateModel.mockRejectedValueOnce(new Error('deepseek_unavailable'));
    const store = { saveAsset: vi.fn() } as unknown as MapStore;
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(result.paidCallCount).toBe(2);
    expect(result.assetSources).toEqual([]);
    expect(result.diagnostics.flatMap(item => item.planningIssues)).toContain('asset_generation_failed:deepseek_unavailable');
    expect(result.diagnostics.flatMap(item => item.planningIssues))
      .toContain('explicit_asset_unbound:school:asset-1');
    expect(result.bundle.patches.flatMap(patch => patch.buildings).some(building => building.assetKey === 'asset-1')).toBe(true);
    expect(result.bundle.patches.flatMap(patch => patch.streets).some(street => street.tags.includes('landmark-access'))).toBe(true);
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.generateModel).toHaveBeenCalledTimes(1);
  });

  it('keeps the first generated asset visible when a later paid asset request fails', async () => {
    mocks.llmChat.mockResolvedValueOnce(JSON.stringify(constructionExpansion(2)));
    mocks.generateModel.mockResolvedValueOnce({ format: 2, nodes: [{ id: 'body', mesh: { type: 'box', params: {} } }] })
      .mockRejectedValueOnce(new Error('second_asset_failed'));
    const store = { saveAsset: vi.fn(async (asset: unknown) => ({ ...(asset as object), id: 'saved-first' })) } as unknown as MapStore;
    const result = await generateWorld({ mode: 'construct-whitebox', whiteboxPlan: buildablePlan(), generateAssets: true,
      assetGenerationLimit: 3, repairAttempts: 0 }, store);
    if (!('mode' in result) || result.mode !== 'construct-whitebox') throw new Error('expected_whitebox_construction_result');
    expect(result.paidCallCount).toBe(3);
    expect(result.assetSources).toEqual([expect.objectContaining({ assetId: 'saved-first' })]);
    expect(result.diagnostics.flatMap(item => item.planningIssues)).toContain('asset_generation_failed:second_asset_failed');
    expect(mocks.generateModel).toHaveBeenCalledTimes(2);
  });
});
