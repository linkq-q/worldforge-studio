import { createId } from './map';

export const COLOR_PALETTE_ROLES = [
  'primary', 'secondary', 'accent', 'plant',
  'earth', 'water', 'atmosphere', 'effect'
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
  roles?: Partial<Record<ColorPaletteRole, unknown>> & Record<string, unknown>;
};

const ROLE_HINTS: Record<ColorPaletteRole, { pattern: RegExp; anchor: string }> = {
  primary: { pattern: /主色|主体|主要|primary|main|body|base|crown|帽冠/i, anchor: '#f1d7b2' },
  secondary: { pattern: /辅色|次要|secondary|support|brim|band|帽檐|帽带|边框|边缘|trim/i, anchor: '#8e664d' },
  accent: { pattern: /强调|点缀|徽章|标志|纹样|花纹|accent|badge|emblem|detail|button|window|glass/i, anchor: '#f06b3e' },
  plant: { pattern: /绿色植物|植物|草|叶|树冠|藤|苔藓|灌木|plant|grass|leaf|foliage|vine|moss|shrub|tree/i, anchor: '#76904c' },
  earth: { pattern: /泥土|沙|岩|石|树干|树皮|大地|土壤|地面|道路|earth|soil|sand|rock|stone|trunk|bark|ground|road|paving/i, anchor: '#b89269' },
  water: { pattern: /水|泡沫|浪花|water|foam|wave|aqua/i, anchor: '#4bafca' },
  atmosphere: { pattern: /天空|云|雾|大气|sky|cloud|fog|mist|atmosphere/i, anchor: '#76d0f2' },
  effect: { pattern: /特效|火焰|能量|警示|发光|灯光|effect|fire|flame|energy|warning|glow|light/i, anchor: '#f06b3e' }
};

const LEGACY_ROLE_MAP: Record<string, ColorPaletteRole> = {
  'building.wall': 'primary', 'building.roof': 'secondary', 'building.trim': 'secondary',
  'building.window': 'accent', 'terrain.ground': 'earth', 'terrain.road': 'earth',
  'terrain.rock': 'earth', 'vegetation.grass': 'plant', 'vegetation.foliage': 'plant',
  water: 'water', 'environment.sky': 'atmosphere', 'environment.fog': 'atmosphere',
  lighting: 'effect', effect: 'effect'
};

const LEGACY_ROLE_SOURCES: Record<ColorPaletteRole, string[]> = {
  primary: ['building.wall', 'terrain.ground'],
  secondary: ['building.roof', 'building.trim', 'terrain.road', 'terrain.rock'],
  accent: ['building.window', 'lighting', 'effect'],
  plant: ['vegetation.grass', 'vegetation.foliage'],
  earth: ['terrain.ground', 'terrain.road', 'terrain.rock', 'building.wall', 'building.roof', 'building.trim'],
  water: ['water'],
  atmosphere: ['environment.sky', 'environment.fog'],
  effect: ['effect', 'lighting']
};

