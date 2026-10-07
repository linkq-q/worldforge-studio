import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createToneMapPass } from '@voxel-studio/render-runtime/postprocess';

describe('HDR grading before the final output transform', () => {
  it('preserves highlights for the subsequent bloom and ACES passes', () => {
    const pass = createToneMapPass();
    const shader = pass.material.fragmentShader;
    expect(shader).not.toMatch(/gl_FragColor\s*=\s*vec4\(clamp\(color,\s*0\.0,\s*1\.0\)/);
    expect(shader).toMatch(/gl_FragColor\s*=\s*vec4\(max\(color,\s*vec3\(0\.0\)\),\s*1\.0\)/);
    const adapter = readFileSync(new URL('../src/client/renderRuntimeAdapter.ts', import.meta.url), 'utf8');
    expect(adapter.indexOf("'toneMap', 20")).toBeLessThan(adapter.indexOf("'bloom', 30"));
    expect(adapter.indexOf("'bloom', 30")).toBeLessThan(adapter.indexOf("'output', 100"));
    pass.dispose();
  });

  it('limits brightness lift to dark input while zero lift remains neutral', () => {
    const pass = createToneMapPass();
    const shader = pass.material.fragmentShader;
    expect(shader).toContain('uBrightness * shadowWeight');
    // Read the actual GLSL transition so its dark/mid/highlight behavior is covered.
    const transition = /float shadowWeight = 1\.0 - smoothstep\(([\d.]+), ([\d.]+), luminanceBeforeGrade\)/.exec(shader);
    expect(transition).not.toBeNull();
    const low = Number(transition![1]), high = Number(transition![2]);
    const lift = (luminance: number, amount: number) => amount * (1 - THREE.MathUtils.smoothstep(luminance, low, high));
    expect(lift(0.04, 0.2)).toBeGreaterThan(0.15);
    expect(lift(0.5, 0.2)).toBe(0);
    expect(lift(4, 0.2)).toBe(0);
    for (const value of [0, 0.04, 0.5, 1, 4, 20]) expect(lift(value, 0)).toBe(0);
    expect(shader).toContain('float luminanceBeforeGrade = dot(max(color, vec3(0.0))');
    pass.dispose();
  });
});
