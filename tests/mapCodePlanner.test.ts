import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { discoverMapCodeAssets, executeMapCodePlan, generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import { applyMapOperations } from '../src/shared/mapOperations';

describe('map code planner', () => {
  it('supports basic JavaScript control flow and preserves deterministic placement order', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        for (let index = 0; index < 6; index += 1) {
          if (index % 2 === 0) {
            api.place({ name: 'marker', position: [index * 2 - 4, 0] });
          }
        }
      }
    `, createEmptyMap());

    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');
    expect(placements).toHaveLength(3);
    expect(placements.map((operation) => operation.object.transform?.position?.[0])).toEqual([-4, 0, 4]);
    expect(suggestion.codePlan?.functions).toEqual(['place']);
    expect(() => applyMapOperations(createEmptyMap(), suggestion.operations)).not.toThrow();
    expect(placements.every((operation) => Boolean(operation.object.id))).toBe(true);
  });

  it('combines Bezier sampling with deterministic noise masks', () => {
    const map = createEmptyMap();
    const code = `
      function plan(api) {
        const points = api.sampleBezier([-18,-10], [-8,14], [8,-14], [18,10], 24);
        for (const point of points) {
          if (api.noise2D(point[0], point[1], 0.12) > -0.15) {
            api.place({ name: 'trail-edge', position: point, scale: 0.5 });
          }
        }
      }
    `;

    const first = executeMapCodePlan(code, map);
    const second = executeMapCodePlan(code, map);
    const spatialOperations = (suggestion: typeof first) => suggestion.operations.map((operation) => {
      if (operation.type !== 'object.add') return operation;
      return { ...operation, object: { ...operation.object, id: undefined } };
    });
    expect(spatialOperations(first)).toEqual(spatialOperations(second));
    expect(first.codePlan?.functions).toEqual(['noise2D', 'place', 'sampleBezier']);
  });

  it('provides bounded minimum-distance environment scattering', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const points = api.poissonDisk({ minDistance: 5, maxPoints: 30, seed: 77 });
        for (const point of points) api.place({ name: 'tree-proxy', position: point });
      }
    `, createEmptyMap());
    const points = suggestion.operations.map((operation) => {
      if (operation.type !== 'object.add') throw new Error('unexpected operation');
      const position = operation.object.transform?.position;
      return [position?.[0] ?? 0, position?.[2] ?? 0] as const;
    });
    expect(points.length).toBeGreaterThan(5);
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        expect(Math.hypot(points[left][0] - points[right][0], points[left][1] - points[right][1])).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it('blocks host globals and runaway code', () => {
    expect(() => executeMapCodePlan('function plan(api) { process.cwd(); api.place({ position:[0,0] }); }', createEmptyMap()))
      .toThrow();
    expect(() => executeMapCodePlan('function plan() { while (true) {} }', createEmptyMap()))
      .toThrow();
  });

  it('discovers bounded generated asset requirements', () => {
    const code = `
      function plan(api) {
        const pine = api.requireAsset({
          key: 'pine',
          name: 'Tall pine',
          prompt: 'Standalone low-poly tall pine tree, no ground or background',
          tags: ['Tree', 'pine'],
          variants: 3
        });
        api.place({ assetId: api.asset(pine, 0), position: [0, 0] });
      }
    `;

    expect(discoverMapCodeAssets(code, createEmptyMap(), [], 3)).toEqual([{
      key: 'pine',
      name: 'Tall pine',
      prompt: 'Standalone low-poly tall pine tree, no ground or background',
      tags: ['tree', 'pine'],
      variants: 3
    }]);
    expect(() => discoverMapCodeAssets(code, createEmptyMap(), [], 2))
      .toThrow('map_code_asset_requirement_limit');
  });

  it('generates variants concurrently and replays code with real asset ids', async () => {
    const code = `
      function plan(api) {
        const pine = api.requireAsset({
          key: 'pine', name: 'Pine', prompt: 'Standalone pine tree', tags: ['tree'], variants: 3
        });
        for (let index = 0; index < 6; index += 1) {
          api.place({ assetId: api.asset(pine, index), position: [index * 2, 0] });
        }
      }
    `;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    let active = 0;
    let peak = 0;
    const createAsset = vi.fn(async (request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return testAsset(`asset-${request.name}`, request.name);
    });

    const suggestion = await generateMapCodeSuggestion('make a pine grove', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      maxNewAssets: 3,
      createAsset
    });

    expect(createAsset).toHaveBeenCalledTimes(3);
    expect(peak).toBe(3);
    expect(suggestion.generatedAssets).toHaveLength(3);
    const assetIds = suggestion.operations
      .filter((operation) => operation.type === 'object.add')
      .map((operation) => operation.object.assetId);
    expect(new Set(assetIds).size).toBe(3);
    expect(assetIds.slice(0, 3)).toEqual(assetIds.slice(3, 6));
    expect(() => applyMapOperations(createEmptyMap(), suggestion.operations)).not.toThrow();
  });

  it('asks the AI to repair non-finite code once before failing the plan', async () => {
    const brokenCode = `
      function plan(api) {
        const points = api.sampleBezier([-5, 0], [-2, 3], [2, -3], [5, 0], 4);
        for (let index = 0; index < points.length; index += 1) {
          api.place({ position: [points[index][0], points[index + 1][1]] });
        }
      }
    `;
    const repairedCode = `
      function plan(api) {
        const points = api.sampleBezier([-5, 0], [-2, 3], [2, -3], [5, 0], 4);
        for (let index = 0; index < points.length; index += 1) {
          api.place({ position: points[index] });
        }
      }
    `;
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(brokenCode))
      .mockResolvedValueOnce(response(repairedCode));

    const suggestion = await generateMapCodeSuggestion('make a curved trail', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.codePlan?.code).toContain('position: points[index]');
    expect(suggestion.operations.filter((operation) => operation.type === 'object.add')).toHaveLength(5);
  });
});

function testAsset(id: string, name: string): MapAsset {
  return {
    id,
    name,
    prompt: name,
    tags: ['tree'],
    modelJson: {},
    colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
    mode: 'voxel',
    createdAt: 1,
    updatedAt: 1
  };
}
