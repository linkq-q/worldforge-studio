import * as THREE from 'three';
import fireTextureUrl from './assets/vfx_fire_4x4.png?url';
import sparkTextureUrl from './assets/vfx_spark_4x4.png?url';

export interface MaterialTagFireEntry {
  value?: number;
  variant?: string;
}

export interface MaterialTagFireVocabulary {
  runtime?: {
    companion?: {
      overridesByVariant?: Record<string, {
        innerColor?: number[];
        outerColor?: number[];
      }>;
    };
  };
}

export const MATERIAL_TAG_FIRE_PARAMS = Object.freeze({
  densityScale: 1,
  sizeScale: 1.35,
  plumeSpread: 1,
  pathParticleScale: 2.2,
  pathSpread: 1,
  jetLengthScale: 1,
  jetWidthScale: 2.5,
  jetSpeedScale: 1,
  jetSpread: 0.3,
  jetLiftStrength: 0.45,
  jetTurbulence: 0.29,
  sparkScale: 1.25,
  flicker: 0.31,
  coreColor: '#dd643c',
  bodyColor: '#ff5900',
  edgeColor: '#8e1e0b'
});

const INTENSITY = Object.freeze({
  weak: Object.freeze({ density: 0.65, brightness: 0.9, coverage: 0.8, motion: 0.8 }),
  medium: Object.freeze({ density: 1, brightness: 1, coverage: 1, motion: 1 }),
  strong: Object.freeze({ density: 1.35, brightness: 1.1, coverage: 1.2, motion: 1.2 })
});

type ParticleConfig = Record<string, unknown>;

/**
 * Exact regular-flame recipe used by 3d-generate's material-tag controller.
 * Jet/path authoring is intentionally left to the source editor; current
 * WorldForge assets all use compact replacement groups.
 */
export function createMaterialTagFireConfigs(
  object: THREE.Object3D,
  entry: MaterialTagFireEntry,
  vocabulary: MaterialTagFireVocabulary
): ParticleConfig[] {
  const anchor = measureReplacementAnchor(object);
  const sourceFootprint = Math.max(0.05, anchor.footprintRadius);
  const sourceHeight = Math.max(0.15, anchor.size.y);
  const visualFootprint = curveDimension(sourceFootprint, 0.42, 0.7, 0.55, 2);
  const visualHeight = curveDimension(sourceHeight, 1.2, 0.6, 0.45, 2);
  const value = Number.isFinite(entry.value) ? Number(entry.value) : 0.75;
  const profile = value <= 0.25
    ? { intensity: INTENSITY.weak, valueScale: 0.5, embersOnly: true }
    : value <= 0.5
      ? { intensity: INTENSITY.weak, valueScale: 1, embersOnly: false }
      : value >= 1
        ? { intensity: INTENSITY.strong, valueScale: 1, embersOnly: false }
        : { intensity: INTENSITY.medium, valueScale: 1, embersOnly: false };
  const intensity = {
    ...profile.intensity,
    density: profile.intensity.density
      * MATERIAL_TAG_FIRE_PARAMS.densityScale
      * profile.valueScale
      * Math.min(3, Math.max(1, sourceFootprint / visualFootprint))
  };
  const sizeScale = MATERIAL_TAG_FIRE_PARAMS.sizeScale * profile.valueScale;
  const footprint = visualFootprint * sizeScale;
  const birthFootprint = sourceFootprint * sizeScale;
  const height = visualHeight * sizeScale;
  const palette = resolvePalette(entry.variant, vocabulary, intensity.brightness);
  const common = {
    footprint,
    birthFootprint,
    height,
    intensity,
    palette,
    plumeSpread: MATERIAL_TAG_FIRE_PARAMS.plumeSpread,
    surfaceY: anchor.bottomY,
    surfaceCenter: [anchor.center.x, anchor.center.z] as [number, number]
  };

  if (profile.embersOnly) return [sparkConfig(common)];
  return [...flameBodyConfigs(common), escapeTongueConfig(common), sparkConfig(common)];
}

function measureReplacementAnchor(object: THREE.Object3D): {
  size: THREE.Vector3;
  center: THREE.Vector3;
  footprintRadius: number;
  bottomY: number;
} {
  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) {
    return {
      size: new THREE.Vector3(1, 1, 1),
      center: new THREE.Vector3(0, 0, 0),
      footprintRadius: Math.SQRT1_2,
      bottomY: -0.5
    };
  }
  const origin = object.getWorldPosition(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3()).sub(origin);
  return {
    size,
    center,
    footprintRadius: Math.hypot(size.x * 0.5, size.z * 0.5),
    bottomY: center.y - size.y * 0.5
  };
}

