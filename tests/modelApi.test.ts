import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  generateModel,
  llmChat,
  parseSseModel,
  replayModel,
  refineModel
} from '../src/server/modelApi';

describe('model API adapter', () => {
  const materialTags = { version: 'material-tags-test', tags: {} };
  it('parses SSE model result and errors', () => {
    const parsed = parseSseModel([
      'event: blockout',
      'data: {"stage":"blockout","text":"thinking"}',
      '',
      'event: result',
      'data: {"stage":"result","done":true,"modelJson":{"format":2,"nodes":[]}}'
    ].join('\n'));

    expect(parsed.error).toBeNull();
    expect(parsed.modelJson).toEqual({ format: 2, nodes: [] });
    expect(parsed.stages).toContain('blockout');
  });

  it('falls back between providers for generation', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('nope', { status: 429 }))
      .mockResolvedValueOnce(new Response('data: {"stage":"result","done":true,"modelJson":{"name":"crate"}}\n\n', { status: 200 }));

    const model = await generateModel('crate', {
      apiBase: 'https://example.test',
      providers: ['fireworks', 'glm'],
      fetchImpl,
      materialTags
    });

    expect(model).toEqual({ name: 'crate' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports SSE generation stages as the response stream is consumed', async () => {
    const onStage = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response([
      'data: {"stage":"blockout"}',
      '',
      'data: {"stage":"thinking_start"}',
      '',
      'data: {"stage":"result","done":true,"modelJson":{"name":"crate"}}',
      ''
    ].join('\n'), { status: 200 }));

    await generateModel('crate', {
      apiBase: 'https://example.test',
      providers: ['gpt'],
      fetchImpl,
      onStage,
      materialTags
    });

    expect(onStage).toHaveBeenCalledWith({ status: 'stage', stage: 'blockout' });
    expect(onStage).toHaveBeenCalledWith({ status: 'stage', stage: 'thinking_start' });
    expect(onStage).toHaveBeenCalledWith({ status: 'stage', stage: 'result' });
  });

  it('requests a deterministic seeded model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      'data: {"stage":"result","done":true,"modelJson":{"_meta":{"seed":{"v":1,"seed":42}}}}\n\n',
      { status: 200 }
    ));

    await generateModel('pine tree', {
      apiBase: 'https://example.test',
      providers: ['gpt'],
      fetchImpl,
      materialTags,
      seeded: true,
      seed: 42
    });

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      description: 'pine tree',
      provider: 'gpt',
      seeded: true,
      seed: 42
    });
  });

  it('replays a complete seeded model with a new seed', async () => {
    const source = { format: 2, nodes: [], _meta: { seed: { v: 1, seed: 42 } } };
    const replayed = { format: 2, nodes: [{ id: 'trunk' }], _meta: { seed: { v: 1, seed: 77 } } };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      seed: 77,
      modelJson: replayed
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(replayModel(source, 77, {
      apiBase: 'https://example.test',
      fetchImpl
    })).resolves.toEqual(replayed);
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/api/generate/replay', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ modelJson: source, seed: 77 })
    }));
  });

  it('surfaces replay metadata errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: 'no_metadata'
    }), { status: 400 }));

    await expect(replayModel({ nodes: [] }, 77, {
      apiBase: 'https://example.test',
      fetchImpl
    })).rejects.toThrow('no_metadata');
  });

  it('honors an already-cancelled generation signal before making a request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();

    await expect(generateModel('crate', {
      apiBase: 'https://example.test',
      providers: ['gpt'],
      fetchImpl,
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries a transient transport failure for a planning chat', async () => {
    const onProgress = vi.fn();
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: '{"plan":{}}' }), { status: 200 }));

    await expect(llmChat([{ role: 'user', content: 'plan a grove' }], {
      apiBase: 'https://example.test',
      fetchImpl,
      onProgress
    })).resolves.toBe('{"plan":{}}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Connection: 'close' }));
    expect(fetchImpl.mock.calls[1][1]?.headers).toEqual(expect.objectContaining({ Connection: 'close' }));
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'consulting',
      label: '上游未返回流式日志',
      detail: '本次使用兼容 JSON 响应'
    });
  });

  it('reports reasoning returned by the JSON chat endpoint', async () => {
    const onProgress = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: '{"plan":{}}',
      reasoning: '先检查地图边界，再安排道路。'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    await expect(llmChat([{ role: 'user', content: 'plan a large map' }], {
      fetchImpl,
      onProgress
    })).resolves.toBe('{"plan":{}}');
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: 'consulting',
      label: '模型返回思考过程',
      detail: '先检查地图边界，再安排道路。'
    });
  });

  it('streams reasoning summaries while preserving the final structured chat content', async () => {
    const onProgress = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response([
      'data: {"type":"response.reasoning_summary_text.delta","delta":"先分析"}',
      '',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"地图边界"}',
      '',
      'data: {"type":"response.output_text.delta","delta":"{\\"plan\\":"}',
      '',
      'data: {"type":"response.output_text.delta","delta":"{}}"}',
      '',
      'data: {"type":"response.completed"}',
      ''
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
    }));

    await expect(llmChat([{ role: 'user', content: 'plan a grove' }], {
      apiBase: 'https://example.test',
      fetchImpl,
      onProgress
    })).resolves.toBe('{"plan":{}}');

    expect(onProgress).toHaveBeenLastCalledWith({
      phase: 'consulting',
      label: '模型正在推理并返回摘要',
      detail: '先分析地图边界'
    });
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'consulting',
      label: '上游模型流已连接',
      detail: '等待推理摘要'
    });
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Accept: 'text/event-stream' }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      stream: true,
      thinking: true
    });
  });

  it('accepts OpenAI-compatible chat completion reasoning chunks', async () => {
    const onProgress = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"检查资产"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}',
      '',
      'data: [DONE]',
      ''
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    }));

    await expect(llmChat([{ role: 'user', content: 'inspect assets' }], {
      fetchImpl,
      onProgress
    })).resolves.toBe('{"ok":true}');
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ detail: '检查资产' }));
  });

  it('accepts the Voxel Studio chat stream and reports its final reasoning', async () => {
    const onProgress = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response([
      'event: thinking_start',
      'data: {"stage":"thinking_start"}',
      '',
      'event: thinking_done',
      'data: {"stage":"thinking_done"}',
      '',
      'event: text',
      'data: {"stage":"text","text":"{\\"roads\\":"}',
      '',
      'event: text',
      'data: {"stage":"text","text":"[]}"}',
      '',
      'event: done',
      'data: {"stage":"done","content":"{\\"roads\\":[]}","reasoning":"先确认地形，再规划道路。"}',
      ''
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    }));

    await expect(llmChat([{ role: 'user', content: 'plan roads' }], {
      fetchImpl,
      onProgress
    })).resolves.toBe('{"roads":[]}');
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'consulting',
      label: '模型正在思考',
      detail: '等待思考结果'
    });
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'consulting',
      label: '模型返回思考过程',
      detail: '先确认地形，再规划道路。'
    });
  });

  it('allows mechanical repair chats to disable thinking and use a smaller output budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, content: 'fixed code' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    await expect(llmChat([{ role: 'user', content: 'repair this code' }], {
      apiBase: 'https://example.test',
      fetchImpl,
      maxTokens: 8_000,
      thinking: false
    })).resolves.toBe('fixed code');

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      maxTokens: 8_000,
      thinking: false
    });
  });

  it('accepts type-only text deltas from the chat stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response([
      'data: {"type":"text","text":"{\\"plan\\":"}',
      '',
      'data: {"type":"text","text":"{}}"}',
      '',
      'data: [DONE]',
      ''
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    }));

    await expect(llmChat([{ role: 'user', content: 'plan a grove' }], {
      fetchImpl
    })).resolves.toBe('{"plan":{}}');
  });

  it('persists returned reasoning without storing prompts or final content', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-reasoning-'));
    const reasoningLogPath = path.join(tempDir, 'model-reasoning.jsonl');
    const fetchImpl = vi.fn().mockResolvedValue(new Response([
      'event: thinking_start',
      'data: {"stage":"thinking_start"}',
      '',
      'event: text',
      'data: {"stage":"text","text":"{\\"plan\\":{}}"}',
      '',
      'event: done',
      'data: {"stage":"done","content":"{\\"plan\\":{}}","reasoning":"先检查边界，再安排道路。"}',
      ''
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    }));

    try {
      await llmChat([{ role: 'user', content: 'private map prompt' }], {
        fetchImpl,
        reasoningLogPath
      });
      const record = JSON.parse((await readFile(reasoningLogPath, 'utf8')).trim());
      expect(record).toMatchObject({
        provider: 'gpt',
        attempt: 1,
        transport: 'sse',
        events: ['thinking_start', 'text', 'done'],
        reasoning: '先检查边界，再安排道路。',
        reasoningAvailable: true
      });
      expect(JSON.stringify(record)).not.toContain('private map prompt');
      expect(JSON.stringify(record)).not.toContain('{"plan":{}}');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports a stable upstream chat-service error after transport retries', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(llmChat([{ role: 'user', content: 'plan a grove' }], {
      apiBase: 'https://example.test',
      fetchImpl
    })).rejects.toThrow('chat_service_unreachable');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries when the model backend returns an empty chat response', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'Empty AI response' }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: '{"plan":{}}' }), { status: 200 }));

    await expect(llmChat([{ role: 'user', content: 'plan a grove' }], {
      apiBase: 'https://example.test',
      fetchImpl
    })).resolves.toBe('{"plan":{}}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries when the model backend reports a terminated stream', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'stream terminated unexpectedly' }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: '{"plan":{}}' }), { status: 200 }));

    await expect(llmChat([{ role: 'user', content: 'plan a grove' }], {
      apiBase: 'https://example.test',
      fetchImpl
    })).resolves.toBe('{"plan":{}}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient chat error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'provider_unavailable' }), { status: 400 })
    );

    await expect(llmChat([{ role: 'user', content: 'plan a grove' }], {
      apiBase: 'https://example.test',
      fetchImpl
    })).rejects.toThrow('provider_unavailable');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('surfaces refine metadata errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'no_metadata' }), { status: 400 }));

    await expect(refineModel({ nodes: [] }, 'make it blue', {
      apiBase: 'https://example.test',
      providers: ['fireworks'],
      fetchImpl,
      materialTags
    })).rejects.toThrow('no_metadata');
  });

  it('sends the Voxel Studio material tag vocabulary with model generation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      'data: {"stage":"result","done":true,"modelJson":{"name":"tagged"}}\n\n',
      { status: 200 }
    ));

    await generateModel('tagged tree', {
      apiBase: 'https://example.test',
      providers: ['gpt'],
      fetchImpl,
      materialTags
    });

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ materialTags });
  });

  it('uses a compact generation-only view of the bundled runtime vocabulary by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      'data: {"stage":"result","done":true,"modelJson":{"name":"tagged"}}\n\n',
      { status: 200 }
    ));

    await generateModel('tagged stone', {
      apiBase: 'https://example.test',
      providers: ['gpt'],
      fetchImpl
    });

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = String(init.body);
    const vocabulary = JSON.parse(body).materialTags;
    expect(vocabulary.version).toBe('material-tags-v1');
    expect(vocabulary.tags.base.values).toContain('fabric');
    expect(vocabulary.tags.base.variantEnum).toContain('red-white-vertical');
    expect(vocabulary.tags.base.runtime).toBeUndefined();
    expect(vocabulary.tags.base.sim).toBeUndefined();
    expect(vocabulary.tags.poison).toBeUndefined();
    expect(body.length).toBeLessThan(10_000);
  });

  it('lifts dark inherited foliage colors without changing bark colors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response([
      'data: {"stage":"result","done":true,"modelJson":{"nodes":[',
      '{"id":"crown","tags":[{"tag":"foliage","value":"leaf"}]},',
      '{"id":"leaf","parent":"crown","mesh":{"type":"box","color":2574394}},',
      '{"id":"muted-leaf","parent":"crown","mesh":{"type":"box","color":7438938}},',
      '{"id":"trunk","tags":[{"tag":"base","value":"wood"}],"mesh":{"type":"box","color":5130562}}',
      ']}}',
      ''
    ].join(''), { status: 200 }));

    const model = await generateModel('tree', {
      apiBase: 'https://example.test', providers: ['gpt'], fetchImpl, materialTags
    }) as { nodes: Array<{ id: string; mesh?: { color?: number } }> };

    expect(model.nodes.find((node) => node.id === 'leaf')?.mesh?.color).toBeGreaterThan(2574394);
    expect(model.nodes.find((node) => node.id === 'muted-leaf')?.mesh?.color).not.toBe(7438938);
    expect(model.nodes.find((node) => node.id === 'trunk')?.mesh?.color).toBe(5130562);
  });

});
