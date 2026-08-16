import type { RoomSurface } from './map';

export const INTERIOR_SURFACE_RECIPES = [
  'paint.solid',
  'plaster.soft',
  'wallpaper.stripe',
  'wallpaper.geometric',
  'wood.plank',
  'wood.herringbone',
  'tile.ceramic',
  'tile.stone',
  'carpet.loop',
  'ceiling.panel',
  'glass.panel'
] as const;

export type InteriorSurfaceRecipe = typeof INTERIOR_SURFACE_RECIPES[number];

export interface SurfaceFinishRecipe {
  recipe: InteriorSurfaceRecipe;
  seed: number;
  scale: number;
  rotation: 0 | 90;
  palette: string[];
  jointWidth: number;
  variation: number;
  roughness: number;
}

export interface ProceduralRug {
  id: string;
  shape: 'rectangle' | 'round' | 'runner';
  center: [number, number];
  size: [number, number];
  rotation: 0 | 90;
  pattern: 'border' | 'stripe' | 'geometric' | 'woven';
  palette: string[];
  seed: number;
}

export const INTERIOR_FINISH_LOCKS = ['master', 'walls', 'floor', 'carpet', 'rugs'] as const;
export type InteriorFinishLock = typeof INTERIOR_FINISH_LOCKS[number];

export interface InteriorFinishSettings {
  enabled: boolean;
  wallsEnabled: boolean;
  floorEnabled: boolean;
  carpetEnabled: boolean;
  rugsEnabled: boolean;
  /** Editor application scope. `true` applies a wall edit to all four room walls. */
  uniformWalls: boolean;
  locked: InteriorFinishLock[];
  /** Retained independently so disabling full-room carpet reveals the stored hard floor. */
  carpet: SurfaceFinishRecipe;
}

export interface InteriorArtDirection {
  summary: string;
  styleKeywords: string[];
  palette: string[];
  materialKeywords: string[];
  decorDensity: number;
  focalPoint: string;
  surfaces: Record<RoomSurface, SurfaceFinishRecipe>;
  rugs: ProceduralRug[];
  finishSettings: InteriorFinishSettings;
}

export type InteriorArtDirectionInput = Omit<Partial<InteriorArtDirection>, 'surfaces' | 'finishSettings'> & {
  surfaces?: Partial<Record<RoomSurface, Partial<SurfaceFinishRecipe>>>;
  finishSettings?: Partial<Omit<InteriorFinishSettings, 'carpet'>> & { carpet?: Partial<SurfaceFinishRecipe> };
};

const DEFAULT_SURFACES: Record<RoomSurface, InteriorSurfaceRecipe> = {
  floor: 'wood.plank',
  ceiling: 'paint.solid',
  north: 'plaster.soft',
  south: 'plaster.soft',
  east: 'plaster.soft',
  west: 'plaster.soft'
};

