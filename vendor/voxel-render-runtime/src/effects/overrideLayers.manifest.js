/**
 * overrideLayers.manifest.js — materialOverride effect manifests.
 *
 * These are pure metadata. Runtime routing, batch policy, AI ranges, and default
 * params live here so AI vocabulary and material runtime project from one source.
 */

import { hashStable } from './runtime/EffectRuntimeTypes.js';

const MATERIAL_OVERRIDE_REQUIRES = { uniforms: [], varyings: [], textures: [] };
const OVERRIDE_COMPATIBLE = ['CartoonBase', 'PBRBase', 'Flame', 'EmissivePulse', 'HitFlash', 'ChargeAura', 'FresnelRim'];

const stoneColorRange = {
  designerRange: { h: [20, 55], s: [0.05, 0.45], v: [0.25, 0.75] },
  aiRange: { h: [24, 45], s: [0.08, 0.35], v: [0.32, 0.62] },
};

export const InkSurface = {
  id: 'InkSurface',
  displayName: 'Ink Surface',
  tier: 'standard',
  stage: 'surface',
  kind: 'override',
  route: 'materialOverride',
  slot: 'surfaceDetail',
  scope: 'object',
  batchPolicy: 'standalonePreferred',
  channels: ['baseColor', 'normal'],
  requires: MATERIAL_OVERRIDE_REQUIRES,
  params: {
    style: { type: 'string', default: 'petrified' },
    color: { type: 'color', default: [0.45, 0.39, 0.32], ...stoneColorRange },
    roughness: { type: 'float', default: 0.95, min: 0, max: 1, hardRange: [0, 1], designerRange: [0.55, 1], aiRange: [0.75, 1] },
    metalness: { type: 'float', default: 0, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.1], aiRange: [0, 0.02] },
    crack: { type: 'float', default: 0, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.9], aiRange: [0.15, 0.65] },
    crackColor: { type: 'color', default: [0.12, 0.11, 0.1] },
    noiseScale: { type: 'float', default: 0, min: 0, max: 32, hardRange: [0, 32], designerRange: [0, 24], aiRange: [4, 14] },
    noiseStrength: { type: 'float', default: 0, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.8], aiRange: [0.15, 0.55] },
    randomSeedPerObject: { type: 'bool', default: false },
    seed: { type: 'float', default: 0 },
    normalMapId: { type: 'string', default: null, nullable: true },
    normalStrength: { type: 'float', default: 0, min: 0, max: 2 },
  },
  cost: { instructions: 'med', textureReads: 0, drawCalls: 1 },
  compatibleWith: OVERRIDE_COMPATIBLE,
  incompatibleWith: ['Glass'],
  stateBindings: [],
  forbidden: ['roughness < 0.5', 'noiseScale > 24'],
  notes: [
    'Petrified surfaces should read as heavy and non-metallic.',
    'Avoid excessive noise that hides the object silhouette.',
    'Do not generate parameters outside the allowed ranges.',
  ],
  getEffectBatchKey(params = {}) {
    if (params.randomSeedPerObject) return null;
    return `InkSurface|${hashStable(params)}`;
  },
};

export const Petrify = {
  ...InkSurface,
  id: 'Petrify',
  displayName: 'Petrify',
  incompatibleWith: ['Glass'],
  getEffectBatchKey(params = {}) {
    if (params.randomSeedPerObject) return null;
    return `Petrify|${hashStable(params)}`;
  },
};

