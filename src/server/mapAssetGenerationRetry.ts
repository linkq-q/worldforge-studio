import type { AgentProgressEvent } from '../shared/protocol';

export interface AssetGenerationRetryOptions {
  attempts?: number;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export async function generateMapAssetWithRetry<T>(
  name: string,
  generate: () => Promise<T>,
  options: AssetGenerationRetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const wait = options.wait ?? abortableDelay;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    options.onProgress?.({
      phase: 'generating-asset',
      label: `生成资产：${name}（尝试 ${attempt}/${attempts}）`,
      detail: `attempt:${attempt}/${attempts}`
    });
    try {
      return await generate();
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      lastError = error;
      if (attempt >= attempts) break;
      options.onProgress?.({
        phase: 'asset-retrying',
        label: `${name} 第 ${attempt} 次失败，准备重试 ${attempt + 1}/${attempts}`,
        detail: error instanceof Error ? error.message : String(error)
      });
      await wait(800, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'asset_generation_failed'));
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
