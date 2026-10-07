import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { addMaterialShaderPatch, removeMaterialShaderPatch } from '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js';

const PATCH = 'worldforge:outdoor-spatial-light';
const RAYS = 40;
const directions = Array.from({ length: RAYS }, (_, i) => {
  const y = 1 - 2 * (i + 0.5) / RAYS;
  const a = i * 2.399963229728653;
  return new THREE.Vector3(Math.cos(a) * Math.sqrt(1 - y * y), y, Math.sin(a) * Math.sqrt(1 - y * y));
});

/** Static geometry used by the lighting bake. Instancing is expanded only here, never in the scene. */
export function buildOutdoorLightingGeometry(root: THREE.Object3D): THREE.BufferGeometry | null {
  // Installed Three r160 stores batch ranges here; it has no getGeometryRangeAt.
  type BatchedMeshR160 = THREE.Mesh & {
    isBatchedMesh: boolean;
    _geometryCount: number;
    _drawRanges: Array<{ start: number; count: number }>;
    getVisibleAt(id: number): boolean;
    getMatrixAt(id: number, target: THREE.Matrix4): THREE.Matrix4 | null;
  };
  root.updateWorldMatrix(true, true);
  const positions: number[] = [];
  const colors: number[] = [];
  const point = new THREE.Vector3();
  const color = new THREE.Color();
  const instanceColor = new THREE.Color();
  const matrix = new THREE.Matrix4();
  const instance = new THREE.Matrix4();
  root.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow || mesh.userData.skipShaderApply) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const position = mesh.geometry?.getAttribute('position');
    if (!position) return;
    const index = mesh.geometry.index;
    const count = index?.count ?? position.count;
    const vertexColor = mesh.geometry.getAttribute('color');
    const drawRange = mesh.geometry.drawRange;
    const groups = Array.isArray(mesh.material) ? mesh.geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    const append = (rangeStart: number, rangeCount: number) => {
      const mirrored = matrix.determinant() < 0;
      for (const group of groups) {
        const material = materials[group.materialIndex ?? 0] as THREE.MeshStandardMaterial;
        if (!material?.isMeshStandardMaterial || !material.visible || material.opacity < 0.8 || (material as THREE.MeshPhysicalMaterial).transmission > 0) continue;
        // Alpha-tested crowns do not occlude as solid boxes in this coarse static bake.
        // Their actual cutouts still cast full-resolution solar shadows.
        if (material.userData.effectVariant?.uniforms?.uFoliageTransmission
          || Object.values(material.userData.effectLayers ?? {}).some(layer => (layer as any)?.uniforms?.uFoliageTransmission)) continue;
        const start = Math.max(0, rangeStart, drawRange.start, group.start);
        const end = Math.min(count, rangeStart + rangeCount, drawRange.start + drawRange.count, group.start + group.count);
        for (let face = start; face + 2 < end; face += 3) {
          for (let corner = 0; corner < 3; corner++) {
            const offset = mirrored && corner > 0 ? 3 - corner : corner;
            const vertex = index ? index.getX(face + offset) : face + offset;
            point.fromBufferAttribute(position, vertex).applyMatrix4(matrix);
            positions.push(point.x, point.y, point.z);
            color.copy(material.color).multiply(instanceColor).multiplyScalar(1 - material.metalness);
            if (material.vertexColors && vertexColor) {
              color.r *= vertexColor.getX(vertex);
              color.g *= vertexColor.getY(vertex);
              color.b *= vertexColor.getZ(vertex);
            }
            colors.push(color.r, color.g, color.b);
          }
        }
      }
    };
    instanceColor.setRGB(1, 1, 1);
    const batched = mesh as BatchedMeshR160;
    if (batched.isBatchedMesh) {
      for (let id = 0; id < batched._geometryCount; id++) {
        if (!batched.getVisibleAt(id) || !batched.getMatrixAt(id, instance)) continue;
        matrix.multiplyMatrices(mesh.matrixWorld, instance);
        const range = batched._drawRanges[id];
        append(range.start, range.count);
      }
    } else {
      const instances = mesh as THREE.InstancedMesh;
      for (let n = 0; n < (instances.isInstancedMesh ? instances.count : 1); n++) {
        matrix.copy(mesh.matrixWorld);
        if (instances.isInstancedMesh) {
          instances.getMatrixAt(n, instance); matrix.multiply(instance);
          if (instances.instanceColor) instances.getColorAt(n, instanceColor);
        }
        append(0, count);
      }
    }
  });
  if (!positions.length) return null;
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    .setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

