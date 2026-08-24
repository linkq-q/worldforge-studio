import { createId } from './map';

export const COLOR_PALETTE_ROLES = [
  'building.wall',
  'building.roof',
  'building.trim',
  'building.window',
  'terrain.ground',
  'terrain.road',
  'terrain.rock',
  'vegetation.grass',
  'vegetation.foliage',
  'water',
  'environment.sky',
  'environment.fog',
  'lighting',
  'effect'
] as const;

export type ColorPaletteRole = typeof COLOR_PALETTE_ROLES[number];
export type ColorPaletteLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface ColorPaletteColor {
  hex: string;
  family?: string;
  level?: ColorPaletteLevel;
  token?: string;
  usage?: string;
}

export interface ColorPalette {
  id: string;
  name: string;
  description: string;
  version: 1;
  colors: ColorPaletteColor[];
  roles: Record<ColorPaletteRole, string[]>;
  lockedColors: string[];
  excludedAssetIds: string[];
  excludedTags: string[];
  createdAt: number;
  updatedAt: number;
}

export type ColorPaletteInput = Partial<Omit<ColorPalette, 'colors' | 'roles'>> & {
  colors?: unknown;
  roles?: Partial<Record<ColorPaletteRole, unknown>>;
};

const ROLE_HINTS: Record<ColorPaletteRole, { pattern: RegExp; anchor: string }> = {
  'building.wall': { pattern: /墙|墙体|建筑面|wall|facade|plaster|brick/i, anchor: '#f1d7b2' },
  'building.roof': { pattern: /屋顶|房顶|roof|瓦|结构深色/i, anchor: '#714d48' },
  'building.trim': { pattern: /装饰|边饰|窗框|门框|结构|金属|阳台|雨棚|招牌|栏杆|trim|frame|wood|metal|balcony|awning|signboard|railing/i, anchor: '#8e664d' },
  'building.window': { pattern: /窗|玻璃|window|glass/i, anchor: '#76d0f2' },
  'terrain.ground': { pattern: /地面|沙地|土|ground|sand|soil/i, anchor: '#f1d7b2' },
  'terrain.road': { pattern: /道路|路面|砖地|石板|road|street|paving/i, anchor: '#e7c393' },
  'terrain.rock': { pattern: /岩|石|rock|stone/i, anchor: '#8e8b82' },
  'vegetation.grass': { pattern: /草|草坪|grass|meadow/i, anchor: '#aeb85b' },
  'vegetation.foliage': { pattern: /树|树叶|叶面|植被|foliage|leaf|plant/i, anchor: '#76904c' },
  water: { pattern: /水体|水面|深水|water|aqua/i, anchor: '#4bafca' },
  'environment.sky': { pattern: /天空|sky|云边/i, anchor: '#76d0f2' },
  'environment.fog': { pattern: /雾|薄雾|fog|mist|奶油白/i, anchor: '#eaf9ff' },
  lighting: { pattern: /灯光|暖光|高光|light|highlight/i, anchor: '#ffd170' },
  effect: { pattern: /特效|警示|受击|按钮|动作|effect|warning|cta/i, anchor: '#f06b3e' }
};

export function createColorPalette(input: ColorPaletteInput): ColorPalette {
  const now = Date.now();
  return normalizeColorPalette({
    ...input,
    id: createId('palette'),
    createdAt: now,
    updatedAt: now
  });
}

export function normalizeColorPalette(input: ColorPaletteInput): ColorPalette {
  const now = Date.now();
  const colors = normalizeColors(input.colors);
  if (colors.length < 2 || colors.length > 256) throw new Error('palette_requires_2_to_256_colors');
  const automatic = autoAssignPaletteRoles(colors);
  const roles = Object.fromEntries(COLOR_PALETTE_ROLES.map((role) => {
    const requested = normalizeHexList(input.roles?.[role], colors);
    return [role, requested.length > 0 ? requested : automatic[role]];
  })) as Record<ColorPaletteRole, string[]>;
  return {
    id: cleanText(input.id, createId('palette'), 80),
    name: cleanText(input.name, '未命名色卡', 60),
    description: cleanText(input.description, '', 240),
    version: 1,
    colors,
    roles,
    lockedColors: normalizeHexList(input.lockedColors, colors),
    excludedAssetIds: normalizeTokens(input.excludedAssetIds),
    excludedTags: normalizeTokens(input.excludedTags),
    createdAt: finiteNumber(input.createdAt, now),
    updatedAt: finiteNumber(input.updatedAt, now)
  };
}

