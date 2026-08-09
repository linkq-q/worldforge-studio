import waterState from './defaultWaterState.json';

export const DEFAULT_WATER_STATE = waterState;

// Render plans must not inherit the broad, depth-driven foam layers from the
// artist-tuned default snapshot. Those layers can cover an entire shallow lake;
// generated water owns shore foam separately through uShoreFoamStrength.
export const RENDER_PLAN_WATER_BASE_STATE = {
  uFoamStrength: 0,
  uContactFoamEnabled: false,
  uWhitecapEnabled: false,
  uToonPatternEnabled: true,
  uRippleDecalEnabled: false
} as const;

export interface WaterStateImporter {
  importState(state: Record<string, unknown>): void;
}

export function applyDefaultWaterState(surface: WaterStateImporter): void {
  surface.importState(DEFAULT_WATER_STATE);
}

export function applyRenderPlanWaterBaseState(surface: WaterStateImporter): void {
  applyDefaultWaterState(surface);
  surface.importState(RENDER_PLAN_WATER_BASE_STATE);
}
