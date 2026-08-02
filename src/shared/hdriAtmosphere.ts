import type { HdriTexture } from './hdri';
import type { RenderModuleSelection, RenderPlan } from './renderPlan';

/**
 * Turns a curated panorama's sky/ground swatches into matching fog and
 * hemisphere colours. AI still controls the HDRI tint and atmospheric density;
 * this only keeps the three environment inputs visually coherent.
 */
export function harmonizeHdriAtmosphere(plan: RenderPlan, textures: readonly HdriTexture[]): RenderPlan {
  const hdri = plan.modules.find((module) => module.id === 'environment.hdri');
  const texture = typeof hdri?.params.texture === 'string' ? hdri.params.texture : '';
  const source = textures.find((entry) => entry.file === texture);
  if (!source || (!source.skyColor && !source.groundColor)) return plan;

  const tint = typeof hdri?.params.tint === 'string' ? hdri.params.tint : '#ffffff';
  const tintStrength = numeric(hdri?.params.tintStrength, 0);
  const sky = tintColor(source.skyColor ?? source.groundColor!, tint, tintStrength);
  const ground = tintColor(source.groundColor ?? source.skyColor!, tint, tintStrength);
  const modules = plan.modules.map((module) => ({ ...module, params: { ...module.params } }));
  upsertSceneModule(modules, 'environment.palette', { fogColor: ground });
  upsertSceneModule(modules, 'lighting.hemisphere', { skyColor: sky, groundColor: ground });
  return { ...plan, modules };
}

function upsertSceneModule(
  modules: RenderModuleSelection[],
  id: 'environment.palette' | 'lighting.hemisphere',
  params: Record<string, string>
): void {
  const existing = modules.find((module) => module.id === id);
  if (existing) {
    Object.assign(existing.params, params);
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
