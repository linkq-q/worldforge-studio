import type { RenderPlan } from './renderPlan';

export interface OutdoorLightingSettings {
  quality: number;
  skyQuality: number;
  shadowQuality: number;
  edgeSoftening: number;
  roughnessScale: number;
  sunAzimuth: number;
  sunElevation: number;
  shadowSoftness: number;
  haze: number;
  clouds: number;
  bounce: number;
  materialDetail: number;
  reflections: number;
}

export function compileOutdoorLighting(plan?: RenderPlan): OutdoorLightingSettings | null {
  const params = plan?.modules.find(module => module.id === 'runtime.outdoor-lighting')?.params;
  if (!params) return null;
  const number = (name: string, fallback: number, min = 0, max = 1) => {
    const value = params[name];
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value)) : fallback;
  };
  return {
    quality: Math.round(number('quality', 1, 1, 2)),
    skyQuality: Math.round(number('skyQuality', 1, 1, 4)),
    shadowQuality: Math.round(number('shadowQuality', 1, 1, 2)),
    edgeSoftening: number('edgeSoftening', 0, 0, 0.15),
    roughnessScale: number('roughnessScale', 1, 0.5, 1.5),
    sunAzimuth: number('sunAzimuth', -45, -180, 180),
    sunElevation: number('sunElevation', 32, 5, 85),
    shadowSoftness: number('shadowSoftness', 0.45),
    haze: number('haze', 0.24), clouds: number('clouds', 0.4),
    bounce: number('bounce', 0.25), materialDetail: number('materialDetail', 0.65),
    reflections: number('reflections', 0.6)
  };
}
