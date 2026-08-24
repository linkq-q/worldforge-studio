import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MODEL_API_BASE,
  MODEL_PROVIDERS,
  type AgentProgressEvent,
  type ChatProvider,
  type ModelJobState
} from '../shared/protocol';
import materialTagVocabulary from '@voxel-studio/render-runtime/model/material-tags-v1.json';
import type { ModelGenerationMode } from '../shared/modelGenerationMode';
import { enforceReadableFoliageColors } from '../shared/modelColorPolicy';

export interface ModelApiOptions {
  apiBase?: string;
  providers?: readonly string[];
  mode?: ModelGenerationMode;
  materialTags?: unknown | false;
  fetchImpl?: typeof fetch;
  onStage?: (stage: Partial<ModelJobState>) => void;
  signal?: AbortSignal;
}

export interface ParsedSseResult {
  modelJson: unknown | null;
  error: string | null;
  stages: string[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | readonly ChatMessageContentPart[];
}

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatApiOptions {
  apiBase?: string;
  provider?: ChatProvider;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
  reasoningLogPath?: string | false;
}

interface ChatApiResponse {
  ok?: boolean;
  content?: string;
  reasoning?: string;
  error?: string;
  streamEvents?: string[];
}

export function parseSseModel(text: string): ParsedSseResult {
  let modelJson: unknown | null = null;
  let error: string | null = null;
  const stages: string[] = [];
  const blocks = text.split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;

    const payload = dataLines.join('\n');
    try {
      const event = JSON.parse(payload) as { stage?: string; done?: boolean; modelJson?: unknown; error?: string; errorDetail?: { hint?: string } };
      if (event.stage) stages.push(event.stage);
      if (event.stage === 'error') {
        error = event.errorDetail?.hint ?? event.error ?? '模型生成失败';
      }
      if (event.done || event.stage === 'result') {
        modelJson = event.modelJson ?? null;
      }
    } catch {
      error = '模型生成返回了无法解析的数据';
    }
  }

  return { modelJson, error, stages };
}

async function readSseModelResponse(
  response: Response,
  onStage?: ModelApiOptions['onStage']
): Promise<ParsedSseResult> {
  if (!response.body) {
    const parsed = parseSseModel(await response.text());
    for (const stage of parsed.stages) onStage?.({ status: 'stage', stage });
    return parsed;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let modelJson: unknown | null = null;
  let error: string | null = null;
  const stages: string[] = [];
  const consume = (block: string) => {
    if (!block.trim()) return;
    const parsed = parseSseModel(block);
    if (parsed.modelJson !== null) modelJson = parsed.modelJson;
    if (parsed.error) error = parsed.error;
    for (const stage of parsed.stages) {
      stages.push(stage);
      onStage?.({ status: 'stage', stage });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) consume(block);
    if (done) break;
  }
  consume(buffer);
  return { modelJson, error, stages };
}

export async function generateModel(description: string, options: ModelApiOptions = {}): Promise<unknown> {
  options.signal?.throwIfAborted();
  const fetcher = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? MODEL_API_BASE;
  const providers = options.providers ?? MODEL_PROVIDERS;
  const mode = options.mode ?? 'voxel';
  const materialTags = resolveMaterialTags(options.materialTags);
  const errors: string[] = [];

  for (const provider of providers) {
    options.signal?.throwIfAborted();
    options.onStage?.({ status: 'running', stage: `provider:${provider}` });
    try {
      const resp = await fetcher(`${apiBase}/api/generate/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          provider,
          mode,
          ...(materialTags ? { materialTags } : {})
        }),
        signal: options.signal
      });
      if (!resp.ok) {
        errors.push(`${provider}: HTTP ${resp.status}`);
        continue;
      }
      const parsed = await readSseModelResponse(resp, options.onStage);
      if (parsed.error) {
        errors.push(`${provider}: ${parsed.error}`);
        continue;
      }
      if (parsed.modelJson) return enforceReadableFoliageColors(parsed.modelJson);
      errors.push(`${provider}: 未返回模型数据`);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(errors.join(' | ') || '所有模型 provider 均失败');
}

export async function refineModel(modelJson: unknown, description: string, options: ModelApiOptions = {}): Promise<unknown> {
  options.signal?.throwIfAborted();
  const fetcher = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? MODEL_API_BASE;
  const providers = options.providers ?? MODEL_PROVIDERS;
  const materialTags = resolveMaterialTags(options.materialTags);
  const errors: string[] = [];

  for (const provider of providers) {
    options.signal?.throwIfAborted();
    options.onStage?.({ status: 'running', stage: `provider:${provider}` });
    try {
      const resp = await fetcher(`${apiBase}/api/refine/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelJson,
          description,
          provider,
          ...(materialTags ? { materialTags } : {})
        }),
        signal: options.signal
      });
      const json = await resp.json() as { ok?: boolean; modelJson?: unknown; error?: string };
      if (resp.ok && json.ok && json.modelJson) return enforceReadableFoliageColors(json.modelJson);
      errors.push(`${provider}: ${json.error ?? `HTTP ${resp.status}`}`);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(errors.join(' | ') || '所有 refine provider 均失败');
}

