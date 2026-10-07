import { describe, expect, it } from 'vitest';
import { compileOutdoorLighting } from '../src/shared/outdoorLighting';
import { normalizeRenderScheme } from '../src/shared/renderScheme';
import { decodeWorldForgeTransfer, encodeRenderSchemeTransfer } from '../src/shared/scenePackage';

describe('outdoor lighting scheme', () => {
  it('leaves existing schemes unchanged until explicitly enabled', () => {
    expect(compileOutdoorLighting()).toBeNull();
    expect(compileOutdoorLighting({ version: 2, baseSchemeId: 'render-indoor-neutral', modules: [] })).toBeNull();
  });

  it('preserves the complete outdoor look through portable scheme export', () => {
    const scheme = normalizeRenderScheme({ name: 'Courtyard', renderPlan: {
      version: 2, baseSchemeId: 'render-indoor-neutral', modules: [{ id: 'runtime.outdoor-lighting', params: {
        quality: 2, skyQuality: 4, shadowQuality: 2, edgeSoftening: 0.04, roughnessScale: 0.85, sunAzimuth: -48, sunElevation: 30, shadowSoftness: 0.5, haze: 0.2,
        clouds: 0.4, bounce: 0.25, materialDetail: 0.65, reflections: 0.6
      } }]
    } });
    expect(scheme.renderPlan?.modules).toHaveLength(1);
    const transfer = decodeWorldForgeTransfer(encodeRenderSchemeTransfer(scheme));
    expect(transfer.kind).toBe('render-scheme');
    if (transfer.kind !== 'render-scheme') throw new Error('Wrong transfer');
    expect(compileOutdoorLighting(transfer.renderScheme.renderPlan)).toEqual(scheme.renderPlan?.modules[0].params);
  });

  it('keeps previously saved outdoor schemes on the original rendering algorithm', () => {
    expect(compileOutdoorLighting({ version: 2, baseSchemeId: 'render-indoor-neutral', modules: [
      { id: 'runtime.outdoor-lighting', params: {} }
    ] })?.quality).toBe(1);
    expect(compileOutdoorLighting({ version: 2, baseSchemeId: 'render-indoor-neutral', modules: [
      { id: 'runtime.outdoor-lighting', params: { quality: 2 } }
    ] })?.skyQuality).toBe(1);
    expect(compileOutdoorLighting({ version: 2, baseSchemeId: 'render-indoor-neutral', modules: [
      { id: 'runtime.outdoor-lighting', params: { quality: 2, skyQuality: 4 } }
    ] })?.shadowQuality).toBe(1);
  });

  it('bounds shadow quality independently of the approved sky and lighting', () => {
    for (const [value, expected] of [[0, 1], [2, 2], [9, 2]]) {
      const scheme = normalizeRenderScheme({ name: 'Shadow comparison', renderPlan: {
        version: 2, baseSchemeId: 'render-indoor-neutral', modules: [
          { id: 'runtime.outdoor-lighting', params: { quality: 2, skyQuality: 4, shadowQuality: value, shadowSoftness: 0.5 } }
        ]
      } });
      expect(scheme.renderPlan?.modules[0].params.shadowQuality).toBe(expected);
      expect(compileOutdoorLighting(scheme.renderPlan)).toMatchObject({
        quality: 2, skyQuality: 4, shadowQuality: expected, shadowSoftness: 0.5
      });
      expect(scheme.accessPolicy.parameters.find(parameter => parameter.moduleId === 'runtime.outdoor-lighting'
        && parameter.parameter === 'shadowQuality')).toMatchObject({
        ai: { enabled: true, min: 1, max: 2 }, developer: { enabled: true, min: 1, max: 2 }
      });
    }
  });
});
