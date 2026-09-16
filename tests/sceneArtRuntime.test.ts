import * as THREE from 'three';
import { RuntimeIndex } from '@voxel-studio/render-runtime';
import { describe, expect, it } from 'vitest';
import { SceneArtRuntime, createColorFieldTexture } from '../src/client/sceneArtRuntime';
import { createEmptyMap, createMapObject } from '../src/shared/map';
import { compileSceneArt, type SceneArtPlan } from '../src/shared/sceneArt';
import { buildMapLocalLights } from '../src/client/mapLocalLights';
import { discoverMapCodeAssets, buildMapCodePlannerSystemPrompt } from '../src/server/mapCodePlanner';
import { compileRuntimeGrassStyle } from '../src/shared/renderPlan';
import { buildMapGrassField } from '../src/client/mapGrassRenderer';
import { applyMapOperations } from '../src/shared/mapOperations';

const empty = (): SceneArtPlan => ({ colors: [], lights: [], surfaces: [], wet: [] });
function fixture() {
  const map = createEmptyMap('art', 'art', [16, 4, 16]);
  map.objects = ['one', 'two'].map(id => ({ ...createMapObject(id), id }));
  const modelsRoot = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff' });
  const mesh = new THREE.InstancedMesh(geometry, material, 2);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-2, 0, 0));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(2, 0, 0));
  modelsRoot.add(mesh);
  const runtimeIndex = new RuntimeIndex();
  runtimeIndex.registerInstancedBatch('batch', mesh, ['one:body', 'two:body']);
  const terrain = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), new THREE.MeshStandardMaterial());
  return { map, modelsRoot, mesh, geometry, material, runtimeIndex, terrain, grassRoot: null };
}

