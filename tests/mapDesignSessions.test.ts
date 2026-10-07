import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('lets the backend retry a failed asset within the same batch without consuming a successful-asset slot', async () => {
    const {store,map}=await setup();
    const actions=[{action:'execute',code:'first'},{action:'execute',code:'retry'},{action:'finish'}];
    let attempts=0;
    const manager=new MapDesignSessionManager(store,{
      chat:async()=>JSON.stringify(actions.shift()),
      createAsset:async request=>{
        if(++attempts===1) throw new Error('asset_service_failure');
        return store.saveAsset({name:request.name,prompt:request.prompt,tags:[],mode:'voxel',modelJson:{nodes:[]}});
      },
      execute:async input=>({...suggestion(input.code),generatedAssets:[await input.createAsset!({name:'Tree',prompt:'New tree',tags:[],mode:'voxel'},()=>{})]})
    });
    const session=await manager.create(map.id,{prompt:'An orchard',expectedVersion:map.version,minNewAssets:1,maxNewAssets:1,maxGenerationCalls:2});
    await manager.settled(session.id);
    expect(await manager.get(session.id)).toMatchObject({outcome:'completed',generationCounts:{planning:1,assets:1},assetCalls:2});
    expect((await manager.draft(session.id)).map.assets).toHaveLength(1);
  });
  it('counts a whole autonomous planning task and all of its assets as two generation calls', async () => {
    const {store,map}=await setup();
    const upstream=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}'));
    const actions=[{action:'execute',code:'first'},{action:'execute',code:'second'},{action:'finish'}];
    let transcript='';
    const manager=new MapDesignSessionManager(store,{
      chat:async (messages,options)=>{
        transcript=JSON.stringify(messages);
        await options!.fetchImpl!('https://model.example/api/chat');
        return JSON.stringify(actions.shift());
      },
      createAsset:async request=>store.saveAsset({name:request.name,prompt:request.prompt,tags:[],mode:'voxel',modelJson:{nodes:[]}}),
      execute:async input=>{
        const assets=await Promise.all(Array.from({length:24},(_,i)=>input.createAsset!({name:`Asset ${i}`,prompt:`New ${i}`,tags:[],mode:'voxel'},()=>{})));
        return {...suggestion(input.code),generatedAssets:assets};
      }
    });
    try {
      const session=await manager.create(map.id,{prompt:'A harbor town',expectedVersion:map.version,maxNewAssets:36,maxGenerationCalls:2});
      await manager.settled(session.id);
      expect(await manager.get(session.id)).toMatchObject({outcome:'completed',generationCounts:{planning:1,assets:1},generationCallLimit:2,paidRequests:3,assetCalls:24});
      expect(transcript).toContain('## Architectural composition');
      expect(transcript).toContain('Urban morphology: api.urbanLayout');
      const recovered=new MapDesignSessionManager(store);
      expect(await recovered.get(session.id)).toMatchObject({generationCounts:{planning:1,assets:1}});
      await manager.commit(session.id,2,true);
      await expect(manager.message(session.id,'Another completed task')).rejects.toThrow('design_generation_budget_exhausted');
      expect(upstream).toHaveBeenCalledTimes(3);
    } finally { upstream.mockRestore(); }
  });

  it('lets the model edit a failed submitted program after restart while retaining the complete draft', async () => {
    const {store,map}=await setup();
    const firstResponses=[{action:'execute',code:'valid'}, {action:'execute',code:'radius=40'}, {action:'finish',outcome:'blocked',summary:'Radius needs repair'}];
    const first=new MapDesignSessionManager(store,{
      chat:async()=>JSON.stringify(firstResponses.shift()),
      execute:async input=>{if(input.code==='radius=40')throw new Error('world_invalid_town_radius');return suggestion('Retained scene');}
    });
    const session=await first.create(map.id,{prompt:'Town',expectedVersion:map.version});
    await first.settled(session.id);
    expect((await first.draft(session.id)).map.name).toBe('Retained scene');
    const nextResponses=[{action:'execute',edits:[{old:'radius=40',new:'radius=60'}]}, {action:'finish'}];
    const resumed=new MapDesignSessionManager(store,{
      chat:async()=>JSON.stringify(nextResponses.shift()),
      execute:async input=>{expect(input.code).toBe('radius=60');return suggestion('Repaired scene');}
    });
    await resumed.resume(session.id);
    await resumed.settled(session.id);
    expect((await resumed.draft(session.id)).map.name).toBe('Repaired scene');
    expect((await resumed.get(session.id)).outcome).toBe('completed');
  });

  it('honors 22..36 actual new assets, rejects premature completion, and returns whole-map feedback in the same context', async () => {
    const {store,map}=await setup();
    const responses=[{action:'execute',code:'21'}, {action:'finish'}, {action:'execute',code:'22'}, {action:'finish'}];
    let transcript='';
    const manager=new MapDesignSessionManager(store,{
      chat:async messages=>{transcript=JSON.stringify(messages);return JSON.stringify(responses.shift());},
      createAsset:async request=>store.saveAsset({name:request.name,prompt:request.prompt,tags:[],mode:'voxel',provider:'deepseek',modelJson:{nodes:[{id:'box',mesh:{type:'box',params:{width:1,height:1,depth:1},material:{color:'#826044'}}}]}}),
      execute:async input=>{
        expect(input.assets.every(asset=>asset.provider==='deepseek')).toBe(true);
        const made=[];
        for(let i=0;i<Number(input.code);i++) made.push(await input.createAsset!({name:`Asset ${i}`,prompt:`New ${i}`,tags:[],mode:'voxel'},()=>{}));
        return {...suggestion('All-new draft'),generatedAssets:made};
      }
    });
    const session=await manager.create(map.id,{prompt:'New voxel world',expectedVersion:map.version,provider:'gpt',assetProvider:'deepseek',minNewAssets:22,maxNewAssets:36,reuseExistingAssets:false});
    await manager.settled(session.id);
    const result=await manager.get(session.id);
    expect(result.outcome).toBe('completed');
    expect(result.assetCalls).toBe(22);
    expect(transcript).toContain('design_new_assets_minimum:21/22');
    expect(transcript).toContain('spatialCoverage');
    expect(transcript).toContain('sector-3-3');
    expect(transcript).toContain('disabled: start with the empty catalog');
    expect((await manager.draft(session.id)).map.assets).toHaveLength(22);
  });

  it('rejects conflicting reuse and asset ranges before sending a model request', async () => {
    const {store,map}=await setup();
    let calls=0;
    const manager=new MapDesignSessionManager(store,{chat:async()=>{calls++;return '{}';}});
    await expect(manager.create(map.id,{prompt:'New only',expectedVersion:map.version,minNewAssets:37,maxNewAssets:36})).rejects.toThrow('design_asset_range_invalid');
    await expect(manager.create(map.id,{prompt:'New only',expectedVersion:map.version,reuseExistingAssets:false,assetIds:['old']})).rejects.toThrow('design_new_assets_conflicts_with_library_selection');
    expect(calls).toBe(0);
  });

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
