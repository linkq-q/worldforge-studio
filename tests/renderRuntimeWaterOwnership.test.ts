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

  it('keeps structured inland water visible through its shallow shore transition', () => {
    const river = structuredWaterShoreTransition('river');
    expect(river.transparency).toBeLessThanOrEqual(0.5);
    expect(river.edgeAlpha).toBeGreaterThanOrEqual(0.5);
    expect(structuredWaterShoreTransition('lake').transparency).toBeGreaterThan(river.transparency);
    expect(structuredWaterShoreTransition('ocean').transparency).toBe(0);
  });
});
