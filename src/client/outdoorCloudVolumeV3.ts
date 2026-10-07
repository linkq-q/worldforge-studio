import { BILLOWING_CLOUD_FUNCTIONS } from './outdoorCloudVolumeV2';

// Reuse v4's density layout and stable integration; keep its accepted shader unchanged.
// These local lighting changes form a separately selectable sky, never a scene-wide grade.
const changes = [
  ['vec3 renderBillowingClouds(', 'vec3 renderSculptedClouds('],
  ['for (int j = 0; j < 5; j++)', 'for (int j = 0; j < 8; j++)'],
  ['float a = float(j) / 5.0;', 'float a = float(j) / 8.0;'],
  ['float b = float(j + 1) / 5.0;', 'float b = float(j + 1) / 8.0;'],
  ['* stepLength * 0.028', '* stepLength * 0.038'],
  [
    'float multipleScattering = 0.38 * exp(-opticalDepth * 0.30)',
    'float multipleScattering = 0.22 * exp(-opticalDepth * 0.45)'
  ],
  [
    'float skyVisibility = mix(0.28, 1.0, sqrt(h)) * exp(-density * (1.0 - h) * 0.7);',
    'float skyVisibility = mix(0.12, 1.0, sqrt(h)) * exp(-density * (1.0 - h) * 1.15);'
  ],
  [
    'vec3 ambient = vec3(0.55, 0.85, 1.30) * skyVisibility + vec3(0.10, 0.10, 0.075);',
    'vec3 ambient = vec3(0.28, 0.46, 0.76) * skyVisibility + vec3(0.035, 0.04, 0.04);'
  ],
  [
    'vec3(0.45, 0.65, 0.95) + uCloudSunRadiance * phase * sunlight * 0.12',
    'vec3(0.22, 0.36, 0.58) + uCloudSunRadiance * phase * sunlight * 0.18'
  ],
  [
    'float aerial = 1.0 - exp(-begin * (0.000035 + uCloudHaze * 0.00012));',
    'float aerial = 1.0 - exp(-max(begin - 400.0, 0.0) * (0.000045 + uCloudHaze * 0.00010));'
  ]
] as const;

let shader = BILLOWING_CLOUD_FUNCTIONS;
for (const [before, after] of changes) {
  if (!shader.includes(before)) throw new Error(`cloud_v5_shader_anchor_missing: ${before}`);
  shader = shader.replaceAll(before, after);
}

export const SCULPTED_CLOUD_FUNCTIONS = shader;
