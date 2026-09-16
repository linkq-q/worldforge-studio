import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { RuntimeIndex } from '@voxel-studio/render-runtime';
import { addMaterialShaderPatch } from '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js';
import { sampleTerrainHeight, type EditableMap } from '../shared/map';
import { visualZoneWeight } from '../shared/visualDirection';
import { sampleColorRamp, type SceneArtPlan, type SurfaceDetail, type ColorField } from '../shared/sceneArt';
import { compileSimpleShaderExpression } from '../shared/simpleShader';
import { nearestPaletteColor, type ColorPalette } from '../shared/colorPalette';

interface ArtOptions {
  map: EditableMap;
  modelsRoot: THREE.Group;
  terrain: THREE.Mesh;
  grassRoot: THREE.Group | null;
  runtimeIndex: RuntimeIndex;
  renderer?: THREE.WebGLRenderer;
}
interface MeshRestore { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[]; geometry: THREE.BufferGeometry; clones: THREE.Material[] }
type Selection = Map<THREE.Mesh, Set<number> | null>;
const reflectorShader = (Reflector as unknown as { ReflectorShader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string } }).ReflectorShader;

/** Render-only overrides. Never mutates source assets, persisted map state or shared materials. */
export class SceneArtRuntime {
  readonly time = { value: 0 };
  private restores: MeshRestore[] = [];
  private textures: THREE.Texture[] = [];
  private reflector: Reflector | null = null;
  private reflectionTime: { value: number } | null = null;

  apply(plan: SceneArtPlan, options: ArtOptions, palette?: ColorPalette): void {
    validateSceneArtTargets(plan, options.map);
    this.clear();
    try { this.applyRules(plan, options, palette); }
    catch (error) { this.clear(); throw error; }
  }

