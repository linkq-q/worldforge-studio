import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createEmptyMap, type MapAsset} from '../src/shared/map';
import {createMapAssetGenerator} from '../src/server/mapAssetGenerator';
import type {MapStore} from '../src/server/mapStore';

const model={format:2,nodes:[{id:'wall',mesh:{type:'box',params:{width:2,height:2,depth:1},material:{color:'#bda783'}}}]};
const request={name:'House',prompt:'A plaster house',tags:['house'],mode:'voxel-pro' as const};
const result=()=>new Response(`data: ${JSON.stringify({stage:'result',done:true,modelJson:model})}\n\n`);
let globalFetch: ReturnType<typeof vi.fn>;
beforeEach(()=> {
  globalFetch=vi.fn(async()=>{throw new Error('unexpected default transport');});
  vi.stubGlobal('fetch',globalFetch);
});
afterEach(()=>vi.unstubAllGlobals());
function generator(fetchImpl?: typeof fetch, assets: MapAsset[] = []) {
  const store={saveAsset:vi.fn(async(value)=>({id:'saved-asset',...value}))} as unknown as MapStore;
  return createMapAssetGenerator(store,createEmptyMap(),assets,'deepseek',null,new AbortController().signal,fetchImpl)!;
}

it('routes every ordinary generation retry through the injected HTTP transport', async()=> {
  const transport=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('busy',{status:503})).mockImplementation(async()=>result());
  const asset=await generator(transport)(request,()=>{});
  expect(transport).toHaveBeenCalledTimes(2);
  for(const [url,init] of transport.mock.calls) {
    expect(String(url)).toMatch(/\/api\/generate\/model$/);
    expect(JSON.parse(String(init?.body))).toMatchObject({description:request.prompt,provider:'deepseek'});
  }
  expect(asset.modelJson).toEqual(model);
  expect(globalFetch).not.toHaveBeenCalled();
});

it('routes the seeded source and every variant replay retry through the same transport', async()=> {
  const transport=vi.fn<typeof fetch>()
    .mockImplementationOnce(async()=>result())
    .mockResolvedValueOnce(new Response(JSON.stringify({ok:false,error:'temporary'}),{status:503}))
    .mockImplementation(async()=>new Response(JSON.stringify({ok:true,modelJson:model})));
  const create=generator(transport);
  const family={...request,seedFamilyKey:'homes',variantCount:2};
  await create({...family,variantIndex:0},()=>{});
  await create({...family,variantIndex:1},()=>{});
  expect(transport).toHaveBeenCalledTimes(3);
  expect(String(transport.mock.calls[0][0])).toMatch(/\/api\/generate\/model$/);
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).seeded).toBe(true);
  for(const [url,init] of transport.mock.calls.slice(1)) {
    expect(String(url)).toMatch(/\/api\/generate\/replay$/);
    expect(JSON.parse(String(init?.body)).modelJson).toEqual(model);
  }
  expect(globalFetch).not.toHaveBeenCalled();
});

it('routes mounted additions through the injected transport and keeps the source model', async()=> {
  const source={id:'source-house',modelJson:model} as MapAsset;
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({ok:true,modelJson:model})));
  await generator(transport,[source])({...request,mountOnAssetId:source.id},()=>{});
  expect(transport).toHaveBeenCalledTimes(1);
  expect(String(transport.mock.calls[0][0])).toMatch(/\/api\/mount$/);
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({primary:model,provider:'deepseek'});
  expect(globalFetch).not.toHaveBeenCalled();
});

it('preserves the default fetch path for existing callers that omit the transport', async()=> {
  globalFetch.mockImplementation(async()=>result());
  await generator()(request,()=>{});
  expect(globalFetch).toHaveBeenCalledTimes(1);
});
