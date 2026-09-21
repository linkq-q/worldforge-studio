import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createEffectRuntime } from '@voxel-studio/render-runtime/effects';

describe('Triplanar projection shader', () => {
  it('projects batched and instanced parts in world space', () => {
    const material = new THREE.MeshStandardMaterial();
    createEffectRuntime().runtime.applyToMaterial(material, {
      schemaVersion: '1.0',
      materialLayers: ['Triplanar'],
      layerParams: { Triplanar: { pattern: 1, scale: 2 } }
    });
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader
    };

    material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);

    expect(shader.vertexShader).toContain('effLayerWorldPosition = batchingMatrix * effLayerWorldPosition;');
    expect(shader.vertexShader).toContain('effLayerWorldPosition = instanceMatrix * effLayerWorldPosition;');
    expect(shader.vertexShader).toContain('vEffLayerWorldPos = (modelMatrix * effLayerWorldPosition).xyz;');
    expect(shader.vertexShader).toContain('effLayerWorldNormal = batchingNormalMatrix * effLayerWorldNormal;');
    expect(shader.vertexShader).toContain('effLayerWorldNormal = instanceNormalMatrix * effLayerWorldNormal;');

    material.dispose();
  });

  it('emits vertical, horizontal and checker fabric branches', () => {
    const material = new THREE.MeshStandardMaterial();
    createEffectRuntime().runtime.applyToMaterial(material, {
      schemaVersion: '1.0',
      materialLayers: ['Triplanar'],
      layerParams: { Triplanar: { pattern: 7, plankScale: 0.34 } }
    });
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader
    };

    material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);

    expect(shader.fragmentShader).toContain('FABRIC VERTICAL STRIPES');
    expect(shader.fragmentShader).toContain('FABRIC HORIZONTAL STRIPES');
    expect(shader.fragmentShader).toContain('FABRIC CHECKER');
    expect(shader.fragmentShader).toContain('triPatternIsAbsolute');
    material.dispose();
  });

  it('keeps wood knots compact without changing their world-space frequency', () => {
    const material = new THREE.MeshStandardMaterial();
    createEffectRuntime().runtime.applyToMaterial(material, {
      schemaVersion: '1.0',
      materialLayers: ['Triplanar'],
      layerParams: { Triplanar: { pattern: 0, scale: 2, knotStrength: 0.2 } }
    });
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader
    };

    material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);

    expect(shader.fragmentShader).toContain('vec2 knotUv = triUv * uTriplanarScale * 0.4;');
    expect(shader.fragmentShader).toContain('knotMask = smoothstep(0.3, 0.0, f1k) * hasKnot;');
    material.dispose();
  });

  it('band-limits marble veins while the camera is moving', () => {
    const material = new THREE.MeshStandardMaterial();
    createEffectRuntime().runtime.applyToMaterial(material, {
      schemaVersion: '1.0',
      materialLayers: ['Triplanar'],
      layerParams: { Triplanar: { pattern: 3, scale: 2 } }
    });
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader
    };

    material.onBeforeCompile(shader as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);

    expect(shader.fragmentShader).toContain('float marbleAa1 = max(fwidth(triMarbleData.x), 1e-4);');
    expect(shader.fragmentShader).toContain('float marbleAa2 = max(fwidth(triMarbleData.y), 1e-4);');
    expect(shader.fragmentShader).toContain('min(1.0, marbleLineW / marbleAa1)');
    expect(shader.vertexShader).not.toContain('fwidth(');
    material.dispose();
  });
});
