import {
  MODEL_API_BASE,
  MODEL_PROVIDERS,
  type ChatProvider,
  type ModelJobState
} from '../shared/protocol';
import materialTagVocabulary from '../../../3d-generate/packages/voxel-render-runtime/model/material-tags-v1.json';
import type { ModelGenerationMode } from '../shared/modelGenerationMode';

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
  content: string;
}

export interface ChatApiOptions {
  apiBase?: string;
  provider?: ChatProvider;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
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
      if (parsed.modelJson) return parsed.modelJson;
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
      if (resp.ok && json.ok && json.modelJson) return json.modelJson;
      errors.push(`${provider}: ${json.error ?? `HTTP ${resp.status}`}`);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(errors.join(' | ') || '所有 refine provider 均失败');
}

export async function llmChat(messages: readonly ChatMessage[], options: ChatApiOptions = {}): Promise<string> {
  const response = await (options.fetchImpl ?? fetch)(`${options.apiBase ?? MODEL_API_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      temperature: options.temperature ?? 0.2,
      maxTokens: options.maxTokens ?? 1000,
      provider: options.provider ?? 'gpt'
    }),
    signal: options.signal
  });
  const data = await response.json() as { ok?: boolean; content?: string; error?: string };
  if (!response.ok || !data.ok || typeof data.content !== 'string') {
    throw new Error(data.error || `chat_http_${response.status}`);
  }
  return data.content;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function resolveMaterialTags(value: unknown | false | undefined): unknown | null {
  if (value === false) return null;
  if (value && typeof value === 'object') return value;
  return materialTagVocabulary;
}

