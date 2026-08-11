import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { CompiledAtmosphereFx } from '../shared/atmosphereFx';

export type AtmosphereFxPass = ShaderPass & {
  uniforms: Record<string, THREE.IUniform>;
};

export function createAtmosphereFxPass(): AtmosphereFxPass {
  const pass = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uWindStreaks: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) }
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uWindStreaks;
      uniform vec2 uWindDir;
      varying vec2 vUv;
      void main(){
        vec3 base=texture2D(tDiffuse,vUv).rgb;
        vec2 windUv=vec2(dot(vUv,uWindDir),dot(vUv,vec2(-uWindDir.y,uWindDir.x)));
        float streak=pow(max(0.0,sin(windUv.x*95.0-uTime*2.2)),18.0);
        streak*=smoothstep(0.28,0.0,abs(windUv.y-0.5));
        vec3 color=base;
        color+=vec3(0.78,0.9,1.0)*streak*uWindStreaks*0.08;
        gl_FragColor=vec4(color,1.0);
      }
    `
  }) as AtmosphereFxPass;
  pass.enabled = false;
  return pass;
}

export function configureAtmosphereFxPass(pass: AtmosphereFxPass, state: CompiledAtmosphereFx | null): void {
  pass.uniforms.uWindStreaks.value = state?.channels.windStreaks ?? 0;
  pass.uniforms.uWindDir.value.set(...(state?.wind.direction ?? [1, 0]));
  pass.enabled = Boolean(state && state.channels.windStreaks > 0);
}
