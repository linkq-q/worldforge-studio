export const DEPTH_UTILS_GLSL = /* glsl */ `
  float linearizeDepth(float depthSample, float near, float far) {
    if (depthSample >= 0.9999) return far;
    return (2.0 * near * far) / (far + near - depthSample * (far - near));
  }

  float readLinearDepth(sampler2D tDepth, vec2 uv, float near, float far) {
    return linearizeDepth(texture2D(tDepth, uv).r, near, far);
  }
`;

export const NOISE_UTILS_GLSL = /* glsl */ `
  float hash2D(vec2 p) {
    float h = dot(p, vec2(127.1, 311.7));
    return fract(sin(h) * 43758.5453);
  }

  float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash2D(i);
    float b = hash2D(i + vec2(1.0, 0.0));
    float c = hash2D(i + vec2(0.0, 1.0));
    float d = hash2D(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbmNoise(vec2 p, float time) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    for (int i = 0; i < 3; i++) {
      value += amplitude * noise2D(p * frequency + time * 0.1 * float(i + 1));
      frequency *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }
`;

export const EQUIRECT_UTILS_GLSL = /* glsl */ `
  const float WATER_PI = 3.141592653589793;
  const float WATER_RECIPROCAL_PI = 0.3183098861837907;
  const float WATER_RECIPROCAL_PI2 = 0.15915494309189535;

  vec2 equirectUv(vec3 dir) {
    float u = atan(dir.z, dir.x) * WATER_RECIPROCAL_PI2 + 0.5;
    float v = asin(clamp(dir.y, -1.0, 1.0)) * WATER_RECIPROCAL_PI + 0.5;
    return vec2(u, v);
  }
`;

// Shared by shore-wave stripes and static ripple decals.
export const RING_STRIPE_GLSL = /* glsl */ `
  float ringStripe(float dist, float frequency, float speed, float width, float time) {
    float coord = dist * frequency - time * speed;
    float stripe = fract(coord);
    return 1.0 - smoothstep(width * 0.85, width, stripe);
  }
`;
