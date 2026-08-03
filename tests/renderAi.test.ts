import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_RENDER_SCHEMES } from '../src/shared/renderScheme';
import {
  compileRuntimeOutline,
  compileRuntimePresentation,
  compileRuntimeStyle,
  RENDER_CAPABILITIES,
  type RenderPlan
} from '../src/shared/renderPlan';
import {
  generateRenderSuggestion,
  normalizeRenderSuggestion,
  refineRenderSuggestion
} from '../src/server/renderAi';

describe('render AI adapter', () => {
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
        exposure: 3,
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
          { id: 'presentation.exposure', params: { value: 3 } }
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
      maxTokens: 1000
    });
    expect(requestBody.messages[0].content).toContain('runtime.presentation-style');
    expect(requestBody.messages[0].content).toContain('sketch');
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
      'runtime.grass-style',
      'runtime.material-theme',
      'runtime.light-rig',
      'runtime.post-quality',
      'runtime.atmosphere-fx',
      'runtime.effect-recipe',
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
    const repairRequest = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(repairRequest.messages[3].content).toContain('unknown_render_module');
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
      { fetchImpl, onProgress: (event) => progress.push(event.phase) }
    );

    expect(suggestion.baseSchemeId).toBe(currentPlan.baseSchemeId);
    expect(suggestion.settings.fogDensity).toBe(0.024);
    expect(progress).toEqual(['planning', 'validating', 'complete']);
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request.messages[0].content).toContain('当前 RenderPlan');
  });
});
