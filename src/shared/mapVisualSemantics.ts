import type { EditableMap } from './map';
import { sceneZoneWorldRegion, type SceneCompositionPlan } from './sceneComposition';
import {
  DEFAULT_MAP_VISUAL_SEMANTICS,
  type MapVisualSemantics,
  type VisualZoneTag
} from './visualDirection';

/** Compiles the director's free-form composition into stable spatial tags. */
export function compileMapVisualSemantics(
  map: EditableMap,
  plan: SceneCompositionPlan
): MapVisualSemantics {
  const families = new Map(plan.assetFamilies.map((family) => [family.id, family]));
  return {
    version: 1,
    zones: plan.zones.map((zone) => {
      const region = sceneZoneWorldRegion(zone, map);
      const words = [
        zone.label,
        zone.brief.atmosphere,
        zone.brief.hierarchy,
        ...zone.layers.flatMap((layer) => {
          const family = families.get(layer.familyId);
          return family ? [family.label, family.role, ...family.tags] : [];
        })
      ].join(' ').toLowerCase();
      const tags = new Set<VisualZoneTag>();
      if (zone.water) tags.add('water');
      if (zone.water || zone.terrain.elevation < -0.08) tags.add('lowland');
      if (zone.grassLayers.length > 0 || has(words, ['grass', 'meadow', 'lawn', '草', '花田'])) tags.add('grass');
      if (has(words, ['forest', 'tree', 'woodland', '树林', '森林', '树木', '林地'])) tags.add('forest');
      if (has(words, ['dry', 'desert', 'dust', 'arid', '沙漠', '干燥', '荒地'])) tags.add('dry');
      if (has(words, ['house', 'camp', 'settlement', 'village', 'cabin', '木屋', '营地', '村庄'])) tags.add('settlement');
      if (has(words, ['rock', 'stone', 'cliff', '岩石', '山崖', '石头'])) tags.add('rocky');
      return {
        id: zone.id,
        tags: [...tags],
        center: [region.x, region.z] as [number, number],
        radius: region.r,
        intensity: zone.importance
      };
    }),
    wind: { ...DEFAULT_MAP_VISUAL_SEMANTICS.wind }
  };
}

function has(text: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => text.includes(token));
}