  private applyRules(plan: SceneArtPlan, options: ArtOptions, palette?: ColorPalette): void {
    const selections = plan.surfaces.map(rule => selectArtParts(options.runtimeIndex, options.modelsRoot, rule));
    for (const [i, selection] of selections.entries()) if (!selection.size) throw new Error(`scene_art_surface_not_found:${plan.surfaces[i].objectId}`);
    const targets = new Set<THREE.Mesh>(selections.flatMap(selection => [...selection.keys()]));
    const groundFields = plan.colors.filter(f => f.target !== 'grass');
    const grassFields = plan.colors.filter(f => f.target !== 'terrain');
    const groundTexture = groundFields.length ? createColorFieldTexture(options.map, groundFields, palette) : null;
    const grassTexture = grassFields.length ? createColorFieldTexture(options.map, grassFields, palette) : null;
    if (groundTexture) { targets.add(options.terrain); this.textures.push(groundTexture); }
    const grassMeshes = new Set<THREE.Mesh>();
    if (grassTexture) {
      this.textures.push(grassTexture);
      options.grassRoot?.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh && mesh.userData.grassBladeCount) { targets.add(mesh); grassMeshes.add(mesh); }
      });
    }
    for (const mesh of targets) {
      if (mesh.userData.isModelWater || mesh.userData.isWater || mesh.userData.editorHelper) throw new Error('scene_art_requires_standard_surface');
      const rules = plan.surfaces.flatMap((rule, i) => selections[i].has(mesh) ? [{ rule, slots: selections[i].get(mesh)! }] : []);
      const sourceMaterial = mesh.material, sourceGeometry = mesh.geometry;
      const sources = Array.isArray(sourceMaterial) ? sourceMaterial : [sourceMaterial];
      if (sources.some(source => (source as THREE.ShaderMaterial).isShaderMaterial)) throw new Error('scene_art_requires_standard_surface');
      if (rules.some(r => r.rule.roughness !== undefined || r.rule.metalness !== undefined) && sources.some(source => !(source instanceof THREE.MeshStandardMaterial))) throw new Error('scene_art_pbr_parameters_require_pbr_surface');
      if (rules.some(r => r.rule.transmission !== undefined) && sources.some(source => !(source instanceof THREE.MeshPhysicalMaterial))) throw new Error('scene_art_transmission_requires_glass');
      if (rules.length) {
        mesh.geometry = sourceGeometry.clone();
        writeSelectionAttributes(mesh, rules.map(r => r.slots));
      }
      const field = grassMeshes.has(mesh) ? grassTexture : mesh === options.terrain ? groundTexture : null;
      const clones = sources.map(source => {
        // Keep the original material's runtime-owned uniforms/patches alive; append only our fixed template.
        const material = source.clone();
        if (rules.some(r => r.rule.transmission !== undefined)) {
          const physical = material as THREE.MeshPhysicalMaterial;
          physical.transmission = Math.max(0.0001, physical.transmission);
        }
        material.userData = { ...source.userData, shaderPatchChain: [] };
        addMaterialShaderPatch(material, 'scene-art-base', (shader, renderer) => source.onBeforeCompile(shader, renderer), { order: 0, cacheKey: () => source.customProgramCacheKey() });
        addMaterialShaderPatch(material, 'scene-art', shader => patchSceneArtShader(shader, rules.map(r => r.rule), field, options.map.box.size, this.time, grassMeshes.has(mesh), palette, source.userData.grassUniforms?.uGrassRootColor?.value, (source as THREE.MeshPhysicalMaterial).transmission), { order: 1000, cacheKey: () => JSON.stringify(rules.map(r => r.rule)) + Boolean(field) });
        return material;
      });
      mesh.material = Array.isArray(sourceMaterial) ? clones : clones[0];
      this.restores.push({ mesh, material: sourceMaterial, geometry: sourceGeometry, clones });
    }
    if (plan.wet[0] && options.renderer) this.createWetSurface(plan.wet[0], options);
  }

  update(elapsed: number): void {
    this.time.value = elapsed % 3600;
    if (this.reflectionTime) this.reflectionTime.value = this.time.value;
  }

  clear(): void {
    for (const entry of this.restores) {
      entry.mesh.material = entry.material;
      if (entry.mesh.geometry !== entry.geometry) entry.mesh.geometry.dispose();
      entry.mesh.geometry = entry.geometry;
      entry.clones.forEach(material => material.dispose());
    }
    this.restores = [];
    this.textures.forEach(texture => texture.dispose());
    this.textures = [];
    if (this.reflector) {
      this.reflector.removeFromParent();
      this.reflector.getRenderTarget().dispose();
      this.reflector.geometry.dispose();
      (this.reflector.material as THREE.Material).dispose();
      this.reflector = null;
    }
    this.reflectionTime = null;
  }

  private createWetSurface(rule: SceneArtPlan['wet'][number], options: ArtOptions): void {
    const zone = options.map.visualSemantics.zones.find(z => z.id === rule.zoneId)!;
    const mask = createColorFieldTexture(options.map, [{ zoneId: zone.id, target: 'terrain', axis: 'x', center: [0, 0], start: 0, end: 1, feather: 0.3, strength: 1, stops: [[0, '#ffffff'], [1, '#ffffff']] }]);
    this.textures.push(mask);
    const [width, , depth] = options.map.box.size;
    const level = sampleTerrainHeight(options.map, zone.center[0], zone.center[1]);
    // One capture per scene, not one full-scene render per puddle. Sloping terrain needs a different surface representation.
    for (let z = -depth / 2; z <= depth / 2; z += depth / 32) for (let x = -width / 2; x <= width / 2; x += width / 32) {
      if (visualZoneWeight(zone, x, z) > 0.1 && Math.abs(sampleTerrainHeight(options.map, x, z) - level) > 0.12) {
        throw new Error('wet_surface_requires_flat_zone');
      }
    }
    this.reflectionTime = { value: 0 };
    const shader = {
      uniforms: { ...THREE.UniformsUtils.clone(reflectorShader.uniforms), wfMask: { value: mask }, wfTime: this.reflectionTime, wfStrength: { value: rule.strength }, wfDistortion: { value: rule.distortion } },
      vertexShader: reflectorShader.vertexShader.replace('varying vec4 vUv;', 'varying vec4 vUv; varying vec2 wfRoadUv;').replace('vUv = textureMatrix', 'wfRoadUv = uv; vUv = textureMatrix'),
      fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D wfMask; uniform float wfTime; uniform float wfStrength; uniform float wfDistortion;
        varying vec4 vUv; varying vec2 wfRoadUv;
        void main() {
          float mask = texture2D(wfMask, wfRoadUv).a;
          if (mask < 0.01) discard;
          vec2 offset = vec2(sin(wfRoadUv.y*180.0+wfTime),cos(wfRoadUv.x*170.0-wfTime))*wfDistortion;
          vec3 reflected = texture2D(tDiffuse, vUv.xy/vUv.w + offset).rgb;
          gl_FragColor = vec4(reflected, mask*wfStrength);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    };
    const reflector = new Reflector(new THREE.PlaneGeometry(width, depth), { textureWidth: 512, textureHeight: 512, clipBias: 0.003, shader });
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.y = level + 0.012;
    reflector.name = 'scene-art-wet-surface';
    reflector.userData.skipShaderApply = true;
    reflector.userData.skipNormalDepthPrePass = true;
    const helpers: THREE.Object3D[] = [];
    options.modelsRoot.parent?.traverse(object => {
      if (object.userData.editorHelper || object.userData.isEditorObject || object.userData.isHelper) helpers.push(object);
    });
    const reflect = reflector.onBeforeRender;
    reflector.onBeforeRender = (...args) => {
      const previous = helpers.map(object => object.visible);
      helpers.forEach(object => { object.visible = false; });
      try { reflect.apply(reflector, args); } finally { helpers.forEach((object, i) => { object.visible = previous[i]; }); }
    };
    (reflector.material as THREE.Material).transparent = true;
    (reflector.material as THREE.Material).depthWrite = false;
    options.modelsRoot.add(reflector);
    this.reflector = reflector;
  }
}