describe('scene art runtime', () => {
  it('isolates one instance and restores the original geometry/material on clear', () => {
    const options = fixture();
    const art = new SceneArtRuntime();
    art.apply({ ...empty(), surfaces: [{ objectId: 'one', color: '#ff0000', roughness: 0.2 }] }, options);
    const mask = options.mesh.geometry.getAttribute('wfArtMask0');
    expect(mask.getX(0)).toBe(1);
    expect(mask.getX(1)).toBe(0);
    expect(options.mesh.material).not.toBe(options.material);
    expect(options.geometry.getAttribute('wfArtMask0')).toBeUndefined();
    expect(options.material.color.getHexString()).toBe('ffffff');
    art.clear();
    expect(options.mesh.material).toBe(options.material);
    expect(options.mesh.geometry).toBe(options.geometry);
  });

  it('rejects nonexistent targets and does not color neighboring parts instead', () => {
    const options = fixture(), art = new SceneArtRuntime();
    expect(() => art.apply({ ...empty(), surfaces: [{ objectId: 'missing', color: '#ff0000' }] }, options)).toThrow('unknown_scene_art_object');
    expect(() => art.apply({ ...empty(), surfaces: [{ objectId: 'one', partId: 'missing' }] }, options)).toThrow('surface_not_found');
    expect(options.mesh.material).toBe(options.material);
  });

  it('also isolates geometry slots in a heterogeneous batched mesh', () => {
    const options = fixture(), art = new SceneArtRuntime();
    const geometry = new THREE.BoxGeometry();
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('batchId', new THREE.BufferAttribute(Float32Array.from({ length: count }, (_, i) => i < count / 2 ? 3 : 7), 1));
    const mesh = new THREE.Mesh(geometry, options.material);
    options.modelsRoot.add(mesh);
    options.runtimeIndex.partToRender.clear();
    options.runtimeIndex.partToRender.set('one:body', Object.assign({ mode: 'batched', object: mesh }, { geometryId: 3 }));
    options.runtimeIndex.partToRender.set('two:body', Object.assign({ mode: 'batched', object: mesh }, { geometryId: 7 }));
    art.apply({ ...empty(), surfaces: [{ objectId: 'one', color: '#ff0000' }] }, options);
    const mask = mesh.geometry.getAttribute('wfArtMask0');
    expect(mask.getX(0)).toBe(1);
    expect(mask.getX(count - 1)).toBe(0);
    art.clear();
    expect(mesh.geometry).toBe(geometry);
  });

  it('creates shared world-space fields with feathered edges and no map mutation', () => {
    const { map } = fixture();
    map.visualSemantics.zones = [{ id: 'shore', center: [0, 0], radius: 4, tags: ['grass'], intensity: 1 }];
    const before = JSON.stringify(map);
    const fields = compileSceneArt({ version: 2, baseSchemeId: 'x', modules: [{ id: 'runtime.color-field', params: { config: JSON.stringify({ zoneId: 'shore', start: -4, end: 4, stops: [[0, '#000000'], [1, '#ffffff']] }) } }] }).colors;
    const texture = createColorFieldTexture(map, fields);
    const data = texture.image.data as Uint8Array;
    expect(data[3]).toBe(0);
    expect(data[(64 * 128 + 64) * 4 + 3]).toBe(255);
    expect(data[(64 * 128 + 80) * 4]).toBeGreaterThan(data[(64 * 128 + 48) * 4]);
    expect(JSON.stringify(map)).toBe(before);
    texture.dispose();
  });

  it('compiles expressions after base patches and keeps emission before output', () => {
    const options = fixture(), art = new SceneArtRuntime();
    art.apply({ ...empty(), surfaces: [{ objectId: 'one', colorExpression: 'color * (0.8 + 0.2 * sin(time))', emissionExpression: 'vec3(0.2)' }] }, options);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
    (options.mesh.material as THREE.Material).onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute vec4 wfArtMask0');
    expect(shader.fragmentShader).toContain('wf_time');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance +=');
    art.update(20);
    expect(shader.uniforms.wfArtTime.value).toBe(20);
    art.clear();
  });

  it('honors an explicit grass ramp instead of blending it back to the preset', () => {
    const style = compileRuntimeGrassStyle({ version: 2, baseSchemeId: 'x', modules: [{ id: 'runtime.grass-style', params: { rootColor: '#ff0000', tipColor: '#ff0000', rootDarken: 1, colorStops: '[[0,"#ff0000"],[0.3,"#00ff00"],[1,"#0000ff"]]' } }] });
    expect(style.colorMode).toBe('explicit');
    const map = applyMapOperations(createEmptyMap('grass', 'grass'), [{ type: 'grass.layer.add', layer: { id: 'lawn', preset: 'magic' } }, { type: 'grass.fill', layerId: 'lawn', density: 0.3 }]);
    const field = buildMapGrassField(map, style)!;
    const mesh = field.group.children.find(o => o.userData.grassBladeCount) as THREE.Mesh;
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
    (mesh.material as THREE.Material).onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain('vec3(1.000000,0.000000,0.000000)');
    expect(shader.fragmentShader).toContain('0.300000');
    field.setStyle(compileRuntimeGrassStyle({ version: 2, baseSchemeId: 'x', modules: [] }));
    const restored = field.group.children.find(o => o.userData.grassBladeCount) as THREE.Mesh;
    const restoredShader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
    (restored.material as THREE.Material).onBeforeCompile(restoredShader, {} as THREE.WebGLRenderer);
    expect(restoredShader.fragmentShader).not.toContain('wfGrassRamp');
    field.dispose();
  });

  it('keeps emitter metadata through Scene Code discovery', () => {
    const map = createEmptyMap('lamps', 'lamps');
    const discovery = discoverMapCodeAssets(`function plan(api) { const lamp=api.requireAsset({key:'lamp',name:'路灯',prompt:'standing lamp',light:{kind:'point',color:'#ffd878',intensity:5,range:9,offset:[0,2,0]}}); api.place({assetId:api.asset(lamp),position:[0,0]}); }`, map);
    expect(discovery[0].light).toMatchObject({ kind: 'point', intensity: 5, offset: [0, 2, 0] });
    expect(buildMapCodePlannerSystemPrompt(map, [])).toContain('bright geometry or emissive tags alone');
  });

  it('places lamp offsets through the full instance scale and transform', () => {
    const { map } = fixture();
    map.objects[0].light = { kind: 'point', color: '#ffd878', intensity: 5, range: 9, offset: [0, 2, 0], enabled: true, role: 'practical', castShadow: false, shadowMapSize: 512, shadowBias: 0, shadowNormalBias: 0, shadowRadius: 1 };
    const group = new THREE.Group(); group.scale.setScalar(2); group.position.set(0, 1, 0);
    const lights = buildMapLocalLights(map, new Map([['one', group]]));
    const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 8, 15); camera.lookAt(0, 4, 0);
    lights.update(camera);
    expect((lights.group.children.find(o => (o as THREE.PointLight).isPointLight) as THREE.PointLight).position.y).toBe(5);
  });

  it('rolls back all material changes when a later requested surface is unsupported', () => {
    const options = fixture(), art = new SceneArtRuntime();
    expect(() => art.apply({ ...empty(), surfaces: [{ objectId: 'one', transmission: 0.9 }] }, options)).toThrow('requires_glass');
    expect(options.mesh.material).toBe(options.material);
    expect(options.mesh.geometry).toBe(options.geometry);
  });
});
