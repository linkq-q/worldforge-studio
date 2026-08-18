import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import {
  buildMapCodePlannerSystemPrompt,
  discoverMapCodeAssets,
  executeMapCodePlan,
  generateMapCodeSuggestion
} from '../src/server/mapCodePlanner';
import { applyMapOperations } from '../src/shared/mapOperations';

describe('map code planner', () => {
  it('gives the model a complete Lite-style code and environment design contract', () => {
    const prompt = buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 2, 4);

    expect(prompt).toContain('Return only one synchronous JavaScript function: function plan(api) { ... }.');
    expect(prompt).toContain('Every generated point supports both point[0]/point[1] and point.x/point.z.');
    expect(prompt).toContain('sampleBezierFrames(...) -> frame objects with point,tangent,normal');
    expect(prompt).toContain('sampleBezierFramesBySpacing(...,spacing,gapRatio?)');
    expect(prompt).toContain('api.placeBetween({assetId?,name?,start:[x,z],end:[x,z]');
    expect(prompt).toContain('For a continuous connected run, use one asset family and normally variants:1.');
    expect(prompt).toContain('facing:{normal:frame.normal}');
    expect(prompt).toContain('poissonDisk plus noise2D/fbm2D');
    expect(prompt).toContain('gridPoints with an explicit center and spacing');
    expect(prompt).toContain('circlePoint with deterministic index/count');
    expect(prompt).toContain('facing may be a direction [dx,dz]');
    expect(prompt).toContain('Inward arena ring:');
    expect(prompt).toContain('The sum of all requireAsset variants must be between 2 and 4.');
    expect(prompt).toContain("const tree = api.requireAsset({key:'tree'");
    expect(prompt).toContain('No undefined point, invalid array index, direct array arithmetic');
  });

  it('hides existing assets by default and exposes only explicitly selected reusable assets', async () => {
    const selected = testAsset('asset-selected', 'Selected neon lamp');
    const unselected = testAsset('asset-unselected', 'Unselected old building');
    const code = 'function plan(api) { api.place({ name: "marker", position: [0, 0] }); }';
    const prompts: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      prompts.push(body.messages[0].content);
      return new Response(JSON.stringify({ ok: true, content: code }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    await generateMapCodeSuggestion('make a street', createEmptyMap(), [selected, unselected], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      minNewAssets: 0,
      maxNewAssets: 0
    });
    await generateMapCodeSuggestion('make a street', createEmptyMap(), [selected, unselected], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      reuseExistingAssets: true,
      reusableAssetIds: [selected.id],
      minNewAssets: 0,
      maxNewAssets: 0
    });

    expect(prompts[0]).not.toContain(selected.id);
    expect(prompts[0]).not.toContain(unselected.id);
    expect(prompts[1]).toContain(selected.id);
    expect(prompts[1]).not.toContain(unselected.id);
  });

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

  it('accepts Bezier frame objects as placement points and tangents', () => {
    const map = createEmptyMap();
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const frame = api.bezierPoint(0.5, [-8, -4], [-4, 8], [4, -8], [8, 4]);
        api.place({ position: frame, rotationY: api.tangentYaw(frame) });
      }
    `, map);
    const placement = suggestion.operations.find((operation) => operation.type === 'object.add');

    expect(placement?.type).toBe('object.add');
    if (placement?.type !== 'object.add') throw new Error('missing placement');
    expect(placement.object.transform?.position?.every(Number.isFinite)).toBe(true);
    expect(placement.object.transform?.rotation?.every(Number.isFinite)).toBe(true);
  });

  it('resolves declarative facing directions and targets into Y rotation', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        api.place({ name: 'east', position: [0, 0], facing: [1, 0] });
        api.place({ name: 'north', position: [4, 0], facing: { target: [4, 10] } });
        api.place({ name: 'south', position: [8, 0], facing: { target: [8, 10], offsetY: api.TAU / 2 } });
      }
    `, createEmptyMap());
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(placements).toHaveLength(3);
    if (placements[0].type !== 'object.add' || placements[1].type !== 'object.add' || placements[2].type !== 'object.add') {
      throw new Error('missing placements');
    }
    expect(placements[0].object.transform?.rotation?.[1]).toBeCloseTo(Math.PI / 2);
    expect(placements[1].object.transform?.rotation?.[1]).toBeCloseTo(0);
    expect(placements[2].object.transform?.rotation?.[1]).toBeCloseTo(Math.PI);
    expect(suggestion.codePlan?.functions).toContain('place');
  });

  it('fits generated model dimensions between two endpoints', () => {
    const connectedAsset: MapAsset = {
      ...testAsset('asset-connected-wall', 'Connected wall'),
      modelJson: {
        format: 2,
        nodes: [{
          id: 'wall-body',
          transform: { pos: [0, 2, 0] },
          mesh: { type: 'box', params: { width: 2, height: 4, depth: 1 } }
        }]
      }
    };
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        api.placeBetween({
          assetId: 'asset-connected-wall',
          name: 'connected-wall',
          start: [0, 0],
          end: [10, 0],
          dimensions: [4, 3, 1],
          spanAxis: 'x',
          gapRatio: 0.1
        });
        api.placeBetween({
          name: 'connected-path',
          start: [0, 0],
          end: [0, 8],
          dimensions: [2, 1, 4],
          spanAxis: 'z'
        });
      }
    `, createEmptyMap(), [connectedAsset]);
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(placements).toHaveLength(2);
    if (placements[0].type !== 'object.add' || placements[1].type !== 'object.add') {
      throw new Error('missing connected placements');
    }
    expect(placements[0].object.transform?.position?.[0]).toBeCloseTo(5);
    expect(placements[0].object.transform?.position?.[2]).toBeCloseTo(0);
    expect(placements[0].object.transform?.rotation?.[1]).toBeCloseTo(0);
    expect(placements[0].object.transform?.size).toEqual([9, 3, 1]);
    expect(placements[0].object.transform?.scale).toEqual([0.5, 0.25, 1]);
    expect(placements[1].object.transform?.position?.[2]).toBeCloseTo(4);
    expect(placements[1].object.transform?.rotation?.[1]).toBeCloseTo(0);
    expect(placements[1].object.transform?.size).toEqual([2, 1, 8]);
    expect(placements[1].object.transform?.scale).toEqual([1, 1, 1]);
    expect(suggestion.codePlan?.functions).toEqual(['placeBetween']);
  });

  it('allows facing to override automatic line orientation', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        api.placeBetween({
          name: 'front-overridden-connection',
          start: [0, 0],
          end: [10, 0],
          dimensions: [10, 2, 1],
          spanAxis: 'x',
          facing: { direction: [1, 0] }
        });
      }
    `, createEmptyMap());
    const placement = suggestion.operations.find((operation) => operation.type === 'object.add');

    expect(placement?.type).toBe('object.add');
    if (placement?.type !== 'object.add') throw new Error('missing connected placement');
    expect(placement.object.transform?.rotation?.[1]).toBeCloseTo(Math.PI / 2);
  });

  it('uses Bezier normals for curved wall facades', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const frames = api.sampleBezierFrames([0, -10], [0, -4], [0, 4], [0, 10], 4);
        for (let index = 0; index < frames.length; index += 1) {
          api.place({ name: 'garden-wall', position: frames[index].point, facing: { normal: frames[index].normal } });
        }
      }
    `, createEmptyMap());
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(placements).toHaveLength(5);
    if (placements[2].type !== 'object.add') throw new Error('missing wall placement');
    expect(placements[2].object.transform?.rotation?.[1]).toBeCloseTo(-Math.PI / 2);
    expect(suggestion.codePlan?.functions).toEqual(['place', 'sampleBezierFrames']);
  });

  it('samples repeated curve elements by arc length with a configurable spacing gap', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const frames = api.sampleBezierFramesBySpacing([0, 0], [0, 10], [0, 20], [0, 30], 5, 0.1);
        for (let index = 0; index < frames.length; index += 1) {
          api.place({ name: 'modular-element', position: frames[index].point, facing: { tangent: frames[index].tangent } });
        }
      }
    `, createEmptyMap());
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');
    const zPositions = placements.map((operation) => {
      if (operation.type !== 'object.add') throw new Error('unexpected operation');
      return operation.object.transform?.position?.[2] ?? 0;
    });
    const distances = zPositions.slice(1).map((value, index) => value - zPositions[index]);

    expect(distances.length).toBeGreaterThan(3);
    expect(distances.every((distance) => distance > 5)).toBe(true);
    expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(0.2);
    expect(suggestion.codePlan?.functions).toEqual(['place', 'sampleBezierFramesBySpacing']);
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

  it('exposes generated points through array and named coordinates', () => {
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        const point = api.poissonDisk({ minDistance: 5, maxPoints: 1 })[0];
        api.place({ position: [point.x, point.z] });
      }
    `, createEmptyMap());
    const placement = suggestion.operations.find((operation) => operation.type === 'object.add');

    expect(placement?.type).toBe('object.add');
    if (placement?.type !== 'object.add') throw new Error('missing placement');
    expect(placement.object.transform?.position?.every(Number.isFinite)).toBe(true);
  });

  it('blocks host globals and runaway code', () => {
    expect(() => executeMapCodePlan('function plan(api) { process.cwd(); api.place({ position:[0,0] }); }', createEmptyMap()))
      .toThrow();
    expect(() => executeMapCodePlan('function plan() { while (true) {} }', createEmptyMap()))
      .toThrow();
  });

  it('degrades invented asset ids instead of failing the entire code plan', () => {
    const knownAsset = testAsset('asset-real-sign', 'Neon sign');
    const suggestion = executeMapCodePlan(`
      function plan(api) {
        api.place({ assetId: 'asset-invented', name: 'Neon sign', position: [0, 0] });
        api.place({ assetId: 'asset-still-missing', name: 'Unknown kiosk', position: [4, 0] });
      }
    `, createEmptyMap(), [knownAsset]);
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(placements[0].object.assetId).toBe('asset-real-sign');
    expect(placements[1].object.assetId).toBeNull();
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'asset.unplaced', severity: 'warning' })
    ]));
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
          key: 'pine', name: 'Pine', prompt: 'Standalone pine tree', tags: ['tree'], variants: 3,
          dimensions: [2, 4, 2]
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
    expect(createAsset.mock.calls[0][0].prompt).toContain('local Z+ is the front');
    expect(createAsset.mock.calls[0][0].prompt).toContain('width=2, height=4, depth=2 world units');
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

  it('replans when the code declares fewer than the requested new assets', async () => {
    const reusedOnlyCode = `
      function plan(api) {
        api.place({ name: 'proxy', position: [0, 0] });
      }
    `;
    const generatedAssetCode = `
      function plan(api) {
        const signs = api.requireAsset({
          key: 'neon-sign', name: 'Neon sign', prompt: 'Standalone cyberpunk neon sign', variants: 2
        });
        api.place({ assetId: api.asset(signs, 0), position: [-2, 0] });
        api.place({ assetId: api.asset(signs, 1), position: [2, 0] });
      }
    `;
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(reusedOnlyCode))
      .mockResolvedValueOnce(response(generatedAssetCode));
    const createAsset = vi.fn(async (request) => testAsset(`asset-${request.name}`, request.name));

    const suggestion = await generateMapCodeSuggestion('make a cyberpunk street', createEmptyMap(), [], {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl,
      minNewAssets: 2,
      maxNewAssets: 4,
      createAsset
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(createAsset).toHaveBeenCalledTimes(2);
    expect(suggestion.generatedAssets).toHaveLength(2);
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