export function validateSceneArtTargets(plan: SceneArtPlan, map: EditableMap): void {
  const objects = new Set(map.objects.filter(o => o.visible).map(o => o.id));
  const zones = new Set(map.visualSemantics.zones.map(z => z.id));
  for (const rule of [...plan.surfaces, ...plan.lights]) if (!objects.has(rule.objectId)) throw new Error(`unknown_scene_art_object:${rule.objectId}`);
  for (const rule of plan.lights) if (rule.targetId && !objects.has(rule.targetId)) throw new Error(`unknown_scene_art_target:${rule.targetId}`);
  for (const rule of [...plan.colors, ...plan.wet]) if (rule.zoneId && !zones.has(rule.zoneId)) throw new Error(`unknown_scene_art_zone:${rule.zoneId}`);
}

export function selectArtParts(index: RuntimeIndex, root: THREE.Group, rule: SurfaceDetail): Selection {
  const result: Selection = new Map();
  for (const [id, ref] of index.partToRender) {
    if (!(rule.partId ? id === `${rule.objectId}:${rule.partId}` : id.startsWith(`${rule.objectId}:`))) continue;
    const mesh = ref.object as THREE.Mesh;
    if (!mesh?.isMesh) continue;
    const slot = ref.mode === 'batched' ? (ref as { geometryId?: number }).geometryId : ref.instanceId;
    if (slot === undefined) result.set(mesh, null);
    else {
      if (!result.has(mesh)) result.set(mesh, new Set());
      result.get(mesh)?.add(slot);
    }
  }
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.userData.mapObjectId === rule.objectId && !mesh.userData.editorHelper && (!rule.partId || mesh.userData.partId === rule.partId || mesh.userData.nodeId === rule.partId)) {
      if (!result.has(mesh)) result.set(mesh, null);
    }
  });
  return result;
}

