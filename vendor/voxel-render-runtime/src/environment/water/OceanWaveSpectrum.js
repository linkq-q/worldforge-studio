import * as THREE from 'three';

export const OCEAN_TERRAIN_GLSL = /* glsl */ `
  uniform sampler2D tOceanTerrain;
  uniform bool uUseOceanTerrain;
  uniform vec2 uOceanTerrainSize;
  uniform vec2 uOceanMapSize;
  uniform vec2 uOceanMapCenter;
  uniform float uOceanLevel;
  uniform float uOceanTerrainApronWidth;
  uniform float uOceanTerrainSinkTarget;
  uniform bool uOceanTerrainBounded;
  uniform vec4 uOceanTerrainBounds;
  uniform float uOceanWaveGeometryFadeStart;
  uniform float uOceanWaveGeometryFadeEnd;
  uniform float uOceanNearVertexSpacing;

  bool outsideOceanTerrain(vec2 worldXZ) {
    return uOceanTerrainBounded && (any(lessThan(worldXZ, uOceanTerrainBounds.xy))
      || any(greaterThan(worldXZ, uOceanTerrainBounds.zw)));
  }

  float sampleOceanTerrainHeight(vec2 worldXZ) {
    // Streamed worlds end at a vertical cut; their padded depth field has no
    // rendered seabed outside that cut to support transparent shallows.
    if (outsideOceanTerrain(worldXZ)) return uOceanTerrainSinkTarget;
    vec2 safeMapSize = max(uOceanMapSize, vec2(0.0001));
    vec2 terrainSpan = max(uOceanTerrainSize - 1.0, vec2(1.0));
    vec2 uv = (worldXZ - uOceanMapCenter) / safeMapSize + 0.5;
    vec2 grid = uv * terrainSpan;
    vec2 clampedGrid = clamp(grid, vec2(0.0), terrainSpan);
    vec2 cell = min(floor(clampedGrid), uOceanTerrainSize - 2.0);
    vec2 f = clampedGrid - cell;
    vec2 texel = 1.0 / uOceanTerrainSize;
    vec2 a = (cell + 0.5) * texel;
    float h00 = texture2D(tOceanTerrain, a).r;
    float h10 = texture2D(tOceanTerrain, a + vec2(texel.x, 0.0)).r;
    float h01 = texture2D(tOceanTerrain, a + vec2(0.0, texel.y)).r;
    float h11 = texture2D(tOceanTerrain, a + texel).r;
    if (any(notEqual(grid, clampedGrid))) {
      float edgeHeight = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
      float distanceOutside = length((grid - clampedGrid) * safeMapSize / terrainSpan);
      float t = smoothstep(0.0, max(uOceanTerrainApronWidth, 0.001), distanceOutside);
      // New coast fields already contain a deep padded floor. Extending the
      // finite texture must never raise that floor back toward sinkTarget,
      // otherwise its square edge appears as a bright/dark trench on the sea.
      return mix(edgeHeight, min(edgeHeight, uOceanTerrainSinkTarget), t);
    }
    if (mod(cell.x + cell.y, 2.0) < 0.5) {
      if (f.x + f.y <= 1.0) return h00 + (h10 - h00) * f.x + (h01 - h00) * f.y;
      return h11 + (h01 - h11) * (1.0 - f.x) + (h10 - h11) * (1.0 - f.y);
    }
    if (f.x <= f.y) return h00 + (h11 - h01) * f.x + (h01 - h00) * f.y;
    return h00 + (h10 - h00) * f.x + (h11 - h10) * f.y;
  }

`;

