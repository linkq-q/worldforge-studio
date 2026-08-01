import { describe, expect, it } from 'vitest';
import { renderDeveloperCapability } from '../src/client/developerRenderControls';
import type { RenderScheme } from '../src/shared/renderScheme';
import {
  createDefaultRenderAccessPolicy,
  RENDER_CAPABILITIES
} from '../src/shared/renderPlan';

describe('developer render controls', () => {
  it('previews the current water value across the hard range before access policy limits', () => {
    const accessPolicy = createDefaultRenderAccessPolicy();
    const reflectionAccess = accessPolicy.parameters.find((entry) => (
      entry.moduleId === 'runtime.water-style' && entry.parameter === 'reflectionStrength'
    ));
    if (!reflectionAccess) throw new Error('missing reflectionStrength policy');
    reflectionAccess.developer = { enabled: true, min: 0.2, max: 0.4 };

    const scheme: RenderScheme = {
      id: 'water-tuning',
      name: 'Water tuning',
      description: '',
      sourcePrompt: '',
      styleTags: [],
      renderPlan: {
        version: 2,
        baseSchemeId: 'render-natural-day',
        modules: [{
          key: 'lake',
          id: 'runtime.water-style',
          scope: { target: 'water', tag: 'water' },
          params: {
            recipe: 'calm-lake',
            reflectionStrength: 0.9,
            reflectionDistortion: 0.07,
            reflectionFresnel: 1.4
          }
        }]
      },
      accessPolicy,
      schemaVersion: 1,
      kind: 'custom',
      settings: {
        background: '#000000',
        fogColor: '#000000',
        fogDensity: 0,
        hemisphereSkyColor: '#ffffff',
        hemisphereGroundColor: '#000000',
        hemisphereIntensity: 1,
        sunColor: '#ffffff',
        sunIntensity: 1,
        exposure: 1
      },
      createdAt: 1,
      updatedAt: 1
    };
    const capability = RENDER_CAPABILITIES.find((entry) => entry.id === 'runtime.water-style');
    if (!capability) throw new Error('missing water capability');

    const html = renderDeveloperCapability(capability, scheme, []);
    const currentHeading = html.indexOf('当前效果 · 实时预览');
    const policyHeading = html.indexOf('开放策略');
    const reflectionSlider = html.match(/<input class="developer-value-range"[^>]+data-dev-param="reflectionStrength"[^>]+>/)?.[0];

    expect(currentHeading).toBeGreaterThan(-1);
    expect(policyHeading).toBeGreaterThan(currentHeading);
    expect(reflectionSlider).toContain('min="0"');
    expect(reflectionSlider).toContain('max="1.5"');
    expect(reflectionSlider).toContain('value="0.9"');
    expect(reflectionSlider).not.toContain('disabled');
    expect(html).toContain('反射强度');
    expect(html).toContain('反射扰动');
    expect(html).toContain('反射 Fresnel');
  });
});
