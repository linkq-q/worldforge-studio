import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './modelApi';

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 60 * 60 * 1000;
const activeRun = new AsyncLocalStorage<string>();

interface PendingRequest {
  id: string;
  stage: string;
  messages: readonly ChatMessage[];
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface CodexRun {
  pending: Map<string, PendingRequest>;
  timer: ReturnType<typeof setTimeout>;
}

const runs = new Map<string, CodexRun>();

export function createCodexRun(): string {
  const id = randomUUID();
  const timer = setTimeout(() => closeCodexRun(id), RUN_TIMEOUT_MS);
  timer.unref();
  runs.set(id, { pending: new Map(), timer });
  return id;
}

export function withCodexRun<T>(id: string, work: () => Promise<T>): Promise<T> {
  requireRun(id);
  return activeRun.run(id, work);
}

export function currentCodexRun(): string | undefined {
  return activeRun.getStore();
}

export function pendingCodexRequests(id: string): Array<{ id: string; stage: string; messages: readonly ChatMessage[] }> {
  return [...requireRun(id).pending.values()].map(({ id: requestId, stage, messages }) => ({
    id: requestId, stage, messages
  }));
}

export function respondToCodexRequest(id: string, requestId: string, content: string): void {
  const pending = requireRun(id).pending.get(requestId);
  if (!pending) throw new Error('unknown_codex_request');
  if (!content.trim()) throw new Error('empty_codex_response');
  pending.resolve(content);
}

export function closeCodexRun(id: string): void {
  const run = requireRun(id);
  clearTimeout(run.timer);
  runs.delete(id);
  for (const pending of run.pending.values()) pending.reject(new Error('codex_run_closed'));
}

export function requestCodexCompletion(
  messages: readonly ChatMessage[],
  stage: string,
  signal?: AbortSignal
): Promise<string> {
  const id = activeRun.getStore();
  if (!id) throw new Error('codex_run_required');
  const run = requireRun(id);
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const requestId = randomUUID();
    const finish = () => {
      const pending = run.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      run.pending.delete(requestId);
    };
    const pending: PendingRequest = {
      id: requestId,
      stage,
      messages,
      resolve: (content) => { finish(); resolve(content); },
      reject: (error) => { finish(); reject(error); },
      timer: setTimeout(() => pending.reject(new Error('codex_response_timeout')), REQUEST_TIMEOUT_MS),
      signal,
      onAbort: () => pending.reject(new Error('codex_request_aborted'))
    };
    run.pending.set(requestId, pending);
    if (signal && pending.onAbort) signal.addEventListener('abort', pending.onAbort, { once: true });
  });
}

function requireRun(id: string): CodexRun {
  const run = runs.get(id);
  if (!run) throw new Error('unknown_codex_run');
  return run;
}
