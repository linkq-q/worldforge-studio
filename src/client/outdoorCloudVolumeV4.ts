import { BILLOWING_CLOUD_FUNCTIONS } from './outdoorCloudVolumeV2';

// Start from v4's bright lighting; v6 replaces only the density model and sampling budget.
const changes = [
  ['vec3 renderBillowingClouds(', 'vec3 renderMiddleClouds('],
  ['* stepLength * 0.028', '* stepLength * 0.020'],
  ['for (int i = 0; i < 160; i++)', 'for (int i = 0; i < 256; i++)'],
  ['float stepLength = min(20.0, end - distanceAlongRay);',
    'float stepLength = min(max(20.0, (end - begin) / 256.0), end - distanceAlongRay);'],
  ['distanceAlongRay += stepLength * 2.0; continue;', 'distanceAlongRay += stepLength; continue;']
] as const;

const densityStart = BILLOWING_CLOUD_FUNCTIONS.indexOf('  float billowingDensity(');
const densityEnd = BILLOWING_CLOUD_FUNCTIONS.indexOf('  float cloudOpticalDepth(');
if (densityStart < 0 || densityEnd <= densityStart) throw new Error('cloud_v6_density_anchor_missing');

let middleClouds = BILLOWING_CLOUD_FUNCTIONS.slice(0, densityStart) + /* glsl */`
  uniform highp sampler3D uCloudShapeNoise;

  // Remapping holds the dense core at one while moving the zero-density surface.
  float cloudDensityRemap(float value, float edge) {
    return clamp((value - edge) / max(1.0 - edge, 0.001), 0.0, 1.0);
  }

  float billowingDensity(vec3 world, float detail) {
    if (world.y <= uCloudLayer.x || world.y >= uCloudLayer.y) return 0.0;
    vec3 p = world + vec3(uCloudTime * 0.7, 0.0, uCloudTime * 0.13);
    float heightWeather = texture(uCloudVolumeNoise, vec3(p.xz * 0.000065, 0.28)).r;
    float cloudBase = mix(420.0, 730.0, heightWeather);
    float thickness = mix(340.0, 430.0, heightWeather);
    float h = (world.y - cloudBase) / thickness;
    if (h <= 0.0 || h >= 1.0) return 0.0;
    float heightProfile = smoothstep(0.0, 0.10, h) * (1.0 - smoothstep(0.65, 1.0, h));

    // Weather sets the footprint once. It no longer also crushes density, height, and the crown.
    float weatherNoise = texture(uCloudVolumeNoise, vec3(p.xz * 0.00022, 0.42)).r;
    float weather = smoothstep(0.30, 0.70, weatherNoise + (uCloudCoverage - 0.5) * 0.70);
    if (weather <= 0.001) return 0.0;
    float body = cloudDensityRemap(texture(uCloudShapeNoise, p * 0.00095).r, 0.25);
    float density = cloudDensityRemap(body, 1.0 - weather * heightProfile);
    if (density <= 0.0) return 0.0;
    if (detail > 0.01) {
      float erosion = 1.0 - texture(uCloudShapeNoise, p * 0.0018 + vec3(0.17, 0.31, 0.07)).g;
      float fineErosion = 1.0 - texture(uCloudVolumeNoise, p * 0.0032 + vec3(0.41, 0.09, 0.23)).g;
      float edgeErosion = mix(erosion, fineErosion, 0.40) * 0.25 * detail
        * (1.0 - smoothstep(0.25, 0.70, density));
      density = cloudDensityRemap(density, edgeErosion);
    }
    // Restore a short optical transition after shape carving, for both view and sunlight rays.
    return clamp(density * 2.8, 0.0, 1.0);
  }

` + BILLOWING_CLOUD_FUNCTIONS.slice(densityEnd);
for (const [before, after] of changes) {
  if (!middleClouds.includes(before)) throw new Error(`cloud_v6_shader_anchor_missing: ${before}`);
  middleClouds = middleClouds.replaceAll(before, after);
}

