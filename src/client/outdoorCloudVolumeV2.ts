/** Original cloud material: weather pockets, rounded volume, and shadowed air below it. */
export const BILLOWING_CLOUD_FUNCTIONS = /* glsl */`
  uniform highp sampler3D uCloudVolumeNoise;
  uniform vec2 uCloudLayer;
  uniform vec3 uCloudSunRadiance;
  uniform float uCloudHaze;

  float billowingDensity(vec3 world, float detail) {
    float h = (world.y - uCloudLayer.x) / (uCloudLayer.y - uCloudLayer.x);
    if (h <= 0.0 || h >= 1.0) return 0.0;
    vec3 p = world + vec3(uCloudTime * 0.7, 0.0, uCloudTime * 0.13);
    vec2 weatherShape = texture(uCloudVolumeNoise, vec3(p.xz * 0.00040, 0.42)).rg;
    float weatherNoise = weatherShape.r * 0.72 + weatherShape.g * 0.28;
    float coverageEdge = mix(0.72, 0.35, uCloudCoverage);
    float weather = smoothstep(coverageEdge - 0.045, coverageEdge + 0.10, weatherNoise);
    // The weather mask conservatively rejects clear regions before 3D detail/shadow work.
    if (weather < 0.015) return 0.0;
    float crown = mix(0.45, 0.98, weather);
    float relativeHeight = h / crown;
    if (relativeHeight >= 1.0) return 0.0;
    vec2 shape = texture(uCloudVolumeNoise, p * 0.00125).rg;
    // Worley lobes form the body, rather than merely roughening a smooth value-noise slab.
    float billow = shape.g * 0.65 + shape.r * 0.35;
    float threshold = 0.27 + (1.0 - weather) * 0.22
      + 0.40 * relativeHeight * relativeHeight * relativeHeight;
    float density = billow - threshold;
    if (density <= 0.0) return 0.0;
    if (detail > 0.01) {
      float erosion = 1.0 - texture(uCloudVolumeNoise, p * 0.0036 + vec3(0.17, 0.31, 0.07)).g;
      density -= erosion * 0.10 * detail * (1.0 - smoothstep(0.10, 0.30, density));
    }
    float base = smoothstep(0.0, 0.055, h);
    float top = 1.0 - smoothstep(0.82, 1.0, relativeHeight);
    return clamp(density * 4.5, 0.0, 1.0) * weather * base * top;
  }

  float cloudOpticalDepth(vec3 world, vec3 sunDirection) {
    if (sunDirection.y <= 0.02) return 12.0;
    float enter = max(0.0, (uCloudLayer.x - world.y) / sunDirection.y);
    float leave = min(enter + 1400.0, (uCloudLayer.y - world.y) / sunDirection.y);
    if (leave <= enter) return 0.0;
    float span = leave - enter;
    float opticalDepth = 0.0;
    // Quadratic spacing resolves the nearby lobe that casts the strongest self shadow.
    for (int j = 0; j < 5; j++) {
      float a = float(j) / 5.0;
      float b = float(j + 1) / 5.0;
      float stepLength = (b * b - a * a) * span;
      float distanceAlongSun = enter + (a * a + b * b) * 0.5 * span;
      opticalDepth += billowingDensity(world + sunDirection * distanceAlongSun, 0.0) * stepLength * 0.028;
      if (opticalDepth > 8.0) break;
    }
    return opticalDepth;
  }

  float cloudPhase(float cosine, float g) {
    return (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosine, 0.025), 1.5);
  }

  vec3 cloudShadowedAir(vec3 origin, vec3 ray, vec3 sunDirection, float distanceToCloud, vec3 radiance) {
    float end = min(distanceToCloud, 2200.0);
    if (end <= 0.0) return radiance;
    float transmission = 1.0;
    vec3 scattered = vec3(0.0);
    float phase = cloudPhase(clamp(dot(ray, sunDirection), -1.0, 1.0), 0.55);
    float extinction = 0.000045 + uCloudHaze * 0.00028;
    for (int i = 0; i < 12; i++) {
      // Fixed world-distance intervals avoid aligning every view ray on the same cloud-base heights.
      float a = float(i) / 12.0;
      float b = float(i + 1) / 12.0;
      float start = a * a * 2200.0;
      if (start >= end) break;
      float stepLength = min(b * b * 2200.0, end) - start;
      vec3 world = origin + ray * (start + stepLength * 0.5);
      float airDensity = exp(-max(world.y, 0.0) / 700.0);
      float absorbed = 1.0 - exp(-airDensity * extinction * stepLength);
      // Real cloud density along this sample's sun ray determines the beam and its shadow.
      float sunlight = exp(-cloudOpticalDepth(world, sunDirection));
      scattered += transmission * absorbed
        * (vec3(0.45, 0.65, 0.95) + uCloudSunRadiance * phase * sunlight * 0.12);
      transmission *= 1.0 - absorbed;
    }
    return radiance * transmission + scattered;
  }

  vec3 renderBillowingClouds(vec3 origin, vec3 ray, vec3 sunDirection, vec3 clearSky) {
    if (uCloudCoverage <= 0.001 || ray.y <= 0.008) return clearSky;
    vec2 limits = (uCloudLayer - origin.y) / ray.y;
    float begin = max(0.0, min(limits.x, limits.y));
    float end = min(7000.0, max(limits.x, limits.y));
    if (end <= begin) return clearSky;
    float transmission = 1.0;
    vec3 scattering = vec3(0.0);
    float cosine = clamp(dot(ray, sunDirection), -1.0, 1.0);
    // A narrower, energy-limited forward lobe keeps a silver rim instead of whitening a whole bank.
    float phase = 0.55 + 0.055 * cloudPhase(cosine, 0.78) + 0.09 * cloudPhase(cosine, -0.20);
    float distanceAlongRay = begin;
    for (int i = 0; i < 160; i++) {
      if (distanceAlongRay >= end) break;
      // Fixed 20 m distances resolve low-angle silhouettes without shared horizontal sampling slices.
      float stepLength = min(20.0, end - distanceAlongRay);
      vec3 world = origin + ray * (distanceAlongRay + stepLength * 0.5);
      float density = billowingDensity(world, 1.0);
      if (density <= 0.0001) { distanceAlongRay += stepLength * 2.0; continue; }
      float opticalDepth = cloudOpticalDepth(world, sunDirection);
      float singleScattering = exp(-opticalDepth);
      // One extra scattering octave reuses the optical depth, costing no extra shadow rays.
      float multipleScattering = 0.38 * exp(-opticalDepth * 0.30) * (1.0 - exp(-density * 2.0));
      float h = clamp((world.y - uCloudLayer.x) / (uCloudLayer.y - uCloudLayer.x), 0.0, 1.0);
      float skyVisibility = mix(0.28, 1.0, sqrt(h)) * exp(-density * (1.0 - h) * 0.7);
      vec3 ambient = vec3(0.55, 0.85, 1.30) * skyVisibility + vec3(0.10, 0.10, 0.075);
      vec3 direct = uCloudSunRadiance * (phase * singleScattering * 0.85 + multipleScattering);
      float absorbed = 1.0 - exp(-density * stepLength * 0.028);
      scattering += (ambient + direct) * absorbed * transmission;
      transmission *= 1.0 - absorbed;
      if (transmission < 0.005) break;
      distanceAlongRay += stepLength;
    }
    // Retain shape at the middle distance; only genuinely distant clouds approach the sky color.
    float aerial = 1.0 - exp(-begin * (0.000035 + uCloudHaze * 0.00012));
    scattering = mix(scattering, clearSky * (1.0 - transmission), aerial);
    return cloudShadowedAir(origin, ray, sunDirection, begin, scattering + clearSky * transmission);
  }
`;
