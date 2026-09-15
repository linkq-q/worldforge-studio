import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { generationTraceId, recordGenerationTrace, withGenerationTrace } from '../src/server/generationTrace';
import { generateModel, llmChat } from '../src/server/modelApi';
import { generateMapCodeSuggestion } from '../src/server/mapCodePlanner';
import { generateMapAssetWithRetry } from '../src/server/mapAssetGenerationRetry';
import { createEmptyMap } from '../src/shared/map';
import { buildModelColliderPlan, MAP_ASSET_COLLIDER_PROFILE } from '../src/shared/modelBounds';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDirectory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-full-trace-'));
  directories.push(dir);
  return dir;
}
async function readTrace(root: string, id: string) {
  const day = (await readdir(path.join(root, 'logs'))).find((name) => name.startsWith('generation-'))!;
  const directory = path.join(root, 'logs', day);
  const text = await readFile(path.join(directory, `${id}.jsonl`), 'utf8');
  return { directory, text, records: text.trim().split('\n').map((line) => JSON.parse(line)) };
}

it('isolates concurrent runs, redacts credentials and stores review images locally', async () => {
  const root = await tempDirectory();
  const image = Buffer.from('test image bytes');
  const ids = await Promise.all(['first', 'second'].map((mapId) => withGenerationTrace(root, { mapId }, async () => {
    recordGenerationTrace('request.input', {
      apiKey: 'DO_NOT_SAVE_KEY', authorization: 'Bearer DO_NOT_SAVE_AUTH',
      prompt: 'keep the user prompt', image: `data:image/png;base64,${image.toString('base64')}`
    });
    await Promise.resolve();
    recordGenerationTrace('checkpoint', { mapId });
    return generationTraceId()!;
  })));
  expect(ids[0]).not.toBe(ids[1]);
  for (const [index, id] of ids.entries()) {
    const { records, text, directory } = await readTrace(root, id);
    expect(records.every((record) => record.traceId === id)).toBe(true);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
    expect(records[2].data.mapId).toBe(index === 0 ? 'first' : 'second');
    expect(text).not.toContain('DO_NOT_SAVE');
    expect(text).toContain('keep the user prompt');
    expect(await readFile(path.join(directory, records[1].data.image.localImage))).toEqual(image);
    expect(records.at(-1).data.status).toBe('completed');
  }
});

it('records request bodies, raw SSE, reasoning on thinking_done and actual output', async () => {
  const root = await tempDirectory();
  const stream = [
    'event: thinking_done\ndata: {"stage":"thinking_done","reasoning":"保留入口位置"}',
    'event: text\ndata: {"stage":"text","text":"function plan(api) {}"}',
    'event: done\ndata: {"stage":"done","usage":{"output_tokens":12}}', ''
  ].join('\n\n');
  const id = await withGenerationTrace(root, { mapId: 'map-test' }, async () => {
    await expect(llmChat([{ role: 'user', content: 'keep this full request' }], {
      traceStage: 'test.plan', fetchImpl: vi.fn().mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
    })).resolves.toBe('function plan(api) {}');
    return generationTraceId()!;
  });
  const { records, text } = await readTrace(root, id);
  expect(records.find((r) => r.type === 'chat.request').data.body.messages[0].content).toBe('keep this full request');
  expect(records.find((r) => r.type === 'chat.response').data.response).toMatchObject({ content: 'function plan(api) {}', reasoning: '保留入口位置' });
  expect(records.some((r) => r.type === 'chat.sse' && r.data.value.raw.includes('output_tokens'))).toBe(true);
  expect(records.some((r) => r.type === 'chat.chunk' && r.data.value.bytes > 0)).toBe(true);
  expect(text).toContain('test.plan');
});

it('retains partial stream output and a cancellation outcome', async () => {
  const root = await tempDirectory();
  let id = '';
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('event: text\ndata: {"text":"partial code"}\n\n'));
      else controller.error(new DOMException('cancelled during stream', 'AbortError'));
    }
  });
  await expect(withGenerationTrace(root, { mapId: 'cancel-test' }, async () => {
    id = generationTraceId()!;
    return llmChat([{ role: 'user', content: 'test' }], {
      fetchImpl: vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }))
    });
  })).rejects.toThrow('cancelled during stream');
  const { records } = await readTrace(root, id);
  expect(records.find((r) => r.type === 'chat.stream.error').data.value.partialContent).toBe('partial code');
  expect(records.find((r) => r.type === 'chat.attempt.error').data.attempt).toBe(1);
  expect(records.at(-1).data.status).toBe('cancelled');
});

it('does not break generation when the log directory cannot be written', async () => {
  const root = await tempDirectory();
  const file = path.join(root, 'not-a-directory');
  await writeFile(file, 'occupied');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(withGenerationTrace(file, {}, async () => {
    recordGenerationTrace('progress', { step: 'still usable' });
    return 'usable result';
  })).resolves.toBe('usable result');
  expect(warning).toHaveBeenCalled();
});

it('keeps failed and repaired code versions plus asset retries and final operations', async () => {
  const root = await tempDirectory();
  const bad = "function plan(api) { api.place({name:'marker',position:[NaN,0]}); }";
  const good = "function plan(api) { const tree=api.requireAsset({key:'tree',name:'树',prompt:'tree',variants:1,role:'environment'}); api.place({assetId:api.asset(tree),position:[5,0],role:'environment'}); }";
  const reply = (content: string) => new Response(JSON.stringify({ ok: true, content }), { headers: { 'Content-Type': 'application/json' } });
  const fetchChat = vi.fn().mockResolvedValueOnce(reply(bad)).mockResolvedValueOnce(reply(good));
  const fetchModel = vi.fn()
    .mockRejectedValueOnce(new Error('temporary model failure'))
    .mockResolvedValueOnce(new Response('data: {"stage":"result","modelJson":{"format":2,"nodes":[]}}\n\n'));
  const id = await withGenerationTrace(root, { mapId: 'code-repair-test' }, async () => {
    await generateMapCodeSuggestion('test tree', createEmptyMap(), [], {
      fetchImpl: fetchChat, minNewAssets: 0, maxNewAssets: 1,
      createAsset: async (request) => {
        const modelJson = await generateMapAssetWithRetry(request.name, () => generateModel(request.prompt, {
          fetchImpl: fetchModel, providers: ['gpt']
        }), { wait: async () => {} });
        return {
          id: 'asset-test', name: request.name, prompt: request.prompt, modelJson,
          colliderPlan: buildModelColliderPlan(modelJson, MAP_ASSET_COLLIDER_PROFILE), mode: 'voxel', createdAt: 1, updatedAt: 1
        };
      }
    });
    return generationTraceId()!;
  });
  const { records } = await readTrace(root, id);
  expect(records.find((r) => r.type === 'code.execution.error').data.code).toBe(bad);
  expect(records.find((r) => r.type === 'code.repair.required').data.error).toContain('non_finite_map_code_value');
  expect(records.filter((r) => r.type === 'chat.request').map((r) => r.data.stage)).toEqual(['map.initial-plan', 'map.execution-repair']);
  expect(records.filter((r) => r.type === 'asset.attempt.start').map((r) => r.data.attempt)).toEqual([1, 2]);
  expect(records.some((r) => r.type === 'model.error')).toBe(true);
  const executed = records.filter((r) => r.type === 'code.execution.result').at(-1).data;
  expect(executed.suggestion.codePlan.code).toBe(good);
  expect(executed.suggestion.operations.some((op: { type: string }) => op.type === 'object.add')).toBe(true);
});
