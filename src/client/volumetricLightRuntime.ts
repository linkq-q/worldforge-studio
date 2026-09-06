import * as THREE from 'three';
import type { EditableMap } from '../shared/map';
import type { RenderedMap } from './mapRenderer';
import type { RuntimeVolumetricLight } from '../shared/renderPlan';
import { isNormalDepthPrePassMesh } from './renderPrePassPolicy';

const SHADOW_SIZE = 32;
const MAX_SOURCES = 16;
type VolumeMesh = THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>;
type VolumeRoots = Partial<Pick<RenderedMap, 'objectGroups' | 'modelsRoot' | 'group'>>;

/** Local single scattering: integrate density through air, not a luminous cone shell. */
export class VolumetricLightRuntime {
  readonly group = new THREE.Group();
  private readonly volumes: VolumeMesh[] = [];

  constructor(_scene: THREE.Scene) {
    this.group.name = 'worldforge-volumetric-light';
    this.group.visible = false;
    this.group.userData.isEnvironmentObject = true;
    this.group.userData.skipShaderApply = true;
    this.group.userData.skipNormalDepthPrePass = true;
  }

  apply(map: EditableMap | null, rendered: VolumeRoots | null, style: RuntimeVolumetricLight): void {
    this.clear();
    if (!map || !rendered?.modelsRoot || !rendered.objectGroups || style.mode === 'off' || style.strength <= 0) return;
    const sources = map.objects.flatMap(object => {
      const light = object.light;
      const anchor = rendered.objectGroups!.get(object.id);
      if (!object.visible || !light?.enabled || light.intensity <= 0 || !anchor) return [];
      const pendant = light.kind === 'point' && /吊灯|chandelier|pendant/i.test(object.name);
      const sideLight = light.kind === 'spot' && /窗|window|冷光/i.test(object.name);
      if (!pendant && !sideLight) return [];
      const rotation = anchor.getWorldQuaternion(new THREE.Quaternion());
      // Match mapLocalLights: offsets rotate but do not scale with the model.
      const position = new THREE.Vector3(...light.offset).applyQuaternion(rotation)
        .add(anchor.getWorldPosition(new THREE.Vector3()));
      const direction = light.target
        ? new THREE.Vector3(...light.target).sub(position).normalize()
        : new THREE.Vector3(...(light.direction ?? [0, -1, 0])).applyQuaternion(rotation).normalize();
      return [{ object, light, position, direction, sideLight }];
    }).slice(0, MAX_SOURCES);
    const pendants = sources.filter(source => !source.sideLight);
    const center = pendants.reduce((sum, source) => sum.add(source.position), new THREE.Vector3())
      .divideScalar(Math.max(1, pendants.length));
    const centralIds = new Set([...pendants].sort((a, b) => (
      a.position.distanceToSquared(center) - b.position.distanceToSquared(center)
      || a.object.id.localeCompare(b.object.id)
    )).slice(0, 4).map(source => source.object.id));
    const occluders = style.occlusion === 'large-geometry'
      ? largeOccluders(rendered.group ?? rendered.modelsRoot) : [];
    rendered.modelsRoot.add(this.group);
    this.group.updateWorldMatrix(true, false);
    for (const source of sources) {
      const length = Math.min(source.light.range, style.length * (source.sideLight ? 1.7 : 1));
      const radius = length * (source.sideLight ? 0.28 : 0.52);
      const sourceStrength = source.sideLight ? style.windowStrength
        : style.fixtureStrength * (centralIds.has(source.object.id) ? 1 : 0.3);
      const density = style.strength * sourceStrength * 0.14 * Math.min(1.5, Math.sqrt(source.light.intensity / 10));
      if (density <= 0 || length <= 0) continue;
      const geometry = new THREE.BoxGeometry(radius * 2, radius * 2, length);
      geometry.translate(0, 0, length / 2);
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(source.light.color) },
          uDensity: { value: density },
          uLength: { value: length },
          uRadius: { value: radius },
          uDust: { value: style.dust },
          uTime: { value: 0 },
          uDepth: { value: null },
          uHasDepth: { value: 0 },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uProjectionInverse: { value: new THREE.Matrix4() },
          uViewToVolume: { value: new THREE.Matrix4() },
          uCameraLocal: { value: new THREE.Vector3() },
          uLightDepth: { value: null },
          uFocused: { value: style.mode === 'shafts' ? 1 : 0 }
        },
        vertexShader: `
          varying vec3 vLocal;
          void main() {
            vLocal = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: VOLUME_FRAGMENT,
        transparent: true,
        depthWrite: false,
        // Scene depth truncates the ray, not the proxy's back face. Also works inside the volume.
        depthTest: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'volumetric-air-' + source.object.id;
      mesh.userData.sourceId = source.object.id;
      mesh.userData.skipShaderApply = true;
      mesh.userData.skipNormalDepthPrePass = true;
      const world = new THREE.Matrix4().compose(source.position,
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), source.direction), new THREE.Vector3(1, 1, 1));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(this.group.matrixWorld).invert().multiply(world);
      this.group.add(mesh);
      mesh.updateWorldMatrix(true, false);
      material.uniforms.uLightDepth.value = lightDepth(mesh, length, radius,
        occluders.filter(item => item.sourceId !== source.object.id).map(item => item.box));
      this.volumes.push(mesh);
    }
    this.group.visible = this.volumes.length > 0;
  }

  bindDepth(depth: THREE.DepthTexture, camera: THREE.PerspectiveCamera, width: number, height: number): void {
    for (const mesh of this.volumes) {
      mesh.updateWorldMatrix(true, false);
      const uniforms = mesh.material.uniforms;
      uniforms.uDepth.value = depth;
      uniforms.uHasDepth.value = 1;
      uniforms.uResolution.value.set(width, height);
      uniforms.uProjectionInverse.value.copy(camera.projectionMatrixInverse);
      uniforms.uViewToVolume.value.copy(mesh.matrixWorld).invert().multiply(camera.matrixWorld);
      uniforms.uCameraLocal.value.setFromMatrixPosition(uniforms.uViewToVolume.value);
    }
  }

  update(elapsedSeconds: number): void {
    for (const mesh of this.volumes) mesh.material.uniforms.uTime.value = elapsedSeconds;
  }

  clear(): void {
    for (const mesh of this.volumes) {
      (mesh.material.uniforms.uLightDepth.value as THREE.DataTexture).dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.volumes.length = 0;
    this.group.clear();
    this.group.removeFromParent();
    this.group.visible = false;
  }

  dispose(): void { this.clear(); }
}

// ponytail: static large-geometry AABBs, not dynamic shadow maps. Rebuilt on scheme/map apply.
// Individual shelf boards are used instead of filling the entire shelf's empty interior.
function largeOccluders(root: THREE.Object3D): Array<{ box: THREE.Box3; sourceId: unknown }> {
  const result: Array<{ box: THREE.Box3; sourceId: unknown }> = [];
  root.updateWorldMatrix(true, true);
  root.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !isNormalDepthPrePassMesh(mesh)) return;
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;
    const instanced = mesh as THREE.InstancedMesh;
    const count = instanced.isInstancedMesh ? instanced.count : 1;
    for (let i = 0; i < count; i++) {
      const matrix = new THREE.Matrix4();
      if (instanced.isInstancedMesh) instanced.getMatrixAt(i, matrix);
      matrix.premultiply(mesh.matrixWorld);
      const box = geometry.boundingBox.clone().applyMatrix4(matrix);
      const dimensions = box.getSize(new THREE.Vector3()).toArray().sort((a, b) => b - a);
      if (dimensions[0] >= 1.2 && dimensions[1] >= 0.4) result.push({ box, sourceId: mesh.userData.mapObjectId });
    }
  });
  return result;
}

function lightDepth(mesh: VolumeMesh, length: number, radius: number, boxes: THREE.Box3[]): THREE.DataTexture {
  const bounds = new THREE.Box3().setFromObject(mesh);
  const origin = new THREE.Vector3().applyMatrix4(mesh.matrixWorld);
  const candidates = boxes.filter(box => box.intersectsBox(bounds) && !box.containsPoint(origin));
  const inverse = mesh.matrixWorld.clone().invert();
  const bytes = new Uint8Array(SHADOW_SIZE * SHADOW_SIZE * 4).fill(255);
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  for (let y = 0; y < SHADOW_SIZE; y++) for (let x = 0; x < SHADOW_SIZE; x++) {
    const dx = ((x + 0.5) / SHADOW_SIZE * 2 - 1) * radius;
    const dy = ((y + 0.5) / SHADOW_SIZE * 2 - 1) * radius;
    // Start at the emitter plane, not at the virtual cone apex behind the lamp.
    const start = new THREE.Vector3(dx * 0.5 / (length + 0.5), dy * 0.5 / (length + 0.5), 0).applyMatrix4(mesh.matrixWorld);
    const endpoint = new THREE.Vector3(dx, dy, length).applyMatrix4(mesh.matrixWorld);
    ray.set(start, endpoint.sub(start).normalize());
    let depth = length;
    for (const box of candidates) {
      if (ray.intersectBox(box, hit)) depth = Math.min(depth, hit.applyMatrix4(inverse).z);
    }
    bytes[(y * SHADOW_SIZE + x) * 4] = Math.round(THREE.MathUtils.clamp(depth / length, 0, 1) * 255);
  }
  const texture = new THREE.DataTexture(bytes, SHADOW_SIZE, SHADOW_SIZE);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const VOLUME_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uDensity, uLength, uRadius, uDust, uTime, uHasDepth, uFocused;
  uniform sampler2D uDepth, uLightDepth;
  uniform vec2 uResolution;
  uniform mat4 uProjectionInverse, uViewToVolume;
  uniform vec3 uCameraLocal;
  varying vec3 vLocal;

  float hash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                   mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                   mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    if (uHasDepth < 0.5) discard;
    vec3 ray = normalize(vLocal - uCameraLocal);
    vec3 safeRay = mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), ray)) * max(abs(ray), vec3(0.00001));
    vec3 a = (vec3(-uRadius, -uRadius, 0.0) - uCameraLocal) / safeRay;
    vec3 b = (vec3( uRadius,  uRadius, uLength) - uCameraLocal) / safeRay;
    vec3 lo = min(a, b), hi = max(a, b);
    float start = max(0.0, max(lo.x, max(lo.y, lo.z)));
    float end = min(hi.x, min(hi.y, hi.z));
    vec2 uv = gl_FragCoord.xy / uResolution;
    float depth = texture2D(uDepth, uv).x;
    vec4 view = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec3 surface = (uViewToVolume * vec4(view.xyz / view.w, 1.0)).xyz;
    float surfaceDistance = dot(surface - uCameraLocal, ray);
    end = min(end, surfaceDistance);
    if (end <= start) discard;
    // Fixed work, no frame-varying dither or full-beam brightness animation.
    float stepLength = (end - start) / 24.0;
    float opticalDepth = 0.0;
    for (int i = 0; i < 24; i++) {
      float distanceAlongRay = start + (float(i) + 0.5) * stepLength;
      vec3 p = uCameraLocal + ray * distanceAlongRay;
      float coneRadius = uRadius * (p.z + 0.5) / (uLength + 0.5);
      float r = length(p.xy) / max(coneRadius, 0.001);
      float radial = exp(-mix(2.2, 4.0, uFocused) * r * r) * (1.0 - smoothstep(0.6, 1.0, r));
      float ends = smoothstep(0.05, 0.65, p.z) * (1.0 - smoothstep(uLength * 0.42, uLength, p.z));
      vec2 lightUv = p.xy / max(coneRadius, 0.001) * 0.5 + 0.5;
      float blocker = texture2D(uLightDepth, clamp(lightUv, 0.0, 1.0)).r * uLength;
      float shadow = 1.0 - smoothstep(blocker - 0.25, blocker + 0.05, p.z);
      float surfaceFade = smoothstep(0.0, 0.3, surfaceDistance - distanceAlongRay);
      float air = 1.0 + (noise(p * 0.65 + vec3(uTime * 0.018, 0.0, -uTime * 0.011)) - 0.5) * uDust * 0.5;
      opticalDepth += radial * ends * shadow * surfaceFade * air * stepLength * uDensity;
    }
    float phase = 0.8 + 0.2 * pow(max(0.0, -ray.z), 2.0);
    gl_FragColor = vec4(uColor, (1.0 - exp(-opticalDepth)) * phase);
  }
`;
