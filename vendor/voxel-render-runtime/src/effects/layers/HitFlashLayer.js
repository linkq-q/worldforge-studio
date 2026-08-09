import { EffectLayer } from '../EffectLayer.js';
import { HitFlash as HIT_FLASH_MANIFEST } from '../coreLayers.manifest.js';

const UNIFORM_NAMES = {
  flashColor: 'uHitFlashColor',
  falloff: 'uHitFlashFalloff',
  intensity: 'uHitFlashIntensity',
};

export class HitFlashLayer extends EffectLayer {
  constructor(manifest = HIT_FLASH_MANIFEST) {
    super(manifest);
  }

  getUniformDeclarations() {
    return [
      'uniform float uHitFlash;',
      'uniform vec3 uHitFlashColor;',
      'uniform float uHitFlashFalloff;',
      'uniform float uHitFlashIntensity;',
    ].join('\n');
  }

  getVertexBody() {
    return '';
  }

  getFragmentBody() {
    return [
      'float hitFlashValue = clamp(uHitFlash, 0.0, 1.0);',
      'float hitFlashMask = pow(hitFlashValue, max(uHitFlashFalloff, 0.0001));',
      'gl_FragColor.rgb = mix(gl_FragColor.rgb, uHitFlashColor, clamp(hitFlashMask * uHitFlashIntensity, 0.0, 1.0));',
      'gl_FragColor.rgb += uHitFlashColor * uHitFlashIntensity * hitFlashMask * 0.25;',
    ].join('\n');
  }

  getParamUniformMap() {
    return { ...UNIFORM_NAMES };
  }
}
