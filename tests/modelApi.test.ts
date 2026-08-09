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
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: '{"plan":{}}' }), { status: 200 }));

    await expect(llmChat([{ role: 'user', content: 'plan a grove' }], {
      apiBase: 'https://example.test',
      fetchImpl
    })).resolves.toBe('{"plan":{}}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ Connection: 'close' }));
    expect(fetchImpl.mock.calls[1][1]?.headers).toEqual(expect.objectContaining({ Connection: 'close' }));
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

});