export async function llmChat(messages: readonly ChatMessage[], options: ChatApiOptions = {}): Promise<string> {
  const fetcher = options.fetchImpl ?? fetch;
  const url = `${options.apiBase ?? MODEL_API_BASE}/api/chat`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Connection: 'close'
    },
    body: JSON.stringify({
      messages,
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 1000,
      provider: options.provider ?? 'gpt',
      stream: true,
      reasoning: { summary: 'auto' }
    }),
    signal: options.signal
  };
  const requestId = randomUUID();
  const startedAt = new Date().toISOString();
  const reasoningLogPath = resolveReasoningLogPath(options);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    options.signal?.throwIfAborted();
    options.onProgress?.({
      phase: 'consulting',
      label: '正在连接上游模型流',
      detail: `请求 ${attempt}/3`
    });
    let response: Response;
    let data: ChatApiResponse;
    try {
      response = await fetcher(url, init);
      const streaming = String(response.headers.get('content-type')).includes('text/event-stream');
      options.onProgress?.({
        phase: 'consulting',
        label: streaming ? '上游模型流已连接' : '上游未返回流式日志',
        detail: streaming ? '等待推理摘要' : '本次使用兼容 JSON 响应'
      });
      data = await readChatApiResponse(response, options.onProgress);
      if (reasoningLogPath) {
        try {
          await appendReasoningLog(reasoningLogPath, {
            requestId,
            startedAt,
            completedAt: new Date().toISOString(),
            provider: options.provider ?? 'gpt',
            attempt,
            transport: streaming ? 'sse' : 'json',
            events: data.streamEvents ?? [],
            reasoning: data.reasoning ?? '',
            reasoningAvailable: Boolean(data.reasoning?.trim()),
            ok: response.ok && data.ok === true,
            ...(data.error ? { error: data.error } : {})
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.warn(`[modelApi] reasoning log write failed: ${detail}`);
          options.onProgress?.({ phase: 'consulting', label: '思考日志保存失败', detail });
        }
      }
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      if (attempt === 3) throw new Error('chat_service_unreachable');
      lastError = error;
      await abortableDelay(300, options.signal);
      continue;
    }

    if (response.ok && data.ok && typeof data.content === 'string' && data.content.trim()) {
      return data.content;
    }
    const error = new Error(data.error || (typeof data.content === 'string' ? 'Empty AI response' : `chat_http_${response.status}`));
    if (!isRetryableEmptyChatResponse(data) || attempt === 3) throw error;
    lastError = error;
    await abortableDelay(300, options.signal);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'chat_fetch_failed'));
}

