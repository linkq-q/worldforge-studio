import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AIPrimitiveBatcher, RuntimeIndex } from '@voxel-studio/render-runtime';
import { RenderRuntimeAdapter } from '../src/client/renderRuntimeAdapter';
import { compileRuntimeMaterialThemes, type RenderPlan, type RuntimeMaterialTheme } from '../src/shared/renderPlan';

function adapter(root: THREE.Group, select?: (scope: RuntimeMaterialTheme['scope']) => Map<THREE.Mesh, Set<number> | null>) {
  const result = Object.create(RenderRuntimeAdapter.prototype) as RenderRuntimeAdapter;
  Object.assign(result, {
    modelsRoot: root, materialBaselines: new Map(), materialThemeBindings: new Map(),
    selectMaterialThemeTargets: select, waterBindings: [], waterInteractionAt: new Map(),
    waterDetailTexture: null, waterSceneCapture: null,
    effectRuntime: { removeFromObject3D() {} }
  });
  return result;
}

function apply(runtime: RenderRuntimeAdapter, overrides: Partial<RuntimeMaterialTheme> = {}) {
  (runtime as unknown as { applyMaterialTheme(theme: RuntimeMaterialTheme): void }).applyMaterialTheme({
    key: 'color', scope: { target: 'scene' }, recipe: 'natural', color: '#00ff00', ...overrides
  });
}

function effectiveInstance(mesh: THREE.InstancedMesh, slot: number) {
  const color = new THREE.Color();
  mesh.getColorAt(slot, color);
  return color.multiply((mesh.material as THREE.MeshStandardMaterial).color);
}

function realBatch() {
  const root = new THREE.Group();
  const index = new RuntimeIndex();
  const batcher = new AIPrimitiveBatcher({ runtimeIndex: index });
  batcher.resetScene(root);
  batcher.reset();
  for (const [id, color] of [['wood', 0xff0000], ['leaf', 0x0000ff]] as const) {
    const part = {
      id, isGroup: false, tags: [], offset: { x: 0, y: 0, z: 0 },
      position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
      scale: { x: 1, y: 1, z: 1 },
      mesh: { type: 'box', geometry: { width: 1, height: 1, depth: 1 }, material: { color } }
    };
    batcher.stagePart(part, batcher.canBatch(part, { modelId: 'tree' }), 'tree');
  }
  batcher.compile('tree', new THREE.Group());
  return { root, index, batcher, mesh: batcher.getInstancedMeshes()[0] as THREE.InstancedMesh };
}

