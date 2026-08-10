import type { EditableMap } from './map';
import { sceneZoneWorldRegion, type SceneCompositionPlan } from './sceneComposition';
import {
  DEFAULT_MAP_VISUAL_SEMANTICS,
  type MapVisualSemantics,
  type SceneVisualZone,
  type VisualZoneField,
  type VisualZoneTag
} from './visualDirection';

export type VisualZonePatch = Partial<Pick<SceneVisualZone, 'center' | 'radius' | 'tags' | 'intensity'>>;

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
      if (has(words, ['sand', 'dune', 'desert', '沙', '沙丘', '沙漠'])) tags.add('sand');
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

/** Adds deterministic spatial facts for structured content created outside the director workflow. */
export function completeMapVisualSemantics(map: EditableMap): MapVisualSemantics {
  const zones = map.visualSemantics.zones.map((zone) => ({
    ...zone,
    tags: [...zone.tags],
    ...(zone.locks ? { locks: { ...zone.locks } } : {})
  }));
  for (const water of map.waterBodies) {
    const center: [number, number] = [
      water.points.reduce((sum, point) => sum + point[0], 0) / water.points.length,
      water.points.reduce((sum, point) => sum + point[1], 0) / water.points.length
    ];
    const radius = Math.max(
      1,
      ...water.points.map((point) => Math.hypot(point[0] - center[0], point[1] - center[1]))
    ) + (water.type === 'river' ? water.width / 2 : 0);
    const covered = zones.some((zone) => (
      zone.tags.includes('water')
      && Math.hypot(zone.center[0] - center[0], zone.center[1] - center[1]) <= zone.radius + radius * 0.5
    ));
    if (!covered) {
      zones.push({
        id: `structured-water:${water.id}`,
        tags: ['water', 'lowland'],
        center,
        radius,
        intensity: 0.75
      });
    }
  }
  return {
    version: 1,
    zones: zones.slice(0, 24),
    wind: { ...map.visualSemantics.wind, direction: [...map.visualSemantics.wind.direction] }
  };
}

/** Applies an AI-derived zone patch without overwriting user-locked fields. */
export function patchMapVisualZone(
  semantics: MapVisualSemantics,
  zoneId: string,
  patch: VisualZonePatch,
  options: { respectLocks?: boolean; lockFields?: readonly VisualZoneField[] } = {}
): MapVisualSemantics {
  const respectLocks = options.respectLocks !== false;
  const lockFields = new Set(options.lockFields ?? []);
  let found = false;
  const zones = semantics.zones.map((zone) => {
    if (zone.id !== zoneId) return zone;
    found = true;
    const locks = { ...(zone.locks ?? {}) };
    for (const field of lockFields) locks[field] = true;
    const next = { ...zone, tags: [...zone.tags] };
    for (const field of ['center', 'radius', 'tags', 'intensity'] as const) {
      if (patch[field] === undefined || (respectLocks && zone.locks?.[field])) continue;
      if (field === 'center') next.center = [...patch.center!] as [number, number];
      else if (field === 'tags') next.tags = [...patch.tags!];
      else if (field === 'radius') next.radius = patch.radius!;
      else next.intensity = patch.intensity!;
    }
    return {
      ...next,
      ...(Object.keys(locks).length > 0 ? { locks } : { locks: undefined })
    };
  });
  if (!found) throw new Error('unknown_visual_zone');
  return { ...semantics, zones };
}

function has(text: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => text.includes(token));
}
