import * as THREE from 'three';
import { ParticleEngine, type ParticleEmitter } from '@voxel-studio/render-runtime/effects';
import type { RuntimeWeather } from '../shared/weather';

const MAX_PARTICLES_PER_PRECIPITATION_KIND = 1024;

const DISABLED_WEATHER: RuntimeWeather = {
  enabled: false,
  preset: 'clear',
  intensity: 0,
  skyDim: 1,
  sunDim: 1,
  ambientDim: 1,
  fogDensity: 0,
  precipitation: 0,
  precipitationKind: 'none',
  wetness: 0,
  lightning: false,
  wind: 0,
  flakeSize: 1,
  snowCover: 0,
  transitionSeconds: 0,
  timeOfDay: 13,
  daySpeed: 0
};

export interface WeatherFrame extends RuntimeWeather {
  lightningFlash: number;
}

/** Camera-local precipitation and the small state machine behind weather transitions. */
export class WeatherRuntime {
  private readonly engine: ParticleEngine;
  private rain: ParticleEmitter | null = null;
  private snow: ParticleEmitter | null = null;
  private from = DISABLED_WEATHER;
  private target = DISABLED_WEATHER;
  private current = DISABLED_WEATHER;
  private transitionElapsed = 0;
  private quality = 1;
  private lightningFlash = 0;
  private nextLightning = 7;
  private snowFlakeSize = 1;

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly renderer: THREE.WebGLRenderer
  ) {
    this.engine = new ParticleEngine({ THREE, scene });
  }

  apply(weather: RuntimeWeather): void {
    this.from = this.current;
    this.target = weather;
    this.transitionElapsed = 0;
    if (weather.precipitationKind === 'rain') this.ensureRain();
    if (weather.precipitationKind === 'snow' && this.snow && Math.abs(weather.flakeSize - this.snowFlakeSize) > 0.001) {
      this.engine.remove(this.snow);
      this.snow = null;
    }
    if (weather.precipitationKind === 'snow') this.ensureSnow(weather.flakeSize);
  }

  update(deltaTime: number): WeatherFrame {
    const duration = this.target.transitionSeconds;
    this.transitionElapsed += Math.max(0, deltaTime);
    const progress = duration <= 0 ? 1 : smoothstep(THREE.MathUtils.clamp(this.transitionElapsed / duration, 0, 1));
    this.current = interpolateWeather(this.from, this.target, progress);
    if (this.current.daySpeed > 0) {
      this.current = {
        ...this.current,
        timeOfDay: (this.current.timeOfDay + deltaTime * this.current.daySpeed * 0.08) % 24
      };
      this.target = { ...this.target, timeOfDay: this.current.timeOfDay };
    }

    this.updatePrecipitationRates(progress);
    const position = this.camera.position;
    if (this.rain) this.rain.worldPos = [position.x, position.y + 9, position.z];
    if (this.snow) this.snow.worldPos = [position.x, position.y + 8, position.z];
    const viewportHeight = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    this.engine.update(Math.min(0.05, Math.max(0, deltaTime)), this.camera, null, viewportHeight);
    this.updateLightning(deltaTime);
    return { ...this.current, lightningFlash: this.lightningFlash };
  }

  setQuality(quality: number): void {
    this.quality = THREE.MathUtils.clamp(quality, 0.4, 1);
  }

  getStats(): { particles: number; capacity: number; drawCalls: number; quality: number } {
    const emitters = [this.rain, this.snow].filter((emitter): emitter is ParticleEmitter => !!emitter);
    return {
      particles: emitters.reduce((sum, emitter) => sum + emitter.alive, 0),
      capacity: emitters.reduce((sum, emitter) => sum + emitter.capacity, 0),
      drawCalls: emitters.filter((emitter) => emitter.alive > 0 || emitter.rate > 0).length,
      quality: this.quality
    };
  }

  dispose(): void {
    this.engine.dispose();
    this.rain = null;
    this.snow = null;
  }

  private ensureRain(): void {
    if (this.rain) return;
    this.rain = this.engine.spawn({
      renderMode: 'streak',
      rate: 0,
      duration: Number.POSITIVE_INFINITY,
      lifetime: [0.9, 1.25],
      maxCount: MAX_PARTICLES_PER_PRECIPITATION_KIND,
      emitShape: 'box',
      shapeSize: [14, 2, 14],
      velocity: { dir: [0.08, -1, 0.02], speed: [16, 20], spread: 0.04 },
      colorStart: [0.74, 0.84, 0.92],
      colorEnd: [0.56, 0.7, 0.82],
      alphaStart: 0.42,
      alphaEnd: 0.08,
      alphaCurve: 'easeIn',
      streakLength: 0.38,
      streakWidth: 0.014
    }, { worldPos: [0, 9, 0] });
  }

  private ensureSnow(flakeSize: number): void {
    if (this.snow) return;
    this.snowFlakeSize = flakeSize;
    this.snow = this.engine.spawn({
      renderMode: 'point',
      rate: 0,
      duration: Number.POSITIVE_INFINITY,
      lifetime: [5, 8],
      maxCount: MAX_PARTICLES_PER_PRECIPITATION_KIND,
      emitShape: 'box',
      shapeSize: [14, 2, 14],
      velocity: { dir: [0.12, -1, 0.04], speed: [1, 1.8], spread: 0.22 },
      acceleration: [0, -0.08, 0],
      wobble: [0.65, 0.7],
      colorStart: [1, 1, 1],
      colorEnd: [0.84, 0.92, 1],
      alphaStart: 0.9,
      alphaEnd: 0.15,
      alphaCurve: 'holdFade',
      meshSize: 0.075 * flakeSize,
      scaleStart: 1,
      scaleEnd: 0.8
    }, { worldPos: [0, 8, 0] });
  }

  private updatePrecipitationRates(progress: number): void {
    const contribution = (kind: 'rain' | 'snow'): number => {
      const from = this.from.precipitationKind === kind ? this.from.precipitation * (1 - progress) : 0;
      const target = this.target.precipitationKind === kind ? this.target.precipitation * progress : 0;
      return from + target;
    };
    const rainAmount = contribution('rain');
    const snowAmount = contribution('snow');
    if (rainAmount > 0) this.ensureRain();
    if (snowAmount > 0) this.ensureSnow(this.current.flakeSize);
    if (this.rain) this.rain.rate = 900 * rainAmount * this.quality;
    if (this.snow) this.snow.rate = 240 * snowAmount * this.quality;
    const windX = this.current.wind * 0.72;
    if (this.rain) setEmitterWind(this.rain, windX, 0.02);
    if (this.snow) setEmitterWind(this.snow, windX, 0.04);
  }

  private updateLightning(deltaTime: number): void {
    this.lightningFlash *= Math.exp(-deltaTime * 9);
    if (!this.current.lightning) {
      this.nextLightning = 7;
      return;
    }
    this.nextLightning -= deltaTime;
    if (this.nextLightning <= 0) {
      this.lightningFlash = 1;
      this.nextLightning = 5 + Math.random() * 9;
    }
  }
}

