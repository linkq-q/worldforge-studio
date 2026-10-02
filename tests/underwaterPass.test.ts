import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  absorptionFromTransmittance,
  createUnderwaterPass
} from '@voxel-studio/render-runtime/postprocess';

describe('underwater post-process', () => {
  it('derives stronger red absorption from a blue-green transmission color', () => {
    const absorption = absorptionFromTransmittance(new THREE.Color(0.18, 0.55, 0.72), 35);

    expect(absorption.x).toBeGreaterThan(absorption.y);
    expect(absorption.y).toBeGreaterThan(absorption.z);
    expect(absorption.x).toBeCloseTo(-Math.log(0.18) / 35, 6);
  });

  it('uses scene depth and a moving wave field instead of a flat screen-space waterline', () => {
    const pass = createUnderwaterPass();
    const shader = pass.material.fragmentShader;

    expect(shader).toContain('texture2D(tDepth, vUv)');
    expect(shader).toContain('uProjectionMatrixInverse');
    expect(shader).toContain('uCameraMatrixWorld');
    expect(shader).toContain('float waterSurfaceHeight(vec2 worldXZ)');
    expect(shader).toContain('uTime * uWaveSpeed');
    expect(shader).toContain('float waterlineSlope');
    expect(shader).toContain('uWaterlineColor');
    expect(shader).toContain('waterlineEdge');
    expect(shader).toContain('vec2 waterSurfaceSlope');
    expect(shader).toContain('refractedUv');
    expect(shader).toContain('float causticPattern');
    expect(shader).toContain('waterlineHalo');
    expect(shader).toContain('waterlineFoamShelf');
    expect(shader).toContain('passActivation');
    expect(shader).toContain('rippledWaterlineDelta');
    expect(shader).toContain('cameraUnderwater');
    expect(shader).toContain('sceneUnderwater');
    expect(shader).toContain('exp(-uAbsorption * max(waterDistance, 0.0))');
    expect(shader).not.toContain('texture2D(tDiffuse, vUv +');

    pass.dispose();
  });
});
