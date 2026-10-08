import * as THREE from 'three';
import { RENDER_ORDER } from '../../render/RenderOrders.js';
import { NOISE_UTILS_GLSL } from './chunks.js';
import { OCEAN_TERRAIN_GLSL, OCEAN_SWASH_GLSL, OCEAN_WAVE_SPECTRUM_GLSL,
  sampleOceanWaveDisplacement } from './OceanWaveSpectrum.js';

const MAX_BREAKERS = 12, DROPS_PER_BREAKER = 8, SPAN_STEP = 14, RADIUS = 70;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const fract = x => x - Math.floor(x);
const seedAt = (a, b) => fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);

// A small authored cross-section, inspired by Hugh Malan's HFW SIGGRAPH 2022
// presentation: https://advances.realtimerendering.com/s2022/SIGGRAPH2022-Advances-Water-Malan.pdf
// This is a controlled visual curl, not a fluid simulation. The return under the
// lip matters: a double-sided upright strip cannot show the inside of a breaker.
const PROFILE = [
  [-1.2, 0], [-1.0, 0.06], [-0.8, 0.18], [-0.64, 0.38], [-0.5, 0.61],
  [-0.34, 0.81], [-0.15, 0.95], [0.08, 1.0], [0.32, 0.97], [0.54, 0.86],
  [0.71, 0.68], [0.81, 0.47], [0.79, 0.35], [0.68, 0.34], [0.62, 0.55],
  [0.45, 0.72], [0.23, 0.82], [0.0, 0.82], [-0.15, 0.69], [-0.2, 0.49],
  [-0.14, 0.26], [0.06, 0.07], [0.5, 0], [1.2, 0]
];

function ribbonGeometry() {
  const geometry = new THREE.InstancedBufferGeometry(), positions = [], profiles = [], tangents = [], indices = [];
  const lengthSegments = 12, stride = PROFILE.length;
  for (let along = 0; along <= lengthSegments; along++) {
    for (let cross = 0; cross < stride; cross++) {
      const previous = PROFILE[Math.max(0, cross - 1)], next = PROFILE[Math.min(stride - 1, cross + 1)];
      positions.push(along / lengthSegments, cross / (stride - 1), 0);
      profiles.push(...PROFILE[cross]); tangents.push(next[0] - previous[0], next[1] - previous[1]);
      if (along < lengthSegments && cross < stride - 1) {
        const a = along * stride + cross;
        indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
      }
    }
  }
  geometry.setIndex(indices);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aProfile', new THREE.Float32BufferAttribute(profiles, 2));
  geometry.setAttribute('aProfileTangent', new THREE.Float32BufferAttribute(tangents, 2));
  for (const name of ['aCrestOrigin', 'aBreaker']) geometry.setAttribute(name,
    new THREE.InstancedBufferAttribute(new Float32Array(MAX_BREAKERS * 4), 4).setUsage(THREE.DynamicDrawUsage));
  geometry.instanceCount = 0;
  return geometry;
}

