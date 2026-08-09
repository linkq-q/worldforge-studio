import type { EditableMap } from '../shared/map';
import { deriveContactAwareGrassMap } from './mapGrassRenderer';
import {
  MAX_VISIBLE_MAP_LOCAL_LIGHTS,
  analyzeMapLocalLightCandidates
} from './mapLocalLights';

export interface MapDerivedInspection {
  semanticZoneCount: number;
  wetShoreCount: number;
  grassRetreatedCells: number;
  localLightCandidateCount: number;
  localLightVisibleLimit: number;
}

/** Summarizes render-only derivations without changing persisted map data. */
export function inspectMapDerivedResults(map: EditableMap): MapDerivedInspection {
  const contactMap = deriveContactAwareGrassMap(map);
  const originalLayers = new Map(map.grassLayers.map((layer) => [layer.id, layer]));
  let grassRetreatedCells = 0;
  for (const layer of contactMap.grassLayers) {
    const original = originalLayers.get(layer.id);
    if (!original) continue;
    for (let index = 0; index < layer.densities.length; index += 1) {
      if ((layer.densities[index] ?? 0) + 0.0001 < (original.densities[index] ?? 0)) {
        grassRetreatedCells += 1;
      }
    }
  }
  return {
    semanticZoneCount: map.visualSemantics.zones.length,
    wetShoreCount: map.waterBodies.length,
    grassRetreatedCells,
    localLightCandidateCount: analyzeMapLocalLightCandidates(map).length,
    localLightVisibleLimit: MAX_VISIBLE_MAP_LOCAL_LIGHTS
  };
}