export const LAYERED_CLOUD_FUNCTIONS = middleClouds + /* glsl */`
  float thinCloudDensity(vec3 world, vec2 layer, bool highCloud) {
    float h = (world.y - layer.x) / (layer.y - layer.x);
    if (h <= 0.0 || h >= 1.0) return 0.0;
    vec2 wind = mat2(0.83, -0.55, 0.55, 0.83) * world.xz;
    wind += vec2(uCloudTime * (highCloud ? 2.0 : 0.9), 0.0);
    vec2 flow = texture(uCloudVolumeNoise, vec3(wind * (highCloud ? 0.000085 : 0.00031), 0.71)).rg;
    float field = flow.r;
    vec2 stretched = highCloud
      ? vec2(wind.x * 0.000060 + (flow.g - 0.5) * 0.24, wind.y * 0.00036 + (field - 0.5) * 0.38)
      : vec2(wind.x * 0.00030, wind.y * 0.00085 + (field - 0.5) * 0.12);
    float fibers = texture(uCloudVolumeNoise, vec3(stretched, h * 0.14 + 0.18)).r;
    float mask = highCloud ? smoothstep(0.30, 0.68, field) : smoothstep(0.58, 0.76, field);
    float strands = smoothstep(highCloud ? 0.38 : 0.40, 0.68, fibers);
    float breakup = texture(uCloudVolumeNoise, vec3(wind * (highCloud ? 0.00022 : 0.00065)
      + vec2(0.16, 0.47), 0.32 + h * 0.10)).g;
    strands *= smoothstep(0.22, 0.65, breakup);
    float heightProfile = smoothstep(0.0, 0.25, h) * (1.0 - smoothstep(0.65, 1.0, h));
    return mask * strands * heightProfile * clamp(uCloudCoverage * 2.0, 0.0, 1.0);
  }

  vec3 renderThinCloudLayer(vec3 origin, vec3 ray, vec3 sunDirection, vec2 layer, bool highCloud, vec3 background) {
    if (ray.y <= 0.01) return background;
    float begin = max(0.0, (layer.x - origin.y) / ray.y);
    float end = min(30000.0, (layer.y - origin.y) / ray.y);
    if (end <= begin) return background;
    float stepLength = (end - begin) / 6.0;
    float transmission = 1.0;
    vec3 scattered = vec3(0.0);
    float phase = 0.55 + 0.035 * cloudPhase(clamp(dot(ray, sunDirection), -1.0, 1.0), 0.60);
    // Thin upper ice clouds are sunlit; the sparse low fragments can sit in middle-cloud shade.
    float sunlight = highCloud ? 1.0 : exp(-cloudOpticalDepth(origin + ray * ((begin + end) * 0.5), sunDirection));
    vec3 radiance = vec3(0.90, 1.05, 1.30) + uCloudSunRadiance * phase * sunlight;
    for (int i = 0; i < 6; i++) {
      vec3 world = origin + ray * (begin + (float(i) + 0.5) * stepLength);
      float density = thinCloudDensity(world, layer, highCloud);
      float absorbed = 1.0 - exp(-density * stepLength * (highCloud ? 0.0018 : 0.0010));
      scattered += radiance * absorbed * transmission;
      transmission *= 1.0 - absorbed;
    }
    // Grazing rays have a very long path through a shallow layer; haze erases these distant strips.
    float visibility = exp(-begin * 0.000035) * smoothstep(0.06, 0.20, ray.y);
    return mix(background, scattered + background * transmission, visibility);
  }

  vec3 renderLayeredClouds(vec3 origin, vec3 ray, vec3 sunDirection, vec3 clearSky) {
    if (ray.y <= 0.0) return clearSky;
    // This spectral tint changes sky elevation, not the cloud shadows or any scene surface.
    float elevation = pow(clamp(ray.y, 0.0, 1.0), 0.60);
    float solarGlow = pow(max(dot(ray, sunDirection), 0.0), 16.0);
    vec3 elevationTint = mix(vec3(1.035, 1.02, 1.0), vec3(0.46, 0.72, 1.03), elevation);
    vec3 sky = clearSky * mix(elevationTint, vec3(1.0), solarGlow * 0.70);
    if (uCloudCoverage <= 0.001) return sky;
    // Composite actual height layers from far to near for a ground-level view.
    sky = renderThinCloudLayer(origin, ray, sunDirection, vec2(3600.0, 3740.0), true, sky);
    sky = renderMiddleClouds(origin, ray, sunDirection, sky);
    return renderThinCloudLayer(origin, ray, sunDirection, vec2(270.0, 320.0), false, sky);
  }
`;
