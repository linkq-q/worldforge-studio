import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  RenderRuntimeAdapter,
  shouldBindRenderPlanWaterSurface,
  structuredWaterShoreTransition
} from '../src/client/renderRuntimeAdapter';

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

  it('applies the lake surface detail material to terrain-bound ocean water', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const modelsRoot = new THREE.Group();
    const originalMaterial = new THREE.MeshStandardMaterial();
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(), originalMaterial);
    const shoreTexture = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
    const terrainTexture = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
    ocean.userData.materialTags = ['water', 'ocean'];
    ocean.userData.waterBodyType = 'ocean';
    ocean.userData.waterShore = { texture: shoreTexture, center: [0, 0], size: 4096 };
    ocean.userData.waterOceanTerrain = {
      texture: terrainTexture,
      terrainSize: [1, 1], mapSize: [500, 500], center: [0, 0],
      level: 0, apronWidth: 18, sinkTarget: -3, splashPoints: []
    };
    modelsRoot.add(ocean);
    const adapter = Object.create(RenderRuntimeAdapter.prototype) as RenderRuntimeAdapter;
    Object.assign(adapter as unknown as Record<string, unknown>, {
      renderer: {}, scene, camera, modelsRoot, waterBindings: [], waterDetailTexture: null,
      waterSceneCapture: null, waterEnvironmentMap: null
    });

    (adapter as unknown as { applyWaterStyles(styles: []): void }).applyWaterStyles([]);

    const material = ocean.material as unknown as THREE.ShaderMaterial;
    expect(material.uniforms.uUseWaterNormalMaps.value).toBe(true);
    expect(material.uniforms.uHighlightIntensity.value).toBeCloseTo(0.06);

    material.dispose();
    originalMaterial.dispose();
    ocean.geometry.dispose();
    shoreTexture.dispose();
    terrainTexture.dispose();
  });
});
