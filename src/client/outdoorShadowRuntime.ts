import * as THREE from 'three';
import { addMaterialShaderPatch, removeMaterialShaderPatch } from '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js';

const PATCH_KEY = 'worldforge:outdoor-contact-shadow';

/** Optional PCSS for the outdoor sun; other lights retain their original shadow filtering. */
export class OutdoorShadowRuntime {
  private readonly materials = new Set<THREE.Material>();
  private sun: THREE.DirectionalLight | null = null;
  private readonly sunDirection = { value: new THREE.Vector3() };
  private readonly inverseShadow = { value: new THREE.Matrix4() };
  private readonly metrics = { value: new THREE.Vector3() };
  private readonly softness = { value: 0.5 };

  apply(root: THREE.Object3D | null, sun: THREE.DirectionalLight, softness: number, shadowQuality = 1): void {
    this.clear();
    if (!root || !sun.castShadow) return;
    this.sun = sun;
    this.softness.value = THREE.MathUtils.clamp(softness, 0, 1);
    const receiverPlane = shadowQuality >= 2;
    this.update();
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (let current: THREE.Object3D | null = object; current; current = current.parent) {
        if (current.userData.isWater || current.userData.isEnvironmentObject
          || current.userData.skipShaderApply || current.userData.isHelper || current.userData.isEditorObject) return;
        if (current === root) break;
      }
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (/^Mesh(Standard|Physical|Phong|Lambert)Material$/.test(material.type)) this.materials.add(material);
      }
    });
    let sceneRoot = root;
    while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
    sceneRoot.traverse(object => {
      let ancestor: THREE.Object3D | null = object;
      while (ancestor && ancestor !== root) ancestor = ancestor.parent;
      if (ancestor) return;
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.materials.delete(material);
    });
    for (const material of this.materials) {
      addMaterialShaderPatch(material, PATCH_KEY, shader => {
        if (!shader.fragmentShader.includes('#include <lights_fragment_begin>')) return;
        shader.uniforms.uOutdoorPcssSunDirection = this.sunDirection;
        shader.uniforms.uOutdoorPcssInverseShadow = this.inverseShadow;
        shader.uniforms.uOutdoorPcssMetrics = this.metrics;
        shader.uniforms.uOutdoorPcssSoftness = this.softness;
        shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>',
          `#include <shadowmap_pars_fragment>\n${PCSS_FRAGMENT(receiverPlane)}`);
        const lights = THREE.ShaderChunk.lights_fragment_begin.replace(
          'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )',
          'getOutdoorSunShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ], directionalLight.direction )'
        );
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', lights);
      }, { order: 350, cacheKey: () => receiverPlane ? `${PATCH_KEY}:receiver-plane` : PATCH_KEY });
    }
  }

  update(): void {
    if (!this.sun) return;
    const sun = this.sun;
    this.sunDirection.value.copy(sun.getWorldPosition(new THREE.Vector3()))
      .sub(sun.target.getWorldPosition(new THREE.Vector3())).normalize();
    sun.shadow.updateMatrices(sun);
    this.inverseShadow.value.copy(sun.shadow.matrix).invert();
    const camera = sun.shadow.camera;
    this.metrics.value.set(1 / Math.max(camera.right - camera.left, 0.001),
      1 / Math.max(camera.top - camera.bottom, 0.001), camera.far - camera.near);
  }

  clear(): void {
    for (const material of this.materials) removeMaterialShaderPatch(material, PATCH_KEY);
    this.materials.clear();
    this.sun = null;
  }

  dispose(): void { this.clear(); }
}

