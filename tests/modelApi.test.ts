import { describe, expect, it, vi } from 'vitest';
import {
  generateModel,
  llmChat,
  parseSseModel,
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
      reasoning: { summary: 'auto' }
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

  it('accepts the Voxel Studio stage and done event shape', async () => {
    const onProgress = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response([
      'event: thinking',
      'data: {"stage":"thinking","text":"规划道路"}',
      '',
      'event: result',
      'data: {"done":true,"content":"{\\"roads\\":[]}"}',
      ''
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    }));

    await expect(llmChat([{ role: 'user', content: 'plan roads' }], {
      fetchImpl,
      onProgress
    })).resolves.toBe('{"roads":[]}');
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ detail: '规划道路' }));
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

  it('uses the bundled runtime vocabulary by default', async () => {
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
    expect(JSON.parse(String(init.body)).materialTags.version).toBe('material-tags-v1');
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
