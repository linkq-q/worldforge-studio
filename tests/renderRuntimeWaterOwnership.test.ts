import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { shouldBindRenderPlanWaterSurface, structuredWaterShoreTransition } from '../src/client/renderRuntimeAdapter';

describe('render-plan water ownership', () => {
  it('leaves material-tag model water under its dedicated runtime', () => {
    const naturalWater = new THREE.Mesh();
    const modelWater = new THREE.Mesh();
    modelWater.userData.isModelWater = true;

    expect(shouldBindRenderPlanWaterSurface(naturalWater)).toBe(true);
    expect(shouldBindRenderPlanWaterSurface(modelWater)).toBe(false);
  });

  it('fades narrow river banks and outlet caps without changing lake or ocean transitions', () => {
    const river = structuredWaterShoreTransition('river');
    const lake = structuredWaterShoreTransition('lake');
    expect(river.transparency).toBeGreaterThan(lake.transparency);
    expect(river.edgeAlpha).toBeLessThan(lake.edgeAlpha);
    expect(1 - river.transparency * (1 - river.edgeAlpha)).toBeLessThan(0.5);
    expect(lake).toEqual({ transparency: 0.62, edgeAlpha: 0.38 });
    expect(structuredWaterShoreTransition('ocean').transparency).toBe(0);
  });
});
