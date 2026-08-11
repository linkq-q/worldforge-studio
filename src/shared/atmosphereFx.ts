import type { EditableMap } from './map';
import type { RenderPlan } from './renderPlan';
import { normalizeVisualDirection, type SceneVisualZone, type SceneWindField } from './visualDirection';

export type AtmosphereFxKind = 'pollen' | 'vapor' | 'dust' | 'sand';

export interface CompiledAtmosphereFx {
  masterStrength: number;
  channels: Record<AtmosphereFxKind, number>;
  zones: Record<'pollen' | 'vapor' | 'dust' | 'sand', SceneVisualZone[]>;
  wind: SceneWindField;
}

/** Semantic defaults stay weak; explicit AI intent may strengthen but not disable them. */
export function compileAtmosphereFx(map: EditableMap, plan?: RenderPlan | null): CompiledAtmosphereFx {
  const zones = map.visualSemantics.zones;
  const direction = plan?.visualDirection ? normalizeVisualDirection(plan.visualDirection) : null;
  const intent = direction?.atmosphereFx;
  const overrides = plan?.modules.find((module) => module.id === 'runtime.atmosphere-fx')?.params ?? {};
  const number = (key: string): number | undefined => typeof overrides[key] === 'number' ? overrides[key] as number : undefined;
  const masterStrength = number('masterStrength') ?? intent?.masterStrength ?? 0.35;
  const semanticStrength = number('semanticStrength') ?? 1;
  const pollenZones = zones.filter((zone) => zone.tags.includes('grass') || zone.tags.includes('forest'));
  const vaporZones = zones.filter((zone) => zone.tags.includes('water') || zone.tags.includes('lowland'));
  const dustZones = zones.filter((zone) => zone.tags.includes('dry'));
  const sandZones = map.confirmedAt ? zones.filter((zone) => zone.tags.includes('sand')) : [];
  const wind = map.visualSemantics.wind;
  return {
    masterStrength,
    channels: {
      pollen: clamp(Math.max(number('pollen') ?? intent?.pollen ?? 0, pollenZones.length ? 0.16 * semanticStrength : 0) * masterStrength),
      vapor: clamp(Math.max(number('vapor') ?? intent?.vapor ?? 0, vaporZones.length ? 0.14 * semanticStrength : 0) * masterStrength),
      dust: clamp(Math.max(number('dust') ?? intent?.dust ?? 0, dustZones.length ? 0.1 * semanticStrength : 0) * masterStrength),
      sand: clamp(Math.max(number('sand') ?? intent?.sand ?? 0, sandZones.length ? 0.5 * semanticStrength : 0) * masterStrength)
    },
    zones: { pollen: pollenZones, vapor: vaporZones, dust: dustZones, sand: sandZones },
    wind
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
