/**
 * Vertex-only wind motion shared by plant geometry whose silhouette is already modeled.
 * It deliberately has no fragment or normal body: lotus leaves, bamboo leaves, grass,
 * flowers and similar parts keep their authored material and shape.
 */

import { EffectLayer } from '../EffectLayer.js';
import { VegetationSway as VEGETATION_SWAY_MANIFEST } from '../coreLayers.manifest.js';

const UNIFORM_NAMES = {
  amplitude: 'uVegetationSwayAmplitude',
  frequency: 'uVegetationSwayFrequency',
  phaseScale: 'uVegetationSwayPhaseScale',
};

export class VegetationSwayLayer extends EffectLayer {
  constructor(manifest = VEGETATION_SWAY_MANIFEST) {
    super(manifest);
  }

  getUniformDeclarations() {
    return [
      'uniform float uVegetationSwayAmplitude;',
      'uniform float uVegetationSwayFrequency;',
      'uniform float uVegetationSwayPhaseScale;',
      'uniform float uEffLayerObjectPhase;',
      'uniform float uTime;',
    ].join('\n');
  }

  getVertexBody() {
    return [
      '// Shared plant motion: spatially de-synchronised dual-sine sway.',
      'float vegetationSwayPhase = dot(vEffLayerWorldPos, vec3(uVegetationSwayPhaseScale))',
      '  + uEffLayerObjectPhase * 6.2831 + uTime * uVegetationSwayFrequency;',
      'float vegetationSway = sin(vegetationSwayPhase) * 0.7',
      '  + sin(vegetationSwayPhase * 2.3 + 1.7) * 0.3;',
      'transformed += normalize(vec3(1.0, 0.0, 0.3))',
      '  * (uVegetationSwayAmplitude * vegetationSway);',
    ].join('\n');
  }

  getNormalBody() {
    return '';
  }

  getFragmentBody() {
    return '';
  }

  getParamUniformMap() {
    return { ...UNIFORM_NAMES };
  }
}
