import type { EditableMap } from './map';
import type { RenderPlan } from './renderPlan';
import { normalizeVisualDirection, type SceneVisualZone, type SceneWindField } from './visualDirection';

export type AtmosphereFxKind = 'sunShafts' | 'pollen' | 'vapor' | 'dust' | 'windStreaks';

export interface CompiledAtmosphereFx {
  masterStrength: number;
  channels: Record<AtmosphereFxKind, number>;
  zones: Record<'pollen' | 'vapor' | 'dust', SceneVisualZone[]>;
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
  const daylight = direction?.timeOfDay === 'noon' || direction?.timeOfDay === 'morning';
  const wind = map.visualSemantics.wind;
  return {
    masterStrength,
    channels: {
      sunShafts: clamp(Math.max(number('sunShafts') ?? intent?.sunShafts ?? 0, daylight ? 0.1 * semanticStrength : 0) * masterStrength),
      pollen: clamp(Math.max(number('pollen') ?? intent?.pollen ?? 0, pollenZones.length ? 0.16 * semanticStrength : 0) * masterStrength),
      vapor: clamp(Math.max(number('vapor') ?? intent?.vapor ?? 0, vaporZones.length ? 0.14 * semanticStrength : 0) * masterStrength),
      dust: clamp(Math.max(number('dust') ?? intent?.dust ?? 0, dustZones.length ? 0.1 * semanticStrength : 0) * masterStrength),
      windStreaks: clamp(Math.max(number('windStreaks') ?? intent?.windStreaks ?? 0, wind.speed + wind.gustStrength > 0.8 ? 0.08 * semanticStrength : 0) * masterStrength)
    },
    zones: { pollen: pollenZones, vapor: vaporZones, dust: dustZones },
    wind
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
