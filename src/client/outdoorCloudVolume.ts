import * as THREE from 'three';

const SIZE = 64;
let noiseBytes: Uint8Array<ArrayBuffer> | null = null;

function hash(x: number, y: number, z: number, seed: number): number {
  let value = Math.imul(x, 1597334677) ^ Math.imul(y, 3812015801) ^ Math.imul(z, 2798796415) ^ seed;
  value = Math.imul(value ^ value >>> 16, 2246822519);
  return ((value ^ value >>> 13) >>> 0) / 4294967295;
}

/** Periodic value noise used to build the repeatable GPU volume once. */
export function periodicCloudNoise(x: number, y: number, z: number, period = 8): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
  const wrap = (n: number) => (n % period + period) % period;
  let result = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    result += hash(wrap(ix + dx), wrap(iy + dy), wrap(iz + dz), 15731)
      * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
  }
  return result;
}

export function createCloudVolumeNoise(): THREE.Data3DTexture {
  if (!noiseBytes) {
    noiseBytes = new Uint8Array(SIZE * SIZE * SIZE * 2);
    const cells = 8;
    const points = new Float32Array(cells * cells * cells * 3);
    for (let z = 0; z < cells; z++) for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
      const index = ((z * cells + y) * cells + x) * 3;
      for (let axis = 0; axis < 3; axis++) points[index + axis] = 0.12 + hash(x, y, z, axis * 997 + 41) * 0.76;
    }
    for (let z = 0; z < SIZE; z++) for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const px = (x + 0.5) * cells / SIZE, py = (y + 0.5) * cells / SIZE, pz = (z + 0.5) * cells / SIZE;
      const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
      let nearest = 3;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const i = ((((cz + cells) % cells) * cells + (cy + cells) % cells) * cells + (cx + cells) % cells) * 3;
        const qx = cx + points[i] - px, qy = cy + points[i + 1] - py, qz = cz + points[i + 2] - pz;
        nearest = Math.min(nearest, qx * qx + qy * qy + qz * qz);
      }
      const index = ((z * SIZE + y) * SIZE + x) * 2;
      noiseBytes[index] = Math.round(255 * (periodicCloudNoise(px, py, pz) * 0.72
        + periodicCloudNoise(px * 2, py * 2, pz * 2, 16) * 0.28));
      noiseBytes[index + 1] = Math.round(255 * Math.max(0, 1 - Math.sqrt(nearest)));
    }
  }
  const texture = new THREE.Data3DTexture(noiseBytes, SIZE, SIZE, SIZE);
  texture.format = THREE.RGFormat;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

export const CLOUD_VOLUME_FUNCTIONS = /* glsl */`
  uniform highp sampler3D uCloudVolumeNoise;
  uniform vec2 uCloudLayer;
  uniform vec3 uCloudSunRadiance;

  float cumulusDensity(vec3 world, float detail) {
    float h = (world.y - uCloudLayer.x) / (uCloudLayer.y - uCloudLayer.x);
    if (h <= 0.0 || h >= 1.0) return 0.0;
    vec3 p = world + vec3(uCloudTime * 0.7, 0.0, uCloudTime * 0.13);
    float cover = texture(uCloudVolumeNoise, vec3(p.xz * 0.00035, 0.41)).r;
    float body = texture(uCloudVolumeNoise, p * 0.0014).r;
    float threshold = mix(0.86, 0.40, uCloudCoverage);
    float density = cover * 0.82 + body * 0.40 - threshold;
    density -= h * h * 0.22;
    if (density <= 0.0) return 0.0;
    if (detail > 0.01) {
      float erosion = 1.0 - texture(uCloudVolumeNoise, p * 0.0038).g;
      density -= erosion * detail * 0.075 * (1.0 - smoothstep(0.05, 0.24, density));
    }
    float base = smoothstep(0.0, 0.10, h);
    float top = 1.0 - smoothstep(0.72, 1.0, h);
    return max(density, 0.0) * base * top * 3.8;
  }

  float cumulusSunTransmission(vec3 world, vec3 sunDirection) {
    float opticalDepth = 0.0;
    // Increasing spacing keeps distant self-shadow blockers at a bounded cost.
    float distanceAlongRay = 0.0;
    float stepLength = 18.0;
    for (int j = 0; j < 3; j++) {
      opticalDepth += cumulusDensity(world + sunDirection * (distanceAlongRay + stepLength * 0.5), 0.0) * stepLength;
      if (opticalDepth > 130.0) break;
      distanceAlongRay += stepLength;
      stepLength *= 2.3;
    }
    return exp(-opticalDepth * 0.043);
  }

  vec3 renderCumulus(vec3 origin, vec3 ray, vec3 sunDirection, vec3 clearSky) {
    if (uCloudCoverage <= 0.001 || abs(ray.y) < 0.002) return clearSky;
    vec2 limits = (uCloudLayer - origin.y) / ray.y;
    float begin = max(0.0, min(limits.x, limits.y));
    float end = min(6000.0, max(limits.x, limits.y));
    if (end <= begin) return clearSky;
    float stepLength = (end - begin) / 40.0;
    // A common midpoint on every ray samples the same horizontal slices. A smooth,
    // world-anchored offset breaks those layers without frame/pixel noise or shimmer.
    vec3 entry = origin + ray * begin;
    float offset = 0.15 + 0.70 * texture(uCloudVolumeNoise, entry * 0.0071).r;
    // Fine erosion smaller than the march footprint aliases at the distant horizon.
    float detail = 1.0 - smoothstep(14.0, 35.0, stepLength);
    float transmission = 1.0;
    vec3 scattering = vec3(0.0);
    float mu = dot(ray, sunDirection);
    // A finite forward lobe produces bright cloud edges without clamping HDR radiance.
    float phase = 0.72 + 0.065 * (1.0 - 0.70 * 0.70)
      / pow(1.0 + 0.70 * 0.70 - 2.0 * 0.70 * mu, 1.5);
    for (int i = 0; i < 40; i++) {
      vec3 world = origin + ray * (begin + (float(i) + offset) * stepLength);
      float density = cumulusDensity(world, detail);
      if (density <= 0.0001) continue;
      float lightTransmission = cumulusSunTransmission(world, sunDirection);
      float h = clamp((world.y - uCloudLayer.x) / (uCloudLayer.y - uCloudLayer.x), 0.0, 1.0);
      vec3 ambient = vec3(0.55, 0.82, 1.32) * mix(0.55, 1.0, h);
      // A weaker, less directional term approximates light scattered inside the cloud.
      vec3 direct = uCloudSunRadiance * phase
        * (0.85 * lightTransmission + 0.25 * pow(lightTransmission, 0.3));
      float absorbed = 1.0 - exp(-density * stepLength * 0.043);
      scattering += (ambient + direct) * absorbed * transmission;
      transmission *= 1.0 - absorbed;
      if (transmission < 0.015) break;
    }
    float aerial = 1.0 - exp(-begin * 0.00013);
    scattering = mix(scattering, clearSky * (1.0 - transmission), aerial);
    return scattering + clearSky * transmission;
  }
`;
