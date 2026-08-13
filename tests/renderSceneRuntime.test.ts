import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  RenderSceneRuntime,
  applyRenderScheme,
  type RenderSchemeTargets
} from '../src/client/renderSceneRuntime';
import { RenderRuntimeAdapter } from '../src/client/renderRuntimeAdapter';
import { BUILTIN_RENDER_SCHEMES, createRenderScheme } from '../src/shared/renderScheme';
import { createEmptyMap } from '../src/shared/map';

const PLAIN_SCHEME = BUILTIN_RENDER_SCHEMES[0];
/** A builtin that actually carries a `RenderPlan`, so styling is observable. */
const STYLED_SCHEME = BUILTIN_RENDER_SCHEMES.find((scheme) => scheme.id === 'render-runtime-comic-print')!;

function createTargets() {
  const adapter = {
    resetScopedCapabilities: vi.fn(),
    applyOutline: vi.fn(),
    applyPresentation: vi.fn(),
    applyColorGrade: vi.fn(),
    applyPostQuality: vi.fn(),
    applyDistanceFog: vi.fn(),
    applyScopedCapabilities: vi.fn()
  };
  const styleManager = { applyStyle: vi.fn(), setCartoonParams: vi.fn() };
  const hdriSky = { apply: vi.fn(async () => {}), clear: vi.fn() };
  const rendered = { setGrassStyle: vi.fn(), setLightingTimeOfDay: vi.fn() };
  const updateLighting = vi.fn();
  const targets: RenderSchemeTargets = {
    scene: new THREE.Scene(),
    // `configureRendererOutput` only writes two tone-mapping fields.
    renderer: { toneMapping: 0, toneMappingExposure: 1 } as unknown as THREE.WebGLRenderer,
    sunLight: new THREE.DirectionalLight(0xffffff, 1),
    hemisphereLight: new THREE.HemisphereLight(0xffffff, 0x000000, 1),
    styleManager,
    adapter,
    hdriSky,
    rendered,
    updateLighting
  };
  return { targets, adapter, styleManager, hdriSky, rendered, updateLighting };
}

