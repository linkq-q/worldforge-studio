import { describe, expect, it, vi } from 'vitest';
import { generateMapAssetWithRetry } from '../src/server/mapAssetGenerationRetry';

describe('map asset generation retry', () => {
  it('gives each asset three total attempts and reports failed retries', async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('model invalid'))
      .mockResolvedValue({ ok: true });
    const progress: string[] = [];

    const result = await generateMapAssetWithRetry('松树', generate, {
      onProgress: (event) => progress.push(`${event.phase}:${event.label}`),
      wait: async () => undefined
    });

    expect(result).toEqual({ ok: true });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(progress.filter((item) => item.startsWith('asset-retrying:'))).toHaveLength(2);
    expect(progress.at(-1)).toContain('尝试 3/3');
  });

  it('does not retry cancellation', async () => {
    const cancelled = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const generate = vi.fn().mockRejectedValue(cancelled);

    await expect(generateMapAssetWithRetry('松树', generate, {
      wait: async () => undefined
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(generate).toHaveBeenCalledOnce();
  });
});
