import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addMaterialShaderPatch } from '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js';
import { OutdoorShadowRuntime } from '../src/client/outdoorShadowRuntime';

function compile(material: THREE.Material) {
  const shader = {
    uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader
  } as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('optional directional contact-hardening shadows', () => {
  it('covers narrow center blockers and retains minimum filtering when the outer search misses them', () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    const runtime = new OutdoorShadowRuntime();
    runtime.apply(root, sun, 0.5, 2);
    const shader = compile(material).fragmentShader;
    expect(shader).toContain('outdoorShadowBlockerSeparation(map, p.xy, p, size, gradient)');
    expect(shader).toContain('outdoorShadowBlockerSeparation(map, p.xy + offset, p, size, gradient)');
    expect(shader).toContain('vec2 tapUv = (floor(uv * size) + 0.5) / size;');
    expect(shader).toContain('outdoorShadowReceiverDepth(receiver.z, gradient, tapUv - receiver.xy)');
    expect(shader).not.toContain('if (blockers == 0.0) return');
    expect(shader).toContain('float separation = blockers > 0.0 ? separationSum / blockers * uOutdoorPcssMetrics.z : 0.0;');
    expect(shader).toContain('max(1.75 / size,');
    expect(shader).toContain('for (int i = 0; i < 16; i++)');

    // A 10 cm radius sill falls entirely between the surrounding 1.2 m search
    // samples (the nearest is 30 cm away). The center must still identify it.
    const blocker = (x: number, y: number) => Math.hypot(x, y) < 0.1;
    for (const angle of [0, 0.7, 2.4]) {
      const outerHits = Array.from({ length: 8 }, (_, i) => {
        const radius = 1.2 * Math.sqrt((i + 0.5) / 8);
        const a = i * 2.39996323 + angle;
        return blocker(Math.cos(a) * radius, Math.sin(a) * radius);
      }).filter(Boolean).length;
      expect(outerHits).toBe(0);
      expect(blocker(0, 0)).toBe(true);
    }

    // A nearest lookup reads the texel center, not the requested UV. On this
    // unobstructed tilted plane, the old position comparison invents a blocker.
    const expression = shader.match(/float outdoorShadowReceiverDepth\([^)]*\)\s*\{\s*return ([^;]+);/)![1];
    const depthAtTap = new Function('depth', 'gradient', 'offset', `return ${expression}`);
    const size = 8192, receiverUv = { x: 0.502, y: 0.501 };
    const requested = { x: (4115 + 0.9) / size, y: (4102 + 0.1) / size };
    const tap = { x: (Math.floor(requested.x * size) + 0.5) / size,
      y: (Math.floor(requested.y * size) + 0.5) / size };
    const gradient = { x: 1.2, y: -0.8 };
    const planeDepth = 0.5 + gradient.x * (tap.x - receiverUv.x) + gradient.y * (tap.y - receiverUv.y);
    const biasedDepth = 0.5 - 0.002 / 138.215;
    const oldDepth = biasedDepth + gradient.x * (requested.x - receiverUv.x) + gradient.y * (requested.y - receiverUv.y);
    expect(oldDepth).toBeGreaterThan(planeDepth);
    const correctedDepth = depthAtTap(biasedDepth, gradient, { x: tap.x - receiverUv.x, y: tap.y - receiverUv.y });
    expect(correctedDepth).toBeLessThan(planeDepth);
    // A real blocker 20 cm in front still remains in shadow.
    expect(correctedDepth).toBeGreaterThan(planeDepth - 0.2 / 138.215);
    runtime.apply(root, sun, 0.5, 1);
    const legacy = compile(material).fragmentShader;
    expect(legacy).toContain('if (blockers == 0.0) return outdoorShadowCompare(map, p.xy, p.z, size);');
    expect(legacy).toContain('max(0.55 / size,');
    runtime.dispose();
  });

  it('keeps receiver-plane gradients at close-up UV footprints that the legacy determinant rejects', () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    const runtime = new OutdoorShadowRuntime();
    runtime.apply(root, sun, 0.5, 2);
    const shader = compile(material).fragmentShader;
    expect(shader).toContain('vec2 dxTexel = dx.xy * size, dyTexel = dy.xy * size;');
    expect(shader).toContain('abs(determinant) > 0.00000001');
    const expressions = ['gradientX', 'gradientY'].map(name => shader.match(new RegExp(`float ${name} = ([^;]+);`))?.[1]);
    expect(expressions.every(Boolean)).toBe(true);
    // Execute the shader's final component expressions, using an analytical
    // sloped plane viewed at several zoom levels rather than a zero gradient.
    const evaluate = expressions.map(expression => new Function('dx', 'dy', 'dxTexel', 'dyTexel', 'size', 'determinant',
      `return ${expression}`));
    const size = { x: 4096, y: 2048 };
    for (const zoom of [1, 8, 64]) {
      const dx = { x: 0.00002 / zoom, y: 0.000004 / zoom, z: 0 };
      const dy = { x: -0.000003 / zoom, y: 0.000025 / zoom, z: 0 };
      dx.z = 1.2 * dx.x - 0.8 * dx.y;
      dy.z = 1.2 * dy.x - 0.8 * dy.y;
      expect(Math.abs(dx.x * dy.y - dx.y * dy.x)).toBeLessThan(1e-9);
      const dxTexel = { x: dx.x * size.x, y: dx.y * size.y };
      const dyTexel = { x: dy.x * size.x, y: dy.y * size.y };
      const determinant = dxTexel.x * dyTexel.y - dxTexel.y * dyTexel.x;
      expect(Math.abs(determinant)).toBeGreaterThan(1e-8);
      expect(evaluate[0](dx, dy, dxTexel, dyTexel, size, determinant)).toBeCloseTo(1.2, 12);
      expect(evaluate[1](dx, dy, dxTexel, dyTexel, size, determinant)).toBeCloseTo(-0.8, 12);
    }
    runtime.apply(root, sun, 0.5, 1);
    const legacy = compile(material).fragmentShader;
    expect(legacy).not.toContain('dxTexel');
    expect(legacy).toContain('abs(determinant) > 0.000000001');
    runtime.dispose();
  });

  it('uses each bilinear texel receiver depth only in the opt-in shadow version', () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    sun.position.set(-20, 40, 30);
    const runtime = new OutdoorShadowRuntime();
    runtime.apply(root, sun, 0.5);
    const original = compile(material).fragmentShader;
    const originalKey = material.customProgramCacheKey();
    runtime.apply(root, sun, 0.5, 2);
    const corrected = compile(material).fragmentShader;
    expect(corrected).toContain('outdoorShadowReceiverDepth(depth, gradient, base - uv)');
    expect(corrected).toContain('outdoorShadowReceiverDepth(depth, gradient, base + stepUv - uv)');
    expect(corrected).toContain('outdoorShadowCompare(map, p.xy + offset, p.z + dot(gradient, offset), size, gradient)');
    expect(material.customProgramCacheKey()).not.toBe(originalKey);
    expect(material.customProgramCacheKey()).toContain(':receiver-plane#');
    // Evaluate the shader's scalar receiver-depth expression on an unobstructed
    // sloped wall. The stored depths come from the analytical plane at texel centers.
    const expression = corrected.match(/float outdoorShadowReceiverDepth\([^)]*\)\s*\{\s*return ([^;]+);/)?.[1];
    expect(expression).toBeDefined();
    const depthAtTap = new Function('depth', 'gradient', 'offset', `return ${expression}`) as
      (depth: number, gradient: { x: number; y: number }, offset: { x: number; y: number }) => number;
    const gradient = { x: 1.2, y: -0.8 };
    let falseLegacyComparisons = 0;
    for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.5, 0.9]) {
      for (const x of [0, 1]) for (const y of [0, 1]) {
        const offset = { x: (x - fx) / 4096, y: (y - fy) / 4096 };
        const planeDepth = 0.5 + gradient.x * offset.x + gradient.y * offset.y;
        const receiverDepth = 0.5 - 0.002 / 138.215;
        if (receiverDepth > planeDepth) falseLegacyComparisons++;
        expect(depthAtTap(receiverDepth, gradient, offset)).toBeLessThan(planeDepth);
      }
    }
    expect(falseLegacyComparisons).toBeGreaterThan(10);
    runtime.apply(root, sun, 0.5, 1);
    expect(compile(material).fragmentShader).toBe(original);
    expect(material.customProgramCacheKey().replace(/#g\d+/g, '')).toBe(originalKey.replace(/#g\d+/g, ''));
    runtime.dispose();
  });

  it('patches the sun call only, preserves other shader patches and restores the baseline', () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group().add(new THREE.InstancedMesh(new THREE.BoxGeometry(), material, 2));
    addMaterialShaderPatch(material, 'test:existing', shader => { shader.fragmentShader += '\n// existing-effect'; });
    const before = compile(material);
    const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    sun.position.set(-20, 40, 30);
    sun.shadow.camera.left = -60;
    sun.shadow.camera.right = 60;
    sun.shadow.camera.bottom = -40;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 200;
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.updateMatrices(sun);
    const runtime = new OutdoorShadowRuntime();
    runtime.apply(root, sun, 0.5);
    const shader = compile(material);
    expect(shader.fragmentShader).toContain('getOutdoorSunShadow( directionalShadowMap[ i ]');
    expect(shader.fragmentShader).toContain('getShadow( spotShadowMap[ i ]');
    expect(shader.fragmentShader).toContain('getPointShadow( pointShadowMap[ i ]');
    expect(shader.fragmentShader).toContain('// existing-effect');
    expect(shader.fragmentShader).not.toContain('gl_FragCoord');
    expect(shader.uniforms.uOutdoorPcssMetrics.value.toArray()).toEqual([1 / 120, 1 / 80, 199.5]);
    expect(THREE.ShaderChunk.shadowmap_pars_fragment).toBe(chunk);
    sun.position.set(40, 20, 0);
    sun.shadow.camera.far = 240;
    runtime.update();
    expect(shader.uniforms.uOutdoorPcssMetrics.value.z).toBe(239.5);
    expect(shader.uniforms.uOutdoorPcssSunDirection.value.x).toBeCloseTo(2 / Math.sqrt(5));
    runtime.clear();
    expect(compile(material).fragmentShader).toBe(before.fragmentShader);
  });

  it('does not modify environment geometry or a material owned outside the content root', () => {
    const shared = new THREE.MeshStandardMaterial();
    const environment = new THREE.MeshStandardMaterial();
    const sky = new THREE.Mesh(new THREE.BoxGeometry(), environment);
    sky.userData.isEnvironmentObject = true;
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), shared), sky);
    new THREE.Scene().add(root, new THREE.Mesh(new THREE.BoxGeometry(), shared));
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    const runtime = new OutdoorShadowRuntime();
    runtime.apply(root, sun, 0.5);
    expect(compile(shared).uniforms.uOutdoorPcssMetrics).toBeUndefined();
    expect(compile(environment).uniforms.uOutdoorPcssMetrics).toBeUndefined();
    runtime.dispose();
  });
});
