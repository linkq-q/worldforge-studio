import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {MapStore} from '../src/server/mapStore';
import {MapDesignSessionManager} from '../src/server/mapDesignSessions';
import type {MapAiSuggestion} from '../src/shared/mapOperations';

const io=vi.hoisted(()=>({failNextDesignWrite:false,
  holdNextDesignWrite:null as null | {entered:()=>void;release:Promise<void>}}));
vi.mock('node:fs/promises', async original => {
  const actual=await original<typeof import('node:fs/promises')>();
  return {...actual,writeFile:(...args:Parameters<typeof actual.writeFile>)=>{
    if(io.failNextDesignWrite && String(args[0]).includes('design-sessions') && String(args[0]).endsWith('.tmp')) {
      io.failNextDesignWrite=false;
      return Promise.reject(new Error('temporary disk failure'));
    }
    if(io.holdNextDesignWrite && String(args[0]).includes('design-sessions') && String(args[0]).endsWith('.tmp')) {
      const hold=io.holdNextDesignWrite;io.holdNextDesignWrite=null;
      hold.entered();
      return hold.release.then(()=>actual.writeFile(...args));
    }
    return actual.writeFile(...args);
  }};
});

const directories:string[]=[];
afterEach(async()=>{
  io.failNextDesignWrite=false;
  io.holdNextDesignWrite=null;
  vi.restoreAllMocks();
  for(const directory of directories.splice(0)) await rm(directory,{recursive:true,force:true});
});
async function setup() {
  const rootDir=await mkdtemp(path.join(os.tmpdir(),'worldforge-design-concurrency-'));
  directories.push(rootDir);
  const store=new MapStore({rootDir});
  const map=await store.createMap({name:'Original',size:[48,12,48]});
  return {store,map};
}
function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}
function suggestion(name:string):MapAiSuggestion {
  return {summary:name,operations:[{type:'map.update',name}],generatedAssets:[],renderPromptSuggestions:[]};
}

