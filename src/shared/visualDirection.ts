export const VISUAL_DIRECTION_VERSION = 1 as const;

export const CONTRAST_MODES = ['bright-cartoon', 'colored-shadow', 'dramatic'] as const;
export const VISUAL_TIMES_OF_DAY = ['morning', 'noon', 'evening', 'night'] as const;
export const VISUAL_TEMPERATURES = ['cool', 'warm'] as const;
export const VISUAL_ZONE_TAGS = ['grass', 'forest', 'water', 'lowland', 'dry', 'sand', 'settlement', 'rocky'] as const;

export type ContrastMode = typeof CONTRAST_MODES[number];
export type VisualTimeOfDay = typeof VISUAL_TIMES_OF_DAY[number];
export type VisualTemperature = typeof VISUAL_TEMPERATURES[number];
export type VisualZoneTag = typeof VISUAL_ZONE_TAGS[number];
export const VISUAL_ZONE_FIELDS = ['center', 'radius', 'tags', 'intensity'] as const;
export type VisualZoneField = typeof VISUAL_ZONE_FIELDS[number];

export interface VisualPalette {
  sky: string;
  keyLight: string;
  fillLight: string;
  shadow: string;
  fog: string;
  waterBias: string;
  accent: string;
}

export interface AtmosphereFxIntent {
  masterStrength: number;
  pollen: number;
  vapor: number;
  dust: number;
  sand?: number;
}

/** Render-scheme-owned semantic source of truth. */
export interface VisualDirection {
  version: 1;
  contrastMode: ContrastMode;
  timeOfDay: VisualTimeOfDay;
  temperature: VisualTemperature;
  palette: VisualPalette;
  atmosphereFx: AtmosphereFxIntent;
}

export interface SceneVisualZone {
  id: string;
  tags: VisualZoneTag[];
  center: [number, number];
  radius: number;
  intensity: number;
  /** Fields manually edited by the user and therefore preserved during AI recompute. */
  locks?: Partial<Record<VisualZoneField, true>>;
}

export interface SceneWindField {
  direction: [number, number];
  speed: number;
  gustStrength: number;
  gustFrequency: number;
}

/** Map-owned spatial semantics. Coordinates and radii are in world units. */
export interface MapVisualSemantics {
  version: 1;
  zones: SceneVisualZone[];
  wind: SceneWindField;
}

export interface CompiledVisualDirection {
  contrastMode: ContrastMode;
  lightRig: {
    recipe: 'hard-day' | 'soft-morning' | 'backlit' | 'sunset' | 'night';
    strength: number;
    warmth: number;
    shadowSoftness: number;
  };
  colorGrade: {
    contrast: number;
    saturation: number;
    shadowLift: number;
    temperature: number;
    tint: string;
  };
  surfaceShadowFloor: number;
  palette: VisualPalette;
  atmosphereFx: AtmosphereFxIntent;
}

const DEFAULT_PALETTE: VisualPalette = {
  sky: '#9cc7d5',
  keyLight: '#fff0ce',
  fillLight: '#eaf6ff',
  shadow: '#405066',
  fog: '#a9c8ce',
  waterBias: '#77aebc',
  accent: '#d8ef75'
};

export const DEFAULT_VISUAL_DIRECTION: VisualDirection = Object.freeze({
  version: VISUAL_DIRECTION_VERSION,
  contrastMode: 'bright-cartoon',
  timeOfDay: 'noon',
  temperature: 'warm',
  palette: Object.freeze({ ...DEFAULT_PALETTE }),
  atmosphereFx: Object.freeze({
    masterStrength: 0.35,
    pollen: 0,
    vapor: 0,
    dust: 0,
    sand: 0
  })
});

export const DEFAULT_MAP_VISUAL_SEMANTICS: MapVisualSemantics = Object.freeze({
  version: VISUAL_DIRECTION_VERSION,
  zones: [],
  wind: Object.freeze({
    direction: [1, 0.25] as [number, number],
    speed: 0.22,
    gustStrength: 0.18,
    gustFrequency: 0.12
  })
});

export function normalizeVisualDirection(input: unknown): VisualDirection {
  const raw = objectValue(input);
  const palette = objectValue(raw.palette);
  const atmosphereFx = objectValue(raw.atmosphereFx);
  return {
    version: VISUAL_DIRECTION_VERSION,
    contrastMode: enumValue(raw.contrastMode, CONTRAST_MODES, DEFAULT_VISUAL_DIRECTION.contrastMode),
    timeOfDay: enumValue(raw.timeOfDay, VISUAL_TIMES_OF_DAY, DEFAULT_VISUAL_DIRECTION.timeOfDay),
    temperature: enumValue(raw.temperature, VISUAL_TEMPERATURES, DEFAULT_VISUAL_DIRECTION.temperature),
    palette: {
      sky: colorValue(palette.sky, DEFAULT_PALETTE.sky),
      keyLight: colorValue(palette.keyLight, DEFAULT_PALETTE.keyLight),
      fillLight: colorValue(palette.fillLight, DEFAULT_PALETTE.fillLight),
      shadow: colorValue(palette.shadow, DEFAULT_PALETTE.shadow),
      fog: colorValue(palette.fog, DEFAULT_PALETTE.fog),
      waterBias: colorValue(palette.waterBias, DEFAULT_PALETTE.waterBias),
      accent: colorValue(palette.accent, DEFAULT_PALETTE.accent)
    },
    atmosphereFx: {
      masterStrength: numberValue(atmosphereFx.masterStrength, DEFAULT_VISUAL_DIRECTION.atmosphereFx.masterStrength, 0, 1),
      pollen: numberValue(atmosphereFx.pollen, 0, 0, 1),
      vapor: numberValue(atmosphereFx.vapor, 0, 0, 1),
      dust: numberValue(atmosphereFx.dust, 0, 0, 1),
      sand: numberValue(atmosphereFx.sand, 0, 0, 1)
    }
  };
}