export function parseHexPalette(text: string): ColorPaletteColor[] {
  const matches = text.match(/#[0-9a-f]{6}\b/gi) ?? [];
  return normalizeColors(matches);
}

export function inferPaletteLevel(hex: string): ColorPaletteLevel {
  const lightness = hsl(rgb(hex))[2];
  if (lightness >= 0.88) return 'L1';
  if (lightness >= 0.76) return 'L2';
  if (lightness >= 0.62) return 'L3';
  if (lightness >= 0.46) return 'L4';
  return 'L5';
}

export function autoAssignPaletteRoles(
  colors: readonly ColorPaletteColor[]
): Record<ColorPaletteRole, string[]> {
  return Object.fromEntries(COLOR_PALETTE_ROLES.map((role) => {
    const hint = ROLE_HINTS[role];
    const eligible = colors.filter((entry) => roleColorAllowed(role, entry.hex));
    const candidates = eligible.length >= Math.min(2, colors.length) ? eligible : colors;
    const described = candidates.filter((entry) => hint.pattern.test([
      entry.family,
      entry.token,
      entry.usage
    ].filter(Boolean).join(' ')));
    const ranked = [...candidates].sort((a, b) => (
      colorDistance(a.hex, hint.anchor) - colorDistance(b.hex, hint.anchor)
    ));
    const pool = uniqueHexes([...described, ...ranked].map((entry) => entry.hex));
    return [role, pool.slice(0, Math.min(8, Math.max(2, Math.ceil(colors.length / 8))))];
  })) as Record<ColorPaletteRole, string[]>;
}

export function pickPaletteColor(
  palette: ColorPalette,
  role: ColorPaletteRole,
  key: string,
  salt = 0
): string {
  const pool = palette.roles[role]?.length > 0
    ? palette.roles[role]
    : palette.colors.map((entry) => entry.hex);
  return pool[(stableHash(`${key}:${role}:${salt}`) % pool.length + pool.length) % pool.length];
}

export function pickPaletteColorForSource(
  palette: ColorPalette,
  role: ColorPaletteRole,
  source: string,
  variantKey: string
): string {
  const pool = palette.roles[role]?.length > 0
    ? palette.roles[role]
    : palette.colors.map((entry) => entry.hex);
  const ranked = [...pool].sort((a, b) => colorDistance(a, source) - colorDistance(b, source));
  return ranked[stableHash(variantKey) % Math.min(2, ranked.length)];
}

export function nearestPaletteColor(
  palette: ColorPalette,
  source: string,
  role?: ColorPaletteRole
): string {
  const pool = role && palette.roles[role]?.length > 0
    ? palette.roles[role]
    : palette.colors.map((entry) => entry.hex);
  return [...pool].sort((a, b) => colorDistance(a, source) - colorDistance(b, source))[0];
}

export function paletteGenerationBrief(palette: ColorPalette): string {
  const colors = palette.colors.map((entry) => entry.hex).join(', ');
  const roles = COLOR_PALETTE_ROLES.map((role) => `${role}=${palette.roles[role].join('|')}`).join('; ');
  return [
    `[Color palette: ${palette.name}]`,
    `Use these colors for generated asset base and vertex colors: ${colors}.`,
    `Semantic pools: ${roles}.`,
    'Name every visual part semantically and add a tag object {"tag":"palette","value":"building.wall|building.roof|building.trim|building.window|terrain.rock|vegetation.foliage|effect"} when applicable.',
    'Preserve glass, metal, water, transparency and emissive material behavior; the palette controls color, not material physics.'
  ].join('\n').slice(0, 3900);
}

export function inferPaletteRole(text: string, building = false): ColorPaletteRole {
  const normalized = text.toLowerCase();
  const ordered: ColorPaletteRole[] = [
    'building.window', 'building.roof', 'building.trim', 'terrain.road', 'terrain.rock',
    'vegetation.grass', 'vegetation.foliage', 'water', 'effect', 'building.wall'
  ];
  for (const role of ordered) {
    if (ROLE_HINTS[role].pattern.test(normalized) || normalized.includes(role)) return role;
  }
  return building ? 'building.wall' : 'building.trim';
}

function normalizeColors(value: unknown): ColorPaletteColor[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const colors: ColorPaletteColor[] = [];
  for (const item of value) {
    const source = typeof item === 'string' ? { hex: item } : isRecord(item) ? item : null;
    const hex = normalizeHex(source?.hex);
    if (!source || !hex || seen.has(hex)) continue;
    seen.add(hex);
    const level = /^L[1-5]$/.test(String(source.level ?? '')) ? source.level as ColorPaletteLevel : undefined;
    colors.push({
      hex,
      family: cleanOptionalText(source.family, 60),
      level,
      token: cleanOptionalText(source.token, 80),
      usage: cleanOptionalText(source.usage, 240)
    });
  }
  return colors;
}

function normalizeHexList(value: unknown, colors: readonly ColorPaletteColor[]): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(colors.map((entry) => entry.hex));
  return uniqueHexes(value.map(normalizeHex).filter((hex): hex is string => Boolean(hex && allowed.has(hex))));
}

function normalizeTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase().slice(0, 80))
    .filter(Boolean))]
    .slice(0, 128);
}

function uniqueHexes(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeHex).filter((value): value is string => Boolean(value)))];
}

function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) return null;
  return value.trim().toUpperCase();
}

function colorDistance(a: string, b: string): number {
  const left = rgb(a);
  const right = rgb(b);
  const leftHsl = hsl(left);
  const rightHsl = hsl(right);
  const hueDelta = Math.min(Math.abs(leftHsl[0] - rightHsl[0]), 360 - Math.abs(leftHsl[0] - rightHsl[0]));
  const huePenalty = hueDelta ** 2 * Math.min(leftHsl[1], rightHsl[1]) * 20;
  return (left[0] - right[0]) ** 2 * 0.3
    + (left[1] - right[1]) ** 2 * 0.59
    + (left[2] - right[2]) ** 2 * 0.11
    + huePenalty;
}

function roleColorAllowed(role: ColorPaletteRole, hex: string): boolean {
  if (role !== 'building.wall' && role !== 'terrain.ground' && role !== 'terrain.road') return true;
  return hsl(rgb(hex))[2] >= 0.6;
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16 & 0xff, value >> 8 & 0xff, value & 0xff];
}

function hsl([red, green, blue]: [number, number, number]): [number, number, number] {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = max === r
    ? 60 * (((g - b) / delta) % 6)
    : max === g
      ? 60 * ((b - r) / delta + 2)
      : 60 * ((r - g) / delta + 4);
  return [(hue + 360) % 360, saturation, lightness];
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}
