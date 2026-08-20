import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import materialTagVocabulary from '@voxel-studio/render-runtime/model/material-tags-v1.json';
import {
  MATERIAL_TAG_FIRE_PARAMS,
  createMaterialTagFireConfigs
} from '../src/client/materialTagFireRuntime';

describe('material-tag fire recipe', () => {
  it('keeps the 3d-generate live-tuning defaults byte-for-value compatible', () => {
    expect(MATERIAL_TAG_FIRE_PARAMS).toEqual({
      densityScale: 1,
      sizeScale: 1.35,
      plumeSpread: 1,
      pathParticleScale: 2.2,
      pathSpread: 1,
      jetLengthScale: 1,
      jetWidthScale: 2.5,
      jetSpeedScale: 1,
      jetSpread: 0.3,
      jetLiftStrength: 0.45,
      jetTurbulence: 0.29,
      sparkScale: 1.25,
      flicker: 0.31,
      coreColor: '#dd643c',
      bodyColor: '#ff5900',
      edgeColor: '#8e1e0b'
    });
  });

  it('builds the same four regular emitters and ember-only low tier', () => {
    const side = 0.42 * Math.SQRT2;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(side, 1.2, side));
    const fireTag = (materialTagVocabulary as any).tags.fire;
    const regular = createMaterialTagFireConfigs(mesh, { value: 0.75 }, fireTag);
    const embers = createMaterialTagFireConfigs(mesh, { value: 0.25 }, fireTag);

    expect(regular).toHaveLength(4);
    expect(regular.map((config) => config.rate)).toEqual([18, 28, 6, 7]);
    expect(regular.map((config) => config.map)).toEqual([
      expect.stringContaining('vfx_fire_4x4'),
      expect.stringContaining('vfx_fire_4x4'),
      expect.stringContaining('vfx_fire_4x4'),
      expect.stringContaining('vfx_spark_4x4')
    ]);
    expect(embers).toHaveLength(1);
    expect(embers[0].map).toEqual(expect.stringContaining('vfx_spark_4x4'));
    expect(embers[0].rate).toBe(2);
    mesh.geometry.dispose();
  });

  it('derives blue fire from the canonical variant palette', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    const fireTag = (materialTagVocabulary as any).tags.fire;
    const [core] = createMaterialTagFireConfigs(mesh, { value: 1, variant: 'blue' }, fireTag);
    expect(core.colorStart).toEqual([0.72, 0.94, 1]);
    expect(core.colorEnd).not.toEqual([0.557, 0.118, 0.043]);
    mesh.geometry.dispose();
  });
});