describe('applyRenderScheme', () => {
  it('pushes a scheme onto lights, exposure, fog and the runtime adapter', () => {
    const { targets, adapter, styleManager, rendered } = createTargets();
    const scheme = STYLED_SCHEME;

    applyRenderScheme(targets, scheme);

    const settings = scheme.settings;
    expect((targets.scene.background as THREE.Color).getHexString())
      .toBe(new THREE.Color(settings.background).getHexString());
    expect(targets.renderer.toneMappingExposure).toBe(settings.exposure);
    expect(targets.hemisphereLight.intensity).toBe(settings.hemisphereIntensity);
    expect(adapter.applyDistanceFog).toHaveBeenCalledWith(settings.fogColor, settings.fogDensity);
    expect(adapter.resetScopedCapabilities).toHaveBeenCalled();
    expect(rendered.setGrassStyle).toHaveBeenCalled();
    // The plan names an outline and a presentation module; both must arrive.
    expect(styleManager.applyStyle).toHaveBeenCalledWith(
      expect.objectContaining({ renderMode: 'cel' })
    );
    expect(adapter.applyOutline).not.toHaveBeenLastCalledWith({ mode: 'none', params: {} });
    expect(adapter.applyPresentation.mock.lastCall?.[0].mode).not.toBe('none');
  });

  it('restores the neutral look and drops the sky when no scheme is selected', () => {
    const { targets, adapter, styleManager, hdriSky, updateLighting } = createTargets();

    // Start from a styled scheme so a leftover capability would be visible.
    applyRenderScheme(targets, STYLED_SCHEME);
    applyRenderScheme(targets, null);

    expect(styleManager.applyStyle).toHaveBeenLastCalledWith({ renderMode: 'pbr' });
    expect(adapter.applyPostQuality)
      .toHaveBeenLastCalledWith({ bloom: 'off', ssao: 'off', depthOfField: 'off' });
    expect(adapter.applyDistanceFog).toHaveBeenLastCalledWith('#111719', 0);
    expect(adapter.applyScopedCapabilities).toHaveBeenLastCalledWith([], [], []);
    expect(targets.sunLight.intensity).toBe(2.5);
    // The styled pass applied a sky; clearing the scheme has to take it back off.
    expect(hdriSky.apply).toHaveBeenCalledTimes(1);
    expect(hdriSky.clear).toHaveBeenCalledTimes(1);
    expect(updateLighting).toHaveBeenCalled();
  });

  it('uses an indoor night profile instead of the outdoor daylight path', () => {
    const { targets, rendered } = createTargets();
    targets.map = createEmptyMap('night room', 'night-room', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    const scheme = createRenderScheme({
      name: 'indoor night',
      settings: PLAIN_SCHEME.settings,
      renderPlan: {
        version: 2,
        baseSchemeId: PLAIN_SCHEME.id,
        visualDirection: {
          version: 1,
          contrastMode: 'bright-cartoon',
          timeOfDay: 'night',
          temperature: 'cool',
          palette: {
            sky: '#17233f', keyLight: '#9bb8e8', fillLight: '#4b628f', shadow: '#171d2d',
            fog: '#151b2d', waterBias: '#294768', accent: '#ffd39a'
          },
          atmosphereFx: { masterStrength: 0.1, pollen: 0, vapor: 0, dust: 0 }
        },
        modules: []
      }
    });

    applyRenderScheme(targets, scheme);

    expect(rendered.setLightingTimeOfDay).toHaveBeenCalledWith('night');
    expect(targets.sunLight.intensity).toBeLessThan(0.2);
    expect(targets.hemisphereLight.intensity).toBeLessThan(0.1);
    expect(targets.renderer.toneMappingExposure).toBeGreaterThan(scheme.settings.exposure);
  });

  it('treats an explicit night recipe as night even when an older visual direction says noon', () => {
    const { targets, rendered } = createTargets();
    targets.map = createEmptyMap('night override', 'night-override', [10, 3, 8], 'voxel', 'indoor', [10, 3, 8]);
    const scheme = createRenderScheme({
      name: 'night override',
      settings: PLAIN_SCHEME.settings,
      renderPlan: {
        version: 2,
        baseSchemeId: PLAIN_SCHEME.id,
        visualDirection: {
          version: 1,
          contrastMode: 'bright-cartoon',
          timeOfDay: 'noon',
          temperature: 'cool',
          palette: {
            sky: '#17233f', keyLight: '#9bb8e8', fillLight: '#4b628f', shadow: '#171d2d',
            fog: '#151b2d', waterBias: '#294768', accent: '#ffd39a'
          },
          atmosphereFx: { masterStrength: 0.1, pollen: 0, vapor: 0, dust: 0 }
        },
        modules: [{ id: 'runtime.light-rig', params: { recipe: 'night' } }]
      }
    });

    applyRenderScheme(targets, scheme);

    expect(rendered.setLightingTimeOfDay).toHaveBeenCalledWith('night');
  });

  it('leaves the scene unstyled when the scheme carries no render plan', () => {
    const { targets, adapter, hdriSky, rendered } = createTargets();
    const scheme = createRenderScheme({
      name: 'plain',
      settings: {
        ...PLAIN_SCHEME.settings,
        fogColor: '#8899aa',
        hemisphereSkyColor: '#ccddee',
        hemisphereGroundColor: '#252b35',
        sunColor: '#ffd0a0'
      }
    });
    expect(scheme.renderPlan).toBeUndefined();

    applyRenderScheme(targets, scheme);

    expect(adapter.applyOutline).toHaveBeenLastCalledWith({ mode: 'none', params: {} });
    expect(adapter.applyColorGrade).toHaveBeenLastCalledWith({ recipe: 'neutral' });
    expect(adapter.applyScopedCapabilities).toHaveBeenLastCalledWith([], [], []);
    expect(rendered.setGrassStyle.mock.lastCall?.[0]).toMatchObject({
      rootColor: expect.not.stringMatching(/^#72ad49$/i),
      tipColor: expect.not.stringMatching(/^#b7df76$/i),
      groundColor: expect.not.stringMatching(/^#669746$/i)
    });
    // A scheme without a plan must not leave a previous panorama on the dome.
    expect(hdriSky.clear).toHaveBeenCalled();
  });

  it('keeps a legacy plan\'s HDRI after discarding removed streak settings', () => {
    const { targets, hdriSky } = createTargets();
    const scheme = createRenderScheme({
      name: 'legacy HDRI',
      settings: PLAIN_SCHEME.settings,
      renderPlan: {
        version: 2,
        baseSchemeId: PLAIN_SCHEME.id,
        modules: [
          { id: 'environment.hdri', params: { texture: 'night-forest.hdr' } },
          { id: 'runtime.atmosphere-fx', params: { masterStrength: 0.5, sunShafts: 0.8, windStreaks: 0.6 } }
        ]
      }
    });

    expect(scheme.renderPlan?.modules.find((module) => module.id === 'runtime.atmosphere-fx')?.params)
      .toEqual({ masterStrength: 0.5 });

    applyRenderScheme(targets, scheme);

    expect(hdriSky.apply).toHaveBeenCalledWith(expect.objectContaining({ texture: 'night-forest.hdr' }));
  });

  it('keeps explicit grass colors while deriving the remaining colors from the environment', () => {
    const { targets, rendered } = createTargets();
    const scheme = createRenderScheme({
      name: 'manual grass',
      settings: { ...PLAIN_SCHEME.settings, hemisphereGroundColor: '#182536', sunColor: '#ffbb88' },
      renderPlan: {
        version: 2,
        baseSchemeId: PLAIN_SCHEME.id,
        modules: [{ id: 'runtime.grass-style', params: { rootColor: '#123456' } }]
      }
    });

    applyRenderScheme(targets, scheme);

    expect(rendered.setGrassStyle.mock.lastCall?.[0]).toMatchObject({
      rootColor: '#123456',
      tipColor: expect.not.stringMatching(/^#b7df76$/i)
    });
  });
});

describe('RenderSceneRuntime sizing', () => {
  it('does not reset the WebGL canvas when its size is unchanged', () => {
    let pixelRatio = 2;
    const camera = {
      aspect: 1,
      updateProjectionMatrix: vi.fn()
    };
    const renderer = {
      getPixelRatio: () => pixelRatio,
      setSize: vi.fn()
    };
    const adapter = { setSize: vi.fn() };
    const runtime = Object.assign(Object.create(RenderSceneRuntime.prototype), {
      camera,
      renderer,
      adapter
    }) as RenderSceneRuntime;

    runtime.setSize(800, 600);
    runtime.setSize(800, 600);

    expect(renderer.setSize).toHaveBeenCalledTimes(1);
    expect(camera.updateProjectionMatrix).toHaveBeenCalledTimes(1);
    expect(adapter.setSize).toHaveBeenCalledTimes(1);

    pixelRatio = 1;
    runtime.setSize(800, 600);

    expect(renderer.setSize).toHaveBeenCalledTimes(1);
    expect(adapter.setSize).toHaveBeenCalledTimes(2);
  });

  it('resizes post-process targets in the same frame as an adaptive pixel-ratio change', () => {
    let pixelRatio = 2;
    const renderer = {
      getPixelRatio: () => pixelRatio,
      setPixelRatio: vi.fn((value: number) => { pixelRatio = value; }),
      setSize: vi.fn()
    };
    const adapter = {
      setSize: vi.fn(),
      applyAtmosphereFx: vi.fn()
    };
    const runtime = Object.assign(Object.create(RenderSceneRuntime.prototype), {
      renderer,
      adapter,
      atmosphereFx: { setQuality: vi.fn() },
      camera: { aspect: 1, updateProjectionMatrix: vi.fn() },
      basePixelRatio: 2,
      adaptiveQuality: 1,
      width: 800,
      height: 600,
      pixelRatio: 2,
      map: null
    }) as RenderSceneRuntime;

    runtime.setAdaptiveQuality(0.68);

    expect(renderer.setPixelRatio).toHaveBeenCalledOnce();
    expect(adapter.setSize).toHaveBeenCalledWith(800, 600);
  });

  it('keeps the composer pixel ratio in sync with its render targets', () => {
    const composer = { setPixelRatio: vi.fn(), setSize: vi.fn() };
    const target = () => ({ setSize: vi.fn() });
    const normalTarget = target();
    const edgeTarget = target();
    const boundaryTarget = target();
    const edgePass = target();
    const adapter = Object.assign(Object.create(RenderRuntimeAdapter.prototype), {
      renderer: {
        getPixelRatio: () => 1,
        getDrawingBufferSize: (size: THREE.Vector2) => size.set(800, 600)
      },
      composer,
      normalTarget,
      edgeTarget,
      boundaryTarget,
      edgePass,
      inkPass: { uniforms: { uResolution: { value: new THREE.Vector2() } } },
      comicPass: { uniforms: { uResolution: { value: new THREE.Vector2() } } },
      sketchPass: { uniforms: { uResolution: { value: new THREE.Vector2() } } },
      curvaturePass: { uniforms: { uTexelSize: { value: new THREE.Vector2() } } },
      width: 800,
      height: 600,
      pixelRatio: 2
    }) as RenderRuntimeAdapter;

    adapter.setSize(800, 600);

    expect(composer.setPixelRatio).toHaveBeenCalledWith(1);
    expect(composer.setSize).toHaveBeenCalledWith(800, 600);
    for (const renderTarget of [normalTarget, edgeTarget, boundaryTarget, edgePass]) {
      expect(renderTarget.setSize).toHaveBeenCalledWith(800, 600);
    }
  });
});
