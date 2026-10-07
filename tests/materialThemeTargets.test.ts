import * as THREE from 'three';
import { RuntimeIndex } from '@voxel-studio/render-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMaterialThemeSelector } from '../src/client/materialThemeTargets';
import { buildEditableMapGroup } from '../src/client/mapRenderer';
import { RenderSceneRuntime } from '../src/client/renderSceneRuntime';
import { RenderRuntimeAdapter } from '../src/client/renderRuntimeAdapter';
import { createEmptyMap, createMapObject, type MapAsset } from '../src/shared/map';

describe('material theme structured part selection', () => {
  it('uses effective tags and asset ownership for individual slots in shared batches', () => {
    const map = createEmptyMap('tags', 'tags', [16, 4, 16]);
    map.objects = ['tree', 'house'].map(id => ({ ...createMapObject(id), id, assetId: id }));
    const asset = (id: string): MapAsset => ({
      id, name: id, prompt: '', mode: 'test', createdAt: 0, updatedAt: 0,
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 0, candidateCount: 0, fallbackUsed: true },
      modelJson: { nodes: [
        { id: 'root', tags: [{ tag: 'base', value: 'wood' }] },
        { id: 'body', parent: 'root', mesh: {} },
        { id: 'leaf', parent: 'root', tags: [{ tag: 'foliage', value: 'leaf' }], mesh: {} }
      ] }
    });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 4);
    const index = new RuntimeIndex();
    index.registerInstancedBatch('shared', mesh, ['tree:body', 'tree:leaf', 'house:body', 'house:leaf']);
    const root = new THREE.Group(); root.add(mesh);
    const select = createMaterialThemeSelector(index, map, new Map(['tree', 'house'].map(id => [id, asset(id)])), candidate => [candidate.id]);
    expect(select({ target: 'material-tag', tag: 'wood' }).get(mesh)).toEqual(new Set([0, 2]));
    expect(select({ target: 'material-tag', tag: 'base:wood' }).get(mesh)).toEqual(new Set([0, 2]));
    expect(select({ target: 'material-tag', tag: 'foliage' }).get(mesh)).toEqual(new Set([1, 3]));
    expect(select({ target: 'asset-tag', tag: 'tree' }).get(mesh)).toEqual(new Set([0, 1]));
    expect(select({ target: 'material-tag', tag: 'stone' }).get(mesh)).toEqual(new Set());
    const late = new THREE.InstancedMesh(mesh.geometry, mesh.material, 1);
    root.add(late);
    index.registerInstancedBatch('late', late, ['tree:leaf']);
    expect(select({ target: 'material-tag', tag: 'foliage' }).get(late)).toEqual(new Set([0]));
  });

  afterEach(() => vi.unstubAllGlobals());

  it('exposes actual rendered map batch slots to the material theme runtime', async () => {
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => null }) });
    const map = createEmptyMap('theme map', 'theme-map', [16, 4, 16]);
    map.assets = [{
      id: 'tree', name: 'tree', prompt: '', mode: 'test', createdAt: 0, updatedAt: 0,
      colliderPlan: { version: 1, boxes: [], sourceMeshCount: 2, candidateCount: 0, fallbackUsed: true },
      modelJson: { nodes: ['trunk', 'leaf'].map((id, i) => ({
        id, tags: [{ tag: i ? 'foliage' : 'base', value: i ? 'leaf' : 'wood' }],
        mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, material: { color: i ? 0x0000ff : 0xff0000 } }
      })) }
    }];
    map.objects = [{ ...createMapObject('tree'), id: 'tree', assetId: 'tree' }];
    const rendered = await buildEditableMapGroup(map, { terrainTextureSize: 64 });
    try {
      const selector = (rendered as unknown as { selectMaterialThemeTargets: ReturnType<typeof createMaterialThemeSelector> }).selectMaterialThemeTargets;
      expect(selector).toBeTypeOf('function');
      const leaves = selector({ target: 'material-tag', tag: 'foliage' });
      const leaf = rendered.runtimeIndex.getRenderRef('tree:leaf')!;
      const trunk = rendered.runtimeIndex.getRenderRef('tree:trunk')!;
      expect(leaves.get(leaf.object as THREE.Mesh)).toContain(leaf.instanceId);
      expect(leaves.get(trunk.object as THREE.Mesh)?.has(trunk.instanceId!)).toBe(false);
      const runtimeAdapter = Object.create(RenderRuntimeAdapter.prototype) as RenderRuntimeAdapter;
      Object.assign(runtimeAdapter, {
        scene: new THREE.Scene(), modelsRoot: null, contentRoot: rendered.group,
        materialBaselines: new Map(), materialThemeBindings: new Map(), waterBindings: [], waterInteractionAt: new Map(),
        effectRuntime: { removeFromObject3D() {} }
      });
      const sceneRuntime = Object.create(RenderSceneRuntime.prototype) as RenderSceneRuntime;
      Object.assign(sceneRuntime, {
        adapter: runtimeAdapter, meshRegistry: new Map(), volumetricLight: null,
        syncAtmosphereFx() {}, indexRenderedMeshes() {}, applySurfaceCapabilities() {}
      });
      sceneRuntime.attach(rendered);
      (runtimeAdapter as unknown as { applyMaterialTheme(theme: unknown): void }).applyMaterialTheme({
        key: 'leaf', scope: { target: 'material-tag', tag: 'foliage' }, recipe: 'natural', color: '#00ff00'
      });
      const leafMesh = leaf.object as THREE.InstancedMesh;
      const authored = new THREE.Color(); leafMesh.getColorAt(leaf.instanceId!, authored);
      expect(authored.multiply((leafMesh.material as THREE.MeshStandardMaterial).color).getHex()).toBe(0x00ff00);
      runtimeAdapter.resetScopedCapabilities();
    } finally { rendered.dispose(); }
  });
});