export interface OutdoorIrradianceSample {
  positive: THREE.Vector3;
  negative: THREE.Vector3;
  bounce: THREE.Vector3;
  bounceX: THREE.Vector3;
  bounceY: THREE.Vector3;
  bounceZ: THREE.Vector3;
}

/** Six sky-visibility lobes and first-order SH moments of single-bounce irradiance. */
export function sampleOutdoorIrradiance(
  bvh: MeshBVH, geometry: THREE.BufferGeometry, origin: THREE.Vector3,
  sunDirection: THREE.Vector3, sunRadiance: THREE.Color, distance = 80,
): OutdoorIrradianceSample {
  const positive = new THREE.Vector3();
  const negative = new THREE.Vector3();
  const weightsPositive = new THREE.Vector3();
  const weightsNegative = new THREE.Vector3();
  const bounce = new THREE.Vector3();
  const bounceX = new THREE.Vector3();
  const bounceY = new THREE.Vector3();
  const bounceZ = new THREE.Vector3();
  const ray = new THREE.Ray(origin, new THREE.Vector3());
  const sunRay = new THREE.Ray(new THREE.Vector3(), sunDirection);
  const vertexColor = geometry.getAttribute('color');
  const color = new THREE.Vector3();
  for (const direction of directions) {
    ray.direction.copy(direction);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0.04, distance);
    // Distant geometry subtends only a narrow cone; nearby walls block the full lobe.
    const visibility = hit ? 0.04 + 0.20 * Math.min(1, hit.distance / 30) : 1;
    for (let axis = 0; axis < 3; axis++) {
      const component = direction.getComponent(axis);
      const weight = Math.abs(component);
      const result = component > 0 ? positive : negative;
      const denominator = component > 0 ? weightsPositive : weightsNegative;
      result.setComponent(axis, result.getComponent(axis) + visibility * weight);
      denominator.setComponent(axis, denominator.getComponent(axis) + weight);
    }
    if (hit?.face && hit.distance < 32) {
      const normal = hit.face.normal.clone();
      // A back-face hit is inside solid geometry and must never become a light source.
      if (normal.dot(direction) >= 0) continue;
      const cosine = Math.max(0, normal.dot(sunDirection));
      let sunlight = 0;
      if (cosine > 0.01) {
        sunRay.origin.copy(hit.point).addScaledVector(normal, 0.06);
        sunlight = bvh.raycastFirst(sunRay, THREE.DoubleSide, 0.02, distance) ? 0 : cosine;
      }
      color.fromBufferAttribute(vertexColor, hit.face.a);
      // 4pi/N solid angle and Lambert's 1/pi give irradiance moments S and B.
      // First-order cosine convolution is S + 2 * dot(B, receiverNormal), with no extra pi.
      color.set(color.x * sunRadiance.r, color.y * sunRadiance.g, color.z * sunRadiance.b)
        .multiplyScalar(sunlight / RAYS);
      bounce.add(color);
      bounceX.addScaledVector(color, direction.x);
      bounceY.addScaledVector(color, direction.y);
      bounceZ.addScaledVector(color, direction.z);
    }
  }
  positive.divide(weightsPositive);
  negative.divide(weightsNegative);
  return { positive, negative, bounce, bounceX, bounceY, bounceZ };
}

/** View-independent environment visibility. Only indirect light is attenuated. */
export class OutdoorSpatialLighting {
  private geometry: THREE.BufferGeometry | null = null;
  private bvh: MeshBVH | null = null;
  private readonly materials = new Set<THREE.Material>();
  private textures: THREE.Data3DTexture[] = [];
  private arrays: Float32Array[] = [];
  private readonly min = new THREE.Vector3();
  private readonly size = new THREE.Vector3();
  private readonly dimensions = new THREE.Vector3();
  private readonly step = new THREE.Vector3();
  private readonly sunDirection = new THREE.Vector3();
  private readonly sunRadiance = new THREE.Color();
  private cursor = 0;
  private total = 0;
  private readonly ready = { value: 0 };

