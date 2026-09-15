import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface GenerationTrace {
  id: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  record(type: string, data: unknown): void;
  flush(): Promise<void>;
}

const activeTrace = new AsyncLocalStorage<GenerationTrace>();
const SECRET_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)$/i;

/** One local JSONL file per API run; no network transport or HTTP headers are logged. */
export async function withGenerationTrace<T>(
  rootDir: string,
  metadata: Record<string, unknown>,
  work: () => Promise<T>
): Promise<T> {
  const trace = createTrace(rootDir);
  return activeTrace.run(trace, async () => {
    const started = Date.now();
    trace.record('run.start', metadata);
    try {
      const result = await work();
      trace.record('run.end', { status: trace.outcome, elapsedMs: Date.now() - started });
      return result;
    } catch (error) {
      trace.record('run.end', { status: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed', elapsedMs: Date.now() - started, error });
      throw error;
    } finally {
      await trace.flush();
    }
  });
}

export function generationTraceId(): string | undefined {
  return activeTrace.getStore()?.id;
}

export function recordGenerationTrace(type: string, data: unknown): void {
  const trace = activeTrace.getStore();
  if (!trace) return;
  if (type === 'request.error' && trace.outcome !== 'cancelled') trace.outcome = 'failed';
  if (type === 'request.cancelled') trace.outcome = 'cancelled';
  trace.record(type, data);
}

function createTrace(rootDir: string): GenerationTrace {
  const id = randomUUID();
  const directory = path.join(rootDir, 'logs', `generation-${new Date().toISOString().slice(0, 10)}`);
  const file = path.join(directory, `${id}.jsonl`);
  const images = new Set<string>();
  let sequence = 0;
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disabled = false;
  let ready = false;
  let writes = Promise.resolve();
  const enqueue = (write: () => Promise<void>) => {
    writes = writes.then(async () => {
      if (disabled) return;
      if (!ready) { await mkdir(directory, { recursive: true }); ready = true; }
      await write();
    }).catch((error) => {
      disabled = true;
      buffer = '';
      console.warn('[generationTrace] local log write failed:', error instanceof Error ? error.message : String(error));
    });
  };
  const drain = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!buffer || disabled) return;
    const chunk = buffer;
    buffer = '';
    enqueue(() => appendFile(file, chunk, 'utf8'));
  };
  const redact = (value: unknown, seen = new WeakSet<object>()): unknown => {
    if (value instanceof Error) {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      const result = { name: value.name, message: redact(value.message), stack: redact(value.stack), cause: redact(value.cause, seen) };
      seen.delete(value);
      return result;
    }
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'string') {
      const image = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(value);
      if (image) {
        const bytes = Buffer.from(image[2], 'base64');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const name = `${id}-${sha256.slice(0, 16)}.${image[1].split('/')[1]}`;
        if (!images.has(name)) { images.add(name); enqueue(() => writeFile(path.join(directory, name), bytes)); }
        return { localImage: name, mimeType: image[1], bytes: bytes.length, sha256 };
      }
      return value
        .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
        .replace(/\bsk-[a-z0-9_-]{12,}/gi, '[redacted-api-key]')
        .replace(/("(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|password|secret)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2');
    }
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map((item) => redact(item, seen))
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_FIELD.test(key) ? '[redacted]' : redact(item, seen)]));
    seen.delete(value);
    return result;
  };
  return {
    id,
    outcome: 'completed',
    record(type, data) {
      if (disabled) return;
      try {
        buffer += `${JSON.stringify({ traceId: id, sequence: ++sequence, at: new Date().toISOString(), type, data: redact(data) })}\n`;
        if (buffer.length >= 64 * 1024) drain();
        else if (!timer) { timer = setTimeout(drain, 250); timer.unref(); }
      } catch (error) {
        console.warn('[generationTrace] cannot serialize local record:', error instanceof Error ? error.message : String(error));
      }
    },
    async flush() { drain(); await writes; }
  };
}
