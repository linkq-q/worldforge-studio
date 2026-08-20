import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { shouldBindRenderPlanWaterSurface } from '../src/client/renderRuntimeAdapter';

describe('render-plan water ownership', () => {
  it('leaves material-tag model water under its dedicated runtime', () => {
    const naturalWater = new THREE.Mesh();
    const modelWater = new THREE.Mesh();
    modelWater.userData.isModelWater = true;

    expect(shouldBindRenderPlanWaterSurface(naturalWater)).toBe(true);
    expect(shouldBindRenderPlanWaterSurface(modelWater)).toBe(false);
  });
});
