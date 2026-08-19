import { describe, expect, it, vi } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import {
  buildMapCodePlannerSystemPrompt,
  discoverMapCodeAssets,
  executeMapCodePlan,
  generateMapCodeSuggestion
} from '../src/server/mapCodePlanner';
import { applyMapOperations } from '../src/shared/mapOperations';
import { isPointInsideWaterBody } from '../src/shared/mapWater';

describe('map code planner', () => {
  it('gives indoor maps one room-native Code Composer contract', () => {
    const map = createEmptyMap('Classroom', 'indoor-code-prompt', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const prompt = buildMapCodePlannerSystemPrompt(map, [], 3, 8, 'scene');

    expect(prompt).toContain("WorldForge Studio's procedural indoor-scene planner");
    expect(prompt).toContain('single author of the complete indoor layout');
    expect(prompt).toContain('api.roomPoint(localX,localZ,height?)');
    expect(prompt).toContain('api.wallFrame(wall,offset?,bottom?,inset?)');
    expect(prompt).toContain('api.ceilingPoint(localX,localZ,objectHeight?,drop?)');
    expect(prompt).toContain("api.opening({id,kind:'door'|'window'");
    expect(prompt).toContain("api.attach({assetId?,name?,parentId,kind:'supported'|'mounted'");
    expect(prompt).toContain('Keep a continuous route at least 0.8 world units wide');
    expect(prompt).toContain('Do not generate a whole room, floor, ceiling, wall shell, terrain');
    expect(prompt).toContain("role:'functional'|'decor'");
    expect(prompt).not.toContain('Outdoor Scene Code refinement');
    expect(prompt).not.toContain('Road curve:');
    expect(prompt).not.toContain('Natural scatter:');
  });

  it('executes room-native placements and opening bindings in one transaction', () => {
    const map = createEmptyMap('Classroom', 'indoor-code-execution', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const suggestion = executeMapCodePlan(`function plan(api) {
      const frame = api.wallFrame('north', 0, 1.1, 0.02);
      const door = api.opening({ id: 'door-main', kind: 'door', wall: 'south', offset: 3, width: 1.2, height: 2.1 });
      api.place({ name: 'desk', role: 'functional', position: api.roomPoint(0, 1, 0), dimensions: [1.2, 0.75, 0.6], facing: { direction: [0, -1] } });
      api.place({ name: 'board', role: 'functional', position: frame.point, dimensions: [3, 1.4, 0.12], facing: { direction: frame.inward } });
      api.place({ name: 'door', role: 'functional', roomOpeningId: door, dimensions: [1.2, 2.1, 0.12] });
      api.place({ name: 'light', role: 'decor', position: api.ceilingPoint(0, 0, 0.3, 0.1), dimensions: [0.8, 0.3, 0.8] });
    }`, map);
    const roomOperation = suggestion.operations.find((operation) => operation.type === 'room.set');
    const placements = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(roomOperation?.type).toBe('room.set');
    if (roomOperation?.type !== 'room.set') throw new Error('missing room operation');
    expect(roomOperation.room.openings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'door-main', kind: 'door', wall: 'south' })
    ]));
    expect(placements).toHaveLength(4);
    expect(placements.every((operation) => operation.object.heightMode === 'fixed')).toBe(true);
    expect(placements[0].object.transform?.position).toEqual([0, 0, 1]);
    expect(placements[1].object.transform?.position?.[1]).toBeCloseTo(1.1);
    expect(placements[2].object.roomOpeningId).toBe('door-main');
    expect(placements[3].object.transform?.position?.[1]).toBeCloseTo(3.44);
    const applied = applyMapOperations(map, suggestion.operations);
    const appliedDoor = applied.objects.find((object) => object.roomOpeningId === 'door-main');
    expect(appliedDoor?.transform.position[2]).toBeGreaterThan(4);
    expect(suggestion.codePlan?.functions).toEqual(expect.arrayContaining([
      'ceilingPoint', 'opening', 'place', 'roomPoint', 'wallFrame'
    ]));
  });

  it('compiles indoor attachments against earlier placement references', () => {
    const map = createEmptyMap('Cafe', 'indoor-code-attachments', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const counter: MapAsset = {
      ...testAsset('asset-counter', '柜台'),
      modelJson: {
        format: 2,
        nodes: [{ id: 'counter', transform: { pos: [0, 0.5, 0] }, mesh: { type: 'box', params: { width: 2, height: 1, depth: 1 } } }]
      }
    };
    const register: MapAsset = {
      ...testAsset('asset-register', '收银机'),
      modelJson: {
        format: 2,
        nodes: [{ id: 'register', transform: { pos: [0, 0.2, 0] }, mesh: { type: 'box', params: { width: 0.4, height: 0.4, depth: 0.35 } } }]
      }
    };
    const suggestion = executeMapCodePlan(`function plan(api) {
      const counterRef = api.place({ assetId: 'asset-counter', name: '柜台', position: api.roomPoint(0, 0), dimensions: [2, 1, 1], role: 'functional' });
      api.attach({ assetId: 'asset-register', name: '收银机', parentId: counterRef, kind: 'supported', offset: [0, 0], role: 'functional' });
    }`, map, [counter, register]);
    const objects = suggestion.operations.filter((operation) => operation.type === 'object.add');

    expect(objects).toHaveLength(2);
    expect(objects[0].object.transform?.size).toEqual([2, 1, 1]);
    expect(objects[0].object.transform?.scale).toEqual([0.5, 1, 1]);
    expect(objects[1].object.parentId).toBe(objects[0].object.id);
    expect(objects[1].object.transform?.position?.[1]).toBeGreaterThan(0.9);
    expect(suggestion.codePlan?.functions).toEqual(expect.arrayContaining(['attach', 'place', 'roomPoint']));
    expect(suggestion.diagnostics?.some((issue) => issue.code === 'object.invalid-support')).toBe(false);
  });

  it('keeps a living-room group inside the user-owned room without outdoor operations', () => {
    const map = createEmptyMap('Living room', 'indoor-code-living-room', [10, 4, 8], 'voxel', 'indoor', [10, 4, 8]);
    const originalSize = [...map.room!.size];
    const suggestion = executeMapCodePlan(`function plan(api) {
      const door = api.opening({ id: 'living-door', kind: 'door', wall: 'south', offset: 0, width: 1.2, height: 2.1 });
      api.place({ name: '客厅门', roomOpeningId: door, dimensions: [1.2, 2.1, 0.12], role: 'functional' });
      api.place({ name: '沙发', position: api.roomPoint(-2.2, -0.4), facing: { target: [0, -0.4] }, dimensions: [2.4, 0.9, 0.9], role: 'functional' });
      api.place({ name: '茶几', position: api.roomPoint(0, -0.4), dimensions: [1.2, 0.45, 0.7], role: 'functional' });
      const frame = api.wallFrame('north', 0, 0.45);
      api.place({ name: '电视', position: frame.point, facing: { direction: frame.inward }, dimensions: [1.8, 1.05, 0.12], role: 'functional' });
      api.place({ name: '落地灯', position: api.roomPoint(3.6, -2.6), dimensions: [0.45, 1.7, 0.45], role: 'decor' });
    }`, map);
    const applied = applyMapOperations(map, suggestion.operations);

    expect(applied.room?.size).toEqual(originalSize);
    expect(applied.room?.openings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'living-door' })]));
    expect(applied.objects).toHaveLength(5);
    expect(applied.objects.every((object) => object.heightMode === 'fixed')).toBe(true);
    expect(suggestion.operations.some((operation) => (
      operation.type.startsWith('terrain.') || operation.type.startsWith('water.') || operation.type.startsWith('grass.')
    ))).toBe(false);
    expect(applied.objects.every((object) => Math.abs(object.transform.position[0]) < 5 && Math.abs(object.transform.position[2]) < 4.1)).toBe(true);
  });

  it('rejects room-shell ownership and outdoor operations from indoor programs', () => {
    const map = createEmptyMap('Room', 'indoor-code-boundaries', [10, 4, 8], 'voxel', 'indoor', [10, 4, 8]);

    expect(() => discoverMapCodeAssets(`function plan(api) {
      const shell = api.requireAsset({ key: 'shell', name: '整间房', prompt: 'Complete room shell', role: 'functional' });
      api.place({ assetId: api.asset(shell), position: api.roomPoint(0, 0), role: 'functional' });
    }`, map, [], 1)).toThrow('indoor_map_code_forbidden_content');
    expect(() => executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.place({ name: '桌子', position: api.roomPoint(0, 0), role: 'functional' });
    }`, map)).toThrow('indoor_map_code_outdoor_operation');
  });

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
    expect(prompt).toContain('one short Simplified Chinese noun');
    expect(prompt).toContain("const tree = api.requireAsset({key:'tree'");
    expect(prompt).toContain('No undefined point, invalid array index, direct array arithmetic');
  });

  it('gives unified outdoor Code semantic intent and complete scene ownership', () => {
    const prompt = buildMapCodePlannerSystemPrompt(createEmptyMap(), [], 0, 6, 'scene');

    expect(prompt).toContain('Unified scene ownership');
    expect(prompt).toContain("api.sceneIntent({kind:'natural'|'authored'");
    expect(prompt).toContain('Decide this semantically');
    expect(prompt).toContain('A Chinese garden should be recognized through relationships');
    expect(prompt).toContain('entrance, screened turn, reveal, focal view, counter-view, and return path');
    expect(prompt).toContain('api.bridge({waterId');
    expect(prompt).toContain('api.terrain');
    expect(prompt).toContain('api.modifyTerrain');
    expect(prompt).toContain('api.water');
    expect(prompt).toContain('api.grass');
    expect(prompt).toContain("api.modifyTerrain({modifier:'mountain'|'ridge'|'valley'|'basin'");
    expect(prompt).toContain("api.surface({id:'short-id',surface:'grass'|'sand'|'rock'|'soil'|'paving'");
    expect(prompt).toContain("api.grass({id:'short-id',name?,preset:'meadow'|'sand'|'wetland'");
    expect(prompt).toContain('Enum fields are closed choices, not descriptions.');
    expect(prompt).toContain("role:'structure'|'environment'");
  });

  it('accepts structured terrain forms and normalizes common semantic enum labels', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.modifyTerrain({
        modifier: 'gentle central basin',
        region: { kind: 'circle', x: 2, z: 4, radius: 24 },
        amplitude: -1.4,
        softness: 0.8,
        variation: 0.2,
        seed: api.seed
      });
      api.surface({
        id: 'garden-ground',
        surface: 'packed earth',
        region: { kind: 'polygon', points: [[-42,-42],[42,-42],[42,40],[-42,40]] },
        intensity: 0.65
      });
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.modify', modifier: 'basin' }),
      expect.objectContaining({ type: 'terrain.surface', surface: 'soil', intensity: 0.65 })
    ]));

    const legacySuggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.modifyTerrain('gentle central basin', {kind:'circle',x:2,z:4,radius:24}, {amplitude:-1.4});
      api.surface('garden-ground', 'packed earth', {kind:'polygon',points:[[-42,-42],[42,-42],[42,40],[-42,40]]}, 0.65);
    }`, createEmptyMap());
    expect(legacySuggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.modify', modifier: 'basin' }),
      expect.objectContaining({ type: 'terrain.surface', surface: 'soil' })
    ]));
  });

  it('compiles semantic terrain option shapes into strict map operations', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.terrain('plain');
      api.modifyTerrain({
        modifier: 'terrace',
        region: { kind: 'circle', center: [0, 0], radius: 20 },
        amplitude: -2,
        layout: 'stepped garden terraces',
        access: { mode: 'walkable path' },
        direction: [1, 0],
        layers: [{ height: 0.5 }, { height: 1 }, { height: 1.5 }]
      });
    }`, createEmptyMap());

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'terrain.modify',
        modifier: 'terrace',
        amplitude: 2,
        layout: 'terraces',
        access: 'walkable',
        direction: 0,
        layers: 3
      })
    ]));
  });

  it('compiles semantic terrain presets and outlined grass regions without an AI repair', async () => {
    const code = `function plan(api) {
      api.sceneIntent({ kind: 'natural', reason: '池畔自然湿地' });
      api.terrain('rolling', { amplitude: 2 });
      api.grass('池畔湿地', {
        outline: [[-10, -6], [10, -6], [12, 4], [0, 9], [-12, 4]]
      }, {
        preset: 'shore wetland reeds',
        density: 0.55
      });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const suggestion = await generateMapCodeSuggestion('一片起伏地形中的池畔湿地', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.generate', preset: 'hills' }),
      expect.objectContaining({
        type: 'grass.layer.add',
        layer: expect.objectContaining({ preset: 'wetland' })
      }),
      expect.objectContaining({
        type: 'grass.generate',
        region: {
          kind: 'polygon',
          points: [[-10, -6], [10, -6], [12, 4], [0, 9], [-12, 4]]
        },
        density: 0.55
      })
    ]));
  });

  it('allows AI-declared natural scenes to compose terrain without inventing architecture', async () => {
    const code = `function plan(api) {
      api.sceneIntent({ kind: 'natural', reason: 'An untouched wetland has no authored construction' });
      api.terrain('valley', { amplitude: 2, roughness: 0.25 });
      api.water('marsh-water', { type: 'lake', points: [[-8,-4],[8,-4],[8,4],[-8,4]], level: -0.3 });
      api.grass('reeds', { kind: 'circle', center: [0,0], radius: 12 }, { preset: 'meadow', density: 0.45 });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const suggestion = await generateMapCodeSuggestion('一片无人修建的天然湿地', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });

    expect(suggestion.codePlan?.sceneIntent).toBe('natural');
    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(false);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.generate' }),
      expect.objectContaining({ type: 'water.add' }),
      expect.objectContaining({ type: 'grass.layer.add' })
    ]));
  });

  it('asks AI to repair an authored garden that omitted every structural anchor', async () => {
    const gate = { ...testAsset('moon-gate', '月洞门'), tags: ['garden', 'gate'] };
    const incomplete = `function plan(api) {
      api.sceneIntent({ kind: 'authored', reason: '中式园林是人工营造的文化空间' });
      api.terrain('plain');
    }`;
    const repaired = `function plan(api) {
      api.sceneIntent({ kind: 'authored', reason: '中式园林是人工营造的文化空间' });
      api.terrain('plain');
      api.place({ assetId: 'moon-gate', name: '月洞门', role: 'structure', position: [0,0], facing: { direction: [0,1] } });
    }`;
    const response = (content: string) => new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(incomplete))
      .mockResolvedValueOnce(response(repaired));

    const suggestion = await generateMapCodeSuggestion('生成中式园林', createEmptyMap(), [gate], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      reuseExistingAssets: true, reusableAssetIds: [gate.id],
      minNewAssets: 0, maxNewAssets: 0, scope: 'scene'
    });
    const repairRequest = JSON.parse(String((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.body)) as {
      messages: Array<{ content: string }>;
    };

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(repairRequest.messages.at(-1)?.content).toContain('authored_scene_missing_structure');
    expect(suggestion.codePlan?.sceneIntent).toBe('authored');
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ assetId: gate.id, locked: true }) })
    ]));
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

  it('solves a bridge against the actual water boundary and fixes it above the water surface', () => {
    const bridge: MapAsset = {
      ...testAsset('asset-stone-bridge', '石拱桥'),
      tags: ['bridge', 'garden'],
      modelJson: {
        format: 2,
        nodes: [{
          id: 'bridge-body',
          transform: { pos: [0, 0.5, 0] },
          mesh: { type: 'box', params: { width: 2, height: 1, depth: 4 } }
        }]
      }
    };
    const base = createEmptyMap();
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.water('garden-pond', {
        type: 'lake',
        points: [[-8,-5],[8,-5],[8,5],[-8,5]],
        level: 0.5,
        shorelineSmoothness: 0.8,
        shorelineIrregularity: 0
      });
      api.bridge({
        waterId: 'garden-pond',
        assetId: 'asset-stone-bridge',
        name: '石拱桥',
        crossingCenter: [0, 0],
        direction: [1, 0],
        dimensions: [2, 1, 4],
        bankInset: 1,
        deckClearance: 0.2
      });
    }`, base, [bridge]);
    const applied = applyMapOperations({ ...base, assets: [bridge] }, suggestion.operations);
    const object = applied.objects.find((item) => item.assetId === bridge.id);
    const water = applied.waterBodies.find((item) => item.id === 'garden-pond');

    expect(object).toBeDefined();
    expect(water).toBeDefined();
    expect(object?.heightMode).toBe('fixed');
    expect(object?.transform.position[1]).toBeGreaterThanOrEqual(0.7);
    expect(object?.transform.rotation[1]).toBeCloseTo(Math.PI / 2);
    expect(object?.transform.size[2]).toBeGreaterThan(16);
    const halfSpan = (object?.transform.size[2] ?? 0) / 2;
    expect(isPointInsideWaterBody(water!, -halfSpan, 0, applied)).toBe(false);
    expect(isPointInsideWaterBody(water!, halfSpan, 0, applied)).toBe(false);
    expect(suggestion.codePlan?.functions).toContain('bridge');
  });

  it('offers a non-blocking repair diagnostic when bridge scenery bypasses the crossing solver', () => {
    const suggestion = executeMapCodePlan(`function plan(api) {
      api.place({ name: '装饰石桥', position: [0, 0], size: [2, 1, 8] });
    }`, createEmptyMap());

    expect(suggestion.operations.some((operation) => operation.type === 'object.add')).toBe(true);
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'bridge.unresolved-crossing',
        severity: 'warning',
        repaired: false
      })
    ]));
  });

  it('replaces an existing bridge through a refinement delta without resetting the map', async () => {
    const bridge: MapAsset = {
      ...testAsset('asset-stone-bridge', '石拱桥'),
      tags: ['bridge', 'garden'],
      modelJson: {
        format: 2,
        nodes: [{
          id: 'bridge-body',
          transform: { pos: [0, 0.5, 0] },
          mesh: { type: 'box', params: { width: 2, height: 1, depth: 4 } }
        }]
      }
    };
    const base = createEmptyMap();
    base.assets = [bridge];
    const initial = executeMapCodePlan(`function plan(api) {
      api.water('garden-pond', { type: 'lake', points: [[-8,-5],[8,-5],[8,5],[-8,5]], level: 0.5 });
      api.place({ assetId: 'asset-stone-bridge', name: '石拱桥', position: [0,0], size: [2,1,4] });
    }`, base, [bridge]);
    const map = applyMapOperations(base, initial.operations);
    map.assets = [bridge];
    const oldBridge = map.objects.find((object) => object.assetId === bridge.id)!;
    const code = `function plan(api) {
      api.bridge({
        waterId: 'garden-pond',
        assetId: 'asset-stone-bridge',
        replaceObjectId: '${oldBridge.id}',
        crossingCenter: [0,0],
        direction: [1,0],
        dimensions: [2,1,4]
      });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const suggestion = await generateMapCodeSuggestion('修复石桥，让它连接池塘两岸', map, [bridge], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl,
      mode: 'refine', scope: 'scene', minNewAssets: 0, maxNewAssets: 0
    });

    expect(suggestion.operations).toEqual(expect.arrayContaining([
      { type: 'object.remove', objectId: oldBridge.id },
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ assetId: bridge.id }) })
    ]));
    expect(suggestion.operations.some((operation) => operation.type === 'reference.set')).toBe(false);
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
        for (let index = 0; index < 3; index += 1) {
          api.place({ assetId: api.asset(pine, index), position: [index * 2, 0] });
        }
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

  it('rejects declared variants that the program never places', () => {
    expect(() => discoverMapCodeAssets(`
      function plan(api) {
        const wall = api.requireAsset({ key: 'wall', name: 'Wall', prompt: 'Wall', variants: 2 });
        api.place({ assetId: api.asset(wall, 0), position: [0, 0] });
      }
    `, createEmptyMap(), [], 2)).toThrow('unused_map_code_asset_variants');
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

  it('keeps the usable scene when a required generated asset fails and reports a repairable warning', async () => {
    const code = `function plan(api) {
      api.sceneIntent({ kind: 'authored', reason: 'A designed garden' });
      api.terrain('plain');
      const corridor = api.requireAsset({
        key: 'corridor', name: '游廊', prompt: 'Chinese garden covered corridor',
        tags: ['garden', 'corridor'], variants: 1, role: 'structure'
      });
      const willow = api.requireAsset({
        key: 'willow', name: '水柳', prompt: 'Willow tree',
        tags: ['tree', 'willow'], variants: 1, role: 'environment'
      });
      api.place({ assetId: api.asset(corridor, 0), name: '游廊', position: [-5, 0], role: 'structure' });
      api.place({ assetId: api.asset(willow, 0), name: '水柳', position: [5, 0], role: 'environment' });
    }`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: code }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const createAsset = vi.fn(async (request: { name: string }) => {
      if (request.name === '游廊') throw new Error('map_asset_generation_failed:游廊:gpt: HTTP 500');
      return testAsset('asset-willow', request.name);
    });

    const suggestion = await generateMapCodeSuggestion('生成中式园林', createEmptyMap(), [], {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl, createAsset,
      scope: 'scene', minNewAssets: 2, maxNewAssets: 2
    });

    expect(suggestion.generatedAssets).toEqual([{ id: 'asset-willow', name: '水柳' }]);
    expect(suggestion.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'terrain.generate' }),
      expect.objectContaining({ type: 'object.add', object: expect.objectContaining({ assetId: 'asset-willow' }) })
    ]));
    expect(suggestion.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'asset.generation-degraded',
        severity: 'warning',
        repaired: false,
        message: expect.stringContaining('游廊')
      })
    ]));
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