export function normalizeMapVisualSemantics(input: unknown): MapVisualSemantics {
  const raw = objectValue(input);
  const wind = objectValue(raw.wind);
  const zones = Array.isArray(raw.zones)
    ? raw.zones.map(normalizeVisualZone).filter((zone): zone is SceneVisualZone => Boolean(zone)).slice(0, 24)
    : [];
  return {
    version: VISUAL_DIRECTION_VERSION,
    zones,
    wind: {
      direction: unitDirection(wind.direction, DEFAULT_MAP_VISUAL_SEMANTICS.wind.direction),
      speed: numberValue(wind.speed, DEFAULT_MAP_VISUAL_SEMANTICS.wind.speed, 0, 2),
      gustStrength: numberValue(wind.gustStrength, DEFAULT_MAP_VISUAL_SEMANTICS.wind.gustStrength, 0, 1),
      gustFrequency: numberValue(wind.gustFrequency, DEFAULT_MAP_VISUAL_SEMANTICS.wind.gustFrequency, 0.01, 2)
    }
  };
}

export function compileVisualDirection(input: VisualDirection): CompiledVisualDirection {
  const direction = normalizeVisualDirection(input);
  const temperature = direction.temperature === 'warm' ? 0.14 : -0.14;
  const mode = direction.contrastMode;
  const timingRecipe = direction.timeOfDay === 'morning'
    ? 'soft-morning'
    : direction.timeOfDay === 'evening'
      ? 'sunset'
      : direction.timeOfDay === 'night'
        ? 'night'
        : 'hard-day';
  if (mode === 'dramatic') {
    return {
      contrastMode: mode,
      lightRig: {
        recipe: direction.timeOfDay === 'night' ? 'night' : direction.timeOfDay === 'evening' ? 'sunset' : 'backlit',
        strength: 1.08,
        warmth: temperature,
        shadowSoftness: 0.2
      },
      colorGrade: { contrast: 1.18, saturation: 1.02, shadowLift: 0.025, temperature, tint: direction.palette.accent },
      surfaceShadowFloor: 0.24,
      palette: direction.palette,
      atmosphereFx: direction.atmosphereFx
    };
  }
  if (mode === 'colored-shadow') {
    return {
      contrastMode: mode,
      lightRig: { recipe: timingRecipe, strength: 1.02, warmth: temperature, shadowSoftness: 0.34 },
      colorGrade: { contrast: 1.12, saturation: 1.08, shadowLift: 0.05, temperature, tint: direction.palette.shadow },
      surfaceShadowFloor: 0.34,
      palette: direction.palette,
      atmosphereFx: direction.atmosphereFx
    };
  }
  return {
    contrastMode: mode,
    lightRig: { recipe: timingRecipe, strength: 1, warmth: temperature, shadowSoftness: 0.42 },
    colorGrade: { contrast: 1.08, saturation: 1.06, shadowLift: 0.07, temperature, tint: direction.palette.accent },
    surfaceShadowFloor: 0.42,
    palette: direction.palette,
    atmosphereFx: direction.atmosphereFx
  };
}

function normalizeVisualZone(value: unknown): SceneVisualZone | null {
  const raw = objectValue(value);
  const id = typeof raw.id === 'string' ? raw.id.trim().slice(0, 80) : '';
  if (!id) return null;
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.filter((tag): tag is VisualZoneTag => VISUAL_ZONE_TAGS.includes(tag as VisualZoneTag)))].slice(0, 8)
    : [];
  const rawLocks = objectValue(raw.locks);
  const locks = Object.fromEntries(VISUAL_ZONE_FIELDS
    .filter((field) => rawLocks[field] === true)
    .map((field) => [field, true])) as Partial<Record<VisualZoneField, true>>;
  return {
    id,
    tags,
    center: pairValue(raw.center, [0, 0]),
    radius: numberValue(raw.radius, 8, 0.5, 512),
    intensity: numberValue(raw.intensity, 1, 0, 1),
    ...(Object.keys(locks).length > 0 ? { locks } : {})
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}

function colorValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function pairValue(value: unknown, fallback: [number, number]): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return [...fallback];
  return [numberValue(value[0], fallback[0], -512, 512), numberValue(value[1], fallback[1], -512, 512)];
}

function unitDirection(value: unknown, fallback: [number, number]): [number, number] {
  const pair = pairValue(value, fallback);
  const length = Math.hypot(pair[0], pair[1]);
  return length > 0.0001 ? [pair[0] / length, pair[1] / length] : [...fallback];
}
