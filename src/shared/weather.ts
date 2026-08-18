import type { RenderPlan } from './renderPlan';

export type WeatherPreset = 'clear' | 'overcast' | 'rain' | 'snow' | 'storm';
export type PrecipitationKind = 'none' | 'rain' | 'snow';

interface WeatherPresetTarget {
  skyDim: number;
  sunDim: number;
  ambientDim: number;
  fogDensity: number;
  precipitation: number;
  precipitationKind: PrecipitationKind;
  wetness: number;
  lightning: boolean;
}

const WEATHER_PRESETS: Record<WeatherPreset, WeatherPresetTarget> = {
  clear: { skyDim: 1, sunDim: 1, ambientDim: 1, fogDensity: 0, precipitation: 0, precipitationKind: 'none', wetness: 0, lightning: false },
  overcast: { skyDim: 0.76, sunDim: 0.58, ambientDim: 0.96, fogDensity: 0.0015, precipitation: 0, precipitationKind: 'none', wetness: 0.12, lightning: false },
  rain: { skyDim: 0.58, sunDim: 0.4, ambientDim: 0.86, fogDensity: 0.003, precipitation: 0.7, precipitationKind: 'rain', wetness: 0.82, lightning: false },
  snow: { skyDim: 0.84, sunDim: 0.52, ambientDim: 1.04, fogDensity: 0.0022, precipitation: 0.6, precipitationKind: 'snow', wetness: 0.08, lightning: false },
  storm: { skyDim: 0.4, sunDim: 0.24, ambientDim: 0.72, fogDensity: 0.006, precipitation: 1, precipitationKind: 'rain', wetness: 1, lightning: true }
};

export interface RuntimeWeather {
  enabled: boolean;
  preset: WeatherPreset;
  intensity: number;
  skyDim: number;
  sunDim: number;
  ambientDim: number;
  fogDensity: number;
  precipitation: number;
  precipitationKind: PrecipitationKind;
  wetness: number;
  lightning: boolean;
  wind: number;
  flakeSize: number;
  snowCover: number;
  transitionSeconds: number;
  timeOfDay: number;
  daySpeed: number;
}

export function compileRuntimeWeather(plan?: RenderPlan | null): RuntimeWeather {
  const module = plan?.modules.find((item) => item.id === 'runtime.weather');
  const params = module?.params ?? {};
  const preset = weatherPreset(params.preset);
  const target = WEATHER_PRESETS[preset];
  const intensity = clamp(number(params.intensity, 1), 0, 1);
  return {
    enabled: !!module,
    preset,
    intensity,
    skyDim: mix(1, target.skyDim, intensity),
    sunDim: mix(1, target.sunDim, intensity),
    ambientDim: mix(1, target.ambientDim, intensity),
    fogDensity: target.fogDensity * intensity,
    precipitation: target.precipitation * intensity,
    precipitationKind: target.precipitationKind,
    wetness: target.wetness * intensity,
    lightning: target.lightning && intensity > 0.5,
    wind: clamp(number(params.wind, 0), -1, 1),
    flakeSize: clamp(number(params.flakeSize, 1), 0.5, 2),
    snowCover: clamp(number(params.snowCover, preset === 'snow' ? 0.75 : 0), 0, 1),
    transitionSeconds: clamp(number(params.transitionSeconds, 6), 0, 30),
    timeOfDay: clamp(number(params.timeOfDay, 13), 0, 24),
    daySpeed: clamp(number(params.daySpeed, 0), 0, 1)
  };
}

function weatherPreset(value: unknown): WeatherPreset {
  return value === 'overcast' || value === 'rain' || value === 'snow' || value === 'storm' ? value : 'clear';
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mix(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
