import { describe, expect, it, vi } from 'vitest';
import { MAP_ASSET_GENERATION_CONCURRENCY, runAssetGenerationPool } from '../src/server/assetGenerationPool';
import type { AgentProgressEvent } from '../src/shared/protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('asset generation pool', () => {
  it('keeps six workers busy and preserves request order', async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ name: `asset-${index}` }));
    const gates = items.map(() => deferred<string>());
    const started: number[] = [];
    const progress: AgentProgressEvent[] = [];
    let active = 0;
    let peak = 0;

    const resultPromise = runAssetGenerationPool(items, async (_item, index, report) => {
      started.push(index);
      active += 1;
      peak = Math.max(peak, active);
      if (index === 1) report({ status: 'retrying', detail: 'HTTP 500' });
      const result = await gates[index].promise;
      active -= 1;
      return result;
    }, { onProgress: (event) => progress.push(event) });

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5]));
    gates[5].resolve('result-5');
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]));
    gates[0].resolve('result-0');
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]));
    gates[1].resolve('result-1');
    gates[2].resolve('result-2');
    gates[3].resolve('result-3');
    gates[4].resolve('result-4');
    gates[6].resolve('result-6');
    gates[7].resolve('result-7');

    await expect(resultPromise).resolves.toEqual([
      'result-0', 'result-1', 'result-2', 'result-3',
      'result-4', 'result-5', 'result-6', 'result-7'
    ]);
    expect(MAP_ASSET_GENERATION_CONCURRENCY).toBe(6);
    expect(peak).toBe(6);
    expect(progress.some((event) => event.assets?.[1].status === 'retrying')).toBe(true);
    expect(progress.at(-1)?.assets?.every((asset) => asset.status === 'success')).toBe(true);
  });

  it('stops dispatching queued work after a fatal failure', async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({ name: `asset-${index}` }));
    const gates = items.map(() => deferred<string>());
    const started: number[] = [];
    const resultPromise = runAssetGenerationPool(items, async (_item, index) => {
      started.push(index);
      return gates[index].promise;
    });

    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5]));
    gates[0].reject(new Error('fatal'));
    gates[1].resolve('result-1');
    gates[2].resolve('result-2');
    gates[3].resolve('result-3');
    gates[4].resolve('result-4');
    gates[5].resolve('result-5');

    await expect(resultPromise).rejects.toThrow('fatal');
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