function writeSelectionAttributes(mesh: THREE.Mesh, selections: Array<Set<number> | null>): void {
  const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh;
  const count = instanced ? (mesh as THREE.InstancedMesh).count : mesh.geometry.getAttribute('position').count;
  const batches = mesh.geometry.getAttribute('batchId');
  for (let group = 0; group < Math.ceil(selections.length / 4); group++) {
    const values = new Float32Array(count * 4);
    for (let vertex = 0; vertex < count; vertex++) for (let channel = 0; channel < 4; channel++) {
      const selection = selections[group * 4 + channel];
      const slot = instanced ? vertex : batches ? batches.getX(vertex) : undefined;
      values[vertex * 4 + channel] = selection === null || (slot !== undefined && selection?.has(slot)) ? 1 : 0;
    }
    mesh.geometry.setAttribute(`wfArtMask${group}`, instanced ? new THREE.InstancedBufferAttribute(values, 4) : new THREE.BufferAttribute(values, 4));
  }
}

export function createColorFieldTexture(map: EditableMap, fields: ColorField[], palette?: ColorPalette): THREE.DataTexture {
  const resolution = 128;
  const data = new Uint8Array(resolution * resolution * 4);
  const prepared = fields.map(field => ({ ...field, stops: palette ? field.stops.map(([at, hex]): [number, string] => [at, nearestPaletteColor(palette, hex)]) : field.stops }));
  for (let zi = 0; zi < resolution; zi++) for (let xi = 0; xi < resolution; xi++) {
    const x = ((xi + 0.5) / resolution - 0.5) * map.box.size[0];
    const z = (0.5 - (zi + 0.5) / resolution) * map.box.size[2];
    const value = new THREE.Color(0, 0, 0);
    let alpha = 0;
    for (const field of prepared) {
      const zone = field.zoneId ? map.visualSemantics.zones.find(zone => zone.id === field.zoneId) : undefined;
      const weight = Math.min(1, field.strength * (zone ? visualZoneWeight(zone, x, z, field.feather) : 1));
      const coordinate = field.axis === 'x' ? x : field.axis === 'z' ? z : Math.hypot(x - field.center[0], z - field.center[1]);
      const hex = sampleColorRamp(field.stops, (coordinate - field.start) / (field.end - field.start));
      const color = new THREE.Color(hex);
      const nextAlpha = weight + alpha * (1 - weight);
      if (nextAlpha > 0) value.multiplyScalar(alpha * (1 - weight)).add(color.multiplyScalar(weight)).multiplyScalar(1 / nextAlpha);
      alpha = nextAlpha;
    }
    const offset = (zi * resolution + xi) * 4;
    data[offset] = Math.round(value.r * 255); data[offset + 1] = Math.round(value.g * 255); data[offset + 2] = Math.round(value.b * 255); data[offset + 3] = Math.round(alpha * 255);
  }
  const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RGBAFormat);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function patchSceneArtShader(shader: THREE.WebGLProgramParametersWithUniforms, rules: SurfaceDetail[], field: THREE.Texture | null, size: number[], time: { value: number }, grass: boolean, palette?: ColorPalette, grassRootColor?: THREE.Color, baseTransmission = 0): void {
  const masks = Array.from({ length: Math.ceil(rules.length / 4) }, (_, i) => i);
  const declarations = 'varying vec3 wfArtPosition; varying vec3 wfArtNormal; varying vec2 wfArtUv;' + masks.map(i => `varying vec4 vWfArtMask${i};`).join('');
  shader.uniforms.wfArtTime = time;
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${declarations}\n${masks.map(i => `attribute vec4 wfArtMask${i};`).join('')}`)
    .replace('#include <project_vertex>', `
      vec4 wfWorld = ${grass ? 'vec4(0.0, 0.0, 0.0, 1.0)' : 'vec4(transformed, 1.0)'}; vec3 wfN = normal;
      #ifdef USE_BATCHING
        wfWorld = batchingMatrix * wfWorld; wfN = mat3(batchingMatrix) * wfN;
      #endif
      #ifdef USE_INSTANCING
        wfWorld = instanceMatrix * wfWorld; wfN = mat3(instanceMatrix) * wfN;
      #endif
      wfArtPosition = (modelMatrix * wfWorld).xyz; wfArtNormal = mat3(modelMatrix) * wfN; wfArtUv = uv;
      ${masks.map(i => `vWfArtMask${i} = wfArtMask${i};`).join('')}
      #include <project_vertex>`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${declarations}\nuniform float wfArtTime;${field ? 'uniform sampler2D wfArtField; uniform vec3 wfArtGrassRoot;' : ''}`);
  let body = `vec3 wf_color = diffuseColor.rgb; vec3 wf_position = wfArtPosition; vec3 wf_normal = wfArtNormal / max(length(wfArtNormal),0.0001); vec2 wf_uv = wfArtUv; float wf_time = wfArtTime;`;
  if (field) {
    shader.uniforms.wfArtField = { value: field };
    shader.uniforms.wfArtGrassRoot = { value: grassRootColor ?? new THREE.Color('#466638') };
    body += `vec4 wfField = texture2D(wfArtField,vec2(wfArtPosition.x/${size[0].toFixed(6)}+0.5,0.5-wfArtPosition.z/${size[2].toFixed(6)})); diffuseColor.rgb = mix(diffuseColor.rgb,wfField.rgb${grass ? ' * clamp(diffuseColor.rgb / max(wfArtGrassRoot,vec3(0.02)),vec3(0.0),vec3(2.0))' : ''},wfField.a); wf_color = diffuseColor.rgb;`;
  }
  for (const [i, rule] of rules.entries()) {
    const weight = `vWfArtMask${Math.floor(i / 4)}.${'xyzw'[i % 4]}`;
    if (rule.color) body += `diffuseColor.rgb = mix(diffuseColor.rgb,${glColor(palette ? nearestPaletteColor(palette, rule.color) : rule.color)},${weight}); wf_color = diffuseColor.rgb;`;
    if (rule.colorExpression) body += `diffuseColor.rgb = mix(diffuseColor.rgb,clamp(${compileSimpleShaderExpression(rule.colorExpression)},vec3(0.0),vec3(2.0)),${weight}); wf_color=diffuseColor.rgb;`;
    for (const [key, anchor, variable] of [['roughness', 'roughnessmap_fragment', 'roughnessFactor'], ['metalness', 'metalnessmap_fragment', 'metalnessFactor']] as const) {
      if (rule[key] !== undefined) shader.fragmentShader = shader.fragmentShader.replace(`#include <${anchor}>`, `#include <${anchor}>\n${variable}=mix(${variable},${rule[key]!.toFixed(6)},${weight});`);
    }
    if (rule.emissionExpression) {
      const expression = `clamp(${compileSimpleShaderExpression(rule.emissionExpression)},vec3(0.0),vec3(2.0))*${weight}`;
      shader.fragmentShader = shader.fragmentShader.includes('#include <emissivemap_fragment>')
        ? shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += ${expression};`)
        : shader.fragmentShader.replace('#include <opaque_fragment>', `outgoingLight += ${expression};\n#include <opaque_fragment>`);
    }
  }
  const transmissionRules = rules.flatMap((rule, i) => rule.transmission === undefined ? [] : [`material.transmission=mix(material.transmission,${rule.transmission.toFixed(6)},vWfArtMask${Math.floor(i / 4)}.${'xyzw'[i % 4]});`]);
  if (transmissionRules.length) shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment.replace('material.transmission = transmission;', `material.transmission = ${baseTransmission.toFixed(6)};\n${transmissionRules.join('\n')}`));
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${body}`);
}

function glColor(hex: string): string { return `vec3(${new THREE.Color(hex).toArray().map(v => v.toFixed(6)).join(',')})`; }
