import { describe, expect, it } from 'vitest';
import {
  renderDeveloperCapability,
  renderDeveloperWorkspace
} from '../src/client/developerRenderControls';
import type { RenderScheme } from '../src/shared/renderScheme';
import { BUILTIN_RENDER_SCHEMES } from '../src/shared/renderScheme';
import {
  createDefaultRenderAccessPolicy,
  RENDER_CAPABILITIES
} from '../src/shared/renderPlan';

describe('developer render controls', () => {
  it('offers localized road colors and bounded texture controls in existing terrain settings', () => {
    const capability = RENDER_CAPABILITIES.find((entry) => entry.id === 'runtime.terrain-materials');
    if (!capability) throw new Error('missing terrain capability');
    const scheme: RenderScheme = {
      ...BUILTIN_RENDER_SCHEMES[0]!,
      renderPlan: {
        version: 2, baseSchemeId: BUILTIN_RENDER_SCHEMES[0]!.id,
        modules: [{ id: 'runtime.terrain-materials', params: { brickPaverColor: '#a2b3c4', roadTextureScale: 0.75 } }]
      }
    };
    const html = renderDeveloperCapability(capability, scheme, []);
    const colorInput = html.match(/<input[^>]+data-dev-param="brickPaverColor"[^>]+>/)?.[0];
    const scaleInput = html.match(/<input class="developer-value-range"[^>]+data-dev-param="roadTextureScale"[^>]+>/)?.[0];
    const detailInput = html.match(/<input class="developer-value-range"[^>]+data-dev-param="roadDetailStrength"[^>]+>/)?.[0];
    expect(colorInput).toContain('type="color"');
    expect(colorInput).toContain('value="#a2b3c4"');
    expect(scaleInput).toContain('min="0.5"');
    expect(scaleInput).toContain('max="2"');
    expect(scaleInput).toContain('value="0.75"');
    expect(detailInput).toContain('value="0.45"');
    for (const label of ['铺路砖颜色', '沥青路面颜色', '路面纹理尺寸', '路面细节强度']) {
      expect(html).toContain(label);
    }
  });

  it('previews the current water value across the hard range before access policy limits', () => {
    const accessPolicy = createDefaultRenderAccessPolicy();
    const reflectionAccess = accessPolicy.parameters.find((entry) => (
      entry.moduleId === 'runtime.water-style' && entry.parameter === 'environmentReflectionStrength'
    ));
    if (!reflectionAccess) throw new Error('missing environmentReflectionStrength policy');
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
            environmentReflectionStrength: 0.9,
            environmentReflectionExposure: 0.7
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
    const reflectionSlider = html.match(/<input class="developer-value-range"[^>]+data-dev-param="environmentReflectionStrength"[^>]+>/)?.[0];
    const waveSlider = html.match(/<input class="developer-value-range"[^>]+data-dev-param="waveStrength"[^>]+>/)?.[0];

    expect(currentControls).toBeGreaterThan(-1);
    expect(policyControls).toBeGreaterThan(currentControls);
    expect(reflectionSlider).toContain('min="0"');
    expect(reflectionSlider).toContain('max="1"');
    expect(reflectionSlider).toContain('value="0.9"');
    expect(reflectionSlider).not.toContain('disabled');
    expect(waveSlider).toContain('step="0.01"');
    expect(html).toContain('HDRI 环境反射');
    expect(html).toContain('HDRI 反射曝光');
    expect(html).not.toContain('data-dev-param="reflectionStrength"');
    expect(html).not.toContain('data-dev-param="reflectionDistortion"');
    expect(html).not.toContain('data-dev-param="reflectionFresnel"');
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

  it('keeps the shared clear enum localized by capability', () => {
    const underwater = RENDER_CAPABILITIES.find((entry) => entry.id === 'runtime.underwater');
    const weather = RENDER_CAPABILITIES.find((entry) => entry.id === 'runtime.weather');
    if (!underwater || !weather) throw new Error('missing underwater or weather capability');
    const scheme = BUILTIN_RENDER_SCHEMES[0]!;

    expect(renderDeveloperCapability(underwater, scheme, [])).toContain('清澈水下');
    expect(renderDeveloperCapability(underwater, scheme, [])).toContain('焦散强度');
    expect(renderDeveloperCapability(weather, scheme, [])).toContain('晴朗');
    expect(renderDeveloperCapability(weather, scheme, [])).not.toContain('清澈水下');
  });
});