export function normalizeInteriorArtDirection(
  value: InteriorArtDirectionInput | null | undefined,
  seed = 0
): InteriorArtDirection | null {
  if (!value || typeof value !== 'object') return null;
  const palette = normalizePalette(value.palette, ['#d8c7a6', '#9f7652', '#6e5544', '#e7dfce']);
  const rawSurfaces: Partial<Record<RoomSurface, Partial<SurfaceFinishRecipe>>> =
    value.surfaces && typeof value.surfaces === 'object' ? value.surfaces : {};
  const legacyCarpet = rawSurfaces.floor?.recipe === 'carpet.loop';
  const surfaces = Object.fromEntries((['floor', 'ceiling', 'north', 'south', 'east', 'west'] as RoomSurface[])
    .map((surface, index) => [surface, normalizeSurfaceFinish(
      surface === 'floor' && legacyCarpet ? undefined : rawSurfaces[surface],
      DEFAULT_SURFACES[surface],
      seed + index * 97,
      palette
    )])) as Record<RoomSurface, SurfaceFinishRecipe>;
  const rawSettings = value.finishSettings && typeof value.finishSettings === 'object'
    ? value.finishSettings as Partial<InteriorFinishSettings>
    : undefined;
  const wallSurfaces: RoomSurface[] = ['north', 'south', 'east', 'west'];
  const wallpaper = wallSurfaces.map((surface) => surfaces[surface]).find((surface) => surface.recipe.startsWith('wallpaper.'));
  const allowsAccentWall = /accent wall|feature wall|single wall|局部墙|单面墙|背景墙/i.test(value.summary ?? '');
  if (wallpaper && rawSettings?.uniformWalls !== false && !allowsAccentWall) {
    for (const surface of wallSurfaces) surfaces[surface] = { ...wallpaper };
  }
  const glassRoom = /conservatory|greenhouse|glass room|sunroom|玻璃植物房|温室|阳光房/i.test([
    value.summary,
    ...(value.styleKeywords ?? []),
    ...(value.materialKeywords ?? [])
  ].filter(Boolean).join(' '));
  if (glassRoom) surfaces.ceiling = normalizeSurfaceFinish(
    { recipe: 'glass.panel', palette }, 'glass.panel', seed + 701, palette
  );
  const finishSettings: InteriorFinishSettings = {
    enabled: rawSettings?.enabled !== false,
    wallsEnabled: rawSettings?.wallsEnabled !== false,
    floorEnabled: typeof rawSettings?.floorEnabled === 'boolean' ? rawSettings.floorEnabled : !legacyCarpet,
    carpetEnabled: typeof rawSettings?.carpetEnabled === 'boolean' ? rawSettings.carpetEnabled : legacyCarpet,
    rugsEnabled: rawSettings?.rugsEnabled !== false,
    uniformWalls: rawSettings?.uniformWalls !== false,
    locked: normalizeFinishLocks(rawSettings?.locked),
    carpet: normalizeSurfaceFinish(
      rawSettings?.carpet ?? (legacyCarpet ? rawSurfaces.floor : undefined),
      'carpet.loop',
      seed + 809,
      palette
    )
  };
  return {
    summary: cleanText(value.summary, 'coherent indoor art direction', 240),
    styleKeywords: normalizeTextList(value.styleKeywords, 8, 40),
    palette,
    materialKeywords: normalizeTextList(value.materialKeywords, 8, 40),
    decorDensity: clampNumber(value.decorDensity, 0.62, 0.25, 0.9),
    focalPoint: cleanText(value.focalPoint, '', 120),
    surfaces,
    rugs: Array.isArray(value.rugs)
      ? value.rugs.slice(0, 4).flatMap((rug, index) => {
          if (!rug || typeof rug !== 'object') return [];
          const raw = rug as Partial<ProceduralRug>;
          const shape = raw.shape === 'round' || raw.shape === 'runner' ? raw.shape : 'rectangle';
          const pattern = raw.pattern === 'stripe' || raw.pattern === 'geometric' || raw.pattern === 'woven'
            ? raw.pattern
            : 'border';
          return [{
            id: cleanText(raw.id, `rug-${index + 1}`, 80),
            shape,
            center: normalizePair(raw.center, [0, 0], -1, 1),
            size: normalizePair(raw.size, shape === 'runner' ? [0.3, 0.75] : [0.55, 0.42], 0.12, 0.9),
            rotation: raw.rotation === 90 ? 90 : 0,
            pattern,
            palette: normalizePalette(raw.palette, palette),
            seed: Math.trunc(clampNumber(raw.seed, seed + index * 131, 0, 0xffffffff)) >>> 0
          }];
        })
      : [],
    finishSettings
  };
}

export function activeInteriorSurfaceFinish(
  direction: InteriorArtDirection | null | undefined,
  surface: RoomSurface
): SurfaceFinishRecipe | undefined {
  if (!direction) return undefined;
  if (surface === 'ceiling') return direction.surfaces.ceiling;
  const settings = direction.finishSettings;
  if (!settings.enabled) return undefined;
  if (surface === 'floor') {
    if (settings.carpetEnabled) return settings.carpet;
    return settings.floorEnabled ? direction.surfaces.floor : undefined;
  }
  return settings.wallsEnabled ? direction.surfaces[surface] : undefined;
}

export function activeInteriorRugs(direction: InteriorArtDirection | null | undefined): ProceduralRug[] {
  return direction?.finishSettings.enabled && direction.finishSettings.rugsEnabled ? direction.rugs : [];
}

