import type { HdriTexture } from './hdri';
import type { RenderModuleSelection, RenderPlan } from './renderPlan';
import { mixHexColors } from './colorDirector';

/**
 * Turns a curated panorama's sky/ground swatches into matching fog and
 * hemisphere colours. AI still controls the HDRI tint and atmospheric density;
 * this only keeps the three environment inputs visually coherent.
 */
export function harmonizeHdriAtmosphere(
  plan: RenderPlan,
  textures: readonly Pick<HdriTexture, 'file' | 'skyColor' | 'groundColor'>[]
): RenderPlan {
  const hdri = plan.modules.find((module) => module.id === 'environment.hdri');
  const texture = typeof hdri?.params.texture === 'string' ? hdri.params.texture : '';
  const source = textures.find((entry) => entry.file === texture);
  if (!source || (!source.skyColor && !source.groundColor)) return plan;

  const tint = typeof hdri?.params.tint === 'string' ? hdri.params.tint : '#ffffff';
  const tintStrength = numeric(hdri?.params.tintStrength, 0);
  const tintedSky = tintColor(source.skyColor ?? source.groundColor!, tint, tintStrength);
  const tintedGround = tintColor(source.groundColor ?? source.skyColor!, tint, tintStrength);
  // Curated swatches describe the panorama; visual direction remains the
  // stronger art-direction source while preserving some panorama identity.
  const sky = plan.visualDirection
    ? mixHexColors(tintedSky, plan.visualDirection.palette.fillLight, 0.68)
    : tintedSky;
  const ground = plan.visualDirection
    ? mixHexColors(tintedGround, plan.visualDirection.palette.fog, 0.68)
    : tintedGround;
  const sun = plan.visualDirection
    ? plan.visualDirection.palette.keyLight
    : tintColor(sky, '#fff1d2', 0.28);
  const modules = plan.modules.map((module) => ({ ...module, params: { ...module.params } }));
  upsertSceneModule(modules, 'environment.palette', { fogColor: ground });
  upsertSceneModule(modules, 'lighting.hemisphere', { skyColor: sky, groundColor: ground });
  upsertSceneModule(modules, 'lighting.sun', { color: sun });
  return { ...plan, modules };
}

function upsertSceneModule(
  modules: RenderModuleSelection[],
  id: 'environment.palette' | 'lighting.hemisphere' | 'lighting.sun',
  params: Record<string, string>
): void {
  const existing = modules.find((module) => module.id === id);
  if (existing) {
    for (const [key, value] of Object.entries(params)) {
      if (existing.params[key] === undefined) existing.params[key] = value;
    }
    return;
  }
  modules.push({ id, params });
}

function tintColor(base: string, tint: string, strength: number): string {
  const amount = Math.min(1, Math.max(0, strength));
  const baseChannels = channels(base);
  const tintChannels = channels(tint);
  return `#${baseChannels.map((value, index) => Math.round(value + (tintChannels[index] - value) * amount)
    .toString(16).padStart(2, '0')).join('')}`;
}

function channels(value: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function numeric(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
