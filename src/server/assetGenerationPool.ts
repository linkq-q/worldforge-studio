import type { AgentAssetProgress, AgentProgressEvent } from '../shared/protocol';

export const MAP_ASSET_GENERATION_CONCURRENCY = 6;

export type AssetTaskReporter = (
  update: Pick<AgentAssetProgress, 'status' | 'detail'>
) => void;

export interface AssetGenerationPoolOptions {
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
}

export async function runAssetGenerationPool<T extends { name: string }, R>(
  items: readonly T[],
  generate: (item: T, index: number, report: AssetTaskReporter) => Promise<R>,
  options: AssetGenerationPoolOptions = {}
): Promise<R[]> {
  options.signal?.throwIfAborted();
  if (items.length === 0) return [];

  const assets: AgentAssetProgress[] = items.map((item, index) => ({
    key: `asset-${index}`,
    name: item.name,
    status: 'queued'
  }));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let completed = 0;
  let firstError: unknown;

  const emit = () => {
    const active = assets.filter((asset) => asset.status === 'running' || asset.status === 'retrying').length;
    options.onProgress?.({
      phase: 'generating-asset',
      label: `并行生成资产：已完成 ${completed}/${items.length}，进行中 ${active} 个`,
      current: completed,
      total: items.length,
      assets: assets.map((asset) => ({ ...asset }))
    });
  };

  const worker = async (slot: number) => {
    while (firstError === undefined && !options.signal?.aborted) {
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      const state = assets[index];
      state.status = 'running';
      state.slot = slot;
      state.detail = '等待模型返回';
      emit();

      let reportedFailure = false;
      const report: AssetTaskReporter = (update) => {
        state.status = update.status;
        state.detail = update.detail;
        if (update.status === 'failed') reportedFailure = true;
        emit();
      };

      try {
        results[index] = await generate(items[index], index, report);
        if (!reportedFailure) {
          state.status = 'success';
          state.detail = '资产已生成并保存';
        }
      } catch (error) {
        state.status = 'failed';
        state.detail = error instanceof Error ? error.message : String(error);
        firstError ??= error;
      }
      completed += 1;
      emit();
    }
    if (options.signal?.aborted) {
      firstError ??= options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(MAP_ASSET_GENERATION_CONCURRENCY, items.length) },
    (_, index) => worker(index + 1)
  ));
  if (firstError !== undefined) throw firstError;
  return results;
}
