import type { RenderEnvironmentSettings } from './renderScheme';
import { compileVisualDirection, type VisualDirection } from './visualDirection';

export interface VisualWaterPalette {
  color: string;
  shallowColor: string;
  depthColor: string;
}

export function compileVisualEnvironment(direction: VisualDirection): Partial<RenderEnvironmentSettings> {
  const compiled = compileVisualDirection(direction);
  const palette = compiled.palette;
  return {
    background: palette.sky,
    fogColor: mixHexColors(palette.fillLight, palette.fog, 0.68),
    hemisphereSkyColor: palette.fillLight,
    hemisphereGroundColor: mixHexColors(palette.shadow, palette.fillLight, 0.18),
    hemisphereIntensity: compiled.contrastMode === 'dramatic' ? 1.1 : 1.45,
    sunColor: palette.keyLight,
    sunIntensity: compiled.contrastMode === 'dramatic' ? 3.1 : 2.7,
    exposure: direction.timeOfDay === 'evening' ? 1.04 : 1
  };
}

export function compileVisualWaterPalette(direction: VisualDirection): VisualWaterPalette {
  const { palette } = compileVisualDirection(direction);
  return {
    color: palette.waterBias,
    shallowColor: mixHexColors(palette.waterBias, palette.fillLight, 0.42),
    depthColor: mixHexColors(palette.waterBias, palette.shadow, 0.62)
  };
}

/** A deliberately weak tint: tagged source materials remain the primary art direction. */
export function visualMaterialTint(direction: VisualDirection, tag = ''): { color: string; strength: number } {
  const palette = compileVisualDirection(direction).palette;
  const normalized = tag.toLowerCase();
  if (/stone|rock|metal/.test(normalized)) return { color: palette.shadow, strength: 0.12 };
  if (/wood|bark/.test(normalized)) return { color: mixHexColors(palette.shadow, palette.keyLight, 0.24), strength: 0.1 };
  return { color: palette.accent, strength: 0.1 };
}

export function mixHexColors(base: string, tint: string, amount: number): string {
  const t = clamp(amount, 0, 1);
  const a = channels(base);
  const b = channels(tint);
  return `#${a.map((value, index) => Math.round(value + ((b[index] ?? value) - value) * t)
    .toString(16).padStart(2, '0')).join('')}`;
}

function channels(value: string): number[] {
  const safe = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return [1, 3, 5].map((offset) => Number.parseInt(safe.slice(offset, offset + 2), 16));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
