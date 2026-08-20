import { describe, expect, it } from 'vitest';
import { retainLargestWaterRegion } from '@voxel-studio/render-runtime/environment';

function rgba(width: number, height: number, value = 255): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    pixels[index * 4] = value;
    pixels[index * 4 + 1] = value;
    pixels[index * 4 + 2] = value;
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

describe('model-water container mask', () => {
  it('keeps the main basin region and removes smaller areas outside its rim', () => {
    const width = 7;
    const height = 3;
    const water = rgba(width, height);
    const barrier = rgba(width, height, 0);
    for (let y = 0; y < height; y++) {
      const offset = (y * width + 5) * 4;
      barrier[offset] = barrier[offset + 1] = barrier[offset + 2] = 255;
    }

    expect(retainLargestWaterRegion(water, barrier, width, height)).toBe(true);
    expect(water[(1 * width + 2) * 4]).toBe(255);
    expect(water[(1 * width + 6) * 4]).toBe(0);
  });

  it('closes small seams between authored rim blocks before selecting the basin', () => {
    const width = 9;
    const height = 5;
    const water = rgba(width, height);
    const barrier = rgba(width, height, 0);
    for (let y = 0; y < height; y++) {
      if (y === 2) continue;
      const offset = (y * width + 6) * 4;
      barrier[offset] = barrier[offset + 1] = barrier[offset + 2] = 255;
    }

    expect(retainLargestWaterRegion(water, barrier, width, height, 1)).toBe(true);
    expect(water[(2 * width + 3) * 4]).toBe(255);
    expect(water[(2 * width + 8) * 4]).toBe(0);
  });

  it('removes all four square corners outside a segmented basin rim', () => {
    const width = 33;
    const height = 33;
    const center = 16;
    const water = rgba(width, height);
    const barrier = rgba(width, height, 0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (Math.abs(x - center) + Math.abs(y - center) !== 16) continue;
        const offset = (y * width + x) * 4;
        barrier[offset] = barrier[offset + 1] = barrier[offset + 2] = 255;
      }
    }

    expect(retainLargestWaterRegion(water, barrier, width, height, 1)).toBe(true);
    expect(water[(center * width + center) * 4]).toBe(255);
    expect(water[0]).toBe(0);
    expect(water[(width - 1) * 4]).toBe(0);
    expect(water[((height - 1) * width) * 4]).toBe(0);
    expect(water[(width * height - 1) * 4]).toBe(0);
  });
});