export const OCEAN_SWASH_GLSL = /* glsl */ `
  float oceanSwashNoise(vec2 p) {
    vec2 cell = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    vec4 h = fract(sin(vec4(
      dot(cell, vec2(127.1, 311.7)),
      dot(cell + vec2(1.0, 0.0), vec2(127.1, 311.7)),
      dot(cell + vec2(0.0, 1.0), vec2(127.1, 311.7)),
      dot(cell + 1.0, vec2(127.1, 311.7))
    )) * 43758.5453);
    return mix(mix(h.x, h.y, f.x), mix(h.z, h.w, f.x), f.y);
  }

  float oceanSwashPhase(vec2 p, float ground) {
    return fract(uTime * uShoreWaveSpeed * 0.1 + 0.10 * sin(uTime * 0.29) - ground * 0.18
      + oceanSwashNoise(p * 0.19) * 0.28 + oceanSwashNoise(p * 0.43) * 0.10);
  }

  float oceanSwashCrest(vec2 p) {
    vec2 warp = p + vec2(oceanSwashNoise(p * 0.23), oceanSwashNoise(p * 0.23 + 7.0)) * 3.0;
    float strength = clamp(uShoreWaveStrength, 0.0, 2.5);
    return (0.12 + 0.06 * oceanSwashNoise(warp * 0.38 + vec2(uTime * 0.035, -uTime * 0.021))) * strength;
  }

  float oceanSwashTrough(vec2 p) {
    return -0.025 - 0.035 * oceanSwashNoise(p * 0.31 + vec2(-uTime * 0.018, uTime * 0.025));
  }

  float oceanWaveDepthRange() {
    // WorldForge's authored island shelves are intentionally shallow (often
    // about 0.25 m below sea level). Treat only the final shoreline band as
    // swash so the playable ocean still retains its open-water wave spectrum.
    return max(0.16, uShoreWaveRange * 0.42);
  }

  float computeOceanSwashHeight(vec2 p, float openWave) {
    if (uShoreWaveStrength <= 0.0) return openWave;
    float ground = sampleOceanTerrainHeight(p) - uOceanLevel;
    float phase = oceanSwashPhase(p, ground);
    float push = smoothstep(0.0, 0.30, phase) * (1.0 - smoothstep(0.30, 1.0, phase));
    float swash = mix(oceanSwashTrough(p), oceanSwashCrest(p), push);
    float shore = smoothstep(-oceanWaveDepthRange(), -0.025, ground);
    return mix(openWave * 1.3, swash, shore);
  }

  float oceanWaveGeometryFade(vec2 worldXZ) {
    vec2 fromMapCenter = abs(worldXZ - uOceanMapCenter);
    float distanceFromMapCenter = max(fromMapCenter.x, fromMapCenter.y);
    return 1.0 - smoothstep(
      uOceanWaveGeometryFadeStart,
      max(uOceanWaveGeometryFadeEnd, uOceanWaveGeometryFadeStart + 0.001),
      distanceFromMapCenter
    );
  }
`;


