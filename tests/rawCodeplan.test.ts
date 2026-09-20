import { describe, expect, it } from 'vitest';

// Raw codeplan experiment must be enabled before the planner module is imported.
process.env.WORLDFORGE_RAW_CODEPLAN = '1';

const { buildRawSceneCodeSystemPrompt, executeMapCodePlan } = await import('../src/server/mapCodePlanner');
const { createEmptyMap } = await import('../src/shared/map');

describe('raw codeplan mode', () => {
  it('exposes only the ten basic APIs in the system prompt', () => {
    const prompt = buildRawSceneCodeSystemPrompt(createEmptyMap(), 2, 8);
    for (const name of ['terrain', 'modifyTerrain', 'surface', 'water', 'route', 'grass', 'requireAsset', 'asset', 'place', 'random']) {
      expect(prompt).toContain(`api.${name}`);
    }
    expect(prompt).toContain('SPATIAL RHYTHM');
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
