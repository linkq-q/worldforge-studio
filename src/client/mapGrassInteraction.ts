import * as THREE from 'three';
import type { Vec3 } from '../shared/protocol';

interface GrassInteractionUniforms {
  uGrassInteractionPosition: { value: THREE.Vector2 };
  uGrassInteractionDirection: { value: THREE.Vector2 };
  uGrassInteractionRadius: { value: number };
  uGrassInteractionStrength: { value: number };
}

const NORMAL_DECLARATION = 'uniform float uGrassNormalFlatten;';
const WIND_DEFORMATION = 'transformed += grassLocalWind * (grassWave * uGrassWindStrength * vGrassBladeT * vGrassBladeT);';
const INTERACTION_DECLARATIONS = `
uniform vec2 uGrassInteractionPosition;
uniform vec2 uGrassInteractionDirection;
uniform float uGrassInteractionRadius;
uniform float uGrassInteractionStrength;`;
const INTERACTION_DEFORMATION = `
vec2 grassInteractionOffset = grassRootWorld.xz - uGrassInteractionPosition;
float grassInteractionDistance = length(grassInteractionOffset);
float grassInteractionInfluence = 1.0 - smoothstep(0.0, uGrassInteractionRadius, grassInteractionDistance);
grassInteractionInfluence *= grassInteractionInfluence;
vec2 grassInteractionRadial = grassInteractionDistance > 0.001
  ? grassInteractionOffset / grassInteractionDistance
  : uGrassInteractionDirection;
vec2 grassInteractionPush = normalize(mix(grassInteractionRadial, uGrassInteractionDirection, 0.35));
vec3 grassInteractionWorldPush = vec3(grassInteractionPush.x, 0.0, grassInteractionPush.y);
vec3 grassInteractionLocalPush = normalize(vec3(
  dot(instanceMatrix[0].xyz, grassInteractionWorldPush),
  0.0,
  dot(instanceMatrix[2].xyz, grassInteractionWorldPush)
));
transformed += grassInteractionLocalPush
  * (uGrassInteractionStrength * grassInteractionInfluence * vGrassBladeT * vGrassBladeT);`;

/** Adds continuous player bending to the existing grass shader with no matrix uploads. */
export class MapGrassInteraction {
  private readonly uniforms: GrassInteractionUniforms = {
    uGrassInteractionPosition: { value: new THREE.Vector2(1e6, 1e6) },
    uGrassInteractionDirection: { value: new THREE.Vector2(1, 0) },
    uGrassInteractionRadius: { value: 1.35 },
    uGrassInteractionStrength: { value: 0 }
  };
  private readonly lastPosition = new THREE.Vector2(Number.NaN, Number.NaN);
  private readonly targetDirection = new THREE.Vector2();
  private lastElapsedSeconds = Number.NaN;

  constructor(root: THREE.Object3D, radius = 1.35) {
    this.uniforms.uGrassInteractionRadius.value = radius;
    root.traverse((object) => {
      const mesh = object as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh || !mesh.userData.grassBladeCount) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) patchGrassMaterial(material, this.uniforms);
    });
  }

  update(position: Vec3, elapsedSeconds: number): void {
    const x = position[0];
    const z = position[2];
    const deltaTime = Number.isFinite(this.lastElapsedSeconds)
      ? THREE.MathUtils.clamp(elapsedSeconds - this.lastElapsedSeconds, 0, 0.05)
      : 1 / 60;
    this.lastElapsedSeconds = elapsedSeconds;

    if (Number.isFinite(this.lastPosition.x)) {
      this.targetDirection.set(x - this.lastPosition.x, z - this.lastPosition.y);
      if (this.targetDirection.lengthSq() > Math.max(0.000001, deltaTime * deltaTime * 0.0004)) {
        this.targetDirection.normalize();
        const alpha = 1 - Math.exp(-12 * deltaTime);
        this.uniforms.uGrassInteractionDirection.value
          .lerp(this.targetDirection, alpha)
          .normalize();
      }
    }
    this.lastPosition.set(x, z);
    this.uniforms.uGrassInteractionPosition.value.set(x, z);
    this.uniforms.uGrassInteractionStrength.value = 0.48;
  }

  restore(): void {
    this.uniforms.uGrassInteractionStrength.value = 0;
    this.lastPosition.set(Number.NaN, Number.NaN);
    this.lastElapsedSeconds = Number.NaN;
  }
}

function patchGrassMaterial(material: THREE.Material, uniforms: GrassInteractionUniforms): void {
  if (!material.userData.grassUniforms || material.userData.mapGrassInteraction) return;
  const originalCompile = material.onBeforeCompile.bind(material);
  const originalCacheKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    originalCompile(shader, renderer);
    if (!shader.vertexShader.includes(NORMAL_DECLARATION)
      || !shader.vertexShader.includes(WIND_DEFORMATION)) return;
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(NORMAL_DECLARATION, `${NORMAL_DECLARATION}${INTERACTION_DECLARATIONS}`)
      .replace(WIND_DEFORMATION, `${WIND_DEFORMATION}${INTERACTION_DEFORMATION}`);
  };
  material.customProgramCacheKey = () => `${originalCacheKey()}|worldforge-smooth-grass-v1`;
  material.userData.mapGrassInteraction = uniforms;
  material.needsUpdate = true;
}
