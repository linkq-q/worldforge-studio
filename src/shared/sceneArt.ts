import { compileSimpleShaderExpression } from './simpleShader';
import type { RenderPlan } from './renderPlan';

export type ColorStop = [number, string];
export const SCENE_ART_MODULES = ['runtime.color-field', 'runtime.local-light', 'runtime.surface-detail', 'runtime.wet-surface'] as const;
export type SceneArtModuleId = typeof SCENE_ART_MODULES[number];
export interface ColorField {
  zoneId?: string;
  target: 'ground-and-grass' | 'terrain' | 'grass';
  axis: 'x' | 'z' | 'radial';
  center: [number, number];
  start: number;
  end: number;
  feather: number;
  strength: number;
  stops: ColorStop[];
}
export interface LocalArtLight {
  objectId: string;
  kind: 'point' | 'spot';
  color: string;
  intensity: number;
  range: number;
  offset: [number, number, number];
  targetId?: string;
  enabled: boolean;
}
export interface SurfaceDetail {
  objectId: string;
  partId?: string;
  color?: string;
  roughness?: number;
  metalness?: number;
  transmission?: number;
  colorExpression?: string;
  emissionExpression?: string;
}
export interface WetSurface {
  zoneId: string;
  strength: number;
  distortion: number;
}
export interface SceneArtPlan {
  colors: ColorField[];
  lights: LocalArtLight[];
  surfaces: SurfaceDetail[];
  wet: WetSurface[];
}

export function normalizeColorStops(input: unknown): ColorStop[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > 4) throw new Error('color_stops_require_2_to_4');
  const stops = input.map((entry): ColorStop => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('invalid_color_stop');
    return [number(entry[0], 0, 1), color(entry[1])];
  });
  if (stops[0][0] !== 0 || stops.at(-1)![0] !== 1 || stops.some((s, i) => i > 0 && s[0] - stops[i - 1][0] < 0.001)) throw new Error('color_stops_must_increase_from_0_to_1');
  return stops;
}

export function sampleColorRamp(stops: ColorStop[], value: number): string {
  const t = Math.max(0, Math.min(1, value));
  const upper = stops.findIndex(stop => stop[0] >= t);
  if (upper <= 0) return stops[0][1];
  const [a, b] = [stops[upper - 1], stops[upper]];
  const blend = (t - a[0]) / (b[0] - a[0]);
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(a[1].slice(i, i + 2), 16) * (1 - blend) + parseInt(b[1].slice(i, i + 2), 16) * blend).toString(16).padStart(2, '0')).join('');
}

export function normalizeSceneArtConfig(id: SceneArtModuleId, value: unknown): ColorField | LocalArtLight | SurfaceDetail | WetSurface {
  const raw = typeof value === 'string' ? JSON.parse(value) : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_scene_art_config');
  const r = raw as Record<string, unknown>;
  const allow = (keys: string[]) => { if (Object.keys(r).some(key => !keys.includes(key))) throw new Error('unknown_scene_art_field'); };
  if (id === 'runtime.color-field') {
    allow(['zoneId', 'target', 'axis', 'center', 'start', 'end', 'feather', 'strength', 'stops']);
    const start = number(r.start ?? 0, -10000, 10000), end = number(r.end ?? 10, -10000, 10000);
    if (end <= start) throw new Error('invalid_color_field_interval');
    return { ...(r.zoneId ? { zoneId: identifier(r.zoneId) } : {}), target: choice(r.target, ['ground-and-grass', 'terrain', 'grass'], 'ground-and-grass'), axis: choice(r.axis, ['x', 'z', 'radial'], 'x'), center: vector(r.center ?? [0, 0], 2) as [number, number], start, end, feather: number(r.feather ?? 1, 0.01, 20), strength: number(r.strength ?? 1, 0, 1), stops: normalizeColorStops(r.stops) };
  }
  if (id === 'runtime.local-light') {
    allow(['objectId', 'kind', 'color', 'intensity', 'range', 'offset', 'targetId', 'enabled']);
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw new Error('invalid_light_enabled');
    return { objectId: identifier(r.objectId), kind: choice(r.kind, ['point', 'spot'], 'point'), color: color(r.color ?? '#ffd878'), intensity: number(r.intensity ?? 5, 0.5, 12), range: number(r.range ?? 7, 1, 20), offset: vector(r.offset ?? [0, 1, 0], 3) as [number, number, number], ...(r.targetId ? { targetId: identifier(r.targetId) } : {}), enabled: r.enabled !== false };
  }
  if (id === 'runtime.wet-surface') {
    allow(['zoneId', 'strength', 'distortion']);
    return { zoneId: identifier(r.zoneId), strength: number(r.strength ?? 0.3, 0, 0.65), distortion: number(r.distortion ?? 0.002, 0, 0.01) };
  }
  allow(['objectId', 'partId', 'color', 'roughness', 'metalness', 'transmission', 'colorExpression', 'emissionExpression']);
  const result: SurfaceDetail = { objectId: identifier(r.objectId), ...(r.partId ? { partId: identifier(r.partId) } : {}) };
  if (r.color !== undefined) result.color = color(r.color);
  for (const key of ['roughness', 'metalness', 'transmission'] as const) if (r[key] !== undefined) result[key] = number(r[key], 0, 1);
  for (const key of ['colorExpression', 'emissionExpression'] as const) if (r[key] !== undefined) {
    if (typeof r[key] !== 'string') throw new Error('invalid_simple_shader_expression');
    compileSimpleShaderExpression(r[key]);
    result[key] = r[key];
  }
  return result;
}

export function compileSceneArt(plan?: RenderPlan): SceneArtPlan {
  const result: SceneArtPlan = { colors: [], lights: [], surfaces: [], wet: [] };
  for (const module of plan?.modules ?? []) {
    if (!SCENE_ART_MODULES.includes(module.id as SceneArtModuleId)) continue;
    if (module.params.config === '') continue; // An empty developer rule is an inactive draft, not an AI output.
    const config = normalizeSceneArtConfig(module.id as SceneArtModuleId, module.params.config);
    if (module.id === 'runtime.color-field') result.colors.push(config as ColorField);
    if (module.id === 'runtime.local-light') result.lights.push(config as LocalArtLight);
    if (module.id === 'runtime.surface-detail') result.surfaces.push(config as SurfaceDetail);
    if (module.id === 'runtime.wet-surface') result.wet.push(config as WetSurface);
  }
  if (result.colors.length > 4 || result.lights.length > 8 || result.surfaces.length > 16 || result.wet.length > 1) throw new Error('scene_art_budget_exceeded');
  return result;
}

function color(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('invalid_scene_art_color');
  return value.toLowerCase();
}
function number(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('scene_art_number_out_of_range');
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_:.-]{1,120}$/.test(value)) throw new Error('invalid_scene_art_id');
  return value;
}
function vector(value: unknown, size: number): number[] {
  if (!Array.isArray(value) || value.length !== size) throw new Error('invalid_scene_art_vector');
  return value.map(v => number(v, -10000, 10000));
}
function choice<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!values.includes(value as T)) throw new Error('invalid_scene_art_choice');
  return value as T;
}
