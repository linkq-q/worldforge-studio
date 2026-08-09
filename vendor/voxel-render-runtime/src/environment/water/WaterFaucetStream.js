import * as THREE from 'three';
import { NOISE_UTILS_GLSL } from './chunks.js';
import { RENDER_ORDER } from '../../render/RenderOrders.js';

/**
 * WaterStreamSurface — a coherent round free-space water stream (Water Dynamic v1 Phase L/M).
 *
 * Unlike WaterWrapSurface (a shell hugging a solid), this builds TubeGeometry along an
 * explicit centerline. Faucets use a straight guide; fountains use a gravity-sampled
 * ballistic guide. The same origin/direction/speed is shared with companion particles.
 *
 * Routing decides faucet vs fountain by endpoint contact. This class only renders the stream.
 *
 * Duck-typed to match WaterWrapSurface / WaterfallSurface where the registries touch it:
 * `.mesh`, `.material`, `.splashGroup` (null), `.setVisible()`, `.update(dt)`, `.dispose()`.
 */

const FAUCET_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;

  uniform float uTime;
  uniform float uFlowSpeed;
  uniform float uEdgeWobble;
  uniform float uEdgeWobbleScale;
  uniform float uSheetDrift;
  uniform float uSheetTurbulence;

  void main() {
    vUv = uv;
    float anchor = sin(uv.y * 3.14159265);
    float phase = uv.y * max(uEdgeWobbleScale, 0.1) * 6.2831853 + uTime * uFlowSpeed;
    float wobble = sin(phase + uv.x * 19.0) * uEdgeWobble * 0.18 * anchor;
    float drift = sin(phase * 0.73 + uv.x * 7.0) * uSheetDrift * anchor;
    float turbulence = cos(phase * 1.71 + uv.x * 31.0) * uSheetTurbulence * 0.18 * anchor;
    vec3 pos = position + normal * (wobble + drift + turbulence);
    vViewNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const FAUCET_FRAGMENT_SHADER = /* glsl */ `
  ${NOISE_UTILS_GLSL}

  varying vec2 vUv;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;

  uniform float uTime;
  uniform float uFlowSpeed;
  uniform float uBandSteps;
  uniform float uOpacity;
  uniform float uEdgeAlpha;
  uniform float uStrandCount;
  uniform float uFallAcceleration;
  uniform float uFlowWarp;
  uniform float uStrandBreakup;
  uniform float uSheetTurbulence;
  uniform vec3 uTopColor;
  uniform vec3 uBottomColor;
  uniform vec3 uFoamColor;

  void main() {
    // vUv.y runs 0 (spout, top) → 1 (bottom). Scroll the pattern DOWN the tube (+y).
    float v = vUv.y;
    vec2 sp = vec2(
      vUv.x * 3.0 + sin(v * 8.0 + uTime) * uFlowWarp * 0.2,
      v * 4.0 + uTime * uFlowSpeed * (1.0 + v * uFallAcceleration)
    );
    sp.x += noise2D(vec2(v * 6.0, uTime * 0.25)) * uSheetTurbulence * 0.18;
    float flow = fbmNoise(sp, uTime * 0.4);
    float bands = max(uBandSteps, 1.0);
    float banded = floor(flow * bands) / bands;

    // Water is brighter/whiter near the spout, tinting as it falls.
    vec3 col = mix(uTopColor, uBottomColor, clamp(v + banded * 0.12 - 0.06, 0.0, 1.0));

    // A few vertical strands around the tube for a "缕" liquid look (subtle).
    if (uStrandCount > 0.5) {
      float si = floor(vUv.x * uStrandCount);
      float bright = mix(0.9, 1.1, fract(sin(si * 12.9898) * 43758.5453));
      col *= bright;
    }

    // Foam flecks near the top lip (where it leaves the spout) and a little at the tail.
    // NB: well-defined edge order (edge0 < edge1). Reversed edges are undefined in GLSL and
    // returned garbage on some GPUs — turning the whole stream into a white opaque blob.
    float lip = (1.0 - smoothstep(0.0, 0.12, v)) * step(0.55, flow);
    col = mix(col, uFoamColor, lip * 0.6);

    // Fresnel: opaque core, translucent grazing rim.
    float fres = pow(1.0 - clamp(abs(dot(normalize(vViewNormal), normalize(-vViewPos))), 0.0, 1.0), 2.0);
    float alpha = mix(clamp(uOpacity, 0.0, 1.0), clamp(uEdgeAlpha, 0.0, 1.0), fres);
    // Dissolve the very tail so it reads as breaking into droplets rather than a hard cut.
    alpha *= 1.0 - smoothstep(0.82, 1.0, v);
    if (uStrandBreakup > 0.001) {
      float breakup = smoothstep(1.0 - uStrandBreakup, 1.0, flow) * smoothstep(0.52, 1.0, v);
      alpha *= 1.0 - breakup * 0.82;
    }
    alpha = max(alpha, lip * clamp(uOpacity, 0.0, 1.0));

    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * Sample a ballistic stream centerline in one coordinate space.
 * Both the tube core and particle emitter consume the same origin/direction/speed,
 * so a rotated nozzle cannot produce a vertical core with sideways droplets.
 */
export function getBallisticDuration(direction, speed, gravity = 9.8) {
  const dir = direction.clone();
  if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
  dir.normalize();
  const verticalSpeed = Math.max(0, (Number(speed) || 0) * dir.y);
  if (verticalSpeed <= 0.05) return 0.7;
  const apexTime = verticalSpeed / Math.max(gravity, 1e-3);
  // A vertical nozzle is a column: stop shortly after the crown so the tube does not
  // double back through itself. Angled nozzles render the full outward parabola.
  return Math.max(0.35, apexTime * (Math.hypot(dir.x, dir.z) < 0.08 ? 1.15 : 2.0));
}

export function createBallisticPath({
  origin,
  direction,
  speed,
  gravity = 9.8,
  duration = null,
  segments = 24,
}) {
  const p0 = origin.clone();
  const dir = direction.clone();
  if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
  dir.normalize();
  const launchSpeed = Math.max(Number(speed) || 0, 0.01);
  const flightTime = duration ?? getBallisticDuration(dir, launchSpeed, gravity);
  const count = Math.max(3, Math.round(segments));
  const velocity = dir.multiplyScalar(launchSpeed);
  const points = [];
  for (let i = 0; i <= count; i++) {
    const t = flightTime * (i / count);
    points.push(new THREE.Vector3(
      p0.x + velocity.x * t,
      p0.y + velocity.y * t - 0.5 * gravity * t * t,
      p0.z + velocity.z * t,
    ));
  }
  return points;
}

export class WaterStreamSurface {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Object3D} parent - usually the model root group (local-space)
   * @param {object} options
   * @param {THREE.BufferGeometry} [options.sourceGeometry] - fallback guide geometry (legacy faucet path)
   * @param {THREE.Matrix4} [options.localMatrix] - part transform within parent
   * @param {THREE.Vector3[]} [options.pathPoints] - centerline points in parent-local space
   * @param {number} [options.radius] - tube radius when pathPoints are supplied
   */
  constructor(scene, renderer, parent, options = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.parent = parent || scene;
    this._visible = true;

    let pathPoints = options.pathPoints?.map(point => point.clone?.() || new THREE.Vector3(...point));
    let radius = options.radius;
    if (!pathPoints?.length) {
      const src = options.sourceGeometry;
      if (!src) throw new Error('WaterStreamSurface requires pathPoints or sourceGeometry');
      src.computeBoundingBox();
      const bb = src.boundingBox;
      const center = bb.getCenter(new THREE.Vector3());
      const topY = bb.max.y;
      const botY = bb.min.y;
      const height = Math.max(topY - botY, 1e-3);
      radius = radius ?? Math.max(Math.min(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.35, height * 0.02);
      pathPoints = [
        new THREE.Vector3(center.x, topY, center.z),
        new THREE.Vector3(center.x, (topY + botY) * 0.5, center.z),
        new THREE.Vector3(center.x, botY, center.z),
      ];
    }
    this._pathPoints = pathPoints.map(point => point.clone());
    this._tubularSegments = options.tubularSegments ?? Math.max(24, this._pathPoints.length - 1);
    this._radialSegments = options.radialSegments ?? 8;
    this._radius = Math.max(Number(radius) || 0.05, 0.002);
    this._startScale = options.startScale ?? 1.0;
    this._tailScale = options.tailScale ?? 0.5;
    const geometry = this._createGeometry();

    // Taper: wide at the spout, ~half-radius at the tail (a falling stream narrows). Scale
    // each ring toward its own centroid — exact regardless of how the curve was sampled.
    this._taperTube(
      geometry,
      this._tubularSegments,
      this._radialSegments,
      this._startScale,
      this._tailScale,
    );

    this.material = new THREE.ShaderMaterial({
      vertexShader: FAUCET_VERTEX_SHADER,
      fragmentShader: FAUCET_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uFlowSpeed: { value: options.flowSpeed ?? 1.4 },
        uBandSteps: { value: options.bandSteps ?? 5 },
        uOpacity: { value: options.opacity ?? 0.8 },
        uEdgeAlpha: { value: options.edgeAlpha ?? 0.35 },
        uStrandCount: { value: options.strandCount ?? 3 },
        uEdgeWobble: { value: options.edgeWobble ?? 0 },
        uEdgeWobbleScale: { value: options.edgeWobbleScale ?? 1 },
        uFallAcceleration: { value: options.fallAcceleration ?? 0 },
        uSheetDrift: { value: options.sheetDrift ?? 0 },
        uSheetTurbulence: { value: options.sheetTurbulence ?? 0 },
        uFlowWarp: { value: options.flowWarp ?? 0 },
        uStrandBreakup: { value: options.strandBreakup ?? 0 },
        uTopColor: { value: (options.topColor || new THREE.Color(0xbfefff)).clone() },
        uBottomColor: { value: (options.bottomColor || new THREE.Color(0x4fb8e0)).clone() },
        uFoamColor: { value: (options.foamColor || new THREE.Color(0xffffff)).clone() },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = options.name || 'WaterStreamSurface';
    if (options.localMatrix) {
      this.mesh.matrixAutoUpdate = false;
      this.mesh.matrix.copy(options.localMatrix);
    }
    this.mesh.renderOrder = options.renderOrder ?? RENDER_ORDER.EFFECTS;
    this.mesh.userData.skipShaderApply = true;
    this.mesh.userData.isEnvironmentObject = true;
    this.mesh.userData.isWater = true;
    this.mesh.userData.isWaterfall = true; // shares protective classification with Wall/Wrap
    this.parent.add(this.mesh);

    // WaterfallSurface parity: registries iterate `splashGroup?.children`.
    this.splashGroup = null;
  }

  /** Scale each tube ring toward its own centroid so the stream narrows from top to tail. */
  _taperTube(geometry, tubularSegments, radialSegments, topScale, tailScale) {
    const pos = geometry.attributes.position;
    const ringVerts = radialSegments + 1;
    const center = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i <= tubularSegments; i++) {
      center.set(0, 0, 0);
      const base = i * ringVerts;
      for (let j = 0; j < ringVerts; j++) center.add(v.fromBufferAttribute(pos, base + j));
      center.multiplyScalar(1 / ringVerts);
      const s = topScale + (tailScale - topScale) * (i / tubularSegments);
      for (let j = 0; j < ringVerts; j++) {
        v.fromBufferAttribute(pos, base + j).sub(center).multiplyScalar(s).add(center);
        pos.setXYZ(base + j, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  _createGeometry() {
    const curve = new THREE.CatmullRomCurve3(this._pathPoints);
    return new THREE.TubeGeometry(
      curve,
      this._tubularSegments,
      this._radius,
      this._radialSegments,
      false,
    );
  }

  /** Rebuild only the Tube profile; its guide and parent transform stay intact. */
  setProfile({ radius = this._radius, tailScale = this._tailScale } = {}) {
    this._radius = Math.max(Number(radius) || this._radius, 0.002);
    this._tailScale = THREE.MathUtils.clamp(Number(tailScale) || this._tailScale, 0.05, 1.0);
    if (!this.mesh) return;
    const geometry = this._createGeometry();
    this._taperTube(geometry, this._tubularSegments, this._radialSegments, this._startScale, this._tailScale);
    const previous = this.mesh.geometry;
    this.mesh.geometry = geometry;
    previous?.dispose?.();
  }

  get visible() { return this._visible; }

  setVisible(visible) {
    this._visible = Boolean(visible);
    if (this.mesh) this.mesh.visible = this._visible;
  }

  getUniforms() { return this.material?.uniforms || null; }

  _worldBottomAnchor(target = new THREE.Vector3()) {
    if (!this.mesh || this._pathPoints.length === 0) return target.set(0, 0, 0);
    this.mesh.updateWorldMatrix(true, false);
    return this.mesh.localToWorld(target.copy(this._pathPoints[this._pathPoints.length - 1]));
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
    this._pathPoints = [];
  }
}

// Phase L compatibility: existing callers/tests may keep the faucet-specific name.
export const WaterFaucetStream = WaterStreamSurface;

export { FAUCET_VERTEX_SHADER, FAUCET_FRAGMENT_SHADER };
