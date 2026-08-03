import { describe, expect, it } from 'vitest';
import {
  renderDeveloperCapability,
  renderDeveloperWorkspace
} from '../src/client/developerRenderControls';
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
    const currentControls = html.indexOf('developer-preset-grid');
    const policyControls = html.indexOf('developer-policy-table');
    const reflectionSlider = html.match(/<input class="developer-value-range"[^>]+data-dev-param="reflectionStrength"[^>]+>/)?.[0];
    const waveSlider = html.match(/<input class="developer-value-range"[^>]+data-dev-param="waveStrength"[^>]+>/)?.[0];
    const fresnelSlider = html.match(/<input class="developer-value-range"[^>]+data-dev-param="reflectionFresnel"[^>]+>/)?.[0];

    expect(currentControls).toBeGreaterThan(-1);
    expect(policyControls).toBeGreaterThan(currentControls);
    expect(reflectionSlider).toContain('min="0"');
    expect(reflectionSlider).toContain('max="1.5"');
    expect(reflectionSlider).toContain('value="0.9"');
    expect(reflectionSlider).not.toContain('disabled');
    expect(waveSlider).toContain('step="0.01"');
    expect(fresnelSlider).toContain('step="0.01"');
    expect(html).toContain('场景倒影强度');
    expect(html).toContain('HDRI 环境反射');
    expect(html).toContain('HDRI 反射曝光');
    expect(html).toContain('反射扰动');
    expect(html).toContain('反射 Fresnel');
    expect(html).toContain('全局结构化水体');
    expect(html).not.toContain('添加作用域');
    expect(html).not.toContain('在此预设中启用');
  });

  it('shows Scene Builder-style categories and only the selected category controls', () => {
    const scheme: RenderScheme = {
      id: 'natural',
      name: 'Natural',
      description: '',
      sourcePrompt: '',
      styleTags: [],
      accessPolicy: createDefaultRenderAccessPolicy(),
      schemaVersion: 1,
      kind: 'builtin',
      settings: {
        background: '#89abcd',
        fogColor: '#aabbcc',
        fogDensity: 0.012,
        hemisphereSkyColor: '#ffffff',
        hemisphereGroundColor: '#334433',
        hemisphereIntensity: 1.4,
        sunColor: '#ffeecc',
        sunIntensity: 2.8,
        exposure: 1.1
      },
      createdAt: 1,
      updatedAt: 1
    };

    const html = renderDeveloperWorkspace(scheme, [], 'environment', 'tuning');

    expect(html).toContain('data-dev-category="lighting"');
    expect(html).toContain('data-dev-category="style"');
    expect(html).toContain('data-dev-category="post"');
    expect(html).toContain('data-dev-category="environment"');
    expect(html).toContain('data-dev-category="water"');
    expect(html).toContain('data-dev-category="materials"');
    expect(html).toContain('HDRI 天空');
    expect(html).toContain('全局雾');
    expect(html).not.toContain('data-dev-module-id="lighting.sun"');
    expect(html).toContain('value="0.012"');
    expect(html).not.toContain('在此预设中启用');
  });
});