const COLOR_WORDS: Array<[RegExp, string]> = [
  [/(?:海军蓝|藏蓝|\bnavy(?: blue)?\b)/i, '#163A70'],
  [/(?:奶油白|米白|\b(?:cream|ivory)\b)/i, '#FFF2D0'],
  [/(?:白色?|\bwhite\b)/i, '#FFFFFF'],
  [/(?:黑色?|\bblack\b)/i, '#111111'],
  [/(?:灰色?|灰白|\b(?:gray|grey)\b)/i, '#808080'],
  [/(?:棕色?|褐色?|\bbrown\b)/i, '#8B5A2B'],
  [/(?:橙色?|橘色?|\borange\b)/i, '#F06B3E'],
  [/(?:红色?|\bred\b)/i, '#E53935'],
  [/(?:黄色?|金黄|\byellow\b)/i, '#F6E24B'],
  [/(?:青色?|\b(?:cyan|teal)\b)/i, '#22B8CF'],
  [/(?:蓝色?|\bblue\b)/i, '#2563EB'],
  [/(?:绿色?|\bgreen\b)/i, '#49A050'],
  [/(?:紫色?|\b(?:purple|violet)\b)/i, '#7C3AED'],
  [/(?:粉色?|\bpink\b)/i, '#EC4899']
];

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
    const legacy = LEGACY_ROLE_SOURCES[role]
      .flatMap((source) => normalizeHexList(input.roles?.[source], colors));
    return [role, requested.length > 0 ? requested : legacy.length > 0 ? uniqueHexes(legacy) : automatic[role]];
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
  const matches = text.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
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
  const roles = Object.fromEntries(COLOR_PALETTE_ROLES.map((role) => {
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
  return roles;
}

export function pickPaletteColor(
  palette: ColorPalette,
  role: ColorPaletteRole | string,
  key: string,
  salt = 0
): string {
  const normalizedRole = normalizePaletteRole(role);
  const pool = palette.roles[normalizedRole]?.length > 0
    ? palette.roles[normalizedRole]
    : palette.colors.map((entry) => entry.hex);
  return pool[(stableHash(`${key}:${normalizedRole}:${salt}`) % pool.length + pool.length) % pool.length];
}

export function pickPaletteColorForSource(
  palette: ColorPalette,
  role: ColorPaletteRole | string,
  source: string,
  variantKey: string
): string {
  const normalizedRole = normalizePaletteRole(role);
  const pool = palette.roles[normalizedRole]?.length > 0
    ? palette.roles[normalizedRole]
    : palette.colors.map((entry) => entry.hex);
  const ranked = [...pool].sort((a, b) => colorDistance(a, source) - colorDistance(b, source));
  return ranked[stableHash(variantKey) % Math.min(2, ranked.length)];
}

export function nearestPaletteColor(
  palette: ColorPalette,
  source: string,
  role?: ColorPaletteRole | string
): string {
  const normalizedRole = role ? normalizePaletteRole(role) : null;
  const pool = normalizedRole && palette.roles[normalizedRole]?.length > 0
    ? palette.roles[normalizedRole]
    : palette.colors.map((entry) => entry.hex);
  return [...pool].sort((a, b) => colorDistance(a, source) - colorDistance(b, source))[0];
}

/** Resolve an explicit color word from user/model semantic text before role fallback. */
export function inferPaletteColorIntent(text: string): string | null {
  const value = String(text || '');
  return COLOR_WORDS.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

/** Deterministically snap model colors to a palette while preserving material shape and texture metadata. */
export function applyPaletteToModelJson(modelJson: unknown, paletteInput: ColorPaletteInput | ColorPalette): Record<string, unknown> {
  const palette = normalizeColorPalette(paletteInput);
  const output = JSON.parse(JSON.stringify(modelJson && typeof modelJson === 'object' ? modelJson : {})) as Record<string, unknown>;
  const report = {
    appliedMaterials: 0,
    appliedVertexColors: 0,
    skippedTextures: 0,
    explicitIntentColors: 0,
    sourceColors: 0,
    semanticFallbacks: 0,
    usedColors: [] as string[]
  };
  const roots = [output.nodes, output.meshes, output.parts].flatMap((value) => Array.isArray(value) ? value : []);
  const byId = new Map(roots.filter(isRecord).flatMap((node) => typeof node.id === 'string' ? [[node.id, node] as const] : []));
  const visited = new Set<object>();
  const used = new Set<string>();
  const tagValue = (node: Record<string, unknown>, tagName: string): unknown => {
    const tags = Array.isArray(node.tags) ? node.tags : [];
    const tag = tags.find((entry) => isRecord(entry) && entry.tag === tagName);
    return tag && isRecord(tag) ? tag.value : null;
  };
  const inheritedTag = (node: Record<string, unknown>, tagName: string): unknown => {
    const seen = new Set<Record<string, unknown>>();
    let current: Record<string, unknown> | undefined = node;
    while (current && !seen.has(current)) {
      seen.add(current);
      const value = tagValue(current, tagName);
      if (value != null) return value;
      current = typeof current.parent === 'string' ? byId.get(current.parent) : undefined;
    }
    return null;
  };
  const sourceHex = (value: unknown): string | null => {
    if (typeof value === 'string') return normalizeHex(value);
    if (typeof value === 'number' && Number.isFinite(value)) return `#${(Math.max(0, Math.min(0xffffff, Math.round(value))) >>> 0).toString(16).padStart(6, '0')}`.toUpperCase();
    if (Array.isArray(value) && value.length >= 3) {
      const channels = value.slice(0, 3).map((channel) => Math.round(Math.max(0, Math.min(1, Number(channel))) * 255));
      return channels.every(Number.isFinite) ? `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase() : null;
    }
    return null;
  };
  const preserveType = (hex: string, source: unknown): unknown => {
    if (typeof source === 'number') return Number.parseInt(hex.slice(1), 16);
    if (Array.isArray(source)) {
      const value = Number.parseInt(hex.slice(1), 16);
      return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
    }
    return hex;
  };
  const applyNode = (value: unknown, index: number, inheritedRole?: ColorPaletteRole, inheritedIntent?: string): void => {
    if (!isRecord(value) || visited.has(value)) return;
    visited.add(value);
    const semantic = [value.id, value.name, value.label, value.description, value.tags]
      .flatMap((entry) => Array.isArray(entry) ? entry.map((tag) => isRecord(tag) ? `${String(tag.tag ?? '')} ${String(tag.value ?? '')}` : String(tag)) : [entry])
      .filter(Boolean).join(' ');
    const roleValue = inheritedTag(value, 'palette');
    const role = typeof roleValue === 'string'
      ? normalizePaletteRole(roleValue)
      : inheritedRole ?? inferPaletteRole(semantic);
    const intentValue = inheritedTag(value, 'palette-color');
    const intent = (typeof intentValue === 'string' ? normalizeHex(intentValue) : null)
      ?? inferPaletteColorIntent(semantic)
      ?? inheritedIntent;
    const targetFor = (source: unknown, key: string): string => {
      const explicit = intent ?? null;
      if (explicit) { report.explicitIntentColors += 1; return nearestPaletteColor(palette, explicit); }
      const sourceValue = sourceHex(source);
      if (sourceValue) { report.sourceColors += 1; return nearestPaletteColor(palette, sourceValue, role); }
      report.semanticFallbacks += 1;
      return pickPaletteColor(palette, role, `${String(value.id ?? value.name ?? 'part')}:${index}:${key}`);
    };
    const setColor = (owner: Record<string, unknown>, key: string, suffix: string): void => {
      const source = owner[key];
      if (source == null) return;
      if (key === 'color' && owner.map) { report.skippedTextures += 1; return; }
      const target = targetFor(source, suffix);
      owner[key] = preserveType(target, source);
      report.appliedMaterials += 1;
      used.add(target);
    };
    const mesh = isRecord(value.mesh) ? value.mesh : null;
    const material = mesh && isRecord(mesh.material) ? mesh.material : isRecord(value.material) ? value.material : null;
    if (material) setColor(material, 'color', 'material');
    if (mesh) setColor(mesh, 'color', 'mesh');
    setColor(value, 'color', 'node');
    if (Array.isArray(value.vertexColors)) value.vertexColors = value.vertexColors.map((source, vertexIndex) => {
      const target = targetFor(source, `vertex:${vertexIndex}`);
      used.add(target);
      report.appliedVertexColors += 1;
      return preserveType(target, source);
    });
    for (const collection of [value.shapes, value.voxels, value.boxes]) {
      if (Array.isArray(collection)) collection.filter(isRecord).forEach((item, itemIndex) => setColor(item, 'color', `item:${itemIndex}`));
    }
    if (Array.isArray(value.children)) value.children.forEach((child, childIndex) => applyNode(child, childIndex, role, intent ?? undefined));
  };
  roots.forEach((node, index) => applyNode(node, index));
  report.usedColors = [...used].sort();
  output._meta = {
    ...(isRecord(output._meta) ? output._meta : {}),
    colorPalette: normalizeColorPalette(palette),
    colorPaletteReport: report
  };
  return output;
}

export function paletteGenerationBrief(palette: ColorPalette, semanticText = ''): string {
  const roles = generationPaletteRoles(semanticText);
  const pools = roles.map((role) => `${role}=${sampleRoleColors(palette.roles[role], 3).join('|')}`).join('; ');
  return [
    `Palette intent for this asset only (${palette.name}): ${pools}.`,
    `Tag visible parts with the matching palette role (${roles.join('|')}); preserve glass, metal, water, transparency and emission properties.`
  ].join('\n').slice(0, 390);
}

function generationPaletteRoles(semanticText: string): ColorPaletteRole[] {
  const text = semanticText.toLowerCase();
  const roles = COLOR_PALETTE_ROLES.filter((role) => ROLE_HINTS[role].pattern.test(text) || text.includes(role));
  const add = (role: ColorPaletteRole) => {
    if (!roles.includes(role)) roles.push(role);
  };
  if (/(?:tree|pine|fir|树|松|杉)/i.test(text)) {
    add('plant');
    add('earth');
  }
  if (/(?:building|house|cabin|hut|shop|tower|gate|wall|屋|房|建筑|塔|门|墙)/i.test(text)) {
    add('primary');
    add('secondary');
    add('accent');
  }
  if (roles.length === 0) return ['primary', 'secondary', 'accent'];
  return roles.slice(0, 3);
}

function sampleRoleColors(colors: readonly string[], limit: number): string[] {
  if (colors.length <= limit) return [...colors];
  return [...new Set([colors[0], colors[Math.floor(colors.length / 2)], colors[colors.length - 1]])].slice(0, limit);
}

export function inferPaletteRole(text: string, building = false): ColorPaletteRole {
  const normalized = text.toLowerCase();
  const ordered: ColorPaletteRole[] = ['plant', 'earth', 'water', 'atmosphere', 'effect', 'accent', 'secondary', 'primary'];
  for (const role of ordered) {
    if (ROLE_HINTS[role].pattern.test(normalized) || normalized.includes(role)) return role;
  }
  return building ? 'primary' : 'secondary';
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
  if (typeof value !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(value.trim())) return null;
  const raw = value.trim().slice(1);
  if (raw.length === 3) return `#${raw.split('').map((channel) => channel + channel).join('')}`.toUpperCase();
  if (raw.length !== 6) return null;
  return `#${raw}`.toUpperCase();
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
  if (role !== 'primary' && role !== 'earth') return true;
  return hsl(rgb(hex))[2] >= 0.6;
}

export function normalizePaletteRole(value: string): ColorPaletteRole {
  return COLOR_PALETTE_ROLES.includes(value as ColorPaletteRole)
    ? value as ColorPaletteRole
    : LEGACY_ROLE_MAP[value] ?? 'primary';
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
