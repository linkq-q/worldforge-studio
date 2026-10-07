import { describe, expect, it } from 'vitest';
import { createCloudVolumeNoise } from '../src/client/outdoorCloudVolume';
import { createConnectedCloudNoise } from '../src/client/outdoorCloudShapeNoise';

// Compare topology at the same occupied volume, rather than making a denser field win.
function cloudComponents(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.8)];
  const visited = new Uint8Array(values.length);
  let count = 0, largest = 0, occupied = 0;
  for (let start = 0; start < values.length; start++) {
    if (visited[start] || values[start] < threshold) continue;
    count++;
    const stack = [start];
    visited[start] = 1;
    let size = 0;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % 64, y = Math.floor(i / 64) % 64, z = Math.floor(i / 4096);
      for (const j of [
        i - x + (x + 1) % 64, i - x + (x + 63) % 64,
        i - y * 64 + ((y + 1) % 64) * 64, i - y * 64 + ((y + 63) % 64) * 64,
        i - z * 4096 + ((z + 1) % 64) * 4096, i - z * 4096 + ((z + 63) % 64) * 4096
      ]) {
        if (!visited[j] && values[j] >= threshold) { visited[j] = 1; stack.push(j); }
      }
    }
    occupied += size;
    largest = Math.max(largest, size);
  }
  return { count, largestFraction: largest / occupied };
}

describe('connected cloud body', () => {
  it('preserves broad connected masses instead of one cloud per Worley feature point', () => {
    const original = createCloudVolumeNoise();
    const connected = createConnectedCloudNoise();
    const oldBytes = original.image.data as Uint8Array;
    const newBytes = connected.image.data as Uint8Array;
    const originalBody: number[] = [], newBody: number[] = [];
    for (let i = 0; i < oldBytes.length; i += 2) {
      originalBody.push(oldBytes[i] * 0.35 + oldBytes[i + 1] * 0.65);
      newBody.push(newBytes[i]);
    }
    const oldTopology = cloudComponents(originalBody);
    const newTopology = cloudComponents(newBody);
    expect(newTopology.count).toBeLessThan(oldTopology.count / 2);
    expect(newTopology.largestFraction).toBeGreaterThan(oldTopology.largestFraction * 2);
    const second = createConnectedCloudNoise();
    expect(second).not.toBe(connected);
    expect(second.image.data).toBe(connected.image.data);
    expect(connected.image.data).not.toBe(original.image.data);
    original.dispose(); connected.dispose(); second.dispose();
  });
});