function setEmitterWind(emitter: ParticleEmitter, x: number, z: number): void {
  const velocity = emitter.config.velocity as { dir?: [number, number, number] } | undefined;
  if (velocity) velocity.dir = [x, -1, z];
}

function interpolateWeather(from: RuntimeWeather, target: RuntimeWeather, progress: number): RuntimeWeather {
  const number = (a: number, b: number): number => THREE.MathUtils.lerp(a, b, progress);
  return {
    ...target,
    enabled: progress < 1 ? from.enabled || target.enabled : target.enabled,
    intensity: number(from.intensity, target.intensity),
    skyDim: number(from.skyDim, target.skyDim),
    sunDim: number(from.sunDim, target.sunDim),
    ambientDim: number(from.ambientDim, target.ambientDim),
    fogDensity: number(from.fogDensity, target.fogDensity),
    precipitation: number(from.precipitation, target.precipitation),
    precipitationKind: progress < 0.5 ? from.precipitationKind : target.precipitationKind,
    wetness: number(from.wetness, target.wetness),
    wind: number(from.wind, target.wind),
    flakeSize: number(from.flakeSize, target.flakeSize),
    snowCover: number(from.snowCover, target.snowCover),
    timeOfDay: shortestHourLerp(from.timeOfDay, target.timeOfDay, progress),
    daySpeed: number(from.daySpeed, target.daySpeed),
    lightning: progress < 0.5 ? from.lightning : target.lightning
  };
}

function shortestHourLerp(from: number, to: number, progress: number): number {
  let difference = to - from;
  if (difference > 12) difference -= 24;
  if (difference < -12) difference += 24;
  return (from + difference * progress + 24) % 24;
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}