export const Glass = {
  id: 'Glass',
  displayName: 'Glass',
  tier: 'standard',
  stage: 'base',
  kind: 'override',
  route: 'materialOverride',
  slot: 'baseShading',
  scope: 'object',
  batchPolicy: 'standaloneOnly',
  channels: ['baseColor', 'alpha'],
  requires: MATERIAL_OVERRIDE_REQUIRES,
  params: {
    color: { type: 'color', default: [0.985, 0.995, 1], designerRange: { h: [0, 360], s: [0, 0.75], v: [0.55, 1] }, aiRange: { h: [0, 360], s: [0, 0.65], v: [0.65, 1] } },
    opacity: { type: 'float', default: 0.58, min: 0.35, max: 1, hardRange: [0, 1], designerRange: [0.35, 0.85], aiRange: [0.45, 0.75] },
    roughness: { type: 'float', default: 0.055, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.2], aiRange: [0.03, 0.12] },
    metalness: { type: 'float', default: 0.0, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.1], aiRange: [0, 0.05] },
    envMapIntensity: { type: 'float', default: 1.0, min: 0, max: 4, hardRange: [0, 4], designerRange: [0, 3], aiRange: [0.7, 1.4] },
    clearcoat: { type: 'float', default: 0.12, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.5], aiRange: [0, 0.25] },
    clearcoatRoughness: { type: 'float', default: 0.08, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.2], aiRange: [0.04, 0.12] },
    specularIntensity: { type: 'float', default: 1, min: 0, max: 2, hardRange: [0, 2], designerRange: [0, 2], aiRange: [0.75, 1.25] },
    fresnelStrength: { type: 'float', default: 0.16, min: 0, max: 3, hardRange: [0, 3], designerRange: [0, 1], aiRange: [0.08, 0.35] },
    fresnelPower: { type: 'float', default: 2, min: 0.5, max: 8, hardRange: [0.5, 8], designerRange: [0.8, 6], aiRange: [1.4, 4] },
    facetStrength: { type: 'float', default: 0.08, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.4], aiRange: [0.04, 0.16] },
    distortion: { type: 'float', default: 0.008, min: 0, max: 0.15, hardRange: [0, 0.25], designerRange: [0, 0.06], aiRange: [0.004, 0.018] },
    screenEdgeFade: { type: 'float', default: 0.08, min: 0.01, max: 0.25, hardRange: [0.001, 0.5], designerRange: [0.03, 0.18], aiRange: [0.06, 0.12] },
    surfaceVariation: { type: 'float', default: 0.035, min: 0, max: 0.2, hardRange: [0, 0.3], designerRange: [0, 0.12], aiRange: [0.015, 0.07] },
    surfaceScale: { type: 'float', default: 6.0, min: 0.1, max: 32, hardRange: [0.1, 64], designerRange: [1, 24], aiRange: [3, 12] },
    edgeTintStrength: { type: 'float', default: 0.18, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.6], aiRange: [0.08, 0.3] },
    transmission: { type: 'float', default: 0.95, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 1], aiRange: [0.82, 1] },
    ior: { type: 'float', default: 1.48, min: 1, max: 3, hardRange: [1, 3], designerRange: [1.3, 2.5], aiRange: [1.42, 1.8] },
    renderOrder: { type: 'float', default: 8, min: 0, max: 32 },
    thickness: { type: 'float', default: 0.25, min: 0, max: 5, hardRange: [0, 5], designerRange: [0, 2], aiRange: [0.1, 0.6] },
    autoThickness: { type: 'bool', default: true },
    attenuationColor: { type: 'color', default: [0.96, 0.99, 1.0] },
    attenuationDistance: { type: 'float', default: 6.0, min: 0, max: 20, hardRange: [0, 50], designerRange: [1, 15], aiRange: [2, 10] },
  },
  cost: { instructions: 'med', textureReads: 0, drawCalls: 1 },
  compatibleWith: ['Flame', 'EmissivePulse', 'HitFlash', 'ChargeAura', 'FresnelRim'],
  incompatibleWith: ['CartoonBase', 'MatcapBase', 'InkSurface', 'WhiteStroke', 'Petrify'],
  stateBindings: [],
  forbidden: ['opacity < 0.35', 'roughness > 0.3', 'envMapIntensity > 2.0'],
  notes: [
    'Glass should remain readable in gameplay.',
    'Avoid making the object fully transparent.',
    'Use fresnel edge highlight to improve silhouette.',
    'Do not generate parameters outside the allowed ranges.',
  ],
  getEffectBatchKey() {
    return null;
  },
};

export const WhiteStroke = {
  id: 'WhiteStroke',
  displayName: 'White Stroke',
  tier: 'standard',
  stage: 'stylization',
  kind: 'override',
  route: 'materialOverride',
  slot: 'finalStylization',
  scope: 'object',
  batchPolicy: 'standalonePreferred',
  channels: ['baseColor'],
  requires: MATERIAL_OVERRIDE_REQUIRES,
  params: {
    color: { type: 'color', default: [1, 1, 1], designerRange: { h: [0, 360], s: [0, 0.2], v: [0.75, 1] }, aiRange: { h: [0, 360], s: [0, 0.12], v: [0.88, 1] } },
    unlit: { type: 'bool', default: true },
    roughness: { type: 'float', default: 1, min: 0, max: 1, hardRange: [0, 1], designerRange: [0.45, 1], aiRange: [0.75, 1] },
    metalness: { type: 'float', default: 0, min: 0, max: 1 },
    useLocalInkMask: { type: 'bool', default: false },
    maskId: { type: 'string', default: null, nullable: true },
    inkEdgeWidth: { type: 'float', default: 1, min: 0, max: 8, hardRange: [0, 8], designerRange: [0, 4], aiRange: [0.75, 2.5] },
    inkEdgeIntensity: { type: 'float', default: 1, min: 0, max: 4, hardRange: [0, 4], designerRange: [0, 3], aiRange: [0.6, 1.8] },
    inkBleed: { type: 'float', default: 0, min: 0, max: 1, hardRange: [0, 1], designerRange: [0, 0.7], aiRange: [0, 0.3] },
  },
  cost: { instructions: 'low', textureReads: 0, drawCalls: 1 },
  compatibleWith: OVERRIDE_COMPATIBLE,
  incompatibleWith: ['Glass'],
  stateBindings: [],
  forbidden: ['inkEdgeWidth > 4', 'inkEdgeIntensity > 3'],
  notes: [
    'Ink edges should emphasize silhouettes without covering the model.',
    'Keep generated edge width within readable gameplay limits.',
    'Do not generate parameters outside the allowed ranges.',
  ],
  getEffectBatchKey(params = {}) {
    return `WhiteStroke|${hashStable(params)}`;
  },
};

export const OVERRIDE_LAYER_MANIFESTS = [
  Glass,
  InkSurface,
  WhiteStroke,
  Petrify,
];
