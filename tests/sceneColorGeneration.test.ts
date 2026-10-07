import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyMap, type MapAsset } from '../src/shared/map';
import { BUILTIN_RENDER_SCHEMES } from '../src/shared/renderScheme';
import { normalizeColorPalette } from '../src/shared/colorPalette';
import { createMapAssetGenerator } from '../src/server/mapAssetGenerator';
import { generateModel, mountModel, replayModel } from '../src/server/modelApi';
import { MapStore } from '../src/server/mapStore';

vi.mock('../src/server/modelApi', () => ({ generateModel: vi.fn(), llmChat: vi.fn(), mountModel: vi.fn(), replayModel: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const scheme = { ...BUILTIN_RENDER_SCHEMES[0], id: 'coordinated', paletteId: undefined, paletteSnapshot: undefined,
  renderPlan: { version: 2 as const, baseSchemeId: 'render-runtime-sketch-mist', modules: [
    { id: 'runtime.material-theme' as const, key: 'wood', scope: { target: 'material-tag' as const, tag: 'wood' }, params: { color: '#805b3d', strength: 0.7 } }
  ] }
};
const model = { format: 2, nodes: [{ id: 'seat', mesh: { type: 'box', params: { width: 2, height: 1, depth: 1 }, material: { color: '#806040' } } }] };
function fixture() {
  const map = createEmptyMap('Harbor');
  map.renderSchemeId = scheme.id;
  const store = { loadMap: vi.fn(async () => map), loadRenderScheme: vi.fn(async () => scheme), listAssets: vi.fn(async () => []),
    saveAsset: vi.fn(async (value) => ({ id: 'new-bench', ...value }) as MapAsset) } as unknown as MapStore;
  vi.mocked(generateModel).mockResolvedValue(model);
  return { map, store };
}

it('gives regular asset generation the confirmed material direction and preserves returned colors instead of snapping them', async () => {
  const { map, store } = fixture();
  const oldPalette = normalizeColorPalette({ name: 'Old', colors: ['#ff00ff', '#00ff00'] });
  const create = createMapAssetGenerator(store, map, [], 'deepseek', oldPalette, new AbortController().signal)!;
  const asset = await create({ name: 'Bench', prompt: 'A wooden bench with an explicitly requested red plaque.', tags: ['bench'], mode: 'voxel-pro' }, () => {});
  const prompt = vi.mocked(generateModel).mock.calls[0][0];
  expect(prompt).toContain('wood');
  expect(prompt).toContain('#805b3d');
  expect(prompt).toContain('explicitly requested red plaque');
  expect(prompt).not.toContain('#ff00ff');
  expect(asset.modelJson).toEqual(model);
});

const appearance = { version: 1 as const, intent: 'Warm plaster and quiet olive timber', materials: [{ role: 'plaster', color: '#bda783', notes: 'matte walls' }], renderPlan: { version: 1 as const, baseSchemeId: 'render-runtime-sketch-mist', modules: [] } };
it('supplies the shared appearance to mounted additions without repainting the source model', async () => {
  const {map,store}=fixture();
  const source={id:'existing-house',name:'House',modelJson:model} as MapAsset;
  vi.mocked(mountModel).mockResolvedValue(model);
  const create=createMapAssetGenerator(store,map,[source],'deepseek',null,new AbortController().signal)!;
  await create({name:'Sign',prompt:'A red wooden sign',tags:[],mode:'voxel-pro',mountOnAssetId:source.id,appearancePlan:appearance},()=>{});
  const [original,prompt]=vi.mocked(mountModel).mock.calls[0];
  expect(original).toEqual(model);
  expect(prompt).toContain(appearance.intent);
  expect(prompt).toContain('red wooden sign');
  expect(generateModel).not.toHaveBeenCalled();
});
it('generates seeded variants from the same appearance-directed source', async () => {
  const {map,store}=fixture();
  vi.mocked(replayModel).mockResolvedValue(model);
  const create=createMapAssetGenerator(store,map,[],'deepseek',null,new AbortController().signal)!;
  const request={name:'House',prompt:'A plaster house',tags:[],mode:'voxel-pro' as const,seedFamilyKey:'homes',variantCount:2,appearancePlan:appearance};
  await create({...request,variantIndex:0},()=>{});
  await create({...request,variantIndex:1},()=>{});
  expect(generateModel).toHaveBeenCalledOnce();
  expect(vi.mocked(generateModel).mock.calls[0][0]).toContain(appearance.intent);
  expect(replayModel).toHaveBeenCalledOnce();
  expect(vi.mocked(replayModel).mock.calls[0][0]).toEqual(model);
});
it('gives an initial companion precedence over the old scheme and palette, once, preserving explicit colors', async () => {
  const {map,store}=fixture();
  const create=createMapAssetGenerator(store,map,[],'deepseek',normalizeColorPalette({name:'Old',colors:['#ff00ff','#00ff00']}),new AbortController().signal)!;
  const result=await create({name:'Wall',prompt:'A plaster wall with an explicitly red plaque.',tags:[],mode:'voxel-pro',appearancePlan:appearance},()=>{});
  const prompt=vi.mocked(generateModel).mock.calls[0][0];
  expect(prompt).toContain(appearance.intent);
  expect(prompt).toContain('#bda783');
  expect(prompt).toContain('explicitly red plaque');
  expect(prompt.match(/Scene appearance direction:/g)).toHaveLength(1);
  expect(prompt).not.toContain('#805b3d');
  expect(store.loadRenderScheme).not.toHaveBeenCalled();
  expect(result.modelJson).toEqual(model);
});
