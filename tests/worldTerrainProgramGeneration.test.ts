import {beforeEach, describe, expect, it, vi} from 'vitest';
import {generateTerrainOnlyWorld} from '../src/server/worldTerrainProgramGeneration';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MapStore} from '../src/server/mapStore';
import {handleMapHttp} from '../src/server/mapHttp';
import {worldMapSampler} from '../src/shared/worldMapState';
const mocks = vi.hoisted(() => ({llmChat: vi.fn(), recordGenerationTrace: vi.fn()}));
vi.mock('../src/server/modelApi', async original => ({
  ...await original<typeof import('../src/server/modelApi')>(), llmChat: mocks.llmChat
}));
vi.mock('../src/server/generationTrace', async original => ({
  ...await original<typeof import('../src/server/generationTrace')>(), recordGenerationTrace: mocks.recordGenerationTrace
}));
const request = {mode:'terrain-only', representation:'program', prompt:'Connected mountains and tributary canyons',seed:47,size:500};
describe('application terrain-only AI', () => {
  beforeEach(() => vi.clearAllMocks());
  it('uses one model response, preserves its code, and creates no objects or settlement plan', async () => {
    const program = 'function generate(t){t.map((x,z)=>40+10*t.noise(x,z,60)); t.inspect("final");}';
    mocks.llmChat.mockResolvedValue(JSON.stringify({program, constraints:[{region:'center',biome:'grassland'}]}));
    const result = await generateTerrainOnlyWorld(request);
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.llmChat.mock.calls[0][1].maxAttempts).toBe(1);
    expect(result.bundle.plan.recipe.terrainProgram?.source).toBe(program);
    expect(result.bundle.plan.ecology).toEqual([]);
    expect(result.bundle.plan.towns).toEqual([]);
    expect(result.bundle.plan.roads).toEqual([]);
    expect(result.bundle.patches).toEqual([]);
    expect(result.paidCallCount).toBe(1);
    expect(result.terrainEvidence.heightRange[0]).toBeGreaterThan(20);
  });
  it('exposes the original recipe route for comparison with the same request and one call', async () => {
    mocks.llmChat.mockResolvedValue(JSON.stringify({terrain:{version:1,seed:47,size:500,
      reliefProfile:'compact',heightScale:0.1,constraints:[{region:'center',biome:'mountains'}]}}));
    const result = await generateTerrainOnlyWorld({...request,representation:'recipe'});
    expect(result.bundle.plan.recipe.terrainProgram).toBeUndefined();
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
  });
  it('archives raw failed code and never asks the model to repair it', async () => {
    const raw = JSON.stringify({program:'function generate(t){t.map(()=>NaN)}',constraints:[{region:'center',biome:'grassland'}]});
    mocks.llmChat.mockResolvedValue(raw);
    await expect(generateTerrainOnlyWorld(request)).rejects.toThrow();
    expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    expect(mocks.recordGenerationTrace).toHaveBeenCalledWith('world.terrain-only.raw', expect.objectContaining({content:raw}));
  });
  it('passes through the real HTTP dispatcher, saves one transaction, reloads and undoes the same field', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-program-'));
    const store = new MapStore({rootDir});
    const server = http.createServer((req,res) => {
      void handleMapHttp(req,res,store).catch(error => {res.writeHead(500);res.end(String(error));});
    });
    await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
    try {
      mocks.llmChat.mockResolvedValue(JSON.stringify({program:'function generate(t){t.map((x,z)=>50-x*0.1+z*0.02)}',constraints:[{region:'center',biome:'grassland'}]}));
      const base = `http://127.0.0.1:${(server.address() as {port:number}).port}/api/editor`;
      const post = (url:string,body:unknown) => fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const generated = await post('/worlds/generate',request);
      expect(generated.status).toBe(200);
      const {bundle} = await generated.json();
      const {map} = await (await post('/maps',{name:'Terrain program HTTP test'})).json();
      const committed = await post(`/maps/${map.id}/transactions`,{source:'agent',operations:[{type:'world.set',world:{bundle,assets:[]}}]});
      expect(committed.status).toBe(200);
      const loaded = await new MapStore({rootDir}).loadMap(map.id);
      expect(worldMapSampler(loaded.world!)(20,50).height).toBeCloseTo(49,5);
      expect((await store.undoTransaction(map.id)).map.world).toBeUndefined();
      expect((await store.redoTransaction(map.id)).map.world).toEqual(loaded.world);
      expect(mocks.llmChat).toHaveBeenCalledTimes(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      await rm(rootDir,{recursive:true,force:true});
    }
  });
});
