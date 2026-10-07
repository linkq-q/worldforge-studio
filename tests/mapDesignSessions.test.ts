import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MapStore } from '../src/server/mapStore';
import { MapDesignSessionManager } from '../src/server/mapDesignSessions';
import type { ChatMessage } from '../src/server/modelApi';
import type { MapAiSuggestion } from '../src/shared/mapOperations';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function setup() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-design-'));
  directories.push(rootDir);
  const store = new MapStore({ rootDir });
  const map = await store.createMap({ name: 'Original', size: [48, 12, 48] });
  return { store, map };
}

function suggestion(name: string): MapAiSuggestion {
  return { summary: name, operations: [{ type: 'map.update', name }], generatedAssets: [], renderPromptSuggestions: [] };
}

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 200; index++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('design_test_wait_timeout');
}

describe('ongoing map design sessions', () => {
  it('feeds executed facts to the same transcript, replaces drafts, and commits one undoable result', async () => {
    const { store, map } = await setup();
    const conversations: readonly ChatMessage[][] = [];
    const bases: string[] = [];
    const responses = [
      { action: 'execute', code: 'first', summary: 'Place the first street' },
      { action: 'observe', query: { kind: 'summary' } },
      { action: 'execute', edits: [{ old: 'first', new: 'second' }], summary: 'Change the same street' },
      { action: 'finish', summary: 'A connected village' }
    ];
    const manager = new MapDesignSessionManager(store, {
      chat: async messages => { (conversations as ChatMessage[][]).push(structuredClone([...messages])); return JSON.stringify(responses.shift()); },
      execute: async input => { bases.push(input.baseMap.name); return suggestion(input.code); },
      observe: (current, _query, revision) => ({ currentName: current.name, draftRevision: revision }) as never
    });
    const session = await manager.create(map.id, { prompt: 'A village along the river', expectedVersion: map.version });
    await manager.settled(session.id);
    expect(bases).toEqual(['Original', 'Original']);
    expect(conversations[1].map(message => message.content).join('\n')).toContain('"currentName":"first"');
    expect(JSON.stringify(conversations[3])).toContain('A village along the river');
    expect((await manager.draft(session.id)).map.name).toBe('second');
    expect((await store.loadMap(map.id)).name).toBe('Original');
    const view = await manager.get(session.id);
    const committed = await manager.commit(session.id, view.draftRevision, true);
    expect(committed.map.name).toBe('second');
    expect(committed.transaction.operationCount).toBe(1);
    await store.undoTransaction(map.id);
    expect((await store.loadMap(map.id)).name).toBe('Original');
  });

  it('interrupts a pending model call and carries the steering message into continuation', async () => {
    const { store, map } = await setup();
    let calls = 0, interrupted = false;
    const conversations: ChatMessage[][] = [];
    const manager = new MapDesignSessionManager(store, {
      chat: async (messages, options) => {
        conversations.push(structuredClone([...messages]));
        if (++calls === 1) return new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => { interrupted = true; reject(new Error('aborted')); }, { once: true });
        });
        return JSON.stringify({ action: 'finish', outcome: 'unchanged', summary: 'Keep the mountain and move only the shops' });
      }
    });
    const session = await manager.create(map.id, { prompt: 'Create a mountain village', expectedVersion: map.version });
    await until(() => calls === 1);
    await manager.message(session.id, '保留原山形，只调整商铺');
    await manager.settled(session.id);
    expect(interrupted).toBe(true);
    expect(calls).toBe(2);
    const continuation = JSON.stringify(conversations[1]);
    expect(continuation).toContain('Create a mountain village');
    expect(continuation).toContain('保留原山形，只调整商铺');
    expect((await manager.get(session.id)).status).toBe('idle');
    expect((await manager.draft(session.id)).suggestion).toBeNull();
  });

  it('retains the last complete draft on execution failure and persists the original model output', async () => {
    const { store, map } = await setup();
    const responses = [
      { action: 'execute', code: 'valid' }, { action: 'execute', code: 'invalid' }, { action: 'finish', summary: 'Retained draft' }
    ];
    let lastTranscript = '';
    const manager = new MapDesignSessionManager(store, {
      chat: async messages => { lastTranscript = JSON.stringify(messages); return JSON.stringify(responses.shift()); },
      execute: async input => { if (input.code === 'invalid') throw new Error('invalid_geometry'); return suggestion('Good draft'); }
    });
    const session = await manager.create(map.id, { prompt: 'Town', expectedVersion: map.version });
    await manager.settled(session.id);
    expect(lastTranscript).toContain('invalid_geometry');
    expect(lastTranscript).toContain('invalid');
    const recovered = new MapDesignSessionManager(new MapStore({ rootDir: store.rootDir }));
    expect((await recovered.draft(session.id)).map.name).toBe('Good draft');
    expect((await recovered.get(session.id)).draftRevision).toBe(1);
  });

  it('continues the same conversation after commit on a new base without replaying the prior program', async () => {
    const { store, map } = await setup();
    const responses = [{ action: 'execute', code: 'first' }, { action: 'finish' },
      { action: 'execute', code: 'second' }, { action: 'finish' }];
    const bases: string[] = [];
    let latest = '';
    const manager = new MapDesignSessionManager(store, {
      chat: async messages => { latest = JSON.stringify(messages); return JSON.stringify(responses.shift()); },
      execute: async input => { bases.push(input.baseMap.name); return suggestion(input.code); }
    });
    const session = await manager.create(map.id, { prompt: 'First layout', expectedVersion: map.version });
    await manager.settled(session.id);
    await manager.commit(session.id, 1, true);
    await manager.message(session.id, 'Now improve the entrance');
    await manager.settled(session.id);
    expect(bases).toEqual(['Original', 'first']);
    expect(latest).toContain('First layout');
    expect(latest).toContain('Now improve the entrance');
    expect(latest).toContain('already committed program');
    expect((await manager.draft(session.id)).map.name).toBe('second');
  });

  it('rejects stale map or draft versions instead of overwriting manual edits', async () => {
    const { store, map } = await setup();
    const responses = [{ action: 'execute', code: 'first' }, { action: 'finish' }];
    const manager = new MapDesignSessionManager(store, {
      chat: async () => JSON.stringify(responses.shift()), execute: async () => suggestion('Draft')
    });
    const session = await manager.create(map.id, { prompt: 'Town', expectedVersion: map.version });
    await manager.settled(session.id);
    await expect(manager.commit(session.id, 0, true)).rejects.toThrow('design_draft_stale');
    await store.replaceMap(map.id, { ...map, name: 'Manual edit' });
    await expect(manager.message(session.id, 'Continue')).rejects.toThrow('map_transaction_stale');
    await expect(manager.commit(session.id, 1, true)).rejects.toThrow('map_transaction_stale');
    expect((await store.loadMap(map.id)).name).toBe('Manual edit');
    expect((await manager.draft(session.id)).map.name).toBe('Draft');
  });

  it('stops at a visible step budget and bounds explicit same-conversation format corrections', async () => {
    const { store, map } = await setup();
    let calls = 0;
    const manager = new MapDesignSessionManager(store, { maxSteps: 2,
      chat: async () => { calls++; return JSON.stringify({ action: 'observe', query: { kind: 'summary' } }); }
    });
    const session = await manager.create(map.id, { prompt: 'Observe', expectedVersion: map.version });
    await manager.settled(session.id);
    expect(calls).toBe(2);
    expect((await manager.get(session.id)).status).toBe('paused');
    const invalid = new MapDesignSessionManager(store, { chat: async () => 'not a JSON action' });
    const failed = await invalid.create(map.id, { prompt: 'Observe again', expectedVersion: map.version });
    await invalid.settled(failed.id);
    expect((await invalid.get(failed.id)).status).toBe('failed');
    expect((await invalid.get(failed.id)).modelCalls).toBe(3);
  });
});
