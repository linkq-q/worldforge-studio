import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyMap,
  createMapObject,
  getMapBounds,
  MAP_SIZE_PRESETS,
  type MapAsset
} from '../src/shared/map';
import { applyMapOperations } from '../src/shared/mapOperations';
import {
  generateMapSuggestion,
  normalizeMapSuggestion,
  runMapAgent
} from '../src/server/mapAi';
import { planLimits } from '../src/shared/mapPlanning';

const assets = [
  { id: 'asset-tree', name: '松树', prompt: 'low poly pine tree' },
  { id: 'asset-rock', name: '岩石', prompt: 'gray rock' }
] as MapAsset[];

describe('map AI adapter', () => {
  it('places the deterministic terrain base before local terrain and water operations', () => {
    const map = createEmptyMap('terrain plan', 'map-terrain-plan');
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: 'terrain',
      terrainGeneration: { preset: 'valley', amplitude: 5, roughness: 0.6 },
      terrain: [{ mode: 'raise', x: 0, z: 0, size: 2, strength: 0.3 }],
      waters: [{ type: 'lake', points: [[-2, -2], [2, -2], [2, 2], [-2, 2]] }],
      spawn: { x: 0, z: 4 }
    }), map, []);
    const spatialTypes = suggestion.operations
      .map((operation) => operation.type)
      .filter((type) => type !== 'map.update');
    expect(spatialTypes.slice(0, 3)).toEqual(['terrain.generate', 'terrain.brush', 'water.add']);
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
      assetRequestCount: 3
    });
    expect(largeLimits.terrainBrushCount).toBeGreaterThan(smallLimits.terrainBrushCount);
    expect(largeLimits.objectCount).toBeGreaterThan(smallLimits.objectCount);
    expect(largeLimits.assetRequestCount).toBe(8);
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
      waterUpdates: [{ waterId: 'lake-1', level: 0.6 }]
    }), map, assets, 'refine');
    const refined = applyMapOperations(map, suggestion.operations);

    expect(suggestion.operations.filter((operation) => operation.type === 'object.remove')).toHaveLength(2);
    expect(refined.objects).toHaveLength(3);
    expect(refined.waterBodies[0]?.level).toBe(0.6);
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
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      waters: [{
        type: 'lake',
        points: [{ x: -4, z: -4 }, { x: 4, z: -4 }, { x: 4, z: 4 }, { x: -4, z: 4 }]
      }],
      objects: [{ assetId: 'asset-tree', x: 0, z: 0 }],
      spawn: { x: 0, z: 0 }
    }), createEmptyMap('safe spawn', 'map-safe-spawn'), assets);
    const spawn = suggestion.operations.find((operation) => operation.type === 'reference.set');

    expect(spawn?.type).toBe('reference.set');
    if (spawn?.type !== 'reference.set') throw new Error('missing spawn');
    expect(Math.hypot(spawn.point[0], spawn.point[2])).toBeGreaterThan(4.5);
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

  it('generates missing assets and replans with their real ids', async () => {
    const progress: string[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          summary: '需要一棵田园树木',
          assetRequests: [{ name: '田园树', prompt: '低多边形田园树木，无地面和背景' }]
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          summary: '带树木的缓坡田园',
          terrain: [{ mode: 'raise', x: 0, z: 0, size: 5, strength: 0.5 }],
          objects: [{ assetId: 'asset-generated-tree', name: '田园树', x: 2, z: 1 }],
          spawn: { x: 0, z: -4 },
          renderPromptSuggestions: ['素描风格']
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const createAsset = vi.fn().mockResolvedValue({
      id: 'asset-generated-tree',
      name: '田园树',
      prompt: '低多边形田园树木，无地面和背景'
    } as MapAsset);

    const suggestion = await runMapAgent(
      '素描风格的宁静田园，有一些树木',
      createEmptyMap(),
      [],
      {
        apiBase: 'https://example.test',
        provider: 'gpt',
        fetchImpl,
        createAsset,
        onProgress: (event) => progress.push(event.phase)
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(createAsset).toHaveBeenCalledOnce();
    expect(suggestion.generatedAssets).toEqual([{ id: 'asset-generated-tree', name: '田园树' }]);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'object.add',
        object: expect.objectContaining({ assetId: 'asset-generated-tree' })
      })
    ]));
    const secondRequest = JSON.parse(fetchImpl.mock.calls[1][1]?.body as string);
    expect(secondRequest.messages[0].content).toContain('asset-generated-tree');
    expect(progress).toEqual(expect.arrayContaining([
      'planning',
      'checking-assets',
      'generating-asset',
      'replanning',
      'validating',
      'complete'
    ]));
  });

  it('allows the large preset to request up to eight reusable assets', async () => {
    const requests = Array.from({ length: 10 }, (_, index) => ({
      name: `Asset ${index}`,
      prompt: `Reusable low poly asset ${index}`
    }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({ summary: 'asset pass', assetRequests: requests })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          summary: 'final pass',
          assetRequests: [],
          terrain: [{ mode: 'raise', x: 0, z: 0, size: 20, strength: 0.4 }]
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const createAsset = vi.fn().mockImplementation(async (request: { name: string; prompt: string }) => ({
      id: `generated-${request.name}`,
      name: request.name,
      prompt: request.prompt
    } as MapAsset));
    const map = createEmptyMap('large', 'map-large-agent', [...MAP_SIZE_PRESETS[2].size]);

    await runMapAgent('生成大型地图', map, [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      createAsset
    });

    expect(createAsset).toHaveBeenCalledTimes(8);
  });

  it('replans when the first pass only extracts render style', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          summary: '只识别到素描田园氛围',
          renderPromptSuggestions: ['素描风格', '柔和晨雾']
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          summary: '推导出缓坡田园空间',
          terrain: [{ mode: 'raise', x: 0, z: 0, size: 6, strength: 0.35 }],
          spawn: { x: 0, z: -5 },
          renderPromptSuggestions: ['素描风格', '柔和晨雾']
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const suggestion = await runMapAgent('素描风格的宁静田园，带有柔和晨雾', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      createAsset: vi.fn()
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.operations.some((operation) => operation.type === 'terrain.brush')).toBe(true);
    expect(suggestion.operations.some((operation) => operation.type === 'reference.set')).toBe(true);
  });
});