function curveDimension(
  value: number,
  reference: number,
  exponent: number,
  minRatio: number,
  maxRatio: number
): number {
  const ratio = value / reference;
  const visualRatio = ratio < 1
    ? Math.max(minRatio, Math.pow(ratio, exponent))
    : Math.min(maxRatio, ratio);
  return reference * visualRatio;
}

function flameBodyConfigs(common: ResolvedFireRecipe): ParticleConfig[] {
  const { footprint, birthFootprint, height, intensity, palette, plumeSpread, surfaceY, surfaceCenter } = common;
  const coreLifetime: [number, number] = [0.9, 1.1];
  const coreSpeed: [number, number] = [0.08 * intensity.motion, 0.16 * intensity.motion];
  const bodyLifetime: [number, number] = [1.05, 1.35];
  const bodySpeed: [number, number] = [0.12 * intensity.motion, 0.22 * intensity.motion];
  const offset = [surfaceCenter[0], surfaceY + 0.05, surfaceCenter[1]];
  return [
    {
      renderMode: 'point', map: fireTextureUrl, mapFrames: [4, 4], mapFps: 1,
      emitShape: 'box',
      shapeSize: [birthFootprint * 0.45 * intensity.coverage * plumeSpread, 0.04, birthFootprint * 0.45 * intensity.coverage * plumeSpread],
      offset,
      rate: scaledCount(18, intensity.density), maxCount: scaledCount(180, intensity.density),
      lifetime: coreLifetime,
      velocity: { mode: 'cone', dir: [0, 1, 0], speed: coreSpeed, spread: 0.22 * plumeSpread },
      acceleration: [0, solveBuoyancy(height * 0.65, average(coreLifetime), average(coreSpeed)), 0],
      meshSize: readablePointSize(Math.max(0.2, Math.min(height * 0.78, footprint * 1.15)), 0.32),
      scaleStart: 0, scaleEnd: 3.5, sizeCurve: 'easeOut',
      colorStart: palette.core, colorEnd: palette.darkBody,
      alphaStart: 1, alphaEnd: 0, additive: true, flicker: 0.18
    },
    {
      renderMode: 'point', map: fireTextureUrl, mapFrames: [4, 4], mapFps: 1,
      emitShape: 'box',
      shapeSize: [birthFootprint * 0.78 * intensity.coverage * plumeSpread, 0.04, birthFootprint * 0.78 * intensity.coverage * plumeSpread],
      offset,
      rate: scaledCount(28, intensity.density), maxCount: scaledCount(320, intensity.density),
      lifetime: bodyLifetime,
      velocity: { mode: 'cone', dir: [0, 1, 0], speed: bodySpeed, spread: 0.34 * plumeSpread },
      acceleration: [0, solveBuoyancy(height, average(bodyLifetime), average(bodySpeed)), 0],
      meshSize: readablePointSize(Math.max(0.28, Math.min(height, footprint * 1.5)), 0.42),
      scaleStart: 0, scaleEnd: 3.5, sizeCurve: 'easeOut',
      colorStart: palette.vividBody, colorEnd: palette.darkBody,
      alphaStart: 1, alphaEnd: 0, additive: true, flicker: 0.32
    }
  ];
}

function escapeTongueConfig(common: ResolvedFireRecipe): ParticleConfig {
  const { footprint, birthFootprint, height, intensity, palette, plumeSpread, surfaceY, surfaceCenter } = common;
  const lifetime: [number, number] = [0.35, 0.5];
  const speed: [number, number] = [0.12 * intensity.motion, Math.min(0.3, 0.24 * intensity.motion)];
  return {
    renderMode: 'point', map: fireTextureUrl, mapFrames: [4, 4], mapFps: 14,
    emitShape: 'box',
    shapeSize: [birthFootprint * 0.35 * intensity.coverage * plumeSpread, 0.06, birthFootprint * 0.35 * intensity.coverage * plumeSpread],
    offset: [surfaceCenter[0], surfaceY + height * 0.5, surfaceCenter[1]],
    rate: scaledCount(6, intensity.density, 1), maxCount: scaledCount(72, intensity.density),
    lifetime,
    velocity: { mode: 'cone', dir: [0, 1, 0], speed, spread: 0.26 * plumeSpread },
    acceleration: [0, solveBuoyancy(height * 0.35, average(lifetime), average(speed)), 0],
    meshSize: readablePointSize(Math.max(0.16, Math.min(height * 0.58, footprint * 0.85)), 0.28),
    scaleStart: 0.68, scaleEnd: 0, sizeCurve: 'easeOut',
    colorStart: palette.accent, colorEnd: palette.body,
    alphaStart: 0.9, alphaEnd: 0, additive: true, flicker: 0.45
  };
}

