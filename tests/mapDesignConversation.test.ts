import { describe, expect, it, vi } from 'vitest';
import { MapDesignSessionClient, renderDesignMessages, renderDesignAppearance, renderDesignAssetPrompts, designGenerationStatus } from '../src/client/mapDesignConversation';
import type { MapDesignDraft, MapDesignSessionView } from '../src/shared/mapDesignSession';
import { createEmptyMap } from '../src/shared/map';

function session(overrides: Partial<MapDesignSessionView> = {}): MapDesignSessionView {
  return { id: 'design-a', mapId: 'map-a', baseVersion: 1, draftRevision: 0, version: 1,
    status: 'running', messages: [], progress: null, createdAt: 10, updatedAt: 10,
    modelCalls: 1, operationCount: 0, assetCalls: 0, ...overrides };
}
function draft(view: MapDesignSessionView): MapDesignDraft {
  const map = createEmptyMap();
  map.id = view.mapId;
  return { session: view, map, suggestion: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(request: (path: string, init?: RequestInit) => Promise<unknown>, pollMs = 0) {
  const hooks = { changed: vi.fn(), draft: vi.fn(async (_value: MapDesignDraft) => true), committed: vi.fn(async () => {}) };
  const client = new MapDesignSessionClient(request as ConstructorParameters<typeof MapDesignSessionClient>[0], hooks, pollMs);
  return { client, hooks };
}

describe('persistent map design conversation client', () => {
  it('requires a displayed whitebox and sends revision-bound approval without treating resume or commit as approval', async()=>{
    const waiting=session({status:'paused',stage:'awaiting-plan-approval',operationCount:1,draftRevision:3});
    const rendering=deferred<boolean>();
    const preview=draft(waiting);
    preview.suggestion={summary:'Bench',operations:[],generatedAssets:[],renderPromptSuggestions:[],codePlan:{code:'function plan(api){}',placementCount:1,functions:[],assetRequirements:[{key:'bench',name:'<Bench>',variants:1,dimensions:[2,1,1],prompt:'Timber #B88752; metal #46524B'}]}};
    const request=vi.fn(async(path:string,init?:RequestInit)=>path.endsWith('/draft')?preview:init?{session:{...waiting,status:'running',stage:'generating-assets',version:2}}:{sessions:[waiting]});
    const {client,hooks}=setup(request);
    hooks.draft.mockImplementation(()=>rendering.promise);
    const connected=client.connect({mapId:'map-a',version:1});
    await vi.waitFor(()=>expect(hooks.draft).toHaveBeenCalled());
    expect(client.planDisplayed).toBe(false);
    expect(await client.approvePlan()).toBe(false);
    expect(await client.control('resume')).toBe(false);
    expect(await client.commit()).toBe(false);
    rendering.resolve(true);
    await connected;
    expect(client.planDisplayed).toBe(true);
    const table=renderDesignAssetPrompts(client.assetRequirements);
    expect(table).toContain('&lt;Bench&gt;');expect(table).toContain('#B88752');expect(table).toContain('2 × 1 × 1');
    expect(await client.approvePlan()).toBe(true);
    expect(request.mock.calls.at(-1)).toEqual(['/api/editor/design-sessions/design-a/approve-plan',expect.objectContaining({body:JSON.stringify({expectedRevision:3,approved:true})})]);
    client.disconnect();
  });
  it('distinguishes a whole planning task and asset batch from internal calls', () => {
    const text=designGenerationStatus(session({generationCounts:{planning:1,assets:1},generationCallLimit:2,
      modelCalls:12,assetCalls:30,paidRequests:42}));
    expect(text).toContain('整轮规划 1 次');
    expect(text).toContain('资产整批 1 次');
    expect(text).toContain('生成次数 2/2');
    expect(text).toContain('内部 GPT 往返 12 次');
    expect(text).not.toContain('付费请求');
  });
  it('explains an oversized asset library without sending or silently truncating it', async () => {
    const request=vi.fn(async () => ({sessions:[]}));
    const {client}=setup(request);
    await client.connect({mapId:'map-a',version:1});
    request.mockClear();
    expect(await client.send('Build a map',{assetIds:Array.from({length:65},(_,i)=>`asset-${i}`)})).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(client.error).toContain('65');
    expect(client.error).toContain('64 个限制');
  });
  it('retries cached geometry after an asynchronous renderer failure, ignoring stale failure callbacks', async () => {
    let current=session({operationCount:1,draftRevision:1,status:'idle'});
    const request=vi.fn(async (path:string) => path.endsWith('/draft')?draft(current):path.includes('/maps/')?{sessions:[current]}:{session:current});
    const {client,hooks}=setup(request);
    await client.connect({mapId:'map-a',version:1});
    expect(hooks.draft).toHaveBeenCalledTimes(1);
    client.invalidateDraft(1);
    await client.poll();
    expect(hooks.draft).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([path])=>path.endsWith('/draft'))).toHaveLength(1);
    current={...current,draftRevision:2,version:2};
    await client.poll();
    client.invalidateDraft(1);
    await client.poll();
    expect(hooks.draft).toHaveBeenCalledTimes(3);
  });
  it('shows authored material roles and colors without treating reused assets as recolored', () => {
    const html=renderDesignAppearance({version:1,intent:'<coherent>',materials:[{role:'plaster',color:'#bda783',notes:'walls'}],
      renderPlan:{version:1,baseSchemeId:'render-runtime-sketch-mist',modules:[]}});
    expect(html).toContain('background:#bda783');
    expect(html).toContain('plaster');
    expect(html).toContain('&lt;coherent&gt;');
    expect(html).toContain('复用资产保留原色');
    expect(renderDesignAppearance()).toBe('');
  });
  it('retries failed session recovery before allowing a message to create a duplicate conversation', async () => {
    vi.useFakeTimers();
    let recoveries = 0;
    const current = session({ status: 'idle' });
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (init) return { session: { ...current, version: 2 } };
      if (path.includes('/maps/')) {
        if (++recoveries === 1) throw new Error('offline');
        return { sessions: [current] };
      }
      return { session: null, version: current.version };
    });
    const { client } = setup(request, 1_000);
    try {
      await client.connect({ mapId: 'map-a', version: 1 });
      expect(await client.send('接着完善入口')).toBe(false);
      expect(client.error).toContain('offline');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.session?.id).toBe(current.id);
      expect(client.error).toBe('');
      expect(client.loading).toBe(false);
      expect(await client.send('接着完善入口')).toBe(true);
      const writes = request.mock.calls.filter(([, init]) => init);
      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe('/api/editor/design-sessions/design-a/messages');
    } finally { client.disconnect(); vi.useRealTimers(); }
  });

  it('stops recovery retries after successfully discovering that the map has no sessions', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const request = vi.fn(async () => {
      if (++attempts === 1) throw new Error('offline');
      return { sessions: [] };
    });
    const { client } = setup(request, 1_000);
    try {
      await client.connect({ mapId: 'map-a', version: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      await client.connect({ mapId: 'map-a', version: 1 });
      expect(request).toHaveBeenCalledTimes(2);
      expect(client.session).toBeNull();
      expect(client.loading).toBe(false);
      expect(client.error).toBe('');
      expect(vi.getTimerCount()).toBe(0);
    } finally { client.disconnect(); vi.useRealTimers(); }
  });

  it('recovers a session and fetches geometry only for changed draft revisions', async () => {
    let current = session({ operationCount: 2, draftRevision: 1 });
    const request = vi.fn(async (path: string) => path.endsWith('/draft') ? draft(current)
      : path.includes('/maps/') ? { sessions: [current] } : { session: current });
    const { client, hooks } = setup(request);
    await client.connect({ mapId: 'map-a', version: 1 });
    const changes = hooks.changed.mock.calls.length;
    await client.poll();
    expect(hooks.changed).toHaveBeenCalledTimes(changes);
    expect(hooks.draft).toHaveBeenCalledTimes(1);
    current = { ...current, version: 2, progress: { phase: 'planning', label: '调整入口' } };
    await client.poll();
    expect(hooks.draft).toHaveBeenCalledTimes(1);
    current = { ...current, version: 3, draftRevision: 2 };
    await client.poll();
    expect(hooks.draft).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([path]) => path.endsWith('/draft'))).toHaveLength(2);
  });

  it('recovers the newest dialogue rather than an older failed draft with a newer maintenance timestamp', async () => {
    const older=session({id:'old-design',createdAt:10,updatedAt:9999,status:'paused',operationCount:1,draftRevision:1});
    const current=session({id:'new-design',createdAt:20,updatedAt:30,status:'idle',operationCount:1,draftRevision:6});
    const request=vi.fn(async (path:string)=>path.endsWith('/draft') ? draft(current) : {sessions:[older,current]});
    const {client,hooks}=setup(request);
    await client.connect({mapId:'map-a',version:1});
    expect(client.session?.id).toBe('new-design');
    expect(hooks.draft.mock.calls[0][0].session.id).toBe('new-design');
  });

  it('keeps dirty manual work untouched and presents the cached draft once that conflict clears', async () => {
    const current = session({ operationCount: 1, draftRevision: 1, status: 'idle' });
    const request = vi.fn(async (path: string) => path.endsWith('/draft') ? draft(current) : { sessions: [current] });
    const { client, hooks } = setup(request);
    await client.connect({ mapId: 'map-a', version: 1, blocked: '未保存修改' });
    expect(hooks.draft).not.toHaveBeenCalled();
    expect(await client.commit()).toBe(false);
    expect(await client.send('覆盖掉')).toBe(false);
    await client.connect({ mapId: 'map-a', version: 1 });
    expect(hooks.draft).toHaveBeenCalledTimes(1);
    expect(request.mock.calls).toHaveLength(2);
  });

  it('polls with the retained version and leaves messages and geometry untouched when unchanged', async () => {
    let current = session({ version: 5, messages: [{ id: 'm1', role: 'user', content: '保留山形', createdAt: 1 }] });
    const request = vi.fn(async (path: string) => path.includes('/maps/') ? { sessions: [current] }
      : path.endsWith(`?sinceVersion=${current.version}`) ? { session: null, version: current.version } : { session: current });
    const { client, hooks } = setup(request);
    await client.connect({ mapId: 'map-a', version: 1 });
    hooks.changed.mockClear();
    await client.poll();
    expect(request.mock.calls.at(-1)?.[0]).toBe('/api/editor/design-sessions/design-a?sinceVersion=5');
    expect(client.session).toBe(current);
    expect(hooks.changed).not.toHaveBeenCalled();
    expect(hooks.draft).not.toHaveBeenCalled();
    current = { ...current, version: 6, status: 'idle' };
    await client.poll();
    expect(client.session?.version).toBe(6);
    expect(hooks.changed).toHaveBeenCalledTimes(1);
    client.error = '连接中断';
    await client.poll();
    expect(request.mock.calls.at(-1)?.[0]).toBe('/api/editor/design-sessions/design-a?sinceVersion=6');
    expect(client.error).toBe('');
  });

  it('retries a failed draft download even when the session version is unchanged', async () => {
    const current = session({ version: 5, draftRevision: 2, operationCount: 1 });
    let draftRequests = 0;
    const { client, hooks } = setup(async path => {
      if (path.endsWith('/draft')) {
        if (++draftRequests === 1) throw new Error('draft connection interrupted');
        return draft(current);
      }
      return path.includes('/maps/') ? { sessions: [current] } : { session: null, version: 5 };
    });
    await client.connect({ mapId: 'map-a', version: 1 });
    expect(client.error).toContain('draft connection interrupted');
    expect(hooks.draft).not.toHaveBeenCalled();
    await client.poll();
    expect(hooks.draft).toHaveBeenCalledTimes(1);
    expect(client.error).toBe('');
    await client.poll();
    expect(draftRequests).toBe(2);
  });

  it('ignores late recovery and draft responses after switching maps', async () => {
    const a = deferred<{ sessions: MapDesignSessionView[] }>();
    const { client, hooks } = setup(async path => path.includes('/map-a/') ? a.promise : { sessions: [] });
    const recovery = client.connect({ mapId: 'map-a', version: 1 });
    await client.connect({ mapId: 'map-b', version: 4 });
    a.resolve({ sessions: [session({ operationCount: 1, draftRevision: 1 })] });
    await recovery;
    expect(client.context?.mapId).toBe('map-b');
    expect(client.session).toBeNull();
    expect(hooks.draft).not.toHaveBeenCalled();

    const lateDraft = deferred<MapDesignDraft>();
    const view = session({ operationCount: 1, draftRevision: 1 });
    const other = setup(async path => path.endsWith('/draft') ? lateDraft.promise
      : path.includes('/map-a/') ? { sessions: [view] } : { sessions: [] });
    const loading = other.client.connect({ mapId: 'map-a', version: 1 });
    await Promise.resolve();
    await other.client.connect({ mapId: 'map-b', version: 1 });
    lateDraft.resolve(draft(view));
    await loading;
    expect(other.hooks.draft).not.toHaveBeenCalled();
    expect(other.client.session).toBeNull();
  });

  it('steers the current running session and continues the same transcript after a commit', async () => {
    let current = session();
    const requests: { path: string; body: unknown }[] = [];
    const { client } = setup(async (path, init) => {
      if (!init) return { sessions: [current] };
      requests.push({ path, body: JSON.parse(init.body as string) });
      current = { ...current, version: current.version + 1, status: 'running' };
      return { session: current };
    });
    await client.connect({ mapId: 'map-a', version: 1 });
    expect(await client.send('树不要挡住入口')).toBe(true);
    expect(requests[0]).toEqual({ path: '/api/editor/design-sessions/design-a/messages', body: { message: '树不要挡住入口' } });
    client.session = current = { ...current, status: 'committed', baseVersion: 2 };
    await client.connect({ mapId: 'map-a', version: 2 });
    expect(await client.send('沿着这条街再延伸')).toBe(true);
    expect(requests[1].path).toBe('/api/editor/design-sessions/design-a/messages');
  });

  it('discards a message response for a map that is no longer selected', async () => {
    const sent = deferred<{ session: MapDesignSessionView }>();
    const { client } = setup(async (path, init) => init ? sent.promise
      : { sessions: path.includes('/map-a/') ? [session()] : [] });
    await client.connect({ mapId: 'map-a', version: 1 });
    const sending = client.send('移动桥梁');
    await client.connect({ mapId: 'map-b', version: 3 });
    sent.resolve({ session: session({ version: 2 }) });
    expect(await sending).toBe(false);
    expect(client.session).toBeNull();
    expect(client.pending).toBe(false);
  });

  it('does not accept an older status over the result of steering', async () => {
    const oldPoll = deferred<{ session: MapDesignSessionView }>();
    const { client } = setup(async (path, init) => init ? { session: session({ version: 3, status: 'idle' }) }
      : path.includes('/maps/') ? { sessions: [session()] } : oldPoll.promise);
    await client.connect({ mapId: 'map-a', version: 1 });
    const polling = client.poll();
    await client.send('改成小径');
    oldPoll.resolve({ session: session({ version: 2 }) });
    await polling;
    expect(client.session?.version).toBe(3);
    expect(client.session?.status).toBe('idle');
  });

  it('commits a specific draft revision once and blocks stale or currently running drafts', async () => {
    const current = session({ status: 'idle', operationCount: 2, draftRevision: 4 });
    const map = { ...createEmptyMap(), id: 'map-a', version: 2 };
    const request = vi.fn(async (path: string, init?: RequestInit) => init
      ? { map, transaction: { id: 'transaction-1' }, session: { ...current, status: 'committed', baseVersion: 2, operationCount: 0, version: 2 } }
      : path.endsWith('/draft') ? draft(current) : { sessions: [current] });
    const { client, hooks } = setup(request);
    await client.connect({ mapId: 'map-a', version: 1 });
    await client.connect({ mapId: 'map-a', version: 5 });
    expect(await client.commit()).toBe(false);
    await client.connect({ mapId: 'map-a', version: 1 });
    client.session!.status = 'running';
    expect(await client.commit()).toBe(false);
    client.session!.status = 'idle';
    expect(await client.commit()).toBe(true);
    expect(JSON.parse(request.mock.calls.at(-1)![1]!.body as string)).toEqual({ expectedRevision: 4, approved: true });
    expect(hooks.committed).toHaveBeenCalledTimes(1);
    expect(await client.commit()).toBe(false);
  });

  it('shows connection failures without destroying the retained conversation and recovers on the next poll', async () => {
    let fail = false;
    const { client, hooks } = setup(async path => {
      if (fail) throw new Error('network down');
      return path.includes('/maps/') ? { sessions: [session()] } : { session: session({ version: 2 }) };
    });
    await client.connect({ mapId: 'map-a', version: 1 });
    fail = true;
    await client.poll();
    expect(client.error).toContain('network down');
    expect(client.session?.id).toBe('design-a');
    hooks.changed.mockClear();
    await client.poll();
    expect(hooks.changed).not.toHaveBeenCalled();
    fail = false;
    await client.poll();
    expect(client.error).toBe('');
    expect(client.session?.version).toBe(2);
  });

  it('renders actual tool results as escaped expandable text', () => {
    const html = renderDesignMessages(session({ messages: [
      { id: 'm1', role: 'user', content: '<img src=x onerror=alert(1)>', createdAt: 1 },
      { id: 'm2', role: 'tool', action: 'observe', content: '{"slope":12}', createdAt: 2, draftRevision: 3 }
    ] }));
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).toContain('<summary>observe · 草稿 3</summary>');
    expect(html).toContain('&quot;slope&quot;:12');
  });
});