describe('design-session interruption and persistence boundaries',()=>{
  it('allows only one simultaneous create per map and sends one model request',async()=>{
    const {store,map}=await setup();
    const chat=vi.fn(async()=>JSON.stringify({action:'finish'}));
    const manager=new MapDesignSessionManager(store,{chat});
    const results=await Promise.allSettled([
      manager.create(map.id,{prompt:'First request',expectedVersion:map.version}),
      manager.create(map.id,{prompt:'Duplicate request',expectedVersion:map.version})
    ]);
    for(const result of results) if(result.status==='fulfilled') await manager.settled(result.value.id);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({status:'rejected',reason:new Error('design_map_already_running')});
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it.each(['message','resume'] as const)('rejects %s if a commit starts while its base-map read is pending',async command=>{
    const {store,map}=await setup();
    const responses=[{action:'execute',code:'first'},{action:'finish'},
      {action:'execute',code:'after-commit'},{action:'finish'}];
    const bases:string[]=[];
    const chat=vi.fn(async()=>JSON.stringify(responses.shift()));
    const manager=new MapDesignSessionManager(store,{chat,execute:async input=>{
      bases.push(input.baseMap.name);return suggestion(input.code);
    }});
    const session=await manager.create(map.id,{prompt:'Town',expectedVersion:map.version});
    await manager.settled(session.id);
    const reading=deferred(),releaseRead=deferred(),committing=deferred(),releaseCommit=deferred();
    const originalLoad=store.loadMap.bind(store),originalCommit=store.commitTransaction.bind(store);
    let holdRead=true;
    vi.spyOn(store,'loadMap').mockImplementation(async id=>{
      const value=await originalLoad(id);
      if(holdRead){holdRead=false;reading.resolve();await releaseRead.promise;}
      return value;
    });
    vi.spyOn(store,'commitTransaction').mockImplementation(async(...args)=>{
      committing.resolve();await releaseCommit.promise;return originalCommit(...args);
    });
    const steering=command==='message'?manager.message(session.id,'Never lose this edit'):manager.resume(session.id);
    const rejected=expect(steering).rejects.toThrow('design_commit_in_progress');
    await reading.promise;
    const commit=manager.commit(session.id,1,true);
    await committing.promise;
    try {
      releaseRead.resolve();await rejected;
      expect(chat).toHaveBeenCalledTimes(2);
      expect((await manager.draft(session.id)).map.name).toBe('first');
    } finally {releaseRead.resolve();releaseCommit.resolve();}
    await commit;
    await manager.message(session.id,'Continue on the newly committed base');
    await manager.settled(session.id);
    expect(bases).toEqual(['Original','first']);
    expect((await manager.draft(session.id)).map.name).toBe('after-commit');
    expect((await originalLoad(map.id)).name).toBe('first');
  });

  it('rejects steering during the final commit snapshot and continues after that snapshot is durable',async()=>{
    const {store,map}=await setup();
    const responses=[{action:'execute',code:'first'},{action:'finish'},
      {action:'execute',code:'after-commit'},{action:'finish'}];
    const bases:string[]=[];
    const manager=new MapDesignSessionManager(store,{chat:async()=>JSON.stringify(responses.shift()),
      execute:async input=>{bases.push(input.baseMap.name);return suggestion(input.code);}});
    const session=await manager.create(map.id,{prompt:'Town',expectedVersion:map.version});
    await manager.settled(session.id);
    const writing=deferred(),release=deferred();
    io.holdNextDesignWrite={entered:writing.resolve,release:release.promise};
    const commit=manager.commit(session.id,1,true);
    await writing.promise;
    try {
      await expect(manager.message(session.id,'Too early')).rejects.toThrow('design_commit_in_progress');
      expect((await store.loadMap(map.id)).name).toBe('first');
    } finally {release.resolve();}
    await commit;
    await manager.message(session.id,'Continue after save');await manager.settled(session.id);
    const recovered=new MapDesignSessionManager(new MapStore({rootDir:store.rootDir}));
    expect((await recovered.draft(session.id)).map.name).toBe('after-commit');
    expect(bases).toEqual(['Original','first']);
    expect((await recovered.get(session.id)).messages.some(message=>message.content==='Too early')).toBe(false);
  });

  it.each(['pause','message'] as const)('does not replace the completed draft when %s arrives during post-execution validation',async steering=>{
    const {store,map}=await setup();
    const waiting=deferred(),release=deferred();
    let delayNextValidation=false;
    const originalLoad=store.loadMap.bind(store);
    vi.spyOn(store,'loadMap').mockImplementation(async id=>{
      if(delayNextValidation) {
        delayNextValidation=false;
        waiting.resolve();
        await release.promise;
      }
      return originalLoad(id);
    });
    const actions=[{action:'execute',code:'good'}, {action:'finish'},
      {action:'execute',code:'obsolete'}, {action:'finish'}];
    const manager=new MapDesignSessionManager(store,{
      chat:async()=>JSON.stringify(actions.shift()),
      execute:async input=>{
        if(input.code==='obsolete') delayNextValidation=true;
        return suggestion(input.code);
      }
    });
    const session=await manager.create(map.id,{prompt:'A village',expectedVersion:map.version});
    await manager.settled(session.id);
    expect((await manager.draft(session.id)).map.name).toBe('good');
    await manager.message(session.id,'Try a new plan');
    await waiting.promise;
    try {
      if(steering==='pause') await manager.pause(session.id);
      else await manager.message(session.id,'Keep the previous completed draft');
    } finally { release.resolve(); }
    await manager.settled(session.id);
    const final=await manager.draft(session.id);
    expect(final.map.name).toBe('good');
    expect(final.session.draftRevision).toBe(1);
    expect(final.session.status).toBe(steering==='pause'?'paused':'idle');
    expect(JSON.stringify(final.session.messages)).toContain('interrupted_by_user');
    expect((await originalLoad(map.id)).name).toBe('Original');
  });

  it('can save again after a transient snapshot write failure without losing the prior draft',async()=>{
    const {store,map}=await setup();
    const actions=[{action:'execute',code:'good'},{action:'finish'},{action:'finish'}];
    const manager=new MapDesignSessionManager(store,{
      chat:async()=>JSON.stringify(actions.shift()),execute:async()=>suggestion('Good draft')
    });
    const session=await manager.create(map.id,{prompt:'Town',expectedVersion:map.version});
    await manager.settled(session.id);
    io.failNextDesignWrite=true;
    await expect(manager.pause(session.id)).rejects.toThrow('temporary disk failure');
    await manager.message(session.id,'Continue after storage recovered');
    await manager.settled(session.id);
    const recovered=new MapDesignSessionManager(new MapStore({rootDir:store.rootDir}));
    const final=await recovered.draft(session.id);
    expect(final.map.name).toBe('Good draft');
    expect(final.session.status).toBe('idle');
    expect(JSON.stringify(final.session.messages)).toContain('Continue after storage recovered');
  });

  it('reuses an identical asset request across complete program replays instead of charging twice',async()=>{
    const {store,map}=await setup();
    const code="function plan(api){const key=api.requireAsset({key:'tree',name:'树',prompt:'A tree',dimensions:[2,5,2],role:'environment'});api.place({assetId:api.asset(key),position:[2,3]});}";
    const actions=[{action:'execute',code},{action:'execute',code:code.replace('[2,3]','[4,5]')},{action:'finish'}];
    const createAsset=vi.fn(async()=>store.saveAsset({name:'树',prompt:'A tree',tags:['tree'],mode:'voxel',modelJson:{nodes:[]}}));
    const manager=new MapDesignSessionManager(store,{chat:async()=>JSON.stringify(actions.shift()),createAsset});
    const session=await manager.create(map.id,{prompt:'Place a tree',expectedVersion:map.version,maxNewAssets:1});
    await manager.settled(session.id);
    const draft=await manager.draft(session.id);
    expect(createAsset).toHaveBeenCalledTimes(1);
    expect(draft.session.assetCalls).toBe(1);
    expect(draft.session.draftRevision).toBe(2);
    expect(draft.map.objects).toHaveLength(1);
    expect(draft.map.objects[0].transform.position).toEqual([4,0,5]);
    expect(draft.map.objects[0].assetId).toBe((await createAsset.mock.results[0].value).id);
  });
});