describe('render material theme effective base colors', () => {
  it('reaches the target on real primitive batches and restores authored instance colors', () => {
    const { root, batcher, mesh } = realBatch();
    expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xffffff);
    expect(effectiveInstance(mesh, 0).getHex()).toBe(0xff0000);
    const sourceMaterial = mesh.material;
    const sourceColors = mesh.instanceColor;
    const runtime = adapter(root);
    apply(runtime);
    expect(effectiveInstance(mesh, 0).getHex()).toBe(0x00ff00);
    expect(effectiveInstance(mesh, 1).getHex()).toBe(0x00ff00);
    expect(sourceColors?.getX(0)).toBe(1);
    runtime.resetScopedCapabilities();
    expect(mesh.material).toBe(sourceMaterial);
    expect(mesh.instanceColor).toBe(sourceColors);
    expect(effectiveInstance(mesh, 0).getHex()).toBe(0xff0000);
    batcher.dispose();
  });

  it('changes only selected batch slots with linear intensity and no cumulative drift', () => {
    const { root, batcher, mesh } = realBatch();
    const runtime = adapter(root, () => new Map([[mesh, new Set([0])]]));
    apply(runtime, { scope: { target: 'material-tag', tag: 'wood' }, strength: 0.5 });
    expect(effectiveInstance(mesh, 0).r).toBeCloseTo(0.5);
    expect(effectiveInstance(mesh, 0).g).toBeCloseTo(0.5);
    expect(effectiveInstance(mesh, 1).getHex()).toBe(0x0000ff);
    apply(runtime, { scope: { target: 'material-tag', tag: 'wood' }, strength: 0.5 });
    expect(effectiveInstance(mesh, 0).r).toBeCloseTo(0.5);
    runtime.resetScopedCapabilities();
    batcher.dispose();
  });

  it('mixes vertex base colors while preserving shared geometry, material and alpha', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute([1, 0, 0, 0.3, 0, 0, 1, 0.8], 4));
    const material = new THREE.MeshStandardMaterial({ color: '#808080', vertexColors: true, roughness: 0.23, metalness: 0.67 });
    const target = new THREE.Mesh(geometry, material);
    target.userData.materialTags = ['wood'];
    const other = new THREE.Mesh(geometry, material);
    const root = new THREE.Group(); root.add(target, other);
    const runtime = adapter(root);
    apply(runtime, { scope: { target: 'material-tag', tag: 'wood' }, strength: 0.5 });
    const colors = target.geometry.getAttribute('color');
    expect(colors.getX(0) * (target.material as THREE.MeshStandardMaterial).color.r).toBeCloseTo(0.10793, 4);
    expect(colors.getY(0) * (target.material as THREE.MeshStandardMaterial).color.g).toBeCloseTo(0.5);
    expect(colors.getW(0)).toBeCloseTo(0.3);
    expect(other.material).toBe(material); expect(other.geometry).toBe(geometry);
    expect(geometry.getAttribute('color').getX(0)).toBe(1);
    expect((target.material as THREE.MeshStandardMaterial).roughness).toBe(0.23);
    expect((target.material as THREE.MeshStandardMaterial).metalness).toBe(0.67);
    runtime.resetScopedCapabilities();
    expect(target.geometry).toBe(geometry); expect(target.material).toBe(material);
  });

  it('keeps scalar mesh mixing and recipe defaults while isolating shared source materials', () => {
    const material = new THREE.MeshStandardMaterial({ color: '#ff0000', roughness: 0.23, metalness: 0.67 });
    const target = new THREE.Mesh(new THREE.BoxGeometry(), material);
    target.userData.assetTags = ['building'];
    const other = new THREE.Mesh(target.geometry, material);
    const root = new THREE.Group(); root.add(target, other);
    const runtime = adapter(root);
    apply(runtime, { scope: { target: 'asset-tag', tag: 'building' }, strength: 0.5, roughness: 0.83 });
    expect((target.material as THREE.MeshStandardMaterial).color.r).toBeCloseTo(0.5);
    expect((target.material as THREE.MeshStandardMaterial).color.g).toBeCloseTo(0.5);
    expect((target.material as THREE.MeshStandardMaterial).roughness).toBeCloseTo(0.53);
    expect((target.material as THREE.MeshStandardMaterial).metalness).toBe(0.67);
    expect(material.color.getHex()).toBe(0xff0000);
    runtime.resetScopedCapabilities();
    apply(runtime, { scope: { target: 'asset-tag', tag: 'building' }, color: undefined, recipe: 'polished' });
    expect((target.material as THREE.MeshStandardMaterial).roughness).toBe(0.24);
    runtime.resetScopedCapabilities();
  });

  it('selects only tagged geometry slots on Three r160 BatchedMesh', () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial({ color: '#ff0000' });
    const mesh = new THREE.BatchedMesh(2, 48, 72, material);
    const selected = mesh.addGeometry(geometry), untouched = mesh.addGeometry(geometry);
    const root = new THREE.Group(); root.add(mesh);
    const runtime = adapter(root, () => new Map([[mesh, new Set([selected])]]));
    apply(runtime, { scope: { target: 'material-tag', tag: 'wood' } });
    const ids = mesh.geometry.getAttribute('batchId'), colors = mesh.geometry.getAttribute('color');
    expect(colors).toBeDefined();
    for (let i = 0; i < ids.count; i++) {
      if (ids.getX(i) === selected) expect(colors.getY(i)).toBeCloseTo(1);
      if (ids.getX(i) === untouched) expect(colors.getX(i)).toBeCloseTo(1);
    }
    runtime.resetScopedCapabilities();
    expect(mesh.material).toBe(material);
    expect(mesh.geometry.getAttribute('color')).toBeUndefined();
    mesh.dispose();
  });

  it('restores compare mode exactly and reapplies source-based colors to late meshes under modelsRoot', () => {
    const { root, batcher, mesh } = realBatch();
    const runtime = adapter(root);
    const outside = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#ff0000' }));
    const original = mesh.instanceColor;
    const theme: RuntimeMaterialTheme = { key: 'color', scope: { target: 'scene' }, recipe: 'natural', color: '#00ff00', strength: 0.5 };
    runtime.applyScopedCapabilities([theme], [], []);
    expect(effectiveInstance(mesh, 0).g).toBeCloseTo(0.5);
    runtime.resetScopedCapabilities();
    expect(mesh.instanceColor).toBe(original);
    expect(effectiveInstance(mesh, 0).getHex()).toBe(0xff0000);
    const late = new THREE.InstancedMesh(mesh.geometry, new THREE.MeshStandardMaterial(), 1);
    late.setColorAt(0, new THREE.Color('#0000ff'));
    root.add(late);
    Object.assign(runtime, { selectMaterialThemeTargets: () => new Map([[outside, null]]) });
    runtime.applyScopedCapabilities([theme], [], []);
    expect(effectiveInstance(mesh, 0).g).toBeCloseTo(0.5);
    expect(effectiveInstance(late, 0).b).toBeCloseTo(0.5);
    expect(effectiveInstance(late, 0).g).toBeCloseTo(0.5);
    expect((outside.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000);
    runtime.applyScopedCapabilities([], [], []);
    expect(effectiveInstance(late, 0).getHex()).toBe(0x0000ff);
    batcher.dispose();
  });

  it('preserves explicit recipe physics when coordination adds a color, while pure color rules leave physics alone', () => {
    const material = new THREE.MeshStandardMaterial({ color: '#ff0000', roughness: 0.23, metalness: 0.67 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.userData.materialTags = ['metal'];
    const root = new THREE.Group(); root.add(mesh);
    const runtime = adapter(root);
    const plan: RenderPlan = { version: 2, baseSchemeId: 'test', modules: [{
      id: 'runtime.material-theme', scope: { target: 'material-tag', tag: 'metal' },
      params: { recipe: 'weathered', strength: 0.5 }
    }] };
    runtime.applyScopedCapabilities(compileRuntimeMaterialThemes(plan), [], []);
    expect((mesh.material as THREE.MeshStandardMaterial).roughness).toBeCloseTo(0.585);
    expect((mesh.material as THREE.MeshStandardMaterial).metalness).toBeCloseTo(0.525);
    const coordinated: RenderPlan = { ...plan, modules: [{ ...plan.modules[0], params: { ...plan.modules[0].params, color: '#00ff00' } }] };
    runtime.applyScopedCapabilities(compileRuntimeMaterialThemes(coordinated), [], []);
    expect((mesh.material as THREE.MeshStandardMaterial).roughness).toBeCloseTo(0.585);
    expect((mesh.material as THREE.MeshStandardMaterial).metalness).toBeCloseTo(0.525);
    const colorOnly: RenderPlan = { ...plan, modules: [{ ...plan.modules[0], params: { color: '#00ff00', strength: 0.5 } }] };
    runtime.applyScopedCapabilities(compileRuntimeMaterialThemes(colorOnly), [], []);
    expect((mesh.material as THREE.MeshStandardMaterial).roughness).toBe(0.23);
    expect((mesh.material as THREE.MeshStandardMaterial).metalness).toBe(0.67);
    runtime.resetScopedCapabilities();
  });
});
