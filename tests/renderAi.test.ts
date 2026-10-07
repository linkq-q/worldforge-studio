import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_RENDER_SCHEMES as SHIPPED_RENDER_SCHEMES } from '../src/shared/renderScheme';
import {
  compileRuntimeOutline,
  compileRuntimePresentation,
  compileRuntimeStyle,
  compileRuntimeTerrainMaterialStyle,
  compileRuntimeMaterialThemes,
  RENDER_CAPABILITIES,
  type RenderPlan
} from '../src/shared/renderPlan';
import {
  generateRenderSuggestion,
  normalizeRenderSuggestion,
  refineRenderSuggestion
} from '../src/server/renderAi';
import { createEmptyMap } from '../src/shared/map';
import { createRenderSceneProfile } from '../src/shared/renderSceneProfile';
import { normalizeVisualDirection } from '../src/shared/visualDirection';

// Legacy IDs remain useful as isolated parser fixtures; they are not shipped
// by the product and therefore do not reappear in the scheme picker.
const BUILTIN_RENDER_SCHEMES = [
  ...SHIPPED_RENDER_SCHEMES,
  ...['render-natural-day', 'render-morning-mist', 'render-runtime-cel-day'].map((id) => ({
    ...SHIPPED_RENDER_SCHEMES[0],
    id,
    renderPlan: SHIPPED_RENDER_SCHEMES[0].renderPlan
      ? { ...SHIPPED_RENDER_SCHEMES[0].renderPlan, baseSchemeId: id }
      : undefined
  }))
];

