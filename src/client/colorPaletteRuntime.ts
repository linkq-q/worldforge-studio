import {
  inferPaletteLevel,
  pickPaletteColor,
  type ColorPalette,
  type ColorPaletteRole,
  type ColorPaletteLevel
} from '../shared/colorPalette';
import type {
  RuntimeEffectRecipe,
  RuntimeGrassStyle,
  RuntimeHdriSky,
  RuntimeWaterStyle
} from '../shared/renderPlan';
import type { RenderEnvironmentSettings } from '../shared/renderScheme';
import type { TerrainPaletteColors } from './terrainAppearance';

export function paletteEnvironment(
  palette: ColorPalette,
  fallback: RenderEnvironmentSettings
): RenderEnvironmentSettings {
  return {
    ...fallback,
    background: levelColor(palette, 'atmosphere', ['L3', 'L4'], 'background'),
    fogColor: levelColor(palette, 'atmosphere', ['L1', 'L2'], 'fog'),
    hemisphereSkyColor: levelColor(palette, 'atmosphere', ['L1', 'L2'], 'sky-light'),
    hemisphereGroundColor: levelColor(palette, 'earth', ['L4', 'L5'], 'ground-light'),
    sunColor: levelColor(palette, 'effect', ['L1', 'L2'], 'sun')
  };
}

export function paletteGrassStyle(palette: ColorPalette, style: RuntimeGrassStyle): RuntimeGrassStyle {
  return {
    ...style,
    rootColor: levelColor(palette, 'plant', ['L4', 'L5'], 'grass-root'),
    tipColor: levelColor(palette, 'plant', ['L1', 'L2', 'L3'], 'grass-tip'),
    groundColor: levelColor(palette, 'earth', ['L2', 'L3'], 'grass-ground')
  };
}

export function paletteWaterStyles(palette: ColorPalette, styles: RuntimeWaterStyle[]): RuntimeWaterStyle[] {
  const source = styles.length > 0
    ? styles
    : [{ scope: { target: 'water' as const, tag: 'water' }, recipe: 'calm-lake' as const }];
  return source.map((style, index) => ({
    ...style,
    color: levelColor(palette, 'water', ['L3', 'L4'], `water-${index}`),
    shallowColor: levelColor(palette, 'water', ['L1', 'L2'], `water-shallow-${index}`),
    depthColor: levelColor(palette, 'water', ['L4', 'L5'], `water-depth-${index}`),
    foamColor: levelColor(palette, 'atmosphere', ['L1'], `water-foam-${index}`)
  }));
}

export function paletteEffectRecipes(palette: ColorPalette, effects: RuntimeEffectRecipe[]): RuntimeEffectRecipe[] {
  return effects.map((effect, index) => ({
    ...effect,
    color: pickPaletteColor(palette, 'effect', effect.key || `effect-${index}`)
  }));
}

export function paletteHdriStyle(palette: ColorPalette, style: RuntimeHdriSky): RuntimeHdriSky {
  return {
    ...style,
    tint: levelColor(palette, 'atmosphere', ['L2', 'L3'], 'hdri'),
    tintStrength: Math.max(0.35, style.tintStrength)
  };
}

export function paletteTerrainColors(palette?: ColorPalette): TerrainPaletteColors | undefined {
  if (!palette) return undefined;
  return {
    base: levelColor(palette, 'earth', ['L2', 'L3'], 'terrain-base'),
    dry: levelColor(palette, 'earth', ['L3', 'L4'], 'terrain-dry'),
    sand: levelColor(palette, 'earth', ['L1', 'L2'], 'terrain-sand'),
    soil: levelColor(palette, 'earth', ['L4', 'L5'], 'terrain-soil'),
    rock: levelColor(palette, 'earth', ['L3', 'L4'], 'terrain-rock'),
    paving: levelColor(palette, 'earth', ['L2', 'L3', 'L4'], 'terrain-paving'),
    grass: levelColor(palette, 'plant', ['L2', 'L3'], 'terrain-grass'),
    foliage: levelColor(palette, 'plant', ['L2', 'L3'], 'terrain-foliage'),
    water: levelColor(palette, 'water', ['L2', 'L3'], 'terrain-water'),
    settlement: levelColor(palette, 'primary', ['L2', 'L3'], 'terrain-settlement')
  };
}

function levelColor(
  palette: ColorPalette,
  role: ColorPaletteRole,
  levels: ColorPaletteLevel[],
  key: string
): string {
  const allowed = new Set(palette.roles[role]);
  const candidates = palette.colors.filter((entry) => (
    levels.includes(entry.level ?? inferPaletteLevel(entry.hex)) && allowed.has(entry.hex)
  ));
  if (candidates.length === 0) return pickPaletteColor(palette, role, key);
  return candidates[stableIndex(key, candidates.length)].hex;
}

function stableIndex(value: string, length: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash, 31) + value.charCodeAt(index) | 0;
  return Math.abs(hash) % length;
}
