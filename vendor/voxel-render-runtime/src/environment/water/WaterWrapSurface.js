import * as THREE from 'three';
import { NOISE_UTILS_GLSL } from './chunks.js';
import { RENDER_ORDER } from '../../render/RenderOrders.js';

/**
 * WaterWrapSurface — flowing water skinned onto an arbitrary container's real
 * geometry (Water Dynamic v1 Phase H "Wrap"). Unlike WaterfallSurface (a flat
 * vertical plane), this clones the tagged part's actual mesh and pushes it out
 * slightly along its normals, so the water shell hugs a vase / pot / column at
 * any angle — no "flat sheet from the side" reveal.
 *
 * Flow direction is gravity projected onto each fragment's tangent plane
 * (steepest descent), so water runs down the surface following its curvature —
 * a spiraling vase spirals, a straight column runs straight. This needs no
 * baked flow map or extra vertex attributes; it falls out of the world normal.
 *
 * Duck-typed to match WaterfallSurface where the water registries touch it:
 * `.mesh`, `.material` (uniforms uTopColor/uBottomColor/uFoamColor/uBandSteps),
 * `.splashGroup` (null), `.update(dt)`, `.dispose()`.
 */

const WRAP_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vObjPos;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;

  uniform float uShellOffset;

  void main() {
    vObjPos = position;
    vec3 p = position + normal * uShellOffset;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorldPos = wp.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewNormal = normalize(normalMatrix * normal);
    vViewPos = (modelViewMatrix * vec4(p, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const WRAP_FRAGMENT_SHADER = /* glsl */ `
  ${NOISE_UTILS_GLSL}

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying vec3 vObjPos;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;

  uniform float uTime;
  uniform float uFlowSpeed;
  uniform float uFlowScale;
  uniform float uBandSteps;
  uniform float uOpacity;
  uniform float uEdgeAlpha;
  uniform float uColumnCount;
  uniform vec3 uTopColor;
  uniform vec3 uBottomColor;
  uniform vec3 uFoamColor;
  uniform float uObjYMin;
  uniform float uObjYMax;
  uniform vec2 uObjCenterXZ;
  uniform float uRadialOverflow; // 0=gravity-down, 1=radial-outward from center

  void main() {
    vec3 N = normalize(vWorldNormal);
    // Gravity projected onto the surface tangent plane → steepest-descent flow dir.
    vec3 down = vec3(0.0, -1.0, 0.0);
    vec3 gravFlow = down - N * dot(down, N);
    float gfl = length(gravFlow);
    gravFlow = gfl > 1e-4 ? gravFlow / gfl : down;

    // ponytail: radial overflow for fountain tiers — water flows outward from
    // the object's center, then hits the rim and falls as a curtain.
    vec3 radialDir = vec3(vWorldPos.x - uObjCenterXZ.x, 0.0, vWorldPos.z - uObjCenterXZ.y);
    float rl = length(radialDir);
    vec3 radialFlow = rl > 1e-4 ? radialDir / rl : vec3(1.0, 0.0, 0.0);
    // Project onto tangent plane so it follows the surface, not just horizontal
    radialFlow = normalize(radialFlow - N * dot(radialFlow, N));

    vec3 flowDir = mix(gravFlow, radialFlow, clamp(uRadialOverflow, 0.0, 1.0));

    // World-space flowing noise scrolled along the downhill direction. World-space
    // origin drifts if the model moves, but the pattern is animated so that's
    // imperceptible; the flow DIRECTION stays correct because it is recomputed.
    vec3 sp = vWorldPos * uFlowScale + flowDir * (uTime * uFlowSpeed);
    float n1 = noise2D(sp.xz + vec2(sp.y));
    float n2 = noise2D(sp.xz * 1.9 + vec2(sp.y * 1.3) + 7.3);
    float flow = clamp(n1 * 0.6 + n2 * 0.4, 0.0, 1.0);
    float bands = max(uBandSteps, 1.0);
    float banded = floor(flow * bands) / bands;

    // Object-space height: stable under model transform. 1 = surface top, 0 = floor.
    float h = clamp((vObjPos.y - uObjYMin) / max(uObjYMax - uObjYMin, 1e-4), 0.0, 1.0);
    vec3 col = mix(uBottomColor, uTopColor, clamp(h + banded * 0.15, 0.0, 1.0));

    // Vertical strands around the body's axis (the cartoon "缕" look).
    if (uColumnCount > 0.5) {
      float ang = atan(vObjPos.z - uObjCenterXZ.y, vObjPos.x - uObjCenterXZ.x);
      float ci = floor((ang / 6.2831853 + 0.5) * uColumnCount);
      float bright = mix(0.85, 1.08, fract(sin(ci * 12.9898) * 43758.5453));
      col *= bright;
    }

    // Foam pooling near the base.
    float foam = smoothstep(0.16, 0.0, h) * step(0.55, flow);
    col = mix(col, uFoamColor, foam);

    // Fresnel edge transparency: opaque body core, translucent grazing rim.
    float fres = pow(1.0 - clamp(abs(dot(normalize(vViewNormal), normalize(-vViewPos))), 0.0, 1.0), 2.2);
    float alpha = mix(clamp(uOpacity, 0.0, 1.0), clamp(uEdgeAlpha, 0.0, 1.0), fres);
    alpha = max(alpha, foam * clamp(uOpacity, 0.0, 1.0));

    gl_FragColor = vec4(col, alpha);
  }
`;

export class WaterWrapSurface {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Object3D} parent - usually the model root group (local-space)
   * @param {object} options
   * @param {THREE.BufferGeometry} options.sourceGeometry - the tagged part's real geometry (cloned here)
   * @param {THREE.Matrix4} [options.localMatrix] - part transform within parent
   */
  constructor(scene, renderer, parent, options = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.parent = parent || scene;
    this._visible = true;

    const geometry = options.sourceGeometry.clone();
    // Phase K: don't trust the source part's authored normals. Mirrored / negatively-scaled
    // instances and CSG parts often carry inconsistent or inward-facing winding, which made
    // the shell inflate INWARD and (with DoubleSide) expose its concave inner wall outward —
    // the "凹面朝外" bug. Recompute object-space normals from winding, and flip the offset
    // sign for mirrored placements (localMatrix determinant < 0) so the shell always grows
    // outward in world space regardless of how the part was placed.
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const center = bb.getCenter(new THREE.Vector3());
    const diag = bb.getSize(new THREE.Vector3()).length();
    const mirrored = options.localMatrix ? options.localMatrix.determinant() < 0 : false;
    const shellOffset = (options.shellOffset ?? Math.max(diag * 0.004, 0.002)) * (mirrored ? -1 : 1);

    this.material = new THREE.ShaderMaterial({
      vertexShader: WRAP_VERTEX_SHADER,
      fragmentShader: WRAP_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uShellOffset: { value: shellOffset },
        uFlowSpeed: { value: options.flowSpeed ?? 0.6 },
        uFlowScale: { value: options.flowScale ?? 1.2 },
        uBandSteps: { value: options.bandSteps ?? 5 },
        uOpacity: { value: options.opacity ?? 0.9 },
        uEdgeAlpha: { value: options.edgeAlpha ?? 0.4 },
        uColumnCount: { value: options.columnCount ?? 8 },
        uTopColor: { value: (options.topColor || new THREE.Color(0x91e7ff)).clone() },
        uBottomColor: { value: (options.bottomColor || new THREE.Color(0x1698c7)).clone() },
        uFoamColor: { value: (options.foamColor || new THREE.Color(0xffffff)).clone() },
        uObjYMin: { value: bb.min.y },
        uObjYMax: { value: bb.max.y },
        uObjCenterXZ: { value: new THREE.Vector2(center.x, center.z) },
        uRadialOverflow: { value: options.radialOverflow ? 1.0 : 0.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Phase K: FrontSide now that normals/offset are corrected — culls the back wall so a
      // transparent shell no longer shows its concave inner surface through the front.
      // ponytail: a genuinely open thin surface (single-sided petal/sail) would vanish from
      // its back; the wrap path targets closed-ish bodies (vase/pot/bowl/tier), so accept it.
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = options.name || 'WaterWrapSurface';
    if (options.localMatrix) {
      this.mesh.matrixAutoUpdate = false;
      this.mesh.matrix.copy(options.localMatrix); // parent = rootGroup → follows model transforms
    }
    this.mesh.renderOrder = options.renderOrder ?? RENDER_ORDER.EFFECTS;
    this.mesh.userData.skipShaderApply = true;
    this.mesh.userData.isEnvironmentObject = true;
    this.mesh.userData.isWater = true;
    this.mesh.userData.isWaterfall = true;
    this.parent.add(this.mesh);

    // Phase K: the dual inner shell was deleted — it read as a hazy "水雾" from outside and
    // doubled the draw calls per wrap. Volumetric depth now comes from the fragment's
    // fresnel edge alpha alone (opaque body core, translucent grazing rim).

    // WaterfallSurface parity: registries iterate `splashGroup?.children`.
    this.splashGroup = null;
  }

  get visible() {
    return this._visible;
  }

  setVisible(visible) {
    this._visible = Boolean(visible);
    if (this.mesh) this.mesh.visible = this._visible;
  }

  getUniforms() {
    return this.material?.uniforms || null;
  }

  update(deltaTime) {
    if (!this._visible || !this.material) return;
    this.material.uniforms.uTime.value += deltaTime;
  }

  dispose() {
    if (this.mesh?.parent) this.mesh.parent.remove(this.mesh);
    this.mesh?.geometry?.dispose?.();
    this.material?.dispose?.();
    this.mesh = null;
    this.material = null;
    this.splashGroup = null;
  }
}

export { WRAP_VERTEX_SHADER, WRAP_FRAGMENT_SHADER };