describe('render AI adapter', () => {
  it('coordinates colors from structured evidence in one text-only request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: JSON.stringify({
      plan: { version: 2, baseSchemeId: 'render-natural-day', modules: [
        { key: 'leaves', id: 'runtime.material-theme', scope: { target: 'material-tag', tag: 'foliage' }, params: { color: '#71864e' } }
      ] }
    }) }), { status: 200 }));
    const map = createEmptyMap(); map.designSemantics.intent = 'Coastal warm stone village';
    const suggestion = await generateRenderSuggestion('统一世界配色', BUILTIN_RENDER_SCHEMES, {
      fetchImpl, coordinateColors: true, sceneProfile: createRenderSceneProfile(map)
    });
    expect(suggestion.plan.modules).toContainEqual(expect.objectContaining({ id: 'runtime.material-theme', params: { color: '#71864e' } }));
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request.messages.every((message: {content: unknown}) => typeof message.content === 'string')).toBe(true);
    expect(request.messages[0].content).toContain('colorContext');
    expect(request.messages[0].content).toContain('地面、植被、建筑、道具、水体与光照');
    expect(request.messages[0].content).toContain('区域身份');
    expect(request.messages[0].content).toContain('源材质颜色');
    expect(request.messages[0].content).toContain('不得使用截图、视觉模型');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('surfaces invalid coordinated output without AI repair', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true, content: '{invalid' }), { status: 200 }));
    const progress: string[] = [];
    await expect(generateRenderSuggestion('统一配色', BUILTIN_RENDER_SCHEMES, {
      fetchImpl, coordinateColors: true, onProgress: event => progress.push(event.phase)
    })).rejects.toThrow('invalid_render_ai_json');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(progress).not.toContain('repairing');
  });

  it('does not retry a failed color coordination transport request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'busy' }), { status: 503 }));
    await expect(generateRenderSuggestion('统一配色', BUILTIN_RENDER_SCHEMES, { fetchImpl, coordinateColors: true })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('preserves current non-color parameters even when coordinated AI output changes or omits them', async () => {
    const currentPlan: RenderPlan = { version: 2, baseSchemeId: 'render-natural-day', modules: [
      { id: 'runtime.grass-style', params: { bladeHeight: 1.2, windStrength: 0.2, rootColor: '#224433' } },
      { key: 'water', id: 'runtime.water-style', scope: { target: 'water' }, params: { waveStrength: 0.35, opacity: 0.6, color: '#335577' } },
      { id: 'runtime.post-quality', params: { ssao: 'soft', bloom: 'off' } }
    ] };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: JSON.stringify({ plan: {
      ...currentPlan, modules: [
        { id: 'runtime.grass-style', params: { bladeHeight: 2, windStrength: 0.9, rootColor: '#776644' } },
        { key: 'water', id: 'runtime.water-style', scope: { target: 'water' }, params: { waveStrength: 1, opacity: 0.8, color: '#448899' } }
      ]
    } }) }), { status: 200 }));
    const suggestion = await refineRenderSuggestion('协调颜色', currentPlan, BUILTIN_RENDER_SCHEMES, { fetchImpl, coordinateColors: true });
    expect(suggestion.plan.modules).toEqual([
      { id: 'runtime.grass-style', params: { bladeHeight: 1.2, windStrength: 0.2, rootColor: '#776644' } },
      { key: 'water', id: 'runtime.water-style', scope: { target: 'water' }, params: { waveStrength: 0.35, opacity: 0.6, color: '#448899' } },
      { id: 'runtime.post-quality', params: { ssao: 'soft', bloom: 'off' } }
    ]);
  });

  it('preserves scoped surface physics and visual direction behavior while coordinating their colors', async () => {
    const original = { objectId: 'house', partId: 'wall', color: '#c1ad99', roughness: 0.72, metalness: 0.03 };
    const currentPlan: RenderPlan = { version: 2, baseSchemeId: 'render-natural-day',
      visualDirection: normalizeVisualDirection({ timeOfDay: 'evening', contrastMode: 'colored-shadow', temperature: 'warm', atmosphereFx: { dust: 0.15 } }),
      modules: [{ key: 'wall', id: 'runtime.surface-detail', params: { config: JSON.stringify(original) } }] };
    const direction = normalizeVisualDirection({ timeOfDay: 'night', temperature: 'cool', palette: { accent: '#773355' }, atmosphereFx: { dust: 1 } });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: JSON.stringify({ plan: {
      ...currentPlan, visualDirection: direction,
      modules: [{ key: 'wall', id: 'runtime.surface-detail', params: { config: JSON.stringify({ ...original, color: '#bfc9b2', roughness: 0.1, metalness: 0.9 }) } }]
    } }) }), { status: 200 }));
    const sceneProfile = createRenderSceneProfile(createEmptyMap());
    sceneProfile.targets!.objects = [{ id: 'house', name: 'house', position: [0, 0, 0], parts: [{ id: 'wall', tags: ['base:stone'] }] }];
    const result = await refineRenderSuggestion('协调石墙与强调色', currentPlan, BUILTIN_RENDER_SCHEMES, { coordinateColors: true, fetchImpl, sceneProfile });
    expect(JSON.parse(String(result.plan.modules[0].params.config))).toEqual({ ...original, color: '#bfc9b2' });
    expect(result.plan.visualDirection).toEqual({ ...currentPlan.visualDirection, palette: direction.palette });
    expect(currentPlan.modules[0].params.config).toBe(JSON.stringify(original));
  });

  it('rejects fabricated world instance targets on the first coordinated attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: JSON.stringify({ plan: {
      version: 2, baseSchemeId: 'render-natural-day', modules: [{ key: 'fake', id: 'runtime.surface-detail', params: {
        config: JSON.stringify({ objectId: 'world-ecology:invented', partId: 'leaf', color: '#446633' })
      } }]
    } }) }), { status: 200 }));
    await expect(generateRenderSuggestion('统一树叶颜色', BUILTIN_RENDER_SCHEMES, {
      coordinateColors: true, fetchImpl, sceneProfile: createRenderSceneProfile(createEmptyMap())
    })).rejects.toThrow('unknown_scene_art_object:world-ecology:invented');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('validates incoming keyed references before merging colors into a real target', async () => {
    const currentPlan: RenderPlan = { version: 2, baseSchemeId: 'render-natural-day', modules: [{
      key: 'wall', id: 'runtime.surface-detail', params: { config: JSON.stringify({ objectId: 'real-house', partId: 'wall', color: '#aaaaaa' }) }
    }] };
    const sceneProfile = createRenderSceneProfile(createEmptyMap());
    sceneProfile.targets!.objects = [{ id: 'real-house', name: 'house', position: [0, 0, 0], parts: [{ id: 'wall', tags: [] }] }];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: JSON.stringify({ plan: {
      ...currentPlan, modules: [{ key: 'wall', id: 'runtime.surface-detail', params: {
        config: JSON.stringify({ objectId: 'invented-house', partId: 'wall', color: '#ff0000' })
      } }]
    } }) }), { status: 200 }));
    await expect(refineRenderSuggestion('协调颜色', currentPlan, BUILTIN_RENDER_SCHEMES, { coordinateColors: true, sceneProfile, fetchImpl }))
      .rejects.toThrow('unknown_scene_art_object:invented-house');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(currentPlan.modules[0].params.config)).color).toBe('#aaaaaa');
  });

  it.each([
    ['runtime.surface-detail', { objectId: 'house', partId: 'wall', color: '#aaaaaa' }, { objectId: 'house', partId: 'roof', color: '#ff0000' }],
    ['runtime.local-light', { objectId: 'house', targetId: 'lamp', color: '#aaaaaa' }, { objectId: 'house', targetId: 'house', color: '#ff0000' }],
    ['runtime.color-field', { target: 'terrain', stops: [[0, '#aaaaaa'], [1, '#ffffff']] }, { target: 'grass', stops: [[0, '#ff0000'], [1, '#ffffff']] }]
  ] as const)('rejects a reused %s key with a different existing config target', async (id, before, after) => {
    const currentPlan: RenderPlan = { version: 2, baseSchemeId: 'render-natural-day', modules: [{ key: 'rule', id, params: { config: JSON.stringify(before) } }] };
    const sceneProfile = createRenderSceneProfile(createEmptyMap());
    sceneProfile.targets!.objects = [
      { id: 'house', name: 'house', position: [0, 0, 0], parts: [{ id: 'wall', tags: [] }, { id: 'roof', tags: [] }] },
      { id: 'lamp', name: 'lamp', position: [1, 0, 0], parts: [] }
    ];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: JSON.stringify({ plan: {
      ...currentPlan, modules: [{ key: 'rule', id, params: { config: JSON.stringify(after) } }]
    } }) }), { status: 200 }));
    await expect(refineRenderSuggestion('协调颜色', currentPlan, BUILTIN_RENDER_SCHEMES, { coordinateColors: true, sceneProfile, fetchImpl }))
      .rejects.toThrow('coordinate_rule_target_changed:rule');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a reused material-theme key with a different scope', async () => {
    const currentPlan: RenderPlan = { version: 2, baseSchemeId: 'render-natural-day', modules: [{
      key: 'wood', id: 'runtime.material-theme', scope: { target: 'material-tag', tag: 'wood' }, params: { color: '#aaaaaa' }
    }] };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: JSON.stringify({ plan: {
      ...currentPlan, modules: [{ key: 'wood', id: 'runtime.material-theme', scope: { target: 'asset-tag', tag: 'house' }, params: { color: '#ff0000' } }]
    } }) }), { status: 200 }));
    await expect(refineRenderSuggestion('协调颜色', currentPlan, BUILTIN_RENDER_SCHEMES, { coordinateColors: true, fetchImpl }))
      .rejects.toThrow('coordinate_rule_target_changed:wood');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each<Record<string, string | number>>([{ roughness: 0.9, metalness: 0.2 }, { recipe: 'weathered' }])('preserves existing material interpolation strength for physics-bearing rules %j', async physics => {
    const currentPlan: RenderPlan = { version: 2, baseSchemeId: 'render-natural-day', modules: [{
      key: 'wood', id: 'runtime.material-theme', scope: { target: 'material-tag', tag: 'wood' }, params: { ...physics, strength: 0.2, color: '#aaaaaa' }
    }] };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: JSON.stringify({ plan: {
      ...currentPlan, modules: [{ ...currentPlan.modules[0], params: { ...physics, strength: 0.8, color: '#ff0000' } }]
    } }) }), { status: 200 }));
    const result = await refineRenderSuggestion('协调颜色', currentPlan, BUILTIN_RENDER_SCHEMES, { coordinateColors: true, fetchImpl });
    const before = compileRuntimeMaterialThemes(currentPlan)[0], after = compileRuntimeMaterialThemes(result.plan)[0];
    expect(after).toMatchObject({ strength: before.strength, roughness: before.roughness, metalness: before.metalness, color: '#ff0000' });
  });

  it('allows strength changes on existing pure color material rules', async () => {
    const currentPlan: RenderPlan = { version: 2, baseSchemeId: 'render-natural-day', modules: [{
      key: 'wood', id: 'runtime.material-theme', scope: { target: 'material-tag', tag: 'wood' }, params: { strength: 0.2, color: '#aaaaaa' }
    }] };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: JSON.stringify({ plan: {
      ...currentPlan, modules: [{ ...currentPlan.modules[0], params: { strength: 0.8, color: '#ff0000' } }]
    } }) }), { status: 200 }));
    const result = await refineRenderSuggestion('协调颜色', currentPlan, BUILTIN_RENDER_SCHEMES, { coordinateColors: true, fetchImpl });
    expect(result.plan.modules[0].params).toEqual({ strength: 0.8, color: '#ff0000' });
  });

  it('keeps scene-directed road colors from AI responses in the render plan', async () => {
    const params = { asphaltColor: '#6a7d85', brickPaverColor: '#b8a58a', roadDetailStrength: 0.3, roadTextureScale: 0.75 };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({
        plan: { version: 2, baseSchemeId: 'render-natural-day', modules: [{ id: 'runtime.terrain-materials', params }] },
        explanation: '道路采用与建筑协调的灰蓝沥青和米色铺装。'
      })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const suggestion = await generateRenderSuggestion('灰蓝色城市道路与米色石材广场', BUILTIN_RENDER_SCHEMES, {
      apiBase: 'https://example.test', provider: 'gpt', fetchImpl
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(suggestion.plan.modules).toContainEqual({ id: 'runtime.terrain-materials', params });
    expect(compileRuntimeTerrainMaterialStyle(suggestion.plan)).toMatchObject(params);
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> };
    expect(requestBody.messages[0]?.content).toContain('道路与铺装配色使用 runtime.terrain-materials');
    expect(requestBody.messages[0]?.content).toContain('值越大砖石纹理越大');
  });

  it('extracts JSON and clamps the render whitelist', () => {
    const suggestion = normalizeRenderSuggestion([
      '```json',
      JSON.stringify({
        plan: {
          version: 1,
          baseSchemeId: 'render-morning-mist',
          modules: [
            { id: 'environment.palette', params: { background: '#d7d2c4', fogColor: '#c9c5b8' } },
            { id: 'atmosphere.fog', params: { density: -2 } },
            { id: 'lighting.sun', params: { intensity: 4.2 } },
            { id: 'presentation.exposure', params: { value: 8 } }
          ]
        },
        styleTags: ['sketch', ' pastoral ', 'sketch', 4],
        explanation: '使用晨雾作为基础。'
      }),
      '```'
    ].join('\n'), BUILTIN_RENDER_SCHEMES);

    expect(suggestion).toEqual({
      baseSchemeId: 'render-morning-mist',
      settings: {
        background: '#d7d2c4',
        fogColor: '#c9c5b8',
        exposure: 1.5,
        fogDensity: 0,
        sunIntensity: 4.2
      },
      styleTags: ['sketch', 'pastoral'],
      explanation: '使用晨雾作为基础。',
      plan: {
        version: 1,
        baseSchemeId: 'render-morning-mist',
        modules: [
          { id: 'environment.palette', params: { background: '#d7d2c4', fogColor: '#c9c5b8' } },
          { id: 'atmosphere.fog', params: { density: 0 } },
          { id: 'lighting.sun', params: { intensity: 4.2 } },
          { id: 'presentation.exposure', params: { value: 1.5 } }
        ]
      }
    });
  });

  it('rejects a scheme id outside the supplied library', () => {
    expect(() => normalizeRenderSuggestion(
      '{"baseSchemeId":"unknown","settings":{}}',
      BUILTIN_RENDER_SCHEMES
    )).toThrow('unknown_render_scheme');
  });

  it('rejects an unsupported RenderPlan version', () => {
    expect(() => normalizeRenderSuggestion(JSON.stringify({
      plan: { version: 3, baseSchemeId: 'render-natural-day', modules: [] }
    }), BUILTIN_RENDER_SCHEMES)).toThrow('unsupported_render_plan_version');
  });

  it('allows AI to choose only a catalogued HDRI and harmonizes fog with its ground swatch', () => {
    const suggestion = normalizeRenderSuggestion(JSON.stringify({
      plan: {
        version: 2,
        baseSchemeId: 'render-natural-day',
        modules: [{
          id: 'environment.hdri',
          params: { texture: 'forest-day.exr', tint: '#ffffff', tintStrength: 0 }
        }]
      }
    }), BUILTIN_RENDER_SCHEMES, [{
      id: 'forest-day', file: 'forest-day.exr', extension: 'exr', bytes: 1,
      tags: ['day', 'forest'], skyColor: '#aaccff', groundColor: '#61745a'
    }]);

    expect(suggestion.plan.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'environment.palette', params: expect.objectContaining({ fogColor: '#61745a' }) }),
      expect.objectContaining({ id: 'lighting.hemisphere', params: expect.objectContaining({ skyColor: '#aaccff' }) })
    ]));
    expect(() => normalizeRenderSuggestion(JSON.stringify({
      plan: { version: 2, baseSchemeId: 'render-natural-day', modules: [{ id: 'environment.hdri', params: { texture: 'unknown.exr' } }] }
    }), BUILTIN_RENDER_SCHEMES, [{
      id: 'forest-day', file: 'forest-day.exr', extension: 'exr', bytes: 1, tags: []
    }])).toThrow('invalid_render_code:environment.hdri.texture');
  });

  it('calls the existing Voxel Studio chat API with the selected provider', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({
        baseSchemeId: 'render-natural-day',
        settings: { exposure: 0.9 },
        styleTags: ['soft-light'],
        explanation: '降低曝光。'
      })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const suggestion = await generateRenderSuggestion('柔和的田园晨雾', BUILTIN_RENDER_SCHEMES, {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl
    });

    expect(suggestion.settings.exposure).toBe(0.9);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.test/api/chat');
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    expect(requestBody).toMatchObject({
      provider: 'gpt',
      temperature: 0.2,
      maxTokens: 4096
    });
    expect(requestBody.messages[0].content).toContain('runtime.presentation-style');
    expect(requestBody.messages[0].content).toContain('sketch');
    expect(requestBody.messages[0].content).toContain('青绿、松石、翡翠、深蓝、灰蓝、茶绿');
    expect(requestBody.messages[0].content).toContain('opacity 默认保持在 0.45-0.72');
  });

  it('caps the combined HDRI, hard-day and color-grade contrast budget', () => {
    const suggestion = normalizeRenderSuggestion(JSON.stringify({
      plan: {
        version: 2,
        baseSchemeId: 'render-natural-day',
        modules: [
          {
            id: 'environment.hdri',
            params: { texture: 'bright-day.exr', exposure: 1.12, intensity: 1.3 }
          },
          {
            id: 'runtime.light-rig',
            params: { recipe: 'hard-day', strength: 1.35 }
          },
          {
            id: 'runtime.color-grade',
            params: { recipe: 'neutral', contrast: 1.14 }
          }
        ]
      }
    }), BUILTIN_RENDER_SCHEMES, [{
      id: 'bright-day', file: 'bright-day.exr', extension: 'exr', bytes: 1,
      tags: ['day'], skyColor: '#dcecff', groundColor: '#71808a'
    }]);
    const hdri = suggestion.plan.modules.find((module) => module.id === 'environment.hdri')!;
    const light = suggestion.plan.modules.find((module) => module.id === 'runtime.light-rig')!;
    const grade = suggestion.plan.modules.find((module) => module.id === 'runtime.color-grade')!;
    const budget = Number(hdri.params.exposure) * Number(hdri.params.intensity)
      * Number(light.params.strength) * Number(grade.params.contrast);

    expect(budget).toBeLessThanOrEqual(1.9);
    expect(Number(hdri.params.intensity)).toBeLessThan(1.3);
  });

  it('retries until the plan carries an HDRI sky when the user asked for one', async () => {
    const reply = (modules: unknown[]) => new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({ plan: { version: 2, baseSchemeId: 'render-natural-day', modules } })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply([{ id: 'atmosphere.fog', params: { density: 0.01 } }]))
      .mockResolvedValueOnce(reply([{ id: 'environment.hdri', params: { texture: 'forest-day.exr' } }]));

    const suggestion = await generateRenderSuggestion('黄昏森林', BUILTIN_RENDER_SCHEMES, {
      apiBase: 'https://example.test',
      fetchImpl,
      requireHdriSky: true,
      hdriTextures: [{ id: 'forest-day', file: 'forest-day.exr', extension: 'exr', bytes: 1, tags: ['forest'] }]
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).messages[0].content))
      .toContain('environment.hdri-library');
    expect(String(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body)).messages[3].content))
      .toContain('missing_requested_hdri_sky');
    expect(suggestion.plan.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'environment.hdri', params: expect.objectContaining({ texture: 'forest-day.exr' }) })
    ]));
  });

  it('exposes only capabilities that the current renderer can apply', () => {
    expect(RENDER_CAPABILITIES.map((capability) => capability.id)).toEqual([
      'environment.palette',
      'environment.hdri',
      'atmosphere.fog',
      'lighting.hemisphere',
      'lighting.sun',
      'presentation.exposure',
      'runtime.surface-style',
      'runtime.outline-style',
      'runtime.presentation-style',
      'runtime.color-grade',
      'runtime.water-style',
      'runtime.underwater',
      'runtime.grass-style',
      'runtime.material-theme',
      'runtime.light-rig',
      'runtime.post-quality',
      'runtime.terrain-materials',
      'runtime.weather',
      'runtime.atmosphere-fx',
      'runtime.volumetric-light',
      'runtime.glass-style',
      'runtime.effect-recipe',
      'runtime.color-field',
      'runtime.local-light',
      'runtime.surface-detail',
      'runtime.wet-surface',
      'runtime.shader-extension'
    ]);
  });

  it('compiles the runtime surface style and clamps its safe parameters', () => {
    const suggestion = normalizeRenderSuggestion(JSON.stringify({
      plan: {
        version: 1,
        baseSchemeId: 'render-natural-day',
        modules: [{
          id: 'runtime.surface-style',
          params: { mode: 'cel', bands: 99, rampStrength: -1 }
        }]
      }
    }), BUILTIN_RENDER_SCHEMES);

    expect(compileRuntimeStyle(suggestion.plan)).toEqual({
      mode: 'cel',
      cartoon: { bands: 8, rampStrength: 0 }
    });
  });

  it('rejects runtime style values outside the published enum', () => {
    expect(() => normalizeRenderSuggestion(JSON.stringify({
      plan: {
        version: 1,
        baseSchemeId: 'render-natural-day',
        modules: [{ id: 'runtime.surface-style', params: { mode: 'full-glsl' } }]
      }
    }), BUILTIN_RENDER_SCHEMES)).toThrow('invalid_render_enum:runtime.surface-style.mode');
  });

  it('compiles a safe sketch presentation plan without requiring a sketch preset', () => {
    const suggestion = normalizeRenderSuggestion(JSON.stringify({
      plan: {
        version: 1,
        baseSchemeId: 'render-morning-mist',
        modules: [{
          id: 'runtime.presentation-style',
          params: {
            mode: 'sketch',
            coordinateSpace: 'world',
            worldScale: 99,
            strength: 5,
            hatchSpacing: 2,
            colorMode: 'monochrome',
            lineColor: '#303038',
            paperColor: '#f4f0e6'
          }
        }]
      }
    }), BUILTIN_RENDER_SCHEMES);

    expect(compileRuntimePresentation(suggestion.plan)).toEqual({
      mode: 'sketch',
      sketch: {
        coordinateSpace: 'world',
        worldScale: 12,
        strength: 1,
        hatchSpacing: 3,
        preserveColor: false,
        lineColor: '#303038',
        paperColor: '#f4f0e6'
      },
      paper: {},
      comic: {}
    });
  });

  it('compiles the shipped outline modes and clamps their safe controls', () => {
    const suggestion = normalizeRenderSuggestion(JSON.stringify({
      plan: {
        version: 1,
        baseSchemeId: 'render-natural-day',
        modules: [{
          id: 'runtime.outline-style',
          params: {
            mode: 'echo',
            strength: 9,
            width: 0,
            objectWeight: 4,
            echoCount: 8,
            echoColor: '#d64562'
          }
        }]
      }
    }), BUILTIN_RENDER_SCHEMES);

    expect(compileRuntimeOutline(suggestion.plan)).toEqual({
      mode: 'echo',
      params: {
        strength: 2,
        width: 0.5,
        objectWeight: 2,
        echoCount: 3,
        echoColor: '#d64562'
      }
    });
  });

  it('compiles the named comic print recipe with safe refinements', () => {
    const suggestion = normalizeRenderSuggestion(JSON.stringify({
      plan: {
        version: 1,
        baseSchemeId: 'render-runtime-cel-day',
        modules: [{
          id: 'runtime.presentation-style',
          params: {
            mode: 'comic-print',
            halftoneStrength: 2,
            comicLineWidth: 8,
            printOffset: -2
          }
        }]
      }
    }), BUILTIN_RENDER_SCHEMES);

    expect(compileRuntimePresentation(suggestion.plan)).toMatchObject({
      mode: 'comic-print',
      comic: {
        halftoneStrength: 0.7,
        lineWidth: 4,
        printOffset: 0
      }
    });
  });

  it('repairs a plan that ignores an explicit sketch request', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          plan: { version: 1, baseSchemeId: 'render-morning-mist', modules: [] }
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          plan: {
            version: 1,
            baseSchemeId: 'render-morning-mist',
            modules: [{ id: 'runtime.presentation-style', params: { mode: 'sketch' } }]
          }
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const suggestion = await generateRenderSuggestion(
      '素描风格，柔和晨雾，宁静清晨氛围',
      BUILTIN_RENDER_SCHEMES,
      { fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(compileRuntimePresentation(suggestion.plan).mode).toBe('sketch');
  });

  it('turns an outdoor-biased reply into a clear material-first indoor plan', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({
        plan: {
          version: 2,
          baseSchemeId: 'render-runtime-sketch-mist',
          modules: [
            { id: 'environment.hdri', params: { texture: 'forest-day.exr', intensity: 1.4 } },
            { id: 'atmosphere.fog', params: { density: 0.02 } },
            { id: 'runtime.surface-style', params: { mode: 'cel' } },
            { id: 'runtime.grass-style', params: { windStrength: 0.4 } },
            { id: 'runtime.light-rig', params: { recipe: 'hard-day', strength: 1.4 } },
            { id: 'runtime.post-quality', params: { bloom: 'strong', ssao: 'strong' } },
            { id: 'presentation.exposure', params: { value: 1.45 } }
          ]
        },
        explanation: '明亮的自然光。'
      })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const suggestion = await generateRenderSuggestion('现代办公室，干净自然光', BUILTIN_RENDER_SCHEMES, {
      fetchImpl,
      requireHdriSky: true,
      hdriTextures: [{ id: 'forest-day', file: 'forest-day.exr', extension: 'exr', bytes: 1, tags: ['day'] }],
      sceneProfile: {
        sceneMode: 'indoor', size: [12, 3.2, 9],
        room: { windowCount: 2, doorCount: 1, windowArea: 6.4 },
        interior: { summary: 'modern office', palette: ['#e8e1d4', '#8b735c'], materialKeywords: ['oak'], surfaceRecipes: ['wood.plank', 'plaster.soft'] },
        lighting: { practicalLightCount: 1, coverageRatio: 0.25 },
        content: { hasWater: false, hasGrass: false, hasEmissive: true }
      }
    });

    expect(suggestion.baseSchemeId).toBe('render-indoor-neutral');
    expect(suggestion.settings.fogDensity).toBe(0);
    expect(suggestion.plan.modules.some((module) => module.id === 'runtime.grass-style')).toBe(false);
    expect(suggestion.plan.modules.find((module) => module.id === 'runtime.surface-style')?.params.mode).toBe('pbr');
    expect(suggestion.plan.modules.find((module) => module.id === 'runtime.light-rig')?.params.recipe).toBe('interior-daylight');
    expect(suggestion.plan.modules.find((module) => module.id === 'runtime.post-quality')?.params)
      .toMatchObject({ bloom: 'off', ssao: 'soft' });
    expect(suggestion.plan.modules.find((module) => module.id === 'environment.hdri')?.params)
      .toMatchObject({ backgroundVisibility: 'hidden', useAsEnvironment: 'on', environmentIntensity: 0.7 });
    expect(suggestion.plan.modules.find((module) => module.id === 'presentation.exposure')?.params.value).toBeLessThanOrEqual(1.1);
    expect(suggestion.explanation).toContain('灯光覆盖不足');

    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request.messages[0].content).toContain('"sceneMode":"indoor"');
    expect(request.messages[0].content).toContain('"coverageRatio":0.25');
  });

  it('keeps explicitly requested indoor smoke instead of forcing a clear room', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({
        plan: {
          version: 2,
          baseSchemeId: 'render-indoor-neutral',
          modules: [
            { id: 'environment.hdri', params: { texture: 'forest-day.exr' } },
            { id: 'atmosphere.fog', params: { density: 0.018 } }
          ]
        }
      })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const suggestion = await generateRenderSuggestion('地下酒吧里有明显烟雾', BUILTIN_RENDER_SCHEMES, {
      fetchImpl,
      requireHdriSky: true,
      hdriTextures: [{ id: 'forest-day', file: 'forest-day.exr', extension: 'exr', bytes: 1, tags: ['day'] }],
      sceneProfile: {
        sceneMode: 'indoor', size: [10, 3, 8],
        room: { windowCount: 0, doorCount: 1, windowArea: 0 },
        lighting: { practicalLightCount: 3, coverageRatio: 0.9 },
        content: { hasWater: false, hasGrass: false, hasEmissive: true }
      }
    });

    expect(suggestion.settings.fogDensity).toBe(0.018);
  });

  it('treats cartoon water as a water style and drops AI-only forbidden quality fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({
        plan: {
          version: 2,
          baseSchemeId: 'render-natural-day',
          modules: [
            {
              key: 'sea-water',
              id: 'runtime.water-style',
              scope: { target: 'water', tag: 'water' },
              params: { recipe: 'stylized', waveStrength: 0.65, waveSpeed: 0.5 }
            },
            {
              id: 'runtime.post-quality',
              params: { bloom: 'soft', ssao: 'soft', depthOfField: 'soft' }
            }
          ]
        }
      })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const suggestion = await generateRenderSuggestion(
      '宁静的海边渔村，清新夏日氛围，卡通风格的水面渲染，清晰的波纹，夏日微风。',
      BUILTIN_RENDER_SCHEMES,
      { fetchImpl }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(compileRuntimeStyle(suggestion.plan).mode).toBe('pbr');
    expect(suggestion.plan.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'runtime.water-style', params: expect.objectContaining({ recipe: 'stylized' }) }),
      expect.objectContaining({
        id: 'runtime.post-quality',
        params: { bloom: 'soft', ssao: 'soft' }
      })
    ]));
  });

  it('repairs an invalid module plan once', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          plan: {
            version: 1,
            baseSchemeId: 'render-natural-day',
            modules: [{ id: 'shader.full-glsl', params: { code: 'void main(){}' } }]
          }
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          plan: {
            version: 1,
            baseSchemeId: 'render-natural-day',
            modules: [
              { id: 'presentation.exposure', params: { value: 0.8 } },
              { id: 'runtime.presentation-style', params: { mode: 'sketch', coordinateSpace: 'world' } }
            ]
          },
          styleTags: ['sketch'],
          explanation: '改用当前可用的曝光模块。'
        })
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const suggestion = await generateRenderSuggestion('素描风格', BUILTIN_RENDER_SCHEMES, {
      apiBase: 'https://example.test',
      provider: 'gpt',
      fetchImpl
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(suggestion.plan.modules[0]?.id).toBe('presentation.exposure');
    const initialRequest = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    const repairRequest = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(initialRequest.maxTokens).toBe(4096);
    expect(repairRequest.maxTokens).toBe(4096);
    expect(repairRequest.temperature).toBe(0);
    expect(repairRequest.messages[3].content).toContain('unknown_render_module');
  });

  it('accepts a valid render plan with a stray trailing brace without a repair request', async () => {
    const content = JSON.stringify({
      plan: {
        version: 2,
        baseSchemeId: 'render-natural-day',
        modules: [{ id: 'presentation.exposure', params: { value: 0.9 } }]
      }
    }) + '}';
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const suggestion = await generateRenderSuggestion('warm morning light', BUILTIN_RENDER_SCHEMES, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(suggestion.plan.baseSchemeId).toBe('render-natural-day');
  });

  it('refines the current render plan without switching its base scheme', async () => {
    const currentPlan: RenderPlan = {
      version: 2,
      baseSchemeId: 'render-morning-mist',
      modules: [
        { id: 'atmosphere.fog', params: { density: 0.012 } },
        { id: 'runtime.presentation-style', params: { mode: 'sketch' } }
      ]
    };
    const progress: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify({
        plan: {
          ...currentPlan,
          modules: [
            { id: 'atmosphere.fog', params: { density: 0.024 } },
            { id: 'runtime.presentation-style', params: { mode: 'sketch' } }
          ]
        },
        explanation: '只增强晨雾'
      })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const suggestion = await refineRenderSuggestion(
      '雾再浓一点，其他不变',
      currentPlan,
      BUILTIN_RENDER_SCHEMES,
      { fetchImpl, onProgress: (event) => progress.push(event.phase), sceneProfile: {
        sceneMode: 'outdoor', size: [48, 24, 48],
        lighting: { practicalLightCount: 0, coverageRatio: 0 },
        content: { hasGrass: true, hasWater: false, hasEmissive: false },
        sceneArtBrief: { intent: 'walkable workshop', experienceMode: 'sequential', groups: [], focuses: [],
          viewpoints: [{ role: 'entry', point: [0, 0] }], relations: [], renderHints: ['warm work surface'] }
      } }
    );

    expect(suggestion.baseSchemeId).toBe(currentPlan.baseSchemeId);
    expect(suggestion.settings.fogDensity).toBe(0.024);
    expect(progress).toEqual(['planning', 'consulting', 'consulting', 'validating', 'complete']);
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request.messages[0].content).toContain('当前 RenderPlan');
    expect(request.messages[0].content).toContain('从 entry 看懂入口与主焦点');
    expect(request.messages[0].content).toContain('warm work surface');
    expect(request.messages[0].content).toContain('不得声称已通过视觉审查');
  });
});
