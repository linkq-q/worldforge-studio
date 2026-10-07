import { describe, expect, it } from 'vitest';
import { createCloudVolumeNoise, periodicCloudNoise } from '../src/client/outdoorCloudVolume';

describe('world-space cloud noise', () => {
  it('is continuous, periodic in all directions and changes through cloud height', () => {
    const value = periodicCloudNoise(2.37, -4.62, 9.28);
    expect(periodicCloudNoise(10.37, -4.62, 9.28)).toBeCloseTo(value, 12);
    expect(periodicCloudNoise(2.37, 3.38, 9.28)).toBeCloseTo(value, 12);
    expect(periodicCloudNoise(2.37, -4.62, 17.28)).toBeCloseTo(value, 12);
    expect(Math.abs(periodicCloudNoise(2.371, -4.62, 9.28) - value)).toBeLessThan(0.002);
    expect(periodicCloudNoise(2.37, -3.62, 9.28)).not.toBeCloseTo(value, 2);
  });

  it('reuses deterministic density bytes but gives each sky its own disposable GPU texture', () => {
    const first = createCloudVolumeNoise();
    const second = createCloudVolumeNoise();
    expect(first).not.toBe(second);
    expect(first.image.data).toBe(second.image.data);
    expect(first.image.data).toHaveLength(64 * 64 * 64 * 2);
    const bytes = first.image.data as Uint8Array;
    let min = 255, max = 0;
    for (let i = 0; i < bytes.length; i += 2) { min = Math.min(min, bytes[i]); max = Math.max(max, bytes[i]); }
    expect(min).toBeLessThan(45);
    expect(max).toBeGreaterThan(210);
    first.dispose();
    second.dispose();
  });
});
