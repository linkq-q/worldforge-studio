import { describe, expect, it, vi } from 'vitest';
import {
  generateModel,
  parseSseModel,
  refineModel
} from '../src/server/modelApi';

describe('model API adapter', () => {
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
      fetchImpl
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

    await generateModel('crate', { apiBase: 'https://example.test', providers: ['gpt'], fetchImpl, onStage });

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

  it('surfaces refine metadata errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'no_metadata' }), { status: 400 }));

    await expect(refineModel({ nodes: [] }, 'make it blue', {
      apiBase: 'https://example.test',
      providers: ['fireworks'],
      fetchImpl
    })).rejects.toThrow('no_metadata');
  });

});