const PCSS_FRAGMENT = (receiverPlane: boolean) => /* glsl */`
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
  uniform vec3 uOutdoorPcssSunDirection, uOutdoorPcssMetrics;
  uniform mat4 uOutdoorPcssInverseShadow;
  uniform float uOutdoorPcssSoftness;

  vec2 outdoorShadowDisc(int i, float count, float angle) {
    float a = float(i) * 2.39996323 + angle;
    return vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / count);
  }

  float outdoorShadowDepth(sampler2D map, vec2 uv) {
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 1.0;
    return unpackRGBAToDepth(texture2D(map, uv));
  }

  ${receiverPlane ? /* glsl */`
  float outdoorShadowReceiverDepth(float depth, vec2 gradient, vec2 offset) {
    return depth + gradient.x * offset.x + gradient.y * offset.y;
  }

  float outdoorShadowBlockerSeparation(sampler2D map, vec2 uv, vec3 receiver, vec2 size, vec2 gradient) {
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) return 0.0;
    vec2 tapUv = (floor(uv * size) + 0.5) / size;
    float depth = outdoorShadowReceiverDepth(receiver.z, gradient, tapUv - receiver.xy);
    return max(0.0, depth - outdoorShadowDepth(map, tapUv));
  }
  ` : ''}
  float outdoorShadowCompare(sampler2D map, vec2 uv, float depth, vec2 size${receiverPlane ? ', vec2 gradient' : ''}) {
    // Bilinear comparisons smooth individual texels without widening contact shadows.
    vec2 pixel = uv * size - 0.5;
    vec2 f = fract(pixel);
    vec2 base = (floor(pixel) + 0.5) / size;
    vec2 stepUv = 1.0 / size;
    ${receiverPlane ? /* glsl */`
    // The caller has already corrected the outer PCSS offset; these are only
    // the four bilinear texel-center offsets relative to that requested UV.
    float d00 = outdoorShadowReceiverDepth(depth, gradient, base - uv);
    float d10 = outdoorShadowReceiverDepth(depth, gradient, base + vec2(stepUv.x, 0.0) - uv);
    float d01 = outdoorShadowReceiverDepth(depth, gradient, base + vec2(0.0, stepUv.y) - uv);
    float d11 = outdoorShadowReceiverDepth(depth, gradient, base + stepUv - uv);
    return mix(mix(step(d00, outdoorShadowDepth(map, base)),
                   step(d10, outdoorShadowDepth(map, base + vec2(stepUv.x, 0.0))), f.x),
               mix(step(d01, outdoorShadowDepth(map, base + vec2(0.0, stepUv.y))),
                   step(d11, outdoorShadowDepth(map, base + stepUv)), f.x), f.y);
    ` : /* glsl */`
    return mix(mix(step(depth, outdoorShadowDepth(map, base)),
                   step(depth, outdoorShadowDepth(map, base + vec2(stepUv.x, 0.0))), f.x),
               mix(step(depth, outdoorShadowDepth(map, base + vec2(0.0, stepUv.y))),
                   step(depth, outdoorShadowDepth(map, base + stepUv)), f.x), f.y);
    `}
  }

  float getOutdoorSunShadow(sampler2D map, vec2 size, float bias, float radius, vec4 coordinate, vec3 lightDirection) {
    #if defined(SHADOWMAP_TYPE_VSM)
      return getShadow(map, size, bias, radius, coordinate);
    #else
      vec3 sunView = normalize(mat3(viewMatrix) * uOutdoorPcssSunDirection);
      if (dot(sunView, lightDirection) < 0.9999) return getShadow(map, size, bias, radius, coordinate);
      vec3 p = coordinate.xyz / coordinate.w;
      if (any(lessThan(p, vec3(0.0))) || any(greaterThan(p, vec3(1.0)))) return 1.0;
      vec4 world = uOutdoorPcssInverseShadow * vec4(p, 1.0);
      // Rotation belongs to the world, with no camera- or frame-dependent noise.
      float angle = dot(world.xyz / world.w, vec3(0.71, 0.37, 1.13));
      vec3 dx = dFdx(p), dy = dFdy(p);
      ${receiverPlane ? /* glsl */`
      // UV areas become tiny at close camera distances. Solve the Jacobian in
      // shadow texels so valid close-up receivers are not treated as degenerate.
      vec2 dxTexel = dx.xy * size, dyTexel = dy.xy * size;
      float determinant = dxTexel.x * dyTexel.y - dxTexel.y * dyTexel.x;
      vec2 gradient = vec2(0.0);
      if (abs(determinant) > 0.00000001) {
        float gradientX = (dx.z * dyTexel.y - dy.z * dxTexel.y) / determinant * size.x;
        float gradientY = (dxTexel.x * dy.z - dyTexel.x * dx.z) / determinant * size.y;
        gradient = vec2(gradientX, gradientY);
      }
      ` : /* glsl */`
      float determinant = dx.x * dy.y - dx.y * dy.x;
      vec2 gradient = abs(determinant) > 0.000000001
        ? vec2(dx.z * dy.y - dy.z * dx.y, dx.x * dy.z - dy.x * dx.z) / determinant : vec2(0.0);
      `}
      gradient = clamp(gradient, vec2(-10.0), vec2(10.0));
      p.z += bias;
      vec2 search = uOutdoorPcssMetrics.xy * (0.20 + uOutdoorPcssSoftness * 2.0);
      float separationSum = 0.0, blockers = 0.0;
      ${receiverPlane ? /* glsl */`
      // The eight surrounding taps can all miss a narrow ledge directly above
      // the receiver; always test the center before searching a wider region.
      float centerSeparation = outdoorShadowBlockerSeparation(map, p.xy, p, size, gradient);
      if (centerSeparation > 0.0) { separationSum = centerSeparation; blockers = 1.0; }
      ` : ''}
      for (int i = 0; i < 8; i++) {
        vec2 offset = outdoorShadowDisc(i, 8.0, angle) * search;
        ${receiverPlane ? /* glsl */`
        float sampleSeparation = outdoorShadowBlockerSeparation(map, p.xy + offset, p, size, gradient);
        if (sampleSeparation > 0.0) {
          separationSum += sampleSeparation;
          blockers += 1.0;
        }
        ` : /* glsl */`
        float stored = outdoorShadowDepth(map, p.xy + offset);
        float receiver = p.z + dot(gradient, offset);
        if (stored < receiver) {
          separationSum += receiver - stored;
          blockers += 1.0;
        }
        `}
      }
      ${receiverPlane ? /* glsl */`
      // Reconstruct the same minimum footprint even when the search misses a
      // blocker; switching to one bilinear lookup creates pinholes and teeth.
      float separation = blockers > 0.0 ? separationSum / blockers * uOutdoorPcssMetrics.z : 0.0;
      ` : /* glsl */`
      if (blockers == 0.0) return outdoorShadowCompare(map, p.xy, p.z, size);
      float separation = separationSum / blockers * uOutdoorPcssMetrics.z;
      `}
      float angularRadius = 0.003 + uOutdoorPcssSoftness * 0.023;
      vec2 filterRadius = max(${receiverPlane ? '1.75' : '0.55'} / size,
        min(separation * angularRadius, 2.2) * uOutdoorPcssMetrics.xy);
      float visibility = 0.0;
      for (int i = 0; i < 16; i++) {
        vec2 offset = outdoorShadowDisc(i, 16.0, angle) * filterRadius;
        visibility += outdoorShadowCompare(map, p.xy + offset, p.z + dot(gradient, offset), size${receiverPlane ? ', gradient' : ''});
      }
      return visibility / 16.0;
    #endif
  }
  #endif
`;