const RIBBON_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform bool uShoreWaveEnabled;
  uniform float uShoreWaveStrength;
  uniform float uShoreWaveRange;
  uniform float uShoreWaveSpeed;
  ${OCEAN_TERRAIN_GLSL}
  ${OCEAN_SWASH_GLSL}
  ${OCEAN_WAVE_SPECTRUM_GLSL}
  attribute vec2 aProfile;
  attribute vec2 aProfileTangent;
  attribute vec4 aCrestOrigin;
  attribute vec4 aBreaker;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec4 vFoam;
  varying float vEnvelope;
  void main() {
    vec2 direction = uOceanWaveComponents[0].xy;
    vec2 tangent = vec2(-direction.y, direction.x);
    float age = aBreaker.x / max(aBreaker.y, 0.001);
    float life = smoothstep(0.0, 0.27, age) * (1.0 - smoothstep(0.64, 1.0, age));
    float ends = smoothstep(0.0, 0.14, position.x) * (1.0 - smoothstep(0.86, 1.0, position.x));
    float envelope = life * ends;
    float flatX = mix(-1.2, 1.2, position.y);
    float forward = mix(flatX, aProfile.x + aProfile.y * age * 0.12, envelope) * aBreaker.w;
    vec2 p = aCrestOrigin.xy + tangent * ((position.x - 0.5) * aCrestOrigin.z) + direction * forward;
    mat2 derivative;
    vec3 displacement = oceanSpectrumDisplacement(p, derivative);
    vec3 world = vec3(p.x, uOceanLevel, p.y) + displacement;
    world.y += aProfile.y * aBreaker.z * envelope;
    vec3 along = vec3(tangent.x, 0.0, tangent.y)
      + (oceanSpectrumDisplacement(p + tangent * 0.05, derivative) - displacement) / 0.05;
    vec3 across = vec3(direction.x, 0.0, direction.y)
      + (oceanSpectrumDisplacement(p + direction * 0.05, derivative) - displacement) / 0.05;
    float dx = mix(2.4 / ${PROFILE.length - 1}.0 * 2.0, aProfileTangent.x, envelope) * aBreaker.w;
    across = across * dx + vec3(0.0, aProfileTangent.y * aBreaker.z * envelope, 0.0);
    vNormal = normalize(cross(along, across));
    vWorld = world;
    vFoam = vec4(position.x * aCrestOrigin.z, position.y, aCrestOrigin.w, age);
    vEnvelope = envelope;
    // The host attaches this group beneath the ocean mesh, but the shared
    // spectrum, terrain and camera are all world-space. Do not transform twice.
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const RIBBON_FRAGMENT = /* glsl */ `
  uniform vec3 uWaterColor;
  uniform vec3 uShallowColor;
  uniform vec3 uFoamColor;
  uniform vec3 uSceneWaterLightDirection;
  uniform float uOceanCrestFoamStrength;
  ${NOISE_UTILS_GLSL}
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec4 vFoam;
  varying float vEnvelope;
  void main() {
    if (vEnvelope < 0.025) discard;
    vec3 normal = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 light = normalize(uSceneWaterLightDirection + vec3(0.001, 0.001, 0.001));
    float lighting = 0.5 + 0.5 * max(dot(normal, light), 0.0);
    float fresnel = pow(1.0 - abs(dot(normal, normalize(cameraPosition - vWorld))), 3.0);
    vec3 water = mix(uWaterColor, uShallowColor, 0.42) * lighting;
    water += vec3(0.12, 0.2, 0.23) * fresnel;
    vec2 uv = vec2(vFoam.x * 2.1 + vFoam.z * 17.0, vFoam.y * 8.0 - vFoam.w * 2.0);
    float noise = noise2D(uv) * 0.7 + noise2D(uv * 3.7) * 0.3;
    float threshold = clamp(0.61 - uOceanCrestFoamStrength * 0.16, 0.3, 0.6);
    float aa = max(fwidth(noise), 0.018);
    float broken = smoothstep(threshold - aa, threshold + aa, noise);
    float lip = smoothstep(0.25, 0.39, vFoam.y) * (1.0 - smoothstep(0.76, 0.91, vFoam.y));
    // White cores reach full coverage; noise makes holes rather than tinting
    // the entire crest into another translucent white stripe.
    vec3 foam = uFoamColor * (0.83 + 0.17 * lighting);
    gl_FragColor = vec4(mix(water, foam, lip * broken), 1.0);
  }
`;

export class OceanBreakers {
  constructor(uniforms) {
    this.enabled = false;
    this.uniforms = {
      ...uniforms,
      uTime: uniforms.uTime || { value: 0 },
      uWaterColor: uniforms.uWaterColor || { value: new THREE.Color('#1d6774') },
      uShallowColor: uniforms.uShallowColor || { value: new THREE.Color('#5cacae') },
      uFoamColor: uniforms.uFoamColor || { value: new THREE.Color('#f1ffff') },
      uSceneWaterLightDirection: uniforms.uSceneWaterLightDirection || { value: new THREE.Vector3(0.4, 1, 0.3).normalize() }
    };
    this.group = new THREE.Group(); this.group.name = 'OceanBreakers'; this.group.visible = false;
    const material = new THREE.ShaderMaterial({ uniforms: this.uniforms,
      vertexShader: RIBBON_VERTEX, fragmentShader: RIBBON_FRAGMENT, side: THREE.DoubleSide,
      transparent: true, depthWrite: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    material.forceSinglePass = true;
    this.ribbon = new THREE.Mesh(ribbonGeometry(), material); this.ribbon.name = 'OceanBreakerSheets';
    const sprayGeometry = new THREE.BufferGeometry();
    sprayGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_BREAKERS * DROPS_PER_BREAKER * 3), 3).setUsage(THREE.DynamicDrawUsage));
    sprayGeometry.setAttribute('aFlight', new THREE.BufferAttribute(new Float32Array(MAX_BREAKERS * DROPS_PER_BREAKER * 4), 4).setUsage(THREE.DynamicDrawUsage));
    sprayGeometry.setDrawRange(0, 0);
    const sprayMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec4 aFlight;
        varying float vAlpha;
        void main() {
          float age = aFlight.w;
          vec3 world = position + aFlight.xyz * age + vec3(0.0, -4.905 * age * age, 0.0);
          vec4 view = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = clamp(52.0 / max(-view.z, 0.1), 1.0, 5.0);
          vAlpha = smoothstep(0.0, 0.025, age) * (1.0 - smoothstep(0.3, 0.65, age));
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uFoamColor;
        varying float vAlpha;
        void main() {
          float radius = length(gl_PointCoord - 0.5);
          float alpha = (1.0 - smoothstep(0.22, 0.5, radius)) * vAlpha;
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(uFoamColor, alpha);
        }
      `, transparent: true, depthTest: true, depthWrite: false
    });
    this.spray = new THREE.Points(sprayGeometry, sprayMaterial); this.spray.name = 'OceanBreakerSpray';
    for (const object of [this.ribbon, this.spray]) {
      object.userData.isWater = true; object.userData.skipShaderApply = true;
      object.frustumCulled = false; object.renderOrder = RENDER_ORDER.EFFECTS; this.group.add(object);
    }
    this._camera = new THREE.Vector3();
  }

  update(camera, time) {
    if (this._disposed) return;
    const u = this.uniforms;
    this.group.visible = Boolean(this.enabled && u.uOceanSpectrumEnabled.value && u.uOceanSpectrumHeight.value > 0
      && u.uOceanCrestFoamStrength.value > 0 && u.uWhitecapEnabled?.value !== false);
    this.ribbon.geometry.instanceCount = 0; this.spray.geometry.setDrawRange(0, 0);
    if (!this.group.visible) return;
    u.uTime.value = time;
    camera.getWorldPosition(this._camera);
    const wave = u.uOceanWaveComponents.value[0], motion = u.uOceanWaveMotion.value[0];
    const k = u.uOceanNearVertexSpacing.value > 0 ? Math.min(wave.w, 2.4 / u.uOceanNearVertexSpacing.value) : wave.w;
    const omega = Math.sqrt(9.81 * k) * motion.x, speed = Math.abs(motion.x);
    const along = this._camera.x * wave.x + this._camera.z * wave.y;
    const across = -this._camera.x * wave.y + this._camera.z * wave.x;
    const crestIndex = Math.round((along * k + omega * time + motion.y - Math.PI / 2) / (Math.PI * 2));
    const spanIndex = Math.round(across / SPAN_STEP), candidates = [];
    for (let front = crestIndex - 2; front <= crestIndex + 2; front++) {
      const crest = (Math.PI / 2 + Math.PI * 2 * front - omega * time - motion.y) / k;
      for (let span = spanIndex - 4; span <= spanIndex + 4; span++) {
        const seed = seedAt(front, span), period = 4.0 + seed * 1.3, life = 1.65 + seed * 0.55;
        const age = fract(time * speed / period + seed) * period;
        if (age >= life || age < 0.015) continue;
        const x = wave.x * crest - wave.y * span * SPAN_STEP, z = wave.y * crest + wave.x * span * SPAN_STEP;
        const d = sampleOceanWaveDisplacement(u, x, z, time);
        const distance = Math.hypot(x + d[0] - this._camera.x, z + d[2] - this._camera.z, u.uOceanLevel.value + d[1] - this._camera.y);
        if (distance >= RADIUS || d[1] < 0.08) continue;
        const fade = 1 - smooth(45, RADIUS, distance);
        const height = Math.min(0.8, d[1] * 0.85) * fade;
        if (height < 0.035) continue;
        candidates.push({ x, z, seed, age, life, height, distance, length: 6 + seed * 4, width: 0.45 + height * 0.55 });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const origin = this.ribbon.geometry.getAttribute('aCrestOrigin'), shape = this.ribbon.geometry.getAttribute('aBreaker');
    const dropPosition = this.spray.geometry.getAttribute('position'), flight = this.spray.geometry.getAttribute('aFlight');
    let count = 0, drops = 0;
    for (const candidate of candidates.slice(0, MAX_BREAKERS)) {
      const { x, z, seed, age, life, height, length, width } = candidate;
      origin.setXYZW(count, x, z, length, seed); shape.setXYZW(count, age, life, height, width); count++;
      // Fixed slots and absolute launch time make scrubbing and switching maps
      // deterministic. A droplet follows gravity after birth, not the moving crest.
      if (candidate.distance > 45) continue;
      for (let i = 0; i < DROPS_PER_BREAKER; i++) {
        const random = seedAt(seed * 91, i + 1), launchAge = life * (0.33 + random * 0.18);
        const airTime = speed > 0 ? (age - launchAge) / speed : -1;
        if (airTime <= 0 || airTime >= 0.65) continue;
        const birthTime = time - airTime, travel = -omega / k;
        const side = (random - 0.5) * length * 0.72;
        const bx = x - wave.x * travel * airTime, bz = z - wave.y * travel * airTime;
        const birthCrest = sampleOceanWaveDisplacement(u, bx, bz, birthTime);
        const birthHeight = Math.min(0.8, birthCrest[1] * 0.85);
        if (birthHeight < 0.035) continue;
        const lip = (0.81 + 0.47 * launchAge / life * 0.12) * (0.45 + birthHeight * 0.55);
        const px = bx - wave.y * side + wave.x * lip;
        const pz = bz + wave.x * side + wave.y * lip;
        const d = sampleOceanWaveDisplacement(u, px, pz, birthTime);
        dropPosition.setXYZ(drops, px + d[0], u.uOceanLevel.value + d[1] + birthHeight * 0.47, pz + d[2]);
        const forward = travel * 0.55, sideways = (random - 0.5) * 0.9;
        flight.setXYZW(drops, wave.x * forward - wave.y * sideways, 1.3 + random * 0.9,
          wave.y * forward + wave.x * sideways, airTime); drops++;
      }
    }
    origin.needsUpdate = shape.needsUpdate = true; dropPosition.needsUpdate = flight.needsUpdate = true;
    this.ribbon.geometry.instanceCount = count; this.spray.geometry.setDrawRange(0, drops);
    this.group.visible = count > 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true; this.group.removeFromParent();
    for (const object of [this.ribbon, this.spray]) { object.geometry.dispose(); object.material.dispose(); }
    this.group.clear();
  }
}
