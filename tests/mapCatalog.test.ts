import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MapStore } from '../src/server/mapStore';
import { mapCatalog, MapCatalogStore } from '../src/server/mapCatalog';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive:true, force:true }))); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldforge-catalog-')); roots.push(root);
  const maps = new MapStore({ rootDir:root }); return { maps, catalog:mapCatalog(maps) };
}
it('moves existing maps together without modifying map versions, contents or undo history', async () => {
  const { maps, catalog } = await setup();
  const one = await maps.createMap({ name:'旧地图一' }); const two = await maps.createMap({ name:'旧地图二' });
  const changed = await maps.commitTransaction(one.id, { source:'manual', operations:[{ type:'object.add', object:{ name:'保留的物体', assetId:null } }] });
  const folder = await catalog.saveFolder({ name:'历史场景' });
  await catalog.move([one.id,two.id], folder.id);
  expect((await catalog.read()).membership).toEqual({ [one.id]:folder.id,[two.id]:folder.id });
  expect(await maps.loadMap(one.id)).toEqual(changed.map);
  expect(await maps.getUndoTransaction(one.id)).toEqual(changed.transaction);
  expect((await new MapCatalogStore(maps).read()).membership[one.id]).toBe(folder.id);
  await catalog.move([one.id],null);
  expect((await catalog.read()).membership[one.id]).toBeUndefined();
});
it('validates nested folders and makes invalid bulk moves atomic', async () => {
  const { maps,catalog } = await setup(); const map=await maps.createMap();
  const parent=await catalog.saveFolder({name:'实验'}); const child=await catalog.saveFolder({name:'机场',parentId:parent.id});
  await expect(catalog.saveFolder({id:parent.id,name:'实验',parentId:child.id})).rejects.toThrow('folder_cycle');
  await expect(catalog.saveFolder({name:'机场',parentId:parent.id})).rejects.toThrow('duplicate_folder_name');
  await expect(catalog.move([map.id,'missing'],child.id)).rejects.toThrow('unknown_map');
  expect((await catalog.read()).membership).toEqual({});
  await Promise.all([catalog.saveFolder({name:'山村'}),catalog.saveFolder({name:'湿地'})]);
  expect((await catalog.read()).folders).toHaveLength(4);
});
