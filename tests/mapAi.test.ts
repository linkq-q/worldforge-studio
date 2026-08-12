import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyMap,
  createMapObject,
  getMapBounds,
  MAP_SIZE_PRESETS,
  sampleTerrainHeight,
  type MapAsset
} from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import {
  generateMapSuggestion,
  normalizeMapSuggestion,
  runMapAgent
} from '../src/server/mapAi';
import { planLimits } from '../src/shared/mapPlanning';
import { isSpawnPositionSafe } from '../src/shared/mapSpawnSafety';
import { planMapComposition } from '../src/server/mapCompositionWorkflow';
import type { SceneCompositionPlan } from '../src/shared/sceneComposition';

const assets: MapAsset[] = [
  testAsset('asset-tree', 'Pine tree', ['tree', 'vegetation'], 'large'),
  testAsset('asset-rock', 'Rock', ['rock', 'stone'], 'medium')
];

describe('map AI adapter', () => {
  it('can return a director plan before generating any assets', async () => {
    const plan = compositionPlan({
      assetFamilies: [family('chairs', ['chair', 'furniture'], 'medium')],
      zones: [zone('seating', [{ familyId: 'chairs', distribution: 'even' }])]
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(chatResponse(plan));
    const createAsset = vi.fn();

    const approved = await planMapComposition(
      '整齐排列的教堂座席，保留中央过道',
      createEmptyMap('chapel', 'chapel-plan', [16, 3, 12], 'voxel', 'indoor', [16, 3, 12]),
      [],
      { apiBase: 'https://example.test', provider: 'gpt', fetchImpl, minNewAssets: 0, maxNewAssets: 4 }
    );

    expect(approved.zones[0].id).toBe('seating');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(createAsset).not.toHaveBeenCalled();
  });

  it('repairs malformed director requirements locally instead of requesting a full replan', async () => {
    const plan = compositionPlan({
      assetFamilies: [family('chairs', ['chair', 'furniture'], 'medium')],
      zones: [zone('seating', [{ familyId: 'chairs', distribution: 'even' }])],
      intentRequirements: [{
        kind: 'asset', description: 'chairs requested by the user', familyId: 'chairs', minCount: 6
      }]
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(chatResponse(plan));

    const approved = await planMapComposition(
      '教室内整齐排列六把椅子',
      createEmptyMap('classroom', 'classroom-plan', [16, 3, 12], 'voxel', 'indoor', [16, 3, 12]),
      [],
      { apiBase: 'https://example.test', provider: 'gpt', fetchImpl, minNewAssets: 0, maxNewAssets: 4 }
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(approved.intentRequirements).toEqual([expect.objectContaining({
      kind: 'asset-family', familyId: 'chairs', minCount: 6
    })]);
  });

  it('keeps successful indoor assets when one model family fails after its own retries', async () => {
    const blackboardFamily = {
      ...(family('front-blackboard', ['blackboard', 'wall-prop'], 'large') as Record<string, unknown>),
      priority: 1
    };
    const plan = compositionPlan({
      assetFamilies: [blackboardFamily, family('chairs', ['chair', 'furniture'], 'medium')],
      zones: [zone('classroom', [
        { familyId: 'front-blackboard', distribution: 'accent' },
        { familyId: 'chairs', distribution: 'even' }
      ])],
      intentRequirements: [{
        id: 'front-blackboard', kind: 'asset-family', description: 'front blackboard',
        targetZoneId: 'classroom', familyId: 'front-blackboard', minCount: 1
      }]
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(plan))
      .mockResolvedValueOnce(chatResponse(reviewPass()));
    const createAsset = vi.fn()
      .mockRejectedValueOnce(new Error('map_asset_generation_failed:Front blackboard:gpt: HTTP 500'))
      .mockResolvedValueOnce(testAsset('asset-chair', 'Chair', ['chair', 'furniture'], 'medium'));

    const suggestion = await runMapAgent(
      '教室内有前方黑板和整齐排列的椅子',
      createEmptyMap('classroom', 'classroom-soft-asset-failure', [16, 3, 12], 'voxel', 'indoor', [16, 3, 12]),
      [],
      { apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.generatedAssets).toEqual([{ id: 'asset-chair', name: 'Chair' }]);
    expect(suggestion.operations.some((operation) => (
      operation.type === 'object.add' && operation.object.assetId === 'asset-chair'
    ))).toBe(true);
    expect(suggestion.composition?.outcome.checks).toEqual(expect.arrayContaining([expect.objectContaining({
      requirementId: 'front-blackboard', status: 'warning'
    })]));
  });

  it('continues from an approved composition without asking the director to redesign it', async () => {
    const approvedPlan = compositionPlan({
      assetFamilies: [family('chairs', ['chair', 'furniture'], 'medium')],
      zones: [zone('seating', [{ familyId: 'chairs', distribution: 'even' }])]
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(chatResponse(reviewPass()));
    const createAsset = vi.fn().mockResolvedValue(testAsset('approved-chair', 'Approved chair', ['chair', 'furniture'], 'medium'));

    const suggestion = await runMapAgent(
      '整齐排列的教堂座席',
      createEmptyMap('chapel', 'approved-chapel', [16, 3, 12], 'voxel', 'indoor', [16, 3, 12]),
      [],
      {
        apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset,
        approvedCompositionPlan: approvedPlan as SceneCompositionPlan
      }
    );

    expect(createAsset).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(suggestion.composition?.plan.zones[0].id).toBe('seating');
  });

  it('rejects an explicit interior prompt on an outdoor map before calling the model', async () => {
    const fetchImpl = vi.fn();

    await expect(runMapAgent(
      '小教堂内部，木椅整齐分排，中间留出过道，全部朝向讲台。',
      createEmptyMap(),
      [],
      { apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset: vi.fn() }
    )).rejects.toThrow('indoor_prompt_requires_indoor_map');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('composes an indoor chapel without terrain and keeps pew rows facing the altar across a center aisle', async () => {
    const map = createEmptyMap('Chapel', 'map-indoor-chapel', [20, 3, 20], 'voxel', 'indoor', [20, 3, 20]);
    const plan = compositionPlan({
      assetFamilies: [
        family('altar', ['altar', 'lectern'], 'medium'),
        family('pews', ['pew', 'furniture', 'wooden', 'honey-oak'], 'medium')
      ],
      zones: [{
        id: 'sanctuary', label: 'Chapel sanctuary', role: 'primary', importance: 1,
        region: { kind: 'circle', center: [0, -0.68], radius: 0.2 },
        brief: {
          atmosphere: 'quiet chapel sanctuary', hierarchy: 'altar is the clear focus',
          openness: 0.35, transitionIntent: 'opens toward the nave'
        },
        terrain: { elevation: 0, roughness: 0, flatness: 1 },
        layers: [{
          familyId: 'altar', density: 0.01, scaleRange: [1, 1], distribution: 'accent', edgeFalloff: 0,
          placement: { mode: 'anchor', intent: 'landmark', direction: 0, offset: 0, facing: 'guide' }
        }],
        grassLayers: [], excludeZoneIds: []
      }, {
        id: 'left-seating', label: 'Left chapel seating', role: 'secondary', importance: 0.9,
        region: { kind: 'circle', center: [-0.42, 0.08], radius: 0.62 },
        brief: {
          atmosphere: 'orderly wooden pew rows', hierarchy: 'left rows lead to the altar',
          openness: 0.45, transitionIntent: 'preserve the center aisle'
        },
        terrain: { elevation: 0, roughness: 0, flatness: 1 },
        layers: [{
          familyId: 'pews', density: 0.08, scaleRange: [1, 1], distribution: 'even', edgeFalloff: 0,
          placement: {
            mode: 'layout', pattern: 'grid', intent: 'audience', direction: 0, spacing: 2.2,
            offset: 0, facing: 'inward', focusFamilyId: 'altar', maxPerGroup: 8, aisleEvery: 2
          }
        }],
        grassLayers: [], excludeZoneIds: []
      }, {
        id: 'right-seating', label: 'Right chapel seating', role: 'secondary', importance: 0.9,
        region: { kind: 'circle', center: [0.42, 0.08], radius: 0.62 },
        brief: {
          atmosphere: 'orderly wooden pew rows', hierarchy: 'right rows lead to the altar',
          openness: 0.45, transitionIntent: 'preserve the center aisle'
        },
        terrain: { elevation: 0, roughness: 0, flatness: 1 },
        layers: [{
          familyId: 'pews', density: 0.08, scaleRange: [1, 1], distribution: 'even', edgeFalloff: 0,
          placement: {
            mode: 'layout', pattern: 'grid', intent: 'audience', direction: 0, spacing: 2.2,
            offset: 0, facing: 'inward', focusFamilyId: 'altar', maxPerGroup: 8, aisleEvery: 2
          }
        }],
        grassLayers: [], excludeZoneIds: []
      }]
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(plan))
      .mockResolvedValueOnce(chatResponse(reviewPass()));
    const createAsset = vi.fn().mockImplementation(async (request: { tags: string[] }) => {
      if (request.tags.includes('altar')) {
        return testAssetWithBounds(
          'asset-indoor-altar', 'Chapel altar', request.tags, 'medium',
          [-0.85, 0, -0.53], [0.85, 2.25, 0.53]
        );
      }
      return testAssetWithBounds(
        'asset-indoor-pew', 'Wooden pew', request.tags, 'medium',
        [-0.75, 1.22, -0.56], [0.75, 3.475, 0.56]
      );
    });

    const suggestion = await runMapAgent(
      '小教堂室内，木椅整齐分排，中间留出过道，全部朝向讲台。',
      map,
      [],
      { apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset }
    );
    const applied = applyMapOperations(map, suggestion.operations);
    const altar = applied.objects.find((object) => object.assetId === 'asset-indoor-altar');
    const pews = applied.objects.filter((object) => object.assetId === 'asset-indoor-pew');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(createAsset).toHaveBeenCalledTimes(2);
    expect(suggestion.operations.some((operation) => (
      operation.type === 'terrain.generate'
      || operation.type === 'terrain.modify'
      || operation.type === 'terrain.refine'
      || operation.type === 'terrain.brush'
      || operation.type === 'water.add'
      || operation.type.startsWith('grass.')
    ))).toBe(false);
    expect(altar).toBeDefined();
    expect(pews.length).toBeGreaterThanOrEqual(40);
    expect(pews.length).toBeLessThanOrEqual(200);
    expect(applied.objects.some((object) => object.id.startsWith('population-'))).toBe(false);
    expect(pews.every((pew) => pew.transform.scale[0] < 0.61)).toBe(true);
    expect(pews.every((pew) => Math.abs(pew.transform.position[1]) < 0.001)).toBe(true);
    expect(pews.every((pew) => (
      pew.transform.position[1] + (3.475 - 1.22) * pew.transform.scale[1] <= 2.84
    ))).toBe(true);
    expect(pews.some((pew) => pew.transform.position[0] < -0.8)).toBe(true);
    expect(pews.some((pew) => pew.transform.position[0] > 0.8)).toBe(true);
    expect(pews.every((pew) => Math.abs(pew.transform.position[0]) > 0.6)).toBe(true);
    expect(pews.every((pew) => {
      const position = pew.transform.position;
      const forward = [Math.sin(pew.transform.rotation[1]), Math.cos(pew.transform.rotation[1])];
      const toAltar = [altar!.transform.position[0] - position[0], altar!.transform.position[2] - position[2]];
      const distance = Math.hypot(toAltar[0], toAltar[1]);
      return (forward[0] * toAltar[0] + forward[1] * toAltar[1]) / distance > 0.98;
    })).toBe(true);
    expect(applied.objects.every((object) => (
      Math.abs(object.transform.position[0]) <= 9.4
      && Math.abs(object.transform.position[2]) <= 9.4
    ))).toBe(true);
  });

  it('places the deterministic terrain base before local terrain and water operations', () => {
    const map = createEmptyMap('terrain plan', 'map-terrain-plan');
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: 'terrain',
      terrainGeneration: { preset: 'valley', amplitude: 5, roughness: 0.6 },
      terrain: [{ mode: 'raise', x: 0, z: 0, size: 2, strength: 0.3 }],
      waters: [{
        type: 'lake', points: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
        shorelineSmoothness: 0.9, shorelineIrregularity: 0.2, seed: 17
      }],
      spawn: { x: 0, z: 4 }
    }), map, []);
    const spatialTypes = suggestion.operations
      .map((operation) => operation.type)
      .filter((type) => type !== 'map.update');
    expect(spatialTypes.slice(0, 3)).toEqual(['terrain.generate', 'terrain.brush', 'water.add']);
    expect(suggestion.operations.find((operation) => operation.type === 'water.add')).toMatchObject({
      water: { shorelineSmoothness: 0.9, shorelineIrregularity: 0.2, seed: 17 }
    });
  });

  it('normalizes reusable terrain modifiers and surfaces independently of the base preset', () => {
    const map = createEmptyMap('composable terrain', 'map-composable-terrain');
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: 'cliff mountain with sand below',
      terrainGeneration: { preset: 'hills', amplitude: 6, roughness: 0.45 },
      terrainModifiers: [{
        modifier: 'cliff', layout: 'wall',
        region: { kind: 'path', points: [[-8, 0], [8, 0]], width: 5 },
        amplitude: 7, softness: 0
      }],
      terrainSurfaces: [{
        surface: 'sand', region: { kind: 'circle', x: 0, z: -8, radius: 6 }, zoneId: 'lower-sand'
      }]
    }), map, []);

    expect(suggestion.operations.map((operation) => operation.type)).toEqual([
      'terrain.generate', 'terrain.modify', 'terrain.surface'
    ]);
    const applied = applyMapOperations(map, suggestion.operations);
    expect(applied.visualSemantics.zones).toContainEqual(expect.objectContaining({
      id: 'lower-sand', tags: expect.arrayContaining(['sand'])
    }));
  });

  it('normalizes ridge, basin and post-sculpt terrain refinement in execution order', () => {
    const map = createEmptyMap('refined landforms', 'map-refined-landforms');
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: 'soft ridge and basin',
      terrainGeneration: { preset: 'hills', amplitude: 4, roughness: 0.4 },
      terrainModifiers: [
        { modifier: 'ridge', access: 'scenic', region: { kind: 'path', points: [[-12, -4], [12, -4]], width: 8 }, amplitude: 4 },
        { modifier: 'basin', region: { kind: 'circle', x: 7, z: 8, radius: 5 }, amplitude: 2 }
      ],
      terrainRefinement: { erosion: 0.28, drainage: 0.1, iterations: 4, talus: 44 }
    }), map, []);

    expect(suggestion.operations.map((operation) => operation.type)).toEqual([
      'terrain.generate', 'terrain.modify', 'terrain.modify', 'terrain.refine'
    ]);
    expect(suggestion.operations.at(-1)).toMatchObject({
      type: 'terrain.refine', erosion: 0.28, drainage: 0.1, iterations: 4, talus: 44
    });
    expect(suggestion.operations.find((operation) => operation.type === 'terrain.modify')).toMatchObject({
      type: 'terrain.modify', modifier: 'ridge', access: 'scenic'
    });
  });

  it('scales planning quotas with the selected map size', () => {
    const small = createEmptyMap('small', 'map-small', [...MAP_SIZE_PRESETS[0].size]);
    const large = createEmptyMap('large', 'map-large', [...MAP_SIZE_PRESETS[2].size]);
    const smallLimits = planLimits(getMapBounds(small));
    const largeLimits = planLimits(getMapBounds(large));

    expect(smallLimits).toMatchObject({
      terrainBrushCount: 12,
      brushRadiusMax: 8,
      objectCount: 25,
      waterCount: 3,
      assetRequestCount: 4,
      assetVariantMin: 2,
      assetVariantMax: 4
    });
    expect(largeLimits.terrainBrushCount).toBeGreaterThan(smallLimits.terrainBrushCount);
    expect(largeLimits.objectCount).toBeGreaterThan(smallLimits.objectCount);
    expect(largeLimits.assetRequestCount).toBe(14);
    expect(largeLimits.assetVariantMin).toBe(8);
  });

  it('refines existing objects and water with deterministic delta operations', () => {
    const map = createEmptyMap('refine', 'map-refine');
    map.objects = Array.from({ length: 5 }, (_, index) => ({
      ...createMapObject(`Tree ${index + 1}`, 'asset-tree'),
      id: `tree-${index + 1}`
    }));
    map.waterBodies = [{
      id: 'lake-1',
      name: 'Lake',
      type: 'lake',
      level: 0.2,
      depth: 1.5,
      width: 2,
      points: [[-3, -3], [3, -3], [0, 3]]
    }];

    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: '树少一点，湖面更高',
      objectRemovals: [{ assetId: 'asset-tree', count: 2, seed: 7 }],
      waterUpdates: [{
        waterId: 'lake-1',
        level: 0.6,
        shorelineSmoothness: 0.9,
        shorelineIrregularity: 0.22,
        seed: 11
      }]
    }), map, assets, 'refine');
    const refined = applyMapOperations(map, suggestion.operations);

    expect(suggestion.operations.filter((operation) => operation.type === 'object.remove')).toHaveLength(2);
    expect(refined.objects).toHaveLength(3);
    expect(refined.waterBodies[0]?.level).toBe(0.6);
    expect(refined.waterBodies[0]).toMatchObject({
      shorelineSmoothness: 0.9,
      shorelineIrregularity: 0.22,
      seed: 11
    });
  });

  it('bounds refine operations to one visual zone and preserves locked zone fields', () => {
    const map = createEmptyMap('zone refine', 'map-zone-refine');
    map.visualSemantics.zones = [{
      id: 'focus', tags: ['grass'], center: [0, 0], radius: 5, intensity: 0.8,
      locks: { radius: true }
    }];
    const inside = { ...createMapObject('Inside', 'asset-tree'), id: 'inside' };
    inside.transform.position = [0, 0, 0];
    const outside = { ...createMapObject('Outside', 'asset-tree'), id: 'outside' };
    outside.transform.position = [12, 0, 0];
    map.objects = [inside, outside];

    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: 'only focus',
      terrainGeneration: { preset: 'hills', amplitude: 4 },
      visualZoneUpdates: [{ zoneId: 'focus', radius: 12, intensity: 0.4 }],
      objectUpdates: [
        { objectId: 'inside', x: 1, z: 1 },
        { objectId: 'outside', x: 0, z: 0 }
      ]
    }), map, assets, 'refine', 'focus');
    const refined = applyMapOperations(map, suggestion.operations);

    expect(suggestion.operations.some((operation) => operation.type === 'terrain.generate')).toBe(false);
    expect(suggestion.operations.filter((operation) => operation.type === 'object.update')).toHaveLength(1);
    expect(refined.objects.find((object) => object.id === 'outside')?.transform.position[0]).toBe(12);
    expect(refined.visualSemantics.zones[0]).toMatchObject({ radius: 5, intensity: 0.4 });
  });

  it('restricts the global base-terrain pass to one shared height field', () => {
    const map = createEmptyMap('base terrain', 'map-base-terrain');
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: 'shared hills',
      terrainGeneration: { preset: 'hills', amplitude: 5 },
      terrainModifiers: [{ modifier: 'dune', region: { kind: 'circle', x: 0, z: 0, radius: 8 } }],
      objects: [{ assetId: 'asset-tree', x: 0, z: 0 }],
      renderPromptSuggestions: ['misty']
    }), map, assets, 'refine', undefined, undefined, true);

    expect(suggestion.operations.map((operation) => operation.type)).toEqual(['terrain.generate']);
  });

  it('retries once when the global base-terrain response omits terrain generation', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse({ summary: 'no terrain yet', renderPromptSuggestions: ['misty'] }))
      .mockResolvedValueOnce(chatResponse({
        summary: 'shared valley',
        terrainGeneration: { preset: 'valley', amplitude: 5, roughness: 0.5 }
      }));

    const suggestion = await runMapAgent('a shared valley base', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset: vi.fn(),
      mode: 'refine', baseTerrainOnly: true, minNewAssets: 0, maxNewAssets: 0
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.operations.some((operation) => operation.type === 'terrain.generate')).toBe(true);
  });

  it('regenerates one ecology region with terrain overlap at its shared boundary', () => {
    const map = createEmptyMap('regions', 'map-regions');
    map.layout.regions = [{
      id: 'left', name: 'Left', prompt: 'forest', groupId: null, color: '#49a078',
      points: [[-24, -24], [0, -24], [0, 24], [-24, 24]],
      boundaryLocked: false, contentLocked: false
    }, {
      id: 'right', name: 'Right', prompt: 'desert', groupId: null, color: '#db8a4b',
      points: [[0, -24], [24, -24], [24, 24], [0, 24]],
      boundaryLocked: false, contentLocked: false
    }];
    const old = { ...createMapObject('old tree', 'asset-tree'), id: 'old-tree' };
    old.transform.position = [-8, 0, 0];
    old.generation = { kind: 'region', id: 'left', generationId: 'old-generation' };
    map.objects = [old];

    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: 'replace left',
      renderPromptSuggestions: ['global style must not change'],
      objectRemovals: [{ objectIds: ['old-tree'] }],
      terrain: [{ mode: 'raise', x: -1, z: 0, size: 5, strength: 1 }],
      terrainModifiers: [{ modifier: 'dune', region: { kind: 'circle', x: -1, z: 0, radius: 5 } }],
      waters: [{ type: 'lake', points: [[-3, -3], [2, -3], [-3, 2]] }],
      objects: [{ assetId: 'asset-tree', x: -10, z: 0 }]
    }), map, assets, 'refine', undefined, 'left');

    expect(suggestion.operations.filter((operation) => operation.type === 'object.remove')).toHaveLength(1);
    expect(suggestion.operations.some((operation) => operation.type === 'map.update')).toBe(false);
    expect(suggestion.operations.some((operation) => operation.type === 'terrain.brush')).toBe(true);
    expect(suggestion.operations.some((operation) => operation.type === 'terrain.modify')).toBe(true);
    expect(suggestion.operations.some((operation) => operation.type === 'water.add')).toBe(false);
    expect(suggestion.operations.find((operation) => operation.type === 'object.add')).toEqual(expect.objectContaining({
      object: expect.objectContaining({ generation: expect.objectContaining({ kind: 'region', id: 'left' }) })
    }));
    const applied = applyMapOperations(map, suggestion.operations);
    expect(sampleTerrainHeight(applied, 1, 0)).toBeGreaterThan(0);
  });

  it('expands scatter intent into final object operations', () => {
    const map = createEmptyMap('scatter', 'map-ai-scatter');
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: '树林环绕湖泊',
      waters: [{
        type: 'lake',
        points: [{ x: -4, z: -4 }, { x: 4, z: -4 }, { x: 4, z: 4 }, { x: -4, z: 4 }]
      }],
      scatters: [{
        assetIds: ['asset-tree'],
        region: { kind: 'circle', x: 0, z: 0, r: 20 },
        density: 0.04,
        avoidWater: 1,
        maxSlope: 30,
        minSpacing: 2.5,
        scaleRange: [0.8, 1.2],
        seed: 9
      }]
    }), map, assets);

    const objectOperations = suggestion.operations.filter((operation) => operation.type === 'object.add');
    expect(objectOperations.length).toBeGreaterThan(0);
    expect(objectOperations.length).toBeLessThanOrEqual(planLimits(getMapBounds(map)).objectCount);
    expect(suggestion.operations.some((operation) => (operation as { type: string }).type === 'scatter')).toBe(false);
  });

  it.each([
    ['radius alias', { kind: 'circle', x: -12, z: 0, radius: 8 }],
    ['polygon region', { kind: 'polygon', points: [[-22, -12], [-2, -12], [-2, 12], [-22, 12]] }],
    ['path region', { kind: 'path', points: [[-20, -8], [-8, 0], [-4, 10]], width: 5 }],
    ['omitted region', undefined]
  ])('normalizes the %s scatter form inside a targeted ecology region', (_label, region) => {
    const map = createEmptyMap('region scatter', 'map-region-scatter');
    map.layout.regions = [{
      id: 'left', name: 'Left', prompt: 'forest', groupId: null, color: '#49a078',
      points: [[-24, -24], [0, -24], [0, 24], [-24, 24]],
      boundaryLocked: false, contentLocked: false
    }, {
      id: 'right', name: 'Right', prompt: 'desert', groupId: null, color: '#db8a4b',
      points: [[0, -24], [24, -24], [24, 24], [0, 24]],
      boundaryLocked: false, contentLocked: false
    }];
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: 'fill the left region',
      scatters: [{
        assetIds: ['asset-tree'],
        ...(region ? { region } : {}),
        density: 0.04,
        minSpacing: 2,
        seed: 13
      }]
    }), map, assets, 'refine', undefined, 'left');
    const additions = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(additions.length).toBeGreaterThan(0);
    expect(additions.every((operation) => (operation.object.transform?.position?.[0] ?? 1) <= 0)).toBe(true);
  });

  it('keeps spacing between placements from separate scatter plans', () => {
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      scatters: [
        {
          assetIds: ['asset-tree'],
          region: { kind: 'circle', x: 0, z: 0, r: 12 },
          density: 0.01,
          minSpacing: 3.5,
          seed: 3
        },
        {
          assetIds: ['asset-rock'],
          region: { kind: 'circle', x: 0, z: 0, r: 12 },
          density: 0.01,
          minSpacing: 3.5,
          seed: 5
        }
      ]
    }), createEmptyMap('scatter', 'map-multi-scatter'), assets);
    const positions = suggestion.operations
      .filter((operation) => operation.type === 'object.add')
      .map((operation) => operation.object.transform?.position)
      .filter((position): position is [number, number, number] => Boolean(position));

    expect(positions.length).toBeGreaterThan(1);
    for (let index = 0; index < positions.length; index += 1) {
      for (let other = index + 1; other < positions.length; other += 1) {
        expect(Math.hypot(
          positions[index][0] - positions[other][0],
          positions[index][2] - positions[other][2]
        )).toBeGreaterThanOrEqual(3.5);
      }
    }
  });

  it('moves a requested spawn away from water and placed objects', () => {
    const map = createEmptyMap('safe spawn', 'map-safe-spawn');
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      waters: [{
        type: 'lake',
        points: [{ x: -4, z: -4 }, { x: 4, z: -4 }, { x: 4, z: 4 }, { x: -4, z: 4 }]
      }],
      objects: [{ assetId: 'asset-tree', x: 0, z: 0 }],
      spawn: { x: 0, z: 0 }
    }), map, assets);
    const spawn = suggestion.operations.find((operation) => operation.type === 'reference.set');

    expect(spawn?.type).toBe('reference.set');
    if (spawn?.type !== 'reference.set') throw new Error('missing spawn');
    const preview = applyMapOperations(map, suggestion.operations);
    expect(isSpawnPositionSafe(preview, spawn.point[0], spawn.point[2])).toBe(true);
  });

  it('converts a bounded plan into the shared MapOperation protocol', () => {
    const map = createEmptyMap('test', 'map-ai-test');
    map.box.size = [20, 8, 20];
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: '中央小丘和两棵松树',
      terrain: [{ mode: 'raise', x: 0, z: 0, size: 4, strength: 1 }],
      waters: [{
        type: 'lake',
        name: '丘边湖泊',
        level: 0.35,
        points: [{ x: -4, z: -2 }, { x: 1, z: -3 }, { x: 3, z: 2 }, { x: -3, z: 3 }]
      }],
      objects: [
        { assetId: 'asset-tree', name: '松树 A', x: 1, z: 1, rotationYDeg: 90, scale: 1.2 },
        { assetId: 'asset-tree', name: '松树 B', x: -2, z: 2 }
      ],
      spawn: { x: 0, z: -4, yawDeg: 15 },
      renderPromptSuggestions: ['柔和晨雾', ' pastoral ', '柔和晨雾']
    }), map, assets);

    expect(suggestion.summary).toBe('中央小丘和两棵松树');
    expect(suggestion.renderPromptSuggestions).toEqual(['柔和晨雾', 'pastoral']);
    expect(suggestion.operations.map((operation) => operation.type)).toEqual([
      'map.update',
      'terrain.brush',
      'water.add',
      'object.add',
      'object.add',
      'reference.set'
    ]);
    expect(suggestion.operations[2]).toMatchObject({
      type: 'water.add',
      water: {
        type: 'lake',
        level: 0.35,
        points: [[-4, -2], [1, -3], [3, 2], [-3, 3]]
      }
    });
    expect(suggestion.operations[3]).toMatchObject({
      type: 'object.add',
      object: {
        assetId: 'asset-tree',
        transform: { position: [1, expect.any(Number), 1], scale: [1.2, 1.2, 1.2] }
      }
    });
  });

  it('rejects assets outside the supplied library', () => {
    expect(() => normalizeMapSuggestion(JSON.stringify({
      objects: [{ assetId: 'unknown', x: 0, z: 0 }]
    }), createEmptyMap(), assets)).toThrow('unknown_map_asset');
  });

  it('calls the existing chat API and returns a validated suggestion', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({
        summary: '一块小丘',
        terrain: [{ mode: 'raise', x: 0, z: 0, size: 3, strength: 0.8 }]
      })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const suggestion = await generateMapSuggestion('生成中央小丘', createEmptyMap(), assets, {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl
    });

    expect(suggestion.operations).toHaveLength(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.test/api/chat');
  });

  it('reuses a specifically matching existing asset only when reuse is enabled', async () => {
    const progress: string[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(compositionPlan({
        assetFamilies: [family('trees', ['tree', 'vegetation'], 'large')],
        zones: [zone('grove', [{ familyId: 'trees', distribution: 'clustered' }])]
      })))
      .mockResolvedValueOnce(chatResponse(reviewPass()));
    let generatedIndex = 0;
    const createAsset = vi.fn().mockImplementation(async () => {
      generatedIndex += 1;
      return testAsset(
        `asset-generated-tree-${generatedIndex}`,
        `Pastoral tree ${generatedIndex}`,
        ['tree', 'vegetation'],
        'large',
        'curve'
      );
    });

    const suggestion = await runMapAgent(
      'A quiet pastoral grove',
      { ...createEmptyMap(), assetGenerationMode: 'curve' },
      [testAsset('asset-voxel-tree', 'Old voxel tree', ['tree', 'vegetation'], 'large', 'voxel')],
      {
        apiBase: 'https://example.test',
        provider: 'gpt',
        fetchImpl,
        createAsset,
        reuseExistingAssets: true,
        onProgress: (event) => progress.push(event.phase)
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(createAsset).not.toHaveBeenCalled();
    expect(JSON.stringify(suggestion.operations)).toContain('asset-voxel-tree');
    expect(suggestion.generatedAssets).toHaveLength(0);
    expect(progress).toEqual(expect.arrayContaining([
      'composing',
      'resolving-assets',
      'compiling',
      'reviewing',
      'validating',
      'complete'
    ]));
  });

  it('retries a refine plan once when it misses the requested minimum new assets', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse({ summary: 'too few', assetRequests: [], terrain: [{ mode: 'raise', x: 0, z: 0 }] }))
      .mockResolvedValueOnce(chatResponse({
        summary: 'request one',
        assetRequests: [{ name: 'Pine', prompt: 'one reusable pine tree', tags: ['tree'] }],
        terrain: [{ mode: 'raise', x: 0, z: 0 }]
      }))
      .mockResolvedValueOnce(chatResponse({
        summary: 'place generated asset',
        assetRequests: [],
        objects: [{ assetId: 'asset-new-pine', x: 0, z: 0 }]
      }));
    const createAsset = vi.fn().mockResolvedValue(testAsset('asset-new-pine', 'Pine', ['tree'], 'large'));

    const suggestion = await runMapAgent('add a pine', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset,
      mode: 'refine', minNewAssets: 1, maxNewAssets: 2
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(createAsset).toHaveBeenCalledOnce();
    expect(JSON.stringify(suggestion.operations)).toContain('asset-new-pine');
  });

  it('locally places generated assets omitted by the final refine pass without another AI request', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse({
        summary: 'request one',
        assetRequests: [{ name: 'Pine', prompt: 'one reusable pine tree', tags: ['tree'] }]
      }))
      .mockResolvedValueOnce(chatResponse({
        summary: 'terrain only by mistake',
        assetRequests: [],
        terrain: [{ mode: 'raise', x: 0, z: 0 }]
      }));
    const createAsset = vi.fn().mockResolvedValue(testAsset('asset-new-pine', 'Pine', ['tree'], 'large'));

    const suggestion = await runMapAgent('add a pine', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset,
      mode: 'refine', minNewAssets: 0, maxNewAssets: 2
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(suggestion.operations)).toContain('asset-new-pine');
  });

  it('keeps other refine operations when a generated asset has no legal placement', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse({
        summary: 'request one',
        assetRequests: [{ name: 'Huge prop', prompt: 'one huge prop', tags: ['prop'] }]
      }))
      .mockResolvedValueOnce(chatResponse({
        summary: 'terrain survives', assetRequests: [], terrain: [{ mode: 'raise', x: 0, z: 0 }]
      }));
    const huge = testAsset('asset-huge-prop', 'Huge prop', ['prop'], 'large');
    huge.footprintRadius = 100;

    const suggestion = await runMapAgent(
      'add a huge prop and raise the ground',
      createEmptyMap('tiny', 'map-tiny-refine', [4, 4, 4]),
      [],
      { apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset: vi.fn().mockResolvedValue(huge), mode: 'refine' }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.operations.some((operation) => operation.type === 'terrain.brush')).toBe(true);
    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(false);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'asset.unplaced' })]));
  });

  it('deterministically places generated assets inside the target region when the retry still omits them', async () => {
    const map = createEmptyMap('regions', 'map-region-fallback');
    map.layout.regions = [{
      id: 'left', name: 'Left', prompt: 'forest', groupId: null, color: '#49a078',
      points: [[-24, -24], [0, -24], [0, 24], [-24, 24]],
      boundaryLocked: false, contentLocked: false
    }, {
      id: 'right', name: 'Right', prompt: 'desert', groupId: null, color: '#db8a4b',
      points: [[0, -24], [24, -24], [24, 24], [0, 24]],
      boundaryLocked: false, contentLocked: false
    }];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse({
        assetRequests: [{ name: 'Pine', prompt: 'one reusable pine tree', tags: ['tree'] }]
      }))
      .mockResolvedValueOnce(chatResponse({ terrain: [{ mode: 'raise', x: -10, z: 0 }] }))
      .mockResolvedValueOnce(chatResponse({ terrain: [{ mode: 'raise', x: -10, z: 0 }] }));
    const createAsset = vi.fn().mockResolvedValue(testAsset('asset-new-pine', 'Pine', ['tree'], 'small'));

    const suggestion = await runMapAgent('add a pine forest', map, [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset,
      mode: 'refine', minNewAssets: 0, maxNewAssets: 2, targetRegionId: 'left'
    });
    const placement = suggestion.operations.find((operation) => (
      operation.type === 'object.add' && operation.object.assetId === 'asset-new-pine'
    ));

    expect(placement?.type).toBe('object.add');
    if (placement?.type !== 'object.add') throw new Error('missing deterministic placement');
    expect(placement.object.transform?.position?.[0]).toBeLessThanOrEqual(0);
    expect(placement.object.generation).toMatchObject({ kind: 'region', id: 'left' });
  });

  it('generates a fresh asset by default even when an old asset has matching broad tags', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(compositionPlan({
        assetFamilies: [family('trees', ['tree', 'vegetation'], 'large')],
        zones: [zone('grove', [{ familyId: 'trees', distribution: 'clustered' }])]
      })))
      .mockResolvedValueOnce(chatResponse(reviewPass()));
    const createAsset = vi.fn().mockResolvedValue(
      testAsset('asset-fresh-tree', 'Fresh tree', ['tree', 'vegetation'], 'large', 'curve')
    );

    const suggestion = await runMapAgent(
      'A quiet pastoral grove',
      { ...createEmptyMap(), assetGenerationMode: 'curve' },
      [testAsset('asset-old-tree', 'Old tree', ['tree', 'vegetation'], 'large')],
      { apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset }
    );

    expect(createAsset).toHaveBeenCalledOnce();
    expect(JSON.stringify(suggestion.operations)).toContain('asset-fresh-tree');
    expect(JSON.stringify(suggestion.operations)).not.toContain('asset-old-tree');
  });

  it('repairs a malformed scene zone twice before rejecting the composition', async () => {
    const malformedPlan = compositionPlan({
      zones: [{ id: 'main', label: 'Main zone', role: 'focal' }]
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(malformedPlan))
      .mockResolvedValueOnce(chatResponse(malformedPlan))
      .mockResolvedValueOnce(chatResponse(compositionPlan()))
      .mockResolvedValueOnce(chatResponse(reviewPass()));

    await expect(runMapAgent(
      'A quiet pastoral grove',
      createEmptyMap(),
      [],
      { apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset: vi.fn() }
    )).resolves.toEqual(expect.objectContaining({ operations: expect.any(Array) }));
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('exposes only the explicitly selected asset-library ids for reuse', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(compositionPlan({
        assetFamilies: [family('trees', ['pine', 'tree'], 'large')],
        zones: [zone('forest grove', [{ familyId: 'trees', distribution: 'accent' }])]
      })))
      .mockResolvedValueOnce(chatResponse(reviewPass()));
    const selected: MapAsset = {
      ...testAsset('asset-selected-pine', 'Selected pine', ['pine', 'tree'], 'large'),
      libraryId: 'library-forest',
      libraryMetadata: {
        tags: ['pine', 'tree'],
        applicableZones: ['forest'],
        repeatable: true,
        landmark: false,
        enabled: true,
        priority: 1,
        analysisStatus: 'ready' as const,
        rotation: 'random' as const
      }
    };
    const unselected = testAsset('asset-unselected-pine', 'Unselected pine', ['pine', 'tree'], 'large');

    const suggestion = await runMapAgent('pine forest', createEmptyMap(), [selected, unselected], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      createAsset: vi.fn(),
      reuseExistingAssets: true,
      reusableAssetIds: [selected.id]
    });

    expect(JSON.stringify(suggestion.operations)).toContain(selected.id);
    expect(JSON.stringify(suggestion.operations)).not.toContain(unselected.id);
    expect(suggestion.reusedAssets).toEqual([{ id: selected.id, name: selected.name, libraryId: 'library-forest' }]);
  });

  it('allows the large preset to generate all ten requested reusable assets', async () => {
    const families = Array.from({ length: 10 }, (_, index) => family(`asset-${index}`, [`tag-${index}`], 'small'));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(compositionPlan({ assetFamilies: families })))
      .mockResolvedValueOnce(chatResponse(reviewPass()));
    const createAsset = vi.fn().mockImplementation(async (request: { name: string; prompt: string; tags: string[] }) => (
      testAsset(`generated-${request.name}`, request.name, request.tags, 'small')
    ));
    const map = createEmptyMap('large', 'map-large-agent', [...MAP_SIZE_PRESETS[2].size]);

    await runMapAgent('生成大型地图', map, [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      createAsset
    });

    expect(createAsset).toHaveBeenCalledTimes(10);
  });

  it('repairs an invalid director response once before continuing', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse({ summary: 'style only', renderPromptSuggestions: ['sketch'] }))
      .mockResolvedValueOnce(chatResponse(compositionPlan()))
      .mockResolvedValueOnce(chatResponse(reviewPass()));

    const suggestion = await runMapAgent('素描风格的宁静田园，带有柔和晨雾', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      createAsset: vi.fn()
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(suggestion.operations.some((operation) => operation.type === 'terrain.generate')).toBe(true);
    expect(suggestion.operations.some((operation) => operation.type === 'reference.set')).toBe(false);
  });

  it('runs only director-requested specialists and applies their bounded advice before review', async () => {
    const plan = compositionPlan({
      consultations: [{
        id: 'shore-specialist',
        discipline: 'shoreline ecology',
        targetZoneIds: ['main'],
        question: 'How should the region edge become more natural?',
        priority: 0.9
      }]
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chatResponse(plan))
      .mockResolvedValueOnce(chatResponse({
        summary: 'Use a softer transition.',
        findings: [{ code: 'edge.hard', severity: 'warning', message: 'The region edge is abrupt.' }],
        patches: [{ type: 'zone.update', zoneId: 'main', radius: 0.72 }]
      }))
      .mockResolvedValueOnce(chatResponse(reviewPass()));
    const progress: string[] = [];

    const suggestion = await runMapAgent('a natural scene', createEmptyMap(), assets, {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      createAsset: vi.fn(),
      reuseExistingAssets: true,
      onProgress: (event) => progress.push(event.phase)
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(progress).toContain('consulting');
    expect(suggestion.composition?.consultations).toHaveLength(1);
    expect(suggestion.composition?.plan.zones[0].region.radius).toBe(0.72);
  });

  it('places multiple accents safely before deterministic validation', async () => {
    const progress: string[] = [];
    const duplicatePlan = compositionPlan({
      assetFamilies: [
        family('trees', ['tree'], 'large'),
        family('rocks', ['rock'], 'medium')
      ],
      zones: [zone('focus', [
        { familyId: 'trees', distribution: 'accent' },
        { familyId: 'rocks', distribution: 'accent' }
      ])]
    });
    const responses = [chatResponse(duplicatePlan), chatResponse(reviewPass())];
    const fetchImpl = vi.fn().mockImplementation(async () => responses.shift());

    const suggestion = await runMapAgent('place trees', createEmptyMap(), assets, {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      createAsset: vi.fn(),
      reuseExistingAssets: true,
      onProgress: (event) => progress.push(event.phase)
    });
    const applied = applyMapOperations(createEmptyMap(), suggestion.operations);

    expect(progress).toContain('validating');
    expect(suggestion.diagnostics?.some((issue) => issue.code === 'object.overlap')).toBe(false);
    expect(applied.objects).toHaveLength(2);
  });
});

function compositionPlan(overrides: {
  assetFamilies?: unknown[];
  zones?: unknown[];
  consultations?: unknown[];
  intentRequirements?: unknown[];
} = {}): unknown {
  const zones = overrides.zones ?? [zone('main', [])];
  const focalZoneId = (zones[0] as { id: string }).id;
  return {
    version: 1,
    summary: 'A coherent generated scene',
    globalBrief: {
      spatialTheme: 'A scene organized around one readable visual idea.',
      visualHierarchy: 'The focal zone is framed by quieter surrounding space.',
      assetArtDirection: 'Consistent silhouettes, palette, proportions, and generation mode.',
      focalZoneId,
      terrainBase: { preset: 'hills', seed: 17, amplitude: 3, roughness: 0.45 }
    },
    zones,
    transitions: [],
    assetFamilies: overrides.assetFamilies ?? [],
    ...(overrides.intentRequirements ? { intentRequirements: overrides.intentRequirements } : {}),
    consultations: overrides.consultations ?? [],
    renderPromptSuggestions: ['soft morning atmosphere']
  };
}

function family(id: string, tags: string[], sizeClass: 'small' | 'medium' | 'large'): unknown {
  return {
    id,
    label: id,
    role: `${id} scene role`,
    tags,
    sizeClass,
    desiredVariants: 1,
    priority: 0.8,
    generationBrief: `One reusable ${id} asset.`
  };
}

function zone(
  id: string,
  layers: Array<{ familyId: string; distribution: 'even' | 'clustered' | 'accent' }>
): unknown {
  return {
    id,
    label: id,
    role: 'primary',
    importance: 1,
    region: { kind: 'circle', center: [0, 0], radius: 0.65 },
    brief: {
      atmosphere: 'coherent',
      hierarchy: 'readable focal structure',
      openness: 0.45,
      transitionIntent: 'soft edge'
    },
    terrain: { elevation: 0.1, roughness: 0.5, flatness: 0.2 },
    layers: layers.map((layer) => ({
      ...layer,
      density: layer.distribution === 'accent' ? 0.01 : 0.05,
      scaleRange: [0.9, 1.1],
      edgeFalloff: 0.25
    })),
    excludeZoneIds: []
  };
}

function reviewPass(): unknown {
  return { status: 'pass', summary: 'Composition is coherent.', findings: [], patches: [] };
}

function chatResponse(content: unknown): Response {
  return new Response(JSON.stringify({ ok: true, content: JSON.stringify(content) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function testAsset(
  id: string,
  name: string,
  tags: string[],
  sizeClass: 'small' | 'medium' | 'large',
  mode = 'voxel'
): MapAsset {
  return {
    id,
    name,
    prompt: name,
    tags,
    sizeClass,
    footprintRadius: sizeClass === 'large' ? 1.2 : 0.6,
    modelJson: {},
    colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
    mode,
    createdAt: 1,
    updatedAt: 1
  };
}

function testAssetWithBounds(
  id: string,
  name: string,
  tags: string[],
  sizeClass: 'small' | 'medium' | 'large',
  min: [number, number, number],
  max: [number, number, number]
): MapAsset {
  return {
    ...testAsset(id, name, tags, sizeClass),
    footprintRadius: Math.max(Math.abs(min[0]), Math.abs(max[0]), Math.abs(min[2]), Math.abs(max[2])),
    modelJson: {
      nodes: [{
        id: `${id}-visual`,
        transform: { pos: [0, (max[1] - min[1]) / 2, 0] },
        mesh: { type: 'box', params: { width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] } }
      }]
    },
    colliderPlan: {
      version: 1,
      boxes: [{ min, max, sourceNodeId: 'test-mesh' }],
      sourceMeshCount: 1,
      candidateCount: 1,
      fallbackUsed: false
    }
  };
}