export function mergeInteriorArtDirectionWithLocks(
  current: InteriorArtDirection | null | undefined,
  incoming: InteriorArtDirectionInput,
  seed = 0
): InteriorArtDirection | null {
  const next = normalizeInteriorArtDirection(incoming, seed);
  const previous = normalizeInteriorArtDirection(current, seed);
  if (!next || !previous || previous.finishSettings.locked.length === 0) return next;
  const locked = new Set(previous.finishSettings.locked);
  if (locked.has('master')) next.finishSettings.enabled = previous.finishSettings.enabled;
  if (locked.has('walls')) {
    for (const wall of ['north', 'south', 'east', 'west'] as const) next.surfaces[wall] = { ...previous.surfaces[wall] };
    next.finishSettings.wallsEnabled = previous.finishSettings.wallsEnabled;
    next.finishSettings.uniformWalls = previous.finishSettings.uniformWalls;
  }
  if (locked.has('floor')) {
    next.surfaces.floor = { ...previous.surfaces.floor };
    next.finishSettings.floorEnabled = previous.finishSettings.floorEnabled;
  }
  if (locked.has('carpet')) {
    next.finishSettings.carpet = { ...previous.finishSettings.carpet };
    next.finishSettings.carpetEnabled = previous.finishSettings.carpetEnabled;
  }
  if (locked.has('rugs')) {
    next.rugs = previous.rugs.map((rug) => ({ ...rug, center: [...rug.center], size: [...rug.size], palette: [...rug.palette] }));
    next.finishSettings.rugsEnabled = previous.finishSettings.rugsEnabled;
  }
  next.finishSettings.locked = [...previous.finishSettings.locked];
  return normalizeInteriorArtDirection(next, seed);
}

function normalizeSurfaceFinish(
  value: Partial<SurfaceFinishRecipe> | undefined,
  fallback: InteriorSurfaceRecipe,
  seed: number,
  palette: string[]
): SurfaceFinishRecipe {
  const recipe = INTERIOR_SURFACE_RECIPES.includes(value?.recipe as InteriorSurfaceRecipe)
    ? value!.recipe as InteriorSurfaceRecipe
    : fallback;
  return {
    recipe,
    seed: Math.trunc(clampNumber(value?.seed, seed, 0, 0xffffffff)) >>> 0,
    scale: clampNumber(value?.scale, defaultScale(recipe), 0.08, 3),
    rotation: value?.rotation === 90 ? 90 : 0,
    palette: normalizePalette(value?.palette, palette),
    jointWidth: clampNumber(value?.jointWidth, 0.018, 0, 0.12),
    variation: clampNumber(value?.variation, 0.12, 0, 0.35),
    roughness: clampNumber(value?.roughness, defaultRoughness(recipe), 0.2, 1)
  };
}

function normalizeFinishLocks(value: unknown): InteriorFinishLock[] {
  if (!Array.isArray(value)) return [];
  return INTERIOR_FINISH_LOCKS.filter((lock) => value.includes(lock));
}

function defaultScale(recipe: InteriorSurfaceRecipe): number {
  if (recipe === 'wood.plank' || recipe === 'wood.herringbone') return 0.42;
  if (recipe === 'tile.ceramic' || recipe === 'tile.stone' || recipe === 'ceiling.panel' || recipe === 'glass.panel') return 0.48;
  if (recipe === 'wallpaper.stripe' || recipe === 'wallpaper.geometric') return 0.32;
  return 0.5;
}

function defaultRoughness(recipe: InteriorSurfaceRecipe): number {
  if (recipe === 'tile.ceramic') return 0.48;
  if (recipe === 'tile.stone') return 0.76;
  if (recipe === 'carpet.loop') return 0.96;
  if (recipe === 'glass.panel') return 0.18;
  return 0.82;
}

function normalizePalette(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const colors = value.filter((entry): entry is string => typeof entry === 'string' && /^#[0-9a-f]{6}$/i.test(entry)).slice(0, 6);
  return colors.length >= 2 ? colors : [...fallback];
}

function normalizeTextList(value: unknown, limit: number, length: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry.trim().slice(0, length)] : []).slice(0, limit);
}

function normalizePair(value: unknown, fallback: [number, number], min: number, max: number): [number, number] {
  if (!Array.isArray(value) || value.length < 2) return [...fallback];
  return [clampNumber(value[0], fallback[0], min, max), clampNumber(value[1], fallback[1], min, max)];
}

function cleanText(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