// Artistic sea states, in metres. Each four-wave spectrum stays cheap enough for
// the existing 4 m ocean mesh; these labels are not physical sea-state forecasts.
const SEA_STATES = {
  light: { height: 0.4, wavelength: 14, steepness: 0.18 },
  moderate: { height: 1.5, wavelength: 24, steepness: 0.5 },
  large: { height: 3.8, wavelength: 40, steepness: 0.7 },
};
const WEIGHTS = [0.56, 0.24, 0.14, 0.06];
const LENGTHS = [1, 0.76, 0.55, 0.39];
const DIRECTIONS = [0, 0.58, -0.37, 0.92];
const PHASES = [0, 1.73, 3.91, 5.37];
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const smooth = (lo, hi, value) => { const t = clamp((value - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

export function createOceanWaveUniforms() {
  return {
    uOceanSpectrumEnabled: { value: false },
    uOceanSpectrumHeight: { value: 0 },
    uOceanSpectrumLateral: { value: 0 },
    uOceanCrestFoamStrength: { value: 0 },
    uOceanWaveComponents: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    uOceanWaveMotion: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    tOceanTerrain: { value: null }, uUseOceanTerrain: { value: false },
    uOceanTerrainSize: { value: new THREE.Vector2(2, 2) },
    uOceanMapSize: { value: new THREE.Vector2(1, 1) }, uOceanMapCenter: { value: new THREE.Vector2() },
    uOceanLevel: { value: 0 }, uOceanTerrainApronWidth: { value: 18 }, uOceanTerrainSinkTarget: { value: -3 },
    uOceanTerrainBounded: { value: false }, uOceanTerrainBounds: { value: new THREE.Vector4() },
    uOceanWaveGeometryFadeStart: { value: 1e6 }, uOceanWaveGeometryFadeEnd: { value: 1e6 + 1 },
    uOceanNearVertexSpacing: { value: 0 },
    uShoreWaveEnabled: { value: false }, uShoreWaveStrength: { value: 0 },
    uShoreWaveRange: { value: 0.44 }, uShoreWaveSpeed: { value: 0.3 },
  };
}

const OCEAN_UNIFORM_NAMES = Object.keys(createOceanWaveUniforms());

export function bindOceanWaveUniforms(target, source) {
  if (!target.uOceanSpectrumEnabled) return;
  target.uOceanSpectrumEnabled.value = Boolean(source?.uOceanSpectrumEnabled?.value);
  if (!target.uOceanSpectrumEnabled.value) return;
  for (const name of OCEAN_UNIFORM_NAMES) {
    if (target[name] && source[name]) target[name].value = source[name].value;
  }
}

export function configureOceanSeaState(uniforms, state, controls = {}) {
  const preset = SEA_STATES[state];
  uniforms.uOceanSpectrumEnabled.value = Boolean(preset);
  if (!preset) return;
  const strength = clamp(finite(controls.strength, 0.35), 0, 1.5) / 0.35;
  const speed = clamp(finite(controls.speed, 0.3), 0, 2) / 0.3;
  const scale = clamp(finite(controls.scale, 1.3), 0.25, 4) / 1.3;
  const heading = finite(controls.direction, 28 * Math.PI / 180);
  const sharpness = clamp(finite(controls.sharpness, 2.1), 0.5, 4) / 2.1;
  const amplitude = preset.height * 0.5 * strength;
  const components = uniforms.uOceanWaveComponents.value;
  const motions = uniforms.uOceanWaveMotion.value;
  let slopeBudget = 0;
  for (let i = 0; i < 4; i++) {
    const angle = heading + DIRECTIONS[i];
    const k = 2 * Math.PI * scale / (preset.wavelength * LENGTHS[i]);
    components[i].set(Math.cos(angle), Math.sin(angle), amplitude * WEIGHTS[i], k);
    slopeBudget += amplitude * WEIGHTS[i] * k;
  }
  // Sum Q*A*k < 1 bounds both horizontal Jacobian eigenvalues away from zero.
  const target = Math.min(0.82, preset.steepness * sharpness * Math.min(strength, 1));
  const q = slopeBudget > 0 ? target / slopeBudget : 0;
  for (let i = 0; i < 4; i++) motions[i].set(-speed, PHASES[i], q, 0);
  uniforms.uOceanSpectrumHeight.value = amplitude;
  uniforms.uOceanSpectrumLateral.value = amplitude * q;
  uniforms.uOceanCrestFoamStrength.value = strength > 0 ? clamp(finite(controls.foamStrength, 0.8), 0, 1.5) : 0;
}

export const OCEAN_WAVE_SPECTRUM_GLSL = /* glsl */ `
  uniform bool uOceanSpectrumEnabled;
  uniform float uOceanSpectrumHeight;
  uniform float uOceanSpectrumLateral;
  uniform float uOceanCrestFoamStrength;
  uniform vec4 uOceanWaveComponents[4]; // direction XZ, amplitude, wave number
  uniform vec4 uOceanWaveMotion[4]; // speed multiplier, phase, lateral Q, reserved

  vec3 oceanSpectrumRawDisplacement(vec2 p, out mat2 horizontalDerivative) {
    vec3 result = vec3(0.0);
    horizontalDerivative = mat2(0.0);
    if (uOceanSpectrumHeight <= 0.0) return result;
    for (int i = 0; i < 4; i++) {
      vec4 wave = uOceanWaveComponents[i];
      vec4 motion = uOceanWaveMotion[i];
      float k = uOceanNearVertexSpacing > 0.0 ? min(wave.w, 2.4 / uOceanNearVertexSpacing) : wave.w;
      float phase = dot(p, wave.xy) * k + uTime * sqrt(9.81 * k) * motion.x + motion.y;
      float sine = sin(phase), cosine = cos(phase);
      result += vec3(wave.x * motion.z * wave.z * cosine, wave.z * sine, wave.y * motion.z * wave.z * cosine);
      horizontalDerivative -= motion.z * wave.z * k * sine
        * mat2(wave.x * wave.x, wave.x * wave.y, wave.x * wave.y, wave.y * wave.y);
    }
    if (uUseOceanTerrain) {
      vec2 offset = p - uOceanMapCenter;
      float distance = max(abs(offset.x), abs(offset.y));
      // Bound the extra LOD gradient by .05, preserving the folding budget
      // even for long authored waves and very short requested LOD fades.
      float end = max(uOceanWaveGeometryFadeEnd, 0.001);
      float width = min(end, max(max(end - uOceanWaveGeometryFadeStart, 0.001), uOceanSpectrumLateral * 30.0));
      float lateralScale = min(1.0, width / max(uOceanSpectrumLateral * 30.0, 0.001));
      result.xz *= lateralScale;
      horizontalDerivative *= lateralScale;
      // Expand inward: the existing 4 m / 16 m mesh seam must stay flat.
      float t = clamp((distance - (end - width)) / width, 0.0, 1.0);
      float fade = 1.0 - t * t * (3.0 - 2.0 * t);
      vec2 gradient = abs(offset.x) >= abs(offset.y) ? vec2(sign(offset.x), 0.0) : vec2(0.0, sign(offset.y));
      gradient *= -6.0 * t * (1.0 - t) / width;
      horizontalDerivative = horizontalDerivative * fade
        + mat2(result.xz * gradient.x, result.xz * gradient.y);
      result *= fade;
    }
    return result;
  }

  vec3 oceanSpectrumDisplacement(vec2 p, out mat2 horizontalDerivative) {
    vec3 result = oceanSpectrumRawDisplacement(p, horizontalDerivative);
    if (uOceanSpectrumHeight <= 0.0) return result;
    if (uUseOceanTerrain) {
      // Depth changes vertical motion at the actual displaced location. Scaling
      // lateral motion by a steep seabed gradient can fold even a safe spectrum.
      vec2 displacedXZ = p + result.xz;
      float ground = sampleOceanTerrainHeight(displacedXZ) - uOceanLevel;
      float depth = max(-ground, 0.0);
      float envelope = smoothstep(0.025, max(0.16, uOceanSpectrumHeight * 2.0), depth)
        * min(1.0, depth * 0.8 / max(uOceanSpectrumHeight, 0.001));
      result.y *= envelope;
      if (uShoreWaveEnabled) {
        result.y = computeOceanSwashHeight(displacedXZ, result.y / (uShoreWaveStrength > 0.0 ? 1.3 : 1.0));
      }
      result.y = max(result.y, min(0.0, ground + 0.005));
    }
    return result;
  }

  float oceanSpectrumHeightAt(vec2 worldXZ) {
    vec2 p = worldXZ;
    mat2 derivative;
    // Invert lateral Gerstner motion: the camera is at displaced world XZ.
    // Four Newton steps converge rapidly under the bounded folding budget.
    for (int i = 0; i < 4; i++) {
      vec3 displacement = oceanSpectrumRawDisplacement(p, derivative);
      mat2 jacobian = mat2(1.0) + derivative;
      vec2 error = p + displacement.xz - worldXZ;
      float determinant = max(jacobian[0].x * jacobian[1].y - jacobian[1].x * jacobian[0].y, 0.025);
      p -= vec2(jacobian[1].y * error.x - jacobian[1].x * error.y,
        -jacobian[0].y * error.x + jacobian[0].x * error.y) / determinant;
    }
    return oceanSpectrumDisplacement(p, derivative).y;
  }
`;

const value = (u, key, fallback = 0) => u[key]?.value ?? fallback;
const fract = x => x - Math.floor(x);
function swashNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const sx = smooth(0, 1, fract(x)), sz = smooth(0, 1, fract(z));
  const hash = (a, b) => fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
  const a = hash(ix, iz) * (1 - sx) + hash(ix + 1, iz) * sx;
  const b = hash(ix, iz + 1) * (1 - sx) + hash(ix + 1, iz + 1) * sx;
  return a * (1 - sz) + b * sz;
}

function terrainHeight(u, x, z) {
  const sink = value(u, 'uOceanTerrainSinkTarget', -3);
  const bounds = value(u, 'uOceanTerrainBounds');
  if (value(u, 'uOceanTerrainBounded') && (x < bounds.x || z < bounds.y || x > bounds.z || z > bounds.w)) return sink;
  const image = value(u, 'tOceanTerrain')?.image;
  if (!image?.data || image.width < 2 || image.height < 2) return sink;
  const center = value(u, 'uOceanMapCenter'), size = value(u, 'uOceanMapSize');
  const gx = ((x - center.x) / size.x + 0.5) * (image.width - 1);
  const gz = ((z - center.y) / size.y + 0.5) * (image.height - 1);
  const cx = clamp(gx, 0, image.width - 1), cz = clamp(gz, 0, image.height - 1);
  const ix = Math.min(Math.floor(cx), image.width - 2), iz = Math.min(Math.floor(cz), image.height - 2);
  const fx = cx - ix, fz = cz - iz;
  const h00 = image.data[iz * image.width + ix], h10 = image.data[iz * image.width + ix + 1];
  const h01 = image.data[(iz + 1) * image.width + ix], h11 = image.data[(iz + 1) * image.width + ix + 1];
  if (gx !== cx || gz !== cz) {
    const edge = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
    const distance = Math.hypot((gx - cx) * size.x / (image.width - 1), (gz - cz) * size.y / (image.height - 1));
    const t = smooth(0, Math.max(value(u, 'uOceanTerrainApronWidth'), 0.001), distance);
    return edge * (1 - t) + Math.min(edge, sink) * t;
  }
  if ((ix + iz) % 2 === 0) return fx + fz <= 1
    ? h00 + (h10 - h00) * fx + (h01 - h00) * fz
    : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  return fx <= fz ? h00 + (h11 - h01) * fx + (h01 - h00) * fz
    : h00 + (h10 - h00) * fx + (h11 - h10) * fz;
}

function evaluate(u, x, z, time, shoreline = true) {
  const result = [0, 0, 0], derivative = [0, 0, 0, 0];
  if (!value(u, 'uOceanSpectrumEnabled') || value(u, 'uOceanSpectrumHeight') <= 0) return { result, derivative };
  const spacing = value(u, 'uOceanNearVertexSpacing');
  const waves = value(u, 'uOceanWaveComponents'), motions = value(u, 'uOceanWaveMotion');
  for (let i = 0; i < 4; i++) {
    const wave = waves[i], motion = motions[i];
    const k = spacing > 0 ? Math.min(wave.w, 2.4 / spacing) : wave.w;
    const phase = (x * wave.x + z * wave.y) * k + time * Math.sqrt(9.81 * k) * motion.x + motion.y;
    const sine = Math.sin(phase), cosine = Math.cos(phase);
    const lateral = motion.z * wave.z * cosine, slope = -motion.z * wave.z * k * sine;
    result[0] += wave.x * lateral; result[1] += wave.z * sine; result[2] += wave.y * lateral;
    derivative[0] += slope * wave.x * wave.x;
    derivative[1] += slope * wave.x * wave.y;
    derivative[2] += slope * wave.x * wave.y;
    derivative[3] += slope * wave.y * wave.y;
  }
  if (value(u, 'uUseOceanTerrain')) {
    const center = value(u, 'uOceanMapCenter');
    const ox = x - center.x, oz = z - center.y;
    const distance = Math.max(Math.abs(ox), Math.abs(oz));
    const start = value(u, 'uOceanWaveGeometryFadeStart', 1e6), end = value(u, 'uOceanWaveGeometryFadeEnd', 1e6 + 1);
    const safeEnd = Math.max(end, 0.001);
    const width = Math.min(safeEnd, Math.max(safeEnd - start, 0.001, value(u, 'uOceanSpectrumLateral') * 30));
    const lateralScale = Math.min(1, width / Math.max(value(u, 'uOceanSpectrumLateral') * 30, 0.001));
    result[0] *= lateralScale; result[2] *= lateralScale;
    for (let i = 0; i < 4; i++) derivative[i] *= lateralScale;
    const t = clamp((distance - (safeEnd - width)) / width, 0, 1);
    const fade = 1 - t * t * (3 - 2 * t), gradient = -6 * t * (1 - t) / width;
    const gx = Math.abs(ox) >= Math.abs(oz) ? Math.sign(ox) * gradient : 0;
    const gz = Math.abs(ox) >= Math.abs(oz) ? 0 : Math.sign(oz) * gradient;
    derivative[0] = derivative[0] * fade + result[0] * gx;
    derivative[1] = derivative[1] * fade + result[0] * gz;
    derivative[2] = derivative[2] * fade + result[2] * gx;
    derivative[3] = derivative[3] * fade + result[2] * gz;
    for (let i = 0; i < 3; i++) result[i] *= fade;
    if (!shoreline) return { result, derivative };
    x += result[0]; z += result[2];
    const ground = terrainHeight(u, x, z) - value(u, 'uOceanLevel');
    const depth = Math.max(-ground, 0), amplitude = value(u, 'uOceanSpectrumHeight');
    result[1] *= smooth(0.025, Math.max(0.16, amplitude * 2), depth) * Math.min(1, depth * 0.8 / Math.max(amplitude, 0.001));
    const range = Math.max(0.16, value(u, 'uShoreWaveRange', 0.44) * 0.42);
    const strength = value(u, 'uShoreWaveStrength');
    if (value(u, 'uShoreWaveEnabled') && strength > 0) {
      const phase = fract(time * value(u, 'uShoreWaveSpeed') * 0.1 + 0.1 * Math.sin(time * 0.29) - ground * 0.18
        + swashNoise(x * 0.19, z * 0.19) * 0.28 + swashNoise(x * 0.43, z * 0.43) * 0.1);
      const push = smooth(0, 0.3, phase) * (1 - smooth(0.3, 1, phase));
      const wx = x + swashNoise(x * 0.23, z * 0.23) * 3;
      const wz = z + swashNoise(x * 0.23 + 7, z * 0.23 + 7) * 3;
      const crest = (0.12 + 0.06 * swashNoise(wx * 0.38 + time * 0.035, wz * 0.38 - time * 0.021)) * clamp(strength, 0, 2.5);
      const trough = -0.025 - 0.035 * swashNoise(x * 0.31 - time * 0.018, z * 0.31 + time * 0.025);
      const shore = smooth(-range, -0.025, ground);
      result[1] = result[1] * (1 - shore) + (trough * (1 - push) + crest * push) * shore;
    }
    result[1] = Math.max(result[1], Math.min(0, ground + 0.005));
  }
  return { result, derivative };
}

export function sampleOceanWaveDisplacement(uniforms, x, z, time) {
  return evaluate(uniforms, x, z, time).result;
}

export function sampleOceanWaveHeight(uniforms, x, z, time) {
  let px = x, pz = z;
  for (let i = 0; i < 4; i++) {
    const { result: d, derivative: j } = evaluate(uniforms, px, pz, time, false);
    const a = 1 + j[0], b = j[1], c = j[2], dzz = 1 + j[3], determinant = Math.max(a * dzz - b * c, 0.025);
    const ex = px + d[0] - x, ez = pz + d[2] - z;
    px -= (dzz * ex - b * ez) / determinant;
    pz -= (-c * ex + a * ez) / determinant;
  }
  return evaluate(uniforms, px, pz, time).result[1];
}
