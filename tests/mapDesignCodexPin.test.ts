import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {handleMapHttp} from '../src/server/mapHttp';
import {mapDesignManager} from '../src/server/mapDesignHttp';
import {MapStore} from '../src/server/mapStore';

it('pins the Codex executor across no-header UI continuation, reload, expiration and explicit rebind',async()=>{
  const rootDir=await mkdtemp(path.join(os.tmpdir(),'worldforge-design-codex-pin-'));
  let store=new MapStore({rootDir});
  const map=await store.createMap({name:'Pinned conversation'});
  const server=http.createServer((req,res)=>{void handleMapHttp(req,res,store);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/editor`;
  const nativeFetch=globalThis.fetch;
  const remote=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
    if(String(input).startsWith(base)) return nativeFetch(input,init);
    throw new Error('unexpected_paid_request');
  });
  const runs:string[]=[];
  let sessionId='';
  const post=(url:string,body:unknown,runId?:string)=>fetch(`${base}${url}`,{
    method:'POST',headers:{'Content-Type':'application/json',...(runId?{'X-WorldForge-Codex-Run':runId}:{})},
    body:JSON.stringify(body)
  });
  async function run() {
    const {runId}=await (await post('/codex-runs',{})).json();
    runs.push(runId);
    return runId as string;
  }
  async function next(runId:string) {
    for(let attempt=0;attempt<200;attempt++) {
      const {requests}=await (await fetch(`${base}/codex-runs/${runId}/next`)).json();
      if(requests.length) return requests[0] as {id:string;messages:unknown[]};
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw new Error('missing_pinned_codex_request');
  }
  async function respond(runId:string,requestId:string,action:unknown) {
    expect((await post(`/codex-runs/${runId}/respond`,{requestId,content:JSON.stringify(action)})).status).toBe(200);
  }
  try {
    const first=await run();
    const created=await post(`/maps/${map.id}/design-sessions`,{prompt:'Keep terrain and connect the entrance',expectedVersion:map.version},first);
    expect(created.status).toBe(201);
    sessionId=(await created.json()).session.id;
    await respond(first,(await next(first)).id,{action:'execute',code:"function plan(api){api.route({id:'entry',points:[[-8,0],[8,0]],width:2});}"});
    await respond(first,(await next(first)).id,{action:'finish',summary:'Original draft'});
    await mapDesignManager(store).settled(sessionId);

    // Reload persisted state, then mimic the browser: no executor header.
    store=new MapStore({rootDir});
    expect((await post(`/design-sessions/${sessionId}/messages`,{message:'Keep that route and reconsider the view'})).status).toBe(200);
    const continuation=await next(first);
    expect(JSON.stringify(continuation.messages)).toContain('Keep terrain and connect the entrance');
    expect(JSON.stringify(continuation.messages)).toContain('reconsider the view');
    await respond(first,continuation.id,{action:'finish',summary:'Draft retained'});
    await mapDesignManager(store).settled(sessionId);

    await fetch(`${base}/codex-runs/${first}`,{method:'DELETE'});
    expect((await post(`/design-sessions/${sessionId}/resume`,{})).status).toBe(200);
    await mapDesignManager(store).settled(sessionId);
    const failed=await mapDesignManager(store).draft(sessionId);
    expect(failed.session.status).toBe('failed');
    expect(failed.session.error).toContain('unknown_codex_run');
    expect(failed.session.draftRevision).toBe(1);

    const second=await run();
    expect((await post(`/design-sessions/${sessionId}/resume`,{},second)).status).toBe(200);
    const pendingOld=await next(second);
    // Rebinding a live job must also leave its old AsyncLocalStorage context.
    const third=await run();
    expect((await post(`/design-sessions/${sessionId}/messages`,{message:'Continue through the new executor'},third)).status).toBe(200);
    const rebound=await next(third);
    expect(rebound.id).not.toBe(pendingOld.id);
    expect((await (await fetch(`${base}/codex-runs/${second}/next`)).json()).requests).toHaveLength(0);
    await respond(third,rebound.id,{action:'finish',summary:'Same design, new executor'});
    await mapDesignManager(store).settled(sessionId);
    const final=await mapDesignManager(store).draft(sessionId);
    expect(final.session.status).toBe('idle');
    expect(final.session.draftRevision).toBe(1);
    expect(final.map.guides.some(guide=>guide.id==='entry')).toBe(true);
    expect(remote.mock.calls.every(([input])=>String(input).startsWith(base))).toBe(true);
  } finally {
    if(sessionId) await mapDesignManager(store).pause(sessionId).catch(()=>undefined);
    for(const runId of runs) await fetch(`${base}/codex-runs/${runId}`,{method:'DELETE'});
    if(sessionId) await mapDesignManager(store).settled(sessionId);
    server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    remote.mockRestore();
    await rm(rootDir,{recursive:true,force:true});
  }
});