  apply(root: THREE.Object3D, sun: THREE.DirectionalLight, strength: number, occluders = root, diffuseSky: THREE.Texture | null = null): void {
    this.clear();
    this.geometry = buildOutdoorLightingGeometry(occluders);
    if (!this.geometry) return;
    this.bvh = new MeshBVH(this.geometry, { targetLeafSize: 8 });
    this.geometry.computeBoundingBox();
    const bounds = this.geometry.boundingBox!.clone().expandByScalar(3);
    bounds.getSize(this.size);
    this.min.copy(bounds.min);
    const cellSize = Math.max(2, Math.max(this.size.x, this.size.y, this.size.z) / 31);
    this.dimensions.set(...this.size.toArray().map(value => Math.max(4, Math.ceil(value / cellSize) + 1)) as [number, number, number]);
    this.step.copy(this.size).divide(this.dimensions.clone().addScalar(-1));
    this.total = this.dimensions.x * this.dimensions.y * this.dimensions.z;
    this.sunDirection.subVectors(sun.position, sun.target.position).normalize();
    this.sunRadiance.copy(sun.color).multiplyScalar(sun.intensity);
    for (let i = 0; i < 6; i++) {
      const data = new Float32Array(this.total * 4);
      if (i < 2) data.fill(1);
      const halfData = Uint16Array.from(data, value => THREE.DataUtils.toHalfFloat(value));
      const texture = new THREE.Data3DTexture(halfData, this.dimensions.x, this.dimensions.y, this.dimensions.z);
      texture.format = THREE.RGBAFormat;
      texture.type = THREE.HalfFloatType;
      texture.minFilter = texture.magFilter = THREE.LinearFilter;
      texture.unpackAlignment = 1;
      texture.needsUpdate = true;
      this.arrays.push(data);
      this.textures.push(texture);
    }
    const candidates = new Set<THREE.Material>();
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.skipShaderApply) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if ((material as THREE.MeshStandardMaterial)?.isMeshStandardMaterial) candidates.add(material);
      }
    });
    let sceneRoot = root;
    while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
    sceneRoot.traverse(object => {
      let ancestor: THREE.Object3D | null = object;
      while (ancestor && ancestor !== root) ancestor = ancestor.parent;
      if (ancestor) return;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) candidates.delete(material);
    });
    for (const material of candidates) {
        this.materials.add(material);
        addMaterialShaderPatch(material, PATCH, shader => {
          Object.assign(shader.uniforms, {
            uOutdoorVisibilityPositive: { value: this.textures[0] },
            uOutdoorVisibilityNegative: { value: this.textures[1] },
            uOutdoorLocalBounce: { value: this.textures[2] },
            uOutdoorLocalBounceX: { value: this.textures[3] },
            uOutdoorLocalBounceY: { value: this.textures[4] },
            uOutdoorLocalBounceZ: { value: this.textures[5] },
            uOutdoorGridMin: { value: this.min }, uOutdoorGridSize: { value: this.size },
            uOutdoorGridDimensions: { value: this.dimensions }, uOutdoorGridStep: { value: this.step },
            uOutdoorSpatialReady: this.ready, uOutdoorBounceStrength: { value: strength },
          });
          shader.vertexShader = 'varying vec3 vOutdoorLightWorldPosition;\n' + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
            vec4 outdoorLightPosition = vec4(transformed, 1.0);
            #ifdef USE_BATCHING
              outdoorLightPosition = batchingMatrix * outdoorLightPosition;
            #endif
            #ifdef USE_INSTANCING
              outdoorLightPosition = instanceMatrix * outdoorLightPosition;
            #endif
            vOutdoorLightWorldPosition = (modelMatrix * outdoorLightPosition).xyz;`);
          shader.fragmentShader = `varying vec3 vOutdoorLightWorldPosition;
            uniform highp sampler3D uOutdoorVisibilityPositive;
            uniform highp sampler3D uOutdoorVisibilityNegative;
            uniform highp sampler3D uOutdoorLocalBounce;
            uniform highp sampler3D uOutdoorLocalBounceX, uOutdoorLocalBounceY, uOutdoorLocalBounceZ;
            uniform vec3 uOutdoorGridMin, uOutdoorGridSize, uOutdoorGridDimensions, uOutdoorGridStep;
            uniform float uOutdoorSpatialReady, uOutdoorBounceStrength;
            ` + shader.fragmentShader;
          if (diffuseSky) {
            shader.uniforms.uOutdoorDiffuseSky = { value: diffuseSky };
            // r160 fromScene and the quality-2 courtyard cube both use 256px faces:
            // their 768x1024 PMREMs share CUBEUV_MAX_MIP=8 and the same texel macros.
            shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>', `#include <envmap_physical_pars_fragment>
              #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
                uniform sampler2D uOutdoorDiffuseSky;
                vec3 getOutdoorSkyIrradiance( const in vec3 normal ) {
                  vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
                  vec4 skyRadiance = textureCubeUV( uOutdoorDiffuseSky, worldNormal, 1.0 );
                  return PI * skyRadiance.rgb * envMapIntensity;
                }
              #endif`);
            shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_maps>',
              THREE.ShaderChunk.lights_fragment_maps.replace('getIBLIrradiance( geometryNormal )', 'getOutdoorSkyIrradiance( geometryNormal )'));
          }
          shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', `
            vec3 outdoorWorldNormal = inverseTransformDirection(geometryNormal, viewMatrix);
            vec3 outdoorGridPosition = vOutdoorLightWorldPosition + outdoorWorldNormal * uOutdoorGridStep * 0.55;
            vec3 outdoorGridUv = (outdoorGridPosition - uOutdoorGridMin) / uOutdoorGridSize;
            outdoorGridUv = (clamp(outdoorGridUv, 0.0, 1.0) * (uOutdoorGridDimensions - 1.0) + 0.5) / uOutdoorGridDimensions;
            vec3 outdoorPosVis = texture(uOutdoorVisibilityPositive, outdoorGridUv).rgb;
            vec3 outdoorNegVis = texture(uOutdoorVisibilityNegative, outdoorGridUv).rgb;
            vec3 outdoorDirectionalVisibility = mix(outdoorNegVis, outdoorPosVis, step(vec3(0.0), outdoorWorldNormal));
            float outdoorVisibility = mix(1.0, dot(outdoorWorldNormal * outdoorWorldNormal, outdoorDirectionalVisibility), uOutdoorSpatialReady);
            vec3 outdoorBounce = texture(uOutdoorLocalBounce, outdoorGridUv).rgb;
            vec3 outdoorBounceX = texture(uOutdoorLocalBounceX, outdoorGridUv).rgb;
            vec3 outdoorBounceY = texture(uOutdoorLocalBounceY, outdoorGridUv).rgb;
            vec3 outdoorBounceZ = texture(uOutdoorLocalBounceZ, outdoorGridUv).rgb;
            outdoorBounce = max(vec3(0.0), outdoorBounce + 2.0 * (
              outdoorBounceX * outdoorWorldNormal.x + outdoorBounceY * outdoorWorldNormal.y + outdoorBounceZ * outdoorWorldNormal.z
            )) * uOutdoorBounceStrength * uOutdoorSpatialReady;
            #if defined(RE_IndirectDiffuse)
              irradiance = irradiance * outdoorVisibility + outdoorBounce;
              iblIrradiance *= outdoorVisibility;
            #endif
            #if defined(RE_IndirectSpecular)
              radiance *= mix(outdoorVisibility, 1.0, pow(1.0 - material.roughness, 4.0));
            #endif
            #include <lights_fragment_end>`);
        }, { order: 280, cacheKey: () => `outdoor-spatial-light-v2-sh1${diffuseSky ? '-diffuse-sky' : ''}` });
    }
  }

  /** Bound each frame's CPU work so the page remains interactive during the bake. */
  update(budgetMs = 5): void {
    if (!this.bvh || !this.geometry || this.cursor >= this.total) return;
    const start = performance.now();
    const position = new THREE.Vector3();
    do {
      const index = this.cursor++;
      const x = index % this.dimensions.x;
      const y = Math.floor(index / this.dimensions.x) % this.dimensions.y;
      const z = Math.floor(index / (this.dimensions.x * this.dimensions.y));
      position.set(x, y, z).multiply(this.step).add(this.min);
      const sample = sampleOutdoorIrradiance(this.bvh, this.geometry, position, this.sunDirection, this.sunRadiance);
      [sample.positive, sample.negative, sample.bounce, sample.bounceX, sample.bounceY, sample.bounceZ].forEach((value, channel) => {
        value.toArray(this.arrays[channel], index * 4);
      });
    } while (this.cursor < this.total && performance.now() - start < budgetMs);
    if (this.cursor === this.total) {
      this.textures.forEach((texture, channel) => {
        const data = texture.image.data as Uint16Array;
        this.arrays[channel].forEach((value, index) => { data[index] = THREE.DataUtils.toHalfFloat(value); });
        texture.needsUpdate = true;
      });
      this.ready.value = 1;
      this.geometry.dispose();
      this.geometry = null;
      this.bvh = null;
    }
  }

  getProgress(): number { return this.total ? this.cursor / this.total : 1; }

  clear(): void {
    for (const material of this.materials) removeMaterialShaderPatch(material, PATCH);
    this.materials.clear();
    for (const texture of this.textures) texture.dispose();
    this.geometry?.dispose();
    this.geometry = null;
    this.bvh = null;
    this.textures = [];
    this.arrays = [];
    this.cursor = this.total = this.ready.value = 0;
  }
  dispose(): void { this.clear(); }
}