function sparkConfig(common: ResolvedFireRecipe): ParticleConfig {
  const { footprint, birthFootprint, height, intensity, palette, plumeSpread, surfaceY, surfaceCenter } = common;
  return {
    renderMode: 'point', map: sparkTextureUrl, mapFrames: [4, 4], mapFps: 14,
    emitShape: 'box',
    shapeSize: [birthFootprint * 0.55 * intensity.coverage * plumeSpread, 0.08, birthFootprint * 0.55 * intensity.coverage * plumeSpread],
    offset: [surfaceCenter[0], surfaceY + height * 0.18, surfaceCenter[1]],
    rate: Math.min(12, scaledCount(7, intensity.density, 1)), maxCount: scaledCount(64, intensity.density),
    lifetime: [0.3, 0.75],
    velocity: { mode: 'cone', dir: [0, 1, 0], speed: [0.8, 2.2 * intensity.motion], spread: 0.58 * plumeSpread },
    acceleration: [0, -0.8, 0],
    meshSize: readablePointSize(Math.max(0.05, Math.min(0.16, footprint * 0.18))),
    scaleStart: 0.8, scaleEnd: 0, sizeCurve: 'easeOut',
    colorStart: palette.accent, colorEnd: palette.core,
    alphaStart: 1, alphaEnd: 0, additive: true, flicker: 0.6
  };
}

interface ResolvedFireRecipe {
  footprint: number;
  birthFootprint: number;
  height: number;
  intensity: { density: number; brightness: number; coverage: number; motion: number };
  palette: { core: number[]; body: number[]; vividBody: number[]; darkBody: number[]; accent: number[] };
  plumeSpread: number;
  surfaceY: number;
  surfaceCenter: [number, number];
}

function resolvePalette(variant: string | undefined, vocabulary: MaterialTagFireVocabulary, brightness: number): ResolvedFireRecipe['palette'] {
  const override = variant && variant !== 'normal'
    ? vocabulary.runtime?.companion?.overridesByVariant?.[variant]
    : undefined;
  const bodySource = validColor(override?.outerColor) ?? hexColor(MATERIAL_TAG_FIRE_PARAMS.bodyColor);
  const coreSource = validColor(override?.innerColor) ?? hexColor(MATERIAL_TAG_FIRE_PARAMS.coreColor);
  const darkSource = override ? undefined : hexColor(MATERIAL_TAG_FIRE_PARAMS.edgeColor);
  const body = withValue(bodySource, clamp(0.72 * brightness, 0.6, 0.8));
  const vividBody = vividHueColor(bodySource);
  const darkBody = darkSource ?? darkHueColor(bodySource);
  const accentSource = mix(body, [1, 1, 1], 0.4);
  return {
    core: withValue(coreSource, clamp(Math.max(0.92, colorValue(coreSource)), 0.9, 1)),
    body,
    vividBody,
    darkBody,
    accent: withValue(accentSource, clamp(Math.max(0.9, colorValue(accentSource)), 0.9, 1))
  };
}

function hexColor(value: string): number[] {
  return [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
}

function validColor(value: number[] | undefined): number[] | null {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
    ? value.map((channel) => clamp(channel, 0, 1))
    : null;
}

function colorValue(color: number[]): number { return Math.max(...color); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number(value) || 0)); }
function mix(a: number[], b: number[], t: number): number[] { return a.map((value, index) => value + (b[index] - value) * t); }
function vividHueColor(source: number[]): number[] {
  const min = Math.min(...source);
  const range = Math.max(...source) - min;
  return range <= 1e-6 ? [...source] : source.map((channel) => clamp((channel - min) / range, 0, 1));
}
function withValue(source: number[], target: number): number[] {
  const current = colorValue(source);
  return current <= 0 ? [target, target, target] : source.map((channel) => clamp(channel * target / current, 0, 1));
}
function darkHueColor(source: number[]): number[] { return withValue(vividHueColor(source), 0.3); }
function average(range: [number, number]): number { return (range[0] + range[1]) * 0.5; }
function solveBuoyancy(targetHeight: number, lifetime: number, initialSpeed: number): number {
  const distance = Math.max(0.01, targetHeight);
  const time = Math.max(0.05, lifetime);
  return Math.max(0, (2 * (distance - initialSpeed * time)) / (time * time));
}
function readablePointSize(value: number, minimum = 0.24): number { return Math.max(minimum, Math.max(0, value) * 1.5); }
function scaledCount(base: number, scale: number, minimum = 8): number { return Math.max(minimum, Math.round(base * scale)); }
