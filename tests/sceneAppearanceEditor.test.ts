import {afterEach, expect, it, vi} from 'vitest';
import {MapEditor} from '../src/client/mapEditor';
import {createEmptyMap} from '../src/shared/map';
import {BUILTIN_RENDER_SCHEMES} from '../src/shared/renderScheme';

vi.mock('../src/client/mapDesignConversation', () => ({
  MapDesignSessionClient: class {
    session: unknown = null;
    constructor(_request: unknown, public hooks: any) {}
    connect = vi.fn(async () => {});
    invalidateDraft = vi.fn();
  },
  MapDesignConversation: class { render() {} }
}));
afterEach(() => vi.unstubAllGlobals());
const appearance = {version: 1 as const, intent: 'Warm stone', materials: [{role: 'stone', color: '#aa8866', notes: 'rough'}],
  renderPlan: {version: 2 as const, baseSchemeId: BUILTIN_RENDER_SCHEMES[0].id, modules: []}};
function editor() {
  vi.stubGlobal('localStorage', {getItem: () => null});
  vi.stubGlobal('location', {protocol: 'http:', hostname: 'localhost', origin: 'http://localhost'});
  const e = new MapEditor({dataset: {}, querySelector: () => null} as unknown as HTMLElement) as any;
  e.state.map = createEmptyMap('Appearance');
  e.state.map.renderSchemeId = BUILTIN_RENDER_SCHEMES[0].id;
  e.state.renderSchemes = structuredClone(BUILTIN_RENDER_SCHEMES);
  for (const key of ['renderPanels', 'updateToolbarState', 'cancelAssetPlacement', 'resetManualHistory']) e[key] = () => {};
  e.reloadLists = e.refreshScene = e.clearBrowserMapDraft = async () => {};
  return e;
}
function candidate(e: any) {
  e.mapAiSuggestion = {summary: 'Candidate', operations: [], generatedAssets: [], renderPromptSuggestions: [], appearancePlan: appearance};
  e.mapAiPreviewMap = structuredClone(e.state.map);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({map: e.state.map, transaction: {label: 'Candidate'}}), {headers: {'Content-Type': 'application/json'}}));
}
function conversation(e: any) {
  e.app.querySelector = (selector: string) => selector === '#map-design-panel' ? {hidden: false} : null;
  e.syncDesignConversation();
  return e.designClient.hooks;
}
it('retains the companion after continuous-session commit and applies it only in the confirmed render stage', async () => {
  const e = editor(), id = e.state.map.renderSchemeId;
  const applied = vi.fn(); e.renderScene = {applyScheme: applied};
  await conversation(e).committed({map: e.state.map, transaction: {label:'Design'}, session:{appearancePlan:appearance}});
  expect(e.renderDraft.renderPlan).toEqual(appearance.renderPlan);
  expect(e.state.map).not.toHaveProperty('appearancePlan');
  e.applyCurrentRenderScheme(); expect(applied).toHaveBeenLastCalledWith(null);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({map:e.state.map}),{headers:{'Content-Type':'application/json'}}));
  await e.confirmMap();
  expect(e.state.stage).toBe('render');
  expect(e.state.map.renderSchemeId).toBe(id);
  expect(applied).toHaveBeenLastCalledWith(e.renderDraft);
});
it('restores a committed companion from the persistent conversation without overwriting manual render changes', () => {
  const e = editor(), hooks = conversation(e);
  e.designClient.session = {status:'committed',mapId:e.state.map.id,baseVersion:e.state.map.version,appearancePlan:appearance};
  hooks.changed();
  expect(e.renderDraft.renderPlan).toEqual(appearance.renderPlan);
  e.renderDraft.description = 'manual adjustment';
  hooks.changed();
  expect(e.renderDraft.description).toBe('manual adjustment');
  e.resetRenderDraft(); e.designClient.session.baseVersion++;
  hooks.changed();
  expect(e.plannedRenderDraft).toBe(false);
});
it('keeps a newly saved render scheme when the old committed conversation refreshes before map save', async () => {
  vi.stubGlobal('window',{setTimeout:vi.fn(()=>1),clearTimeout:vi.fn()});
  const e=editor(),hooks=conversation(e);
  e.designClient.session={status:'committed',mapId:e.state.map.id,baseVersion:e.state.map.version,appearancePlan:appearance};
  hooks.changed();
  e.state.stage='render';
  e.renderDraft.description='human edited palette';
  const saved={...e.renderDraft,id:'custom-human-palette',kind:'custom'};
  vi.stubGlobal('prompt',()=> 'Human palette');
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({renderScheme:saved}),{headers:{'Content-Type':'application/json'}}));
  await e.saveRenderDraft();
  expect(e.plannedRenderDraft).toBe(false);
  expect(e.state.dirty).toBe(true);
  e.state.stage='map';
  hooks.changed();
  expect(e.renderDraft.id).toBe(saved.id);
  expect(e.renderDraft.description).toBe('human edited palette');
});
it('invalidates the accepted draft revision when its asynchronous scene render fails', async () => {
  const e=editor(),hooks=conversation(e);
  e.refreshScene=async()=>{throw new Error('GPU build failed');};
  const draft={session:{mapId:e.state.map.id,draftRevision:4},map:e.state.map,suggestion:null};
  expect(await hooks.draft(draft)).toBe(true);
  await Promise.resolve();
  expect(e.designClient.invalidateDraft).toHaveBeenCalledWith(4);
  expect(e.mapAiPreviewMap.id).toBe(e.state.map.id);
  expect(e.state.message).toContain('GPU build failed');
});
it('preserves late manual geometry instead of installing a committed appearance over it', async () => {
  const e = editor(), hooks=conversation(e), before=e.state.map;
  e.state.dirty=true;
  await hooks.committed({map:{...before,name:'server'},transaction:{label:'Design'},session:{appearancePlan:appearance}});
  expect(e.state.map).toBe(before);
  expect(e.renderDraft).toBeNull();
});
it('retains the companion through legacy map acceptance and confirmation without attaching a scheme', async () => {
  const e=editor(); candidate(e);
  await e.applyMapAiPreview();
  expect(e.renderDraft.renderPlan).toEqual(appearance.renderPlan);
  const applied=vi.fn(); e.renderScene={applyScheme:applied};
  e.applyCurrentRenderScheme(); expect(applied).toHaveBeenLastCalledWith(null);
  await e.confirmMap();
  expect(e.state.stage).toBe('render');
  expect(applied).toHaveBeenLastCalledWith(e.renderDraft);
});
it('keeps a failed-save candidate intact and an unconfirmed companion unapplied', async () => {
  const e=editor(); candidate(e); const suggestion=e.mapAiSuggestion;
  vi.stubGlobal('fetch', async () => {throw new Error('save failed');});
  await e.applyMapAiPreview();
  expect(e.mapAiSuggestion).toBe(suggestion); expect(e.renderDraft).toBeNull();
  candidate(e); await e.applyMapAiPreview();
  const applied=vi.fn();e.renderScene={applyScheme:applied};
  vi.stubGlobal('fetch', async () => {throw new Error('confirmation failed');});
  await e.confirmMap();
  expect(e.state.map.confirmedAt).toBeFalsy();
  expect(e.state.stage).toBe('map');
  expect(e.renderDraft.renderPlan).toEqual(appearance.renderPlan);
  expect(applied).toHaveBeenLastCalledWith(null);
});
it('allows map save beside a prepared companion, but blocks save for unsaved render editing', async () => {
  const e=editor();candidate(e);await e.applyMapAiPreview();
  const button={disabled:true,title:'',classList:{toggle:()=>{}}};
  e.app={dataset:{},querySelector:(selector:string)=>selector==='#save-map'?button:null,querySelectorAll:()=>[]};
  e.state.dirty=true;
  MapEditor.prototype['updateToolbarState'].call(e);
  expect(button.disabled).toBe(false);
  e.state.stage='render';
  expect(await e.saveMap()).toBe(false);
});
it.each(['undo','redo'])('clears prepared appearance when %s replaces the accepted map', async action => {
  const e=editor();candidate(e);await e.applyMapAiPreview();
  e.state.redoTransaction={label:'Candidate'};
  await e[action==='undo'?'undoLatestTransaction':'redoLatestTransaction']();
  expect(e.plannedRenderDraft).toBe(false);
  expect(e.renderAiPreview).toBe(false);
});
