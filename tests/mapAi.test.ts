import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import {
  generateMapSuggestion,
  normalizeMapSuggestion,
  runMapAgent
} from '../src/server/mapAi';

const assets = [
  { id: 'asset-tree', name: '松树', prompt: 'low poly pine tree' },
  { id: 'asset-rock', name: '岩石', prompt: 'gray rock' }
] as MapAsset[];

describe('map AI adapter', () => {
  it('converts a bounded plan into the shared MapOperation protocol', () => {
    const map = createEmptyMap('test', 'map-ai-test');
    map.box.size = [20, 8, 20];
    const suggestion = normalizeMapSuggestion(JSON.stringify({
      summary: '中央小丘和两棵松树',
      terrain: [{ mode: 'raise', x: 0, z: 0, size: 4, strength: 1 }],
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
      'object.add',
      'object.add',
      'reference.set'
    ]);
    expect(suggestion.operations[2]).toMatchObject({
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
      { apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset }
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
