import waterState from './defaultWaterState.json';

export const DEFAULT_WATER_STATE = waterState;

export interface WaterStateImporter {
  importState(state: Record<string, unknown>): void;
}

export function applyDefaultWaterState(surface: WaterStateImporter): void {
  surface.importState(DEFAULT_WATER_STATE);
}
