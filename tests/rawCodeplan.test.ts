import { describe, expect, it } from 'vitest';

// Raw codeplan experiment must be enabled before the planner module is imported.
process.env.WORLDFORGE_RAW_CODEPLAN = '1';



const { buildRawSceneCodeSystemPrompt, buildRawIndoorSceneCodeSystemPrompt, executeMapCodePlan } = await import('../src/server/mapCodePlanner');
import type { MapOperation } from '../src/shared/mapOperations';
const { createEmptyMap, buildInteriorWallSegments } = await import('../src/shared/map');
import type { MapInteriorWall } from '../src/shared/map';
const { CODE_PLAN_MODE_OPTIONS, normalizeCodePlanMode } = await import('../src/shared/codePlanModes');

describe('raw codeplan mode', () => {
  it('exposes only the ten basic APIs in the system prompt', () => {
    const prompt = buildRawSceneCodeSystemPrompt(createEmptyMap(), 2, 8);
    for (const name of ['terrain', 'modifyTerrain', 'surface', 'water', 'route', 'grass', 'requireAsset', 'asset', 'place', 'random']) {
      expect(prompt).toContain(`api.${name}`);
    }
    expect(prompt).toContain('SPATIAL RHYTHM');
  });

  it('keeps the minimal baseline prompt free of style paragraphs by default', () => {
    const prompt = buildRawSceneCodeSystemPrompt(createEmptyMap(), 2, 8);
    expect(prompt).not.toContain('Composition style —');
    expect(prompt).not.toContain('shape grammar');
  });

  it('injects exactly the selected composition-style paragraph', async () => {
    const { CODE_PLAN_STYLE_PARAGRAPHS } = await import('../src/shared/codePlanModes');
    const minimal = buildRawSceneCodeSystemPrompt(createEmptyMap(), 2, 8);
    expect((minimal.match(/Composition style —/g) ?? []).length).toBe(0);
    for (const option of CODE_PLAN_MODE_OPTIONS) {
      if (option.key === 'minimal') continue;
      const prompt = buildRawSceneCodeSystemPrompt(createEmptyMap(), 2, 8, option.key);
      expect((prompt.match(/Composition style —/g) ?? []).length).toBe(1);
      expect(prompt).toContain(CODE_PLAN_STYLE_PARAGRAPHS[option.key]);
    }
  });

  it('normalizes unknown plan modes to the minimal baseline', () => {
    expect(normalizeCodePlanMode(undefined)).toBe('minimal');
    expect(normalizeCodePlanMode('grammar')).toBe('grammar');
    expect(normalizeCodePlanMode('no-such-mode')).toBe('minimal');
  });

  it('lists the canonical terrain preset names', () => {
    const prompt = buildRawSceneCodeSystemPrompt(createEmptyMap(), 2, 8);
    expect(prompt).toContain("'dune-desert'");
    expect(prompt).not.toContain("'rolling'");
  });

  it('gives indoor raw mode an eleven-key room-native minimal prompt without outdoor APIs', () => {
    const room = createEmptyMap('教室', 'indoor-raw-prompt', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const prompt = buildRawIndoorSceneCodeSystemPrompt(room, 2, 8);
    for (const name of ['room', 'roomPoint', 'wallFrame', 'ceilingPoint', 'opening', 'interiorWall', 'attach', 'requireAsset', 'asset', 'place', 'random']) {
      expect(prompt).toContain(`api.${name}`);
    }
    expect(prompt).toContain('CIRCULATION');
    expect(prompt).toContain('wallThickness');
    // Recurring failure patterns from the experiments, taught as cautions.
    expect(prompt).toContain('Declare-before-use');
    expect(prompt).toContain('never a descriptive string');
    expect(prompt).toContain('one NaN or Infinity discards the whole plan');
    // Interior partitions are buildable; only the four-shell boundary is map-owned.
    expect(prompt).toContain('Interior partition walls, door leaves and freestanding panels are yours');
    expect(prompt).not.toContain('api.terrain');
    expect(prompt).not.toContain('SPATIAL RHYTHM');
    expect(prompt).not.toContain('Composition style —');
    // The reduction to eleven keys: no composite placement key, no preset math
    // helpers — the prompt tells the model to define its own instead.
    expect(prompt).not.toContain('api.placeBetween');
    expect(prompt).not.toContain('api.clamp');
    expect(prompt).not.toContain('api.gridPoints');
    expect(prompt).toContain('you define yourself');
  });

  it('builds interior walls as whole surfaces with door holes punched out', () => {
    const room = createEmptyMap('公寓', 'interior-wall-geometry', [14, 4, 10], 'voxel', 'indoor', [14, 4, 10]);
    const code = `function plan(api) {
      api.interiorWall({
        id: 'bath-wall', from: [-3, 0], to: [3, 0], thickness: 0.12, height: 2.8,
        wallType: 'solid', color: '#e8e0d0',
        openings: [{ id: 'bath-door', kind: 'door', offset: 0, bottom: 0, width: 0.9, height: 2.1 }]
      });
      const leaf = api.requireAsset({ key:'leaf', name:'卫浴门', prompt:'oak interior door leaf. Coordinate contract: Y+ is up, Z+ is the front direction, X+ is right.', dimensions:[0.9,2.1,0.05], role:'functional' });
      api.place({ assetId: api.asset(leaf), roomOpeningId: 'bath-wall/bath-door', dimensions:[0.9,2.1,0.05], role:'functional' });
    }`;
    const suggestion = executeMapCodePlan(code, room, [], {
      mode: 'discovery', requestMode: 'generate', scope: 'scene'
    });
    const wallOps = suggestion.operations.filter((op) => op.type === 'interior-wall.set');
    expect(wallOps).toHaveLength(1);
    const wallOp = wallOps[0] as Extract<MapOperation, { type: 'interior-wall.set' }>;
    const segments = buildInteriorWallSegments({ interiorWalls: [wallOp.wall as MapInteriorWall] });
    // One door hole splits the wall into left + right + above-door strips.
    expect(segments).toHaveLength(3);
    const leaf: any = suggestion.operations.find(
      (op) => op.type === 'object.add' && (op.object as any).roomOpeningId === 'bath-wall/bath-door'
    );
    expect(leaf).toBeTruthy();
    // Leaf sits inside the hole on the wall axis.
    expect(leaf.object.transform.position[1]).toBeCloseTo(0.02, 2);
  });

  it('keeps rugs and carpets available as indoor decor objects', () => {
    const room = createEmptyMap('客厅', 'indoor-raw-rug', [16, 4, 12], 'voxel', 'indoor', [16, 4, 12]);
    const code = `function plan(api) {
      const rug = api.requireAsset({ key:'rug', name:'地毯', prompt:'round woven wool rug. Coordinate contract: Y+ is up, Z+ is the front direction, X+ is right.', dimensions:[2.4,0.03,2.4], role:'decor' });
      api.place({ assetId: api.asset(rug), name:'地毯', position: api.roomPoint(0, 0), role:'decor' });
    }`;
    const suggestion = executeMapCodePlan(code, room, [], {
      mode: 'discovery', requestMode: 'generate', scope: 'scene'
    });
    expect(suggestion.operations.filter((op) => op.type === 'object.add')).toHaveLength(1);
  });

  it('rejects removed math-helper keys so the model writes its own helpers', () => {
    const room = createEmptyMap('教室', 'indoor-raw-pruned', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    expect(() => executeMapCodePlan(`function plan(api) {
      api.place({ name:'x', position: api.lerp([0, 0], [2, 2], 0.5) });
    }`, room, [], { mode: 'discovery', requestMode: 'generate', scope: 'scene' })).toThrow();
  });

  it('injects the indoor variant of the selected composition style', async () => {
    const { CODE_PLAN_INDOOR_STYLE_PARAGRAPHS, CODE_PLAN_STYLE_PARAGRAPHS } = await import('../src/shared/codePlanModes');
    const room = createEmptyMap('教室', 'indoor-raw-style', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    for (const option of CODE_PLAN_MODE_OPTIONS) {
      if (option.key === 'minimal') continue;
      const prompt = buildRawIndoorSceneCodeSystemPrompt(room, 2, 8, option.key);
      expect((prompt.match(/Composition style —/g) ?? []).length).toBe(1);
      expect(prompt).toContain(CODE_PLAN_INDOOR_STYLE_PARAGRAPHS[option.key]);
      expect(prompt).not.toContain(CODE_PLAN_STYLE_PARAGRAPHS[option.key]);
    }
  });

  it('runs indoor raw code against the room-native sandbox whitelist', () => {
    const room = createEmptyMap('教室', 'indoor-raw-run', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const code = `function plan(api) {
      const sofa = api.requireAsset({ key:'sofa', name:'沙发', prompt:'compact fabric sofa. Coordinate contract: Y+ is up, Z+ is the front direction, X+ is right.', dimensions:[2.2,0.9,0.95], role:'functional' });
      const sofaId = api.asset(sofa);
      const north = api.wallFrame('north', 0, 0);
      api.place({ assetId: sofaId, name:'沙发', position: api.roomPoint(-2, -3), facing:{direction:north.inward}, role:'functional' });
      const lamp = api.requireAsset({ key:'lamp', name:'吊灯', prompt:'simple pendant lamp. Coordinate contract: Y+ is up, Z+ is the front direction, X+ is right.', dimensions:[0.4,0.3,0.4], role:'decor' });
      api.place({ assetId: api.asset(lamp), name:'吊灯', position: api.ceilingPoint(0, 0, 0.3), role:'decor' });
    }`;
    const suggestion = executeMapCodePlan(code, room, [], {
      mode: 'discovery', requestMode: 'generate', scope: 'scene'
    });
    expect(suggestion.operations.filter((op) => op.type === 'object.add').length).toBe(2);
  });

  it('accepts an indoor bare top-level script and rejects non-whitelisted APIs', () => {
    const room = createEmptyMap('教室', 'indoor-raw-wrap', [12, 4, 9], 'voxel', 'indoor', [12, 4, 9]);
    const bare = `const desk = api.requireAsset({ key:'desk', name:'书桌', prompt:'wooden desk. Coordinate contract: Y+ is up, Z+ is the front direction, X+ is right.', dimensions:[1.4,0.75,0.7], role:'functional' });
      api.place({ assetId: api.asset(desk), name:'书桌', position: api.roomPoint(2, 2), role:'functional' });`;
    const suggestion = executeMapCodePlan(bare, room, [], {
      mode: 'discovery', requestMode: 'generate', scope: 'scene'
    });
    expect(suggestion.operations.filter((op) => op.type === 'object.add')).toHaveLength(1);
    expect(() => executeMapCodePlan(`function plan(api) {
      api.terrain('plain', {});
    }`, room, [], { mode: 'discovery', requestMode: 'generate', scope: 'scene' })).toThrow();
  });

  it('lets the model define its own variables, helpers, loops and noise', () => {
    const code = `function plan(api) {
      const SEED_SHIFT = 17.3;
      function hash2(x, z) {
        const s = Math.sin(x * 127.1 + z * 311.7 + SEED_SHIFT) * 43758.5453;
        return s - Math.floor(s);
      }
      function valueNoise(x, z) {
        const base = hash2(Math.floor(x), Math.floor(z));
        return base * 0.6 + hash2(Math.floor(x) + 1, Math.floor(z)) * 0.4;
      }
      const ring = [];
      for (let i = 0; i < 12; i += 1) {
        const angle = (i / 12) * Math.PI * 2;
        ring.push([Math.cos(angle) * 20, Math.sin(angle) * 20]);
      }
      api.terrain('rolling', { amplitude: 0.5 });
      api.water('pond', { type: 'lake', points: [[-5, -5], [5, -5], [5, 5], [-5, 5]], level: -0.4, depth: 1.5 });
      api.route({ id: 'loop', points: ring, closed: true, width: 2, surface: 'paving' });
      const rock = api.requireAsset({ key: 'rock', name: '岩石', prompt: 'A lone boulder. Coordinate contract: Y+ is up, Z+ is the front direction, X+ is right.', dimensions: [2, 2, 2], role: 'environment' });
      const rockId = api.asset(rock);
      for (let i = 0; i < 24; i += 1) {
        const x = (hash2(i, 1) - 0.5) * 80;
        const z = (hash2(i, 2) - 0.5) * 80;
        if (valueNoise(x, z) > 0.5) {
          api.place({ assetId: rockId, name: '散石-' + i, position: [x, z], rotationY: api.random(0, Math.PI * 2) });
        }
      }
    }`;
    const suggestion = executeMapCodePlan(code, createEmptyMap(), [], {
      mode: 'discovery', requestMode: 'generate', scope: 'scene'
    });
    expect(suggestion.operations.filter((op) => op.type === 'object.add').length).toBeGreaterThan(0);
    expect(suggestion.operations.some((op) => op.type === 'terrain.generate')).toBe(true);
    expect(suggestion.operations.some((op) => op.type === 'water.add')).toBe(true);
  });

  it('rejects calls to APIs outside the ten-key whitelist', () => {
    const code = `function plan(api) {
      api.sceneIntent({ kind: 'authored', reason: 'test' });
      api.place({ name: 'x', position: [0, 0] });
    }`;
    expect(() => executeMapCodePlan(code, createEmptyMap(), [], {
      mode: 'final', requestMode: 'generate', scope: 'scene'
    })).toThrow();
  });

  it('accepts a bare top-level script without a plan wrapper', () => {
    const code = `const spots = [];
    for (let i = 0; i < 5; i += 1) spots.push([i * 4 - 8, 6]);
    api.terrain('rolling', {});
    for (const [x, z] of spots) api.place({ name: '石 ' + x, position: [x, z] });`;
    const suggestion = executeMapCodePlan(code, createEmptyMap(), [], {
      mode: 'discovery', requestMode: 'generate', scope: 'scene'
    });
    expect(suggestion.operations.filter((op) => op.type === 'object.add')).toHaveLength(5);
  });

  it('keeps non-scene generation on the full sandbox', () => {
    const code = `function plan(api) {
      api.noise2D(1, 2);
      api.place({ name: 'x', position: [0, 0] });
    }`;
    const suggestion = executeMapCodePlan(code, createEmptyMap(), [], {
      mode: 'final', requestMode: 'generate', scope: 'general'
    });
    expect(suggestion.operations.some((op) => op.type === 'object.add')).toBe(true);
  });
});
