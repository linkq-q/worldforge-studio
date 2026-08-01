import * as THREE from 'three';
import type { RuntimeEffectRecipe } from '../shared/renderPlan';

export interface EffectMaterialLayer {
  type: string;
  params: Record<string, unknown>;
}

/**
 * Translates WorldForge's small, AI-safe recipe vocabulary to the public
 * Voxel Studio Effect Package layer protocol.
 */
export function compileEffectRecipeLayers(recipe: RuntimeEffectRecipe): EffectMaterialLayer[] {
  const color = new THREE.Color(recipe.color ?? '#88bbff');
  const colorArray = [color.r, color.g, color.b];
  const intensity = recipe.intensity ?? 1;
  const speed = recipe.speed ?? 1;

  if (recipe.recipe === 'fresnel') {
    return [{ type: 'FresnelRim', params: { color: colorArray, intensity, power: 2.5 } }];
  }
  if (recipe.recipe === 'flame') {
    return [{ type: 'Flame', params: { color: colorArray, intensity, speed } }];
  }
  if (recipe.recipe === 'magic') {
    return [
      { type: 'FresnelRim', params: { color: colorArray, intensity: intensity * 0.8, power: 2.2 } },
      { type: 'EmissivePulse', params: { color: colorArray, intensity, speed } }
    ];
  }
  if (recipe.recipe === 'aura') {
    return [{
      type: 'ChargeAura',
      params: { color: colorArray, intensity, pulseSpeed: speed, risePower: 1.5, rimBias: 0.75 }
    }];
  }
  if (recipe.recipe === 'sway') {
    return [{
      type: 'VegetationSway',
      params: {
        amplitude: THREE.MathUtils.clamp(intensity * 0.08, 0, 0.2),
        frequency: speed,
        phaseScale: 1.2
      }
    }];
  }
  return [{ type: 'EmissivePulse', params: { color: colorArray, intensity, speed } }];
}