async function readChatApiResponse(
  response: Response,
  onProgress?: ChatApiOptions['onProgress']
): Promise<ChatApiResponse> {
  if (!String(response.headers.get('content-type')).includes('text/event-stream')) {
    const data = await response.json() as ChatApiResponse;
    const reasoning = data.reasoning?.trim();
    if (reasoning) onProgress?.({
      phase: 'consulting',
      label: '模型返回思考过程',
      detail: reasoning.slice(-4_000)
    });
    return data;
  }
  if (!response.body) return { ok: false, error: 'Empty AI response' };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let error = '';
  const streamEvents = new Set<string>();
  const reportReasoning = (label = '模型正在推理并返回摘要') => onProgress?.({
    phase: 'consulting',
    label,
    detail: reasoning.slice(-4_000)
  });
  const consume = (block: string) => {
    if (!block.trim()) return;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;
    const payload = JSON.parse(data) as {
      type?: string;
      delta?: string;
      text?: string;
      summary?: string;
      content?: string;
      stage?: string;
      reasoning?: string;
      error?: string | { message?: string };
      ok?: boolean;
      done?: boolean;
      choices?: Array<{
        delta?: { content?: string; reasoning_content?: string };
        message?: { content?: string };
      }>;
    };
    const type = payload.type ?? event;
    const stage = payload.stage ?? event;
    streamEvents.add(payload.stage ?? payload.type ?? event);
    if (stage === 'thinking_start') {
      onProgress?.({ phase: 'consulting', label: '模型正在思考', detail: '等待思考结果' });
      return;
    }
    if (stage === 'thinking_done') {
      onProgress?.({ phase: 'consulting', label: '模型思考完成', detail: '正在接收正式回复' });
      return;
    }
    if (stage === 'done' || event === 'done' || payload.done === true) {
      content = payload.content ?? payload.choices?.[0]?.message?.content ?? content;
      reasoning = payload.reasoning?.trim() || reasoning;
      if (reasoning) reportReasoning('模型返回思考过程');
      return;
    }
    if (stage === 'text' || event === 'text') {
      content += payload.text ?? payload.delta ?? '';
      return;
    }
    const chatDelta = payload.choices?.[0]?.delta;
    const reasoningDelta = chatDelta?.reasoning_content
      ?? payload.reasoning
      ?? ((payload.stage?.startsWith('thinking') || payload.stage?.startsWith('reasoning')) ? payload.text : undefined);
    if (reasoningDelta || type === 'response.reasoning_summary_text.delta' || event.startsWith('thinking') || event.startsWith('reasoning')) {
      reasoning += reasoningDelta ?? payload.delta ?? payload.text ?? payload.summary ?? '';
      reportReasoning();
      return;
    }
    if (type === 'response.reasoning_summary_text.done') {
      reasoning = payload.text ?? reasoning;
      reportReasoning();
      return;
    }
    if (type === 'response.output_text.delta' || event === 'content' || event === 'output_text') {
      content += payload.delta ?? payload.text ?? payload.content ?? '';
      return;
    }
    if (chatDelta?.content) {
      content += chatDelta.content;
      return;
    }
    if (type === 'response.output_text.done') {
      content = payload.text ?? content;
      return;
    }
    if (event === 'result' || type === 'result') {
      content = payload.content ?? payload.choices?.[0]?.message?.content ?? content;
    }
    if (event === 'error' || type === 'response.error' || type === 'response.failed' || payload.stage === 'error' || payload.ok === false) {
      error = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? 'chat_stream_failed';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) consume(block);
    if (done) break;
  }
  consume(buffer);
  return content.trim()
    ? { ok: !error, content, reasoning, streamEvents: [...streamEvents], ...(error ? { error } : {}) }
    : { ok: false, reasoning, streamEvents: [...streamEvents], error: error || 'Empty AI response' };
}

function resolveReasoningLogPath(options: ChatApiOptions): string | null {
  if (options.reasoningLogPath === false) return null;
  if (typeof options.reasoningLogPath === 'string') return options.reasoningLogPath;
  if (options.fetchImpl) return null;
  if (process.env.WORLDFORGE_REASONING_LOG_PATH) return process.env.WORLDFORGE_REASONING_LOG_PATH;
  const dataDir = process.env.WORLDFORGE_DATA_DIR ?? path.join(process.cwd(), 'data', 'map-editor');
  return path.join(dataDir, 'logs', `model-reasoning-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

async function appendReasoningLog(filePath: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

function isRetryableEmptyChatResponse(data: { ok?: boolean; content?: string; error?: string }): boolean {
  return /empty ai response/i.test(data.error ?? '')
    || (data.ok === true && typeof data.content === 'string' && !data.content.trim());
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

function resolveMaterialTags(value: unknown | false | undefined): unknown | null {
  if (value === false) return null;
  if (value && typeof value === 'object') return value;
  return materialTagVocabulary;
}

