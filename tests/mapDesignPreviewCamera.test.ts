import * as THREE from 'three';
import {afterEach, expect, it, vi} from 'vitest';
import {MapEditor} from '../src/client/mapEditor';
import {createEmptyMap} from '../src/shared/map';
import {applyMapOperations} from '../src/shared/mapOperations';

vi.mock('../src/client/mapDraftStore',async(importOriginal)=>({
  ...await importOriginal<typeof import('../src/client/mapDraftStore')>(),loadBrowserMapPlan:vi.fn(async()=>null)
}));

vi.mock('../src/client/mapDesignConversation',()=>({
  MapDesignSessionClient:class { constructor(_request:unknown,public hooks:any){} connect=vi.fn(async()=>{});invalidateDraft=vi.fn(); },
  MapDesignConversation:class {render(){}}
}));
afterEach(()=>vi.unstubAllGlobals());
function fixture(existingWorld=false) {
  vi.stubGlobal('localStorage',{getItem:()=>null});
  vi.stubGlobal('location',{protocol:'http:',hostname:'localhost',origin:'http://localhost'});
  const e=new MapEditor({dataset:{},querySelector:(s:string)=>s==='#map-design-panel'?{}:null} as unknown as HTMLElement) as any;
  const base=createEmptyMap('blank');
  const world=applyMapOperations(base,[{type:'world.set',world:{assets:[],bundle:{plan:{version:1,id:'new-world',revision:1,
    prompt:'a river valley',recipe:{version:1,seed:1,size:640,constraints:[{region:'center',biome:'grassland'}]},ecology:[],roads:[],towns:[]},patches:[]}}}]);
  e.state.map=existingWorld?world:base;
  e.camera=new THREE.PerspectiveCamera(50,1.6,.1,1500);
  e.camera.position.set(7,3,5);
  e.orbit={target:new THREE.Vector3(0,1.5,0),update:vi.fn()};
  e.renderPanels=e.updateToolbarState=()=>{};
  let resolve!:()=>void;
  const rendering=new Promise<void>(done=>{resolve=done;});
  e.refreshScene=vi.fn(()=>rendering);
  e.syncDesignConversation();
  const draft=(revision:number)=>({session:{id:'design-new-world',mapId:base.id,draftRevision:revision},map:world,suggestion:null});
  return {e,draft,resolve,hooks:e.designClient.hooks};
}
it('frames the first complete world preview from an ordinary map, including recovery at a later draft revision',async()=>{
  const {e,draft,resolve,hooks}=fixture();
  await hooks.draft(draft(4));
  expect(e.camera.position.y).toBe(3);
  resolve();await Promise.resolve();
  expect(e.camera.position.y).toBeGreaterThan(200);
  expect(e.orbit.target.x).toBe(0);
  expect(e.orbit.target.z).toBe(0);
  const framed=e.camera.position.clone(),target=e.orbit.target.clone();
  await hooks.draft(draft(5));await Promise.resolve();
  expect(e.camera.position.equals(framed)).toBe(true);
  expect(e.orbit.target.equals(target)).toBe(true);
  e.camera.position.set(9,10,11);e.orbit.target.set(4,5,6);
  await hooks.draft(draft(6));await Promise.resolve();
  expect(e.camera.position.toArray()).toEqual([9,10,11]);
  expect(e.orbit.target.toArray()).toEqual([4,5,6]);
});
it('does not overwrite camera movement while the first world preview is rendering or on later revisions',async()=>{
  const {e,draft,resolve,hooks}=fixture();
  await hooks.draft(draft(1));
  e.camera.position.set(90,40,30);e.orbit.target.set(20,0,20);
  resolve();await Promise.resolve();
  expect(e.camera.position.toArray()).toEqual([90,40,30]);
  await hooks.draft(draft(2));await Promise.resolve();
  expect(e.camera.position.toArray()).toEqual([90,40,30]);
});
it('frames only the latest complete draft when another revision arrives during rendering',async()=>{
  const {e,draft,resolve,hooks}=fixture();
  await hooks.draft(draft(1));
  await hooks.draft(draft(2));
  resolve();await Promise.resolve();
  expect(e.camera.position.y).toBeGreaterThan(200);
  expect(e.orbit.update).toHaveBeenCalledTimes(1);
});
it('preserves the camera for existing worlds and for a map switched before the draft finishes',async()=>{
  const existing=fixture(true);
  await existing.hooks.draft(existing.draft(1));existing.resolve();await Promise.resolve();
  expect(existing.e.camera.position.toArray()).toEqual([7,3,5]);
  const changed=fixture();
  await changed.hooks.draft(changed.draft(1));changed.e.state.map={...createEmptyMap(),id:'other-map'};
  changed.resolve();await Promise.resolve();
  expect(changed.e.camera.position.toArray()).toEqual([7,3,5]);
});

it('frames a restored world preview again after leaving and returning to its saved map',async()=>{
  const {e,draft,resolve,hooks}=fixture(), original=e.state.map, other=createEmptyMap('other');
  e.designClient.disconnect=vi.fn();
  e.confirmLeaveDirtyMap=async()=>true;
  e.prepareBrowserMapDraftRecovery=async()=>null;
  for(const name of ['cancelAssetPlacement','retainHydratedMapAssets','clearMapAiPreview','resetRenderDraft','resetManualHistory']) e[name]=()=>{};
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/transactions')
    ? {transaction:null,redoTransaction:null}: {map:url.endsWith(other.id)?other:original}),{status:200})));
  await hooks.draft(draft(1));resolve();await Promise.resolve();
  expect(e.camera.position.y).toBeGreaterThan(200);
  await e.loadMap(other.id);
  e.camera.position.set(9,3,5);e.orbit.target.set(0,1,0);
  await e.loadMap(original.id);
  await hooks.draft(draft(1));await Promise.resolve();
  expect(e.camera.position.y).toBeGreaterThan(200);
});

it('frames the rendered mountain heights instead of assuming a height proportional to world width',()=>{
  const {e,draft}=fixture(true), map=draft(1).map;
  const group=new THREE.Group();
  const geometry=new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-320,-390,-320),new THREE.Vector3(320,801,320)
  ]);
  group.add(new THREE.Mesh(geometry));
  e.renderedMap={group};
  e.frameMap(map,new THREE.Vector3(0,0,1));
  e.camera.updateMatrixWorld();
  for(const point of [new THREE.Vector3(-320,-390,-320),new THREE.Vector3(320,801,320)]) {
    const projected=point.project(e.camera);
    expect(Math.abs(projected.y)).toBeLessThan(1);
    expect(projected.z).toBeLessThan(1);
  }
  expect(e.orbit.target.y).toBeCloseTo((801-390)/2);
  geometry.dispose();
});
