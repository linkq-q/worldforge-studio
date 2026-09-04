import * as THREE from 'three';
import {
  addMaterialShaderPatch,
  hasMaterialShaderPatch
} from '@voxel-studio/render-runtime/utils/MaterialShaderPatchChain.js';
import goldTextureUrl from './assets/matcaps/matcap_gold.png?url';
import metalTextureUrl from './assets/matcaps/matcap_metal.png?url';
import silverTextureUrl from './assets/matcaps/matcap_silver.png?url';

const MATCAP_PATCH_KEY = 'material-tag:matcap';
const MATCAP_MODES = { multiply: 0, lerp: 1, tint: 2 } as const;
const MATCAP_TEXTURES = {
  gold: { url: goldTextureUrl, averageLuma: 0.660234 },
  silver: { url: silverTextureUrl, averageLuma: 0.765467 },
  metal: { url: metalTextureUrl, averageLuma: 0.342798 }
} as const;

interface MatcapBinding {
  enabled?: unknown;
  textureName?: unknown;
  blend?: unknown;
  strength?: unknown;
  mode?: unknown;
}

interface MatcapUniforms {
  uTextureMatcap: { value: THREE.Texture };
  uTextureMatcapBlend: { value: number };
  uTextureMatcapStrength: { value: number };
  uTextureMatcapMode: { value: number };
  uTextureMatcapAvgLuma: { value: number };
}

const textureCache = new Map<keyof typeof MATCAP_TEXTURES, THREE.Texture>();

/** Apply the three texture-backed semantic MatCaps authored in 3d-generate. */
export function applyMaterialMatcapBinding(
  target: THREE.Object3D | THREE.Material,
  rawBinding: Record<string, unknown>
): number {
  const binding = normalizeBinding(rawBinding);
  if (!binding) return 0;
  const materials = collectMaterials(target);
  let applied = 0;
  for (const material of materials) {
    if ((material as THREE.ShaderMaterial).isShaderMaterial || (material as THREE.RawShaderMaterial).isRawShaderMaterial) continue;
    const uniforms = ensureUniforms(material, binding.textureName);
    uniforms.uTextureMatcap.value = textureFor(binding.textureName);
    uniforms.uTextureMatcapBlend.value = binding.enabled ? binding.blend : 0;
    uniforms.uTextureMatcapStrength.value = binding.strength;
    uniforms.uTextureMatcapMode.value = MATCAP_MODES[binding.mode];
    uniforms.uTextureMatcapAvgLuma.value = MATCAP_TEXTURES[binding.textureName].averageLuma;
    material.userData.worldforgeMaterialMatcapBinding = { ...binding };
    installShaderPatch(material, uniforms);
    applied += 1;
  }
  return applied;
}

function normalizeBinding(raw: MatcapBinding): {
  enabled: boolean;
  textureName: keyof typeof MATCAP_TEXTURES;
  blend: number;
  strength: number;
  mode: keyof typeof MATCAP_MODES;
} | null {
  const textureName = typeof raw.textureName === 'string' && raw.textureName in MATCAP_TEXTURES
    ? raw.textureName as keyof typeof MATCAP_TEXTURES
    : null;
  if (!textureName) return null;
  const mode = typeof raw.mode === 'string' && raw.mode in MATCAP_MODES
    ? raw.mode as keyof typeof MATCAP_MODES
    : 'multiply';
  return {
    enabled: raw.enabled !== false,
    textureName,
    blend: THREE.MathUtils.clamp(finiteNumber(raw.blend, 0.5), 0, 1),
    strength: THREE.MathUtils.clamp(finiteNumber(raw.strength, 1), 0, 2),
    mode
  };
}

function collectMaterials(target: THREE.Object3D | THREE.Material): THREE.Material[] {
  if ((target as THREE.Material).isMaterial) return [target as THREE.Material];
  const materials = new Set<THREE.Material>();
  (target as THREE.Object3D).traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) return;
    const entries = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    entries.forEach((material) => { if (material) materials.add(material); });
  });
  return [...materials];
}

function textureFor(name: keyof typeof MATCAP_TEXTURES): THREE.Texture {
  const cached = textureCache.get(name);
  if (cached) return cached;
  const source = MATCAP_TEXTURES[name];
  const texture = typeof document === 'undefined'
    ? new THREE.Texture()
    : new THREE.TextureLoader().load(
      source.url,
      undefined,
      undefined,
      (error) => console.warn(`[WorldForge] MatCap texture failed to load: ${name}`, error)
    );
  texture.name = `material-tag:matcap:${name}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(name, texture);
  return texture;
}

function ensureUniforms(
  material: THREE.Material,
  textureName: keyof typeof MATCAP_TEXTURES
): MatcapUniforms {
  const existing = material.userData.worldforgeMaterialMatcapUniforms as MatcapUniforms | undefined;
  if (existing) return existing;
  const uniforms: MatcapUniforms = {
    uTextureMatcap: { value: textureFor(textureName) },
    uTextureMatcapBlend: { value: 0 },
    uTextureMatcapStrength: { value: 1 },
    uTextureMatcapMode: { value: MATCAP_MODES.multiply },
    uTextureMatcapAvgLuma: { value: MATCAP_TEXTURES[textureName].averageLuma }
  };
  material.userData.worldforgeMaterialMatcapUniforms = uniforms;
  return uniforms;
}

function installShaderPatch(material: THREE.Material, uniforms: MatcapUniforms): void {
  if (hasMaterialShaderPatch(material, MATCAP_PATCH_KEY)) return;
  addMaterialShaderPatch(material, MATCAP_PATCH_KEY, (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = `uniform sampler2D uTextureMatcap;
uniform float uTextureMatcapBlend;
uniform float uTextureMatcapStrength;
uniform int uTextureMatcapMode;
uniform float uTextureMatcapAvgLuma;
${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', `
  if (uTextureMatcapBlend > 0.0001) {
    vec3 mcViewDir = normalize(vViewPosition);
    vec3 mcX = normalize(vec3(mcViewDir.z, 0.0, -mcViewDir.x));
    vec3 mcY = cross(mcViewDir, mcX);
    vec2 mcUv = vec2(dot(mcX, normal), dot(mcY, normal)) * 0.495 + 0.5;
    vec3 mcColor = texture2D(uTextureMatcap, mcUv).rgb * uTextureMatcapStrength;
    vec3 mcLit = mcColor;
    if (uTextureMatcapMode == 0) {
      mcLit = gl_FragColor.rgb * mcColor;
    } else if (uTextureMatcapMode == 2) {
      mcLit = gl_FragColor.rgb * (mcColor / max(uTextureMatcapAvgLuma, 0.05));
    }
    gl_FragColor.rgb = mix(gl_FragColor.rgb, mcLit, clamp(uTextureMatcapBlend, 0.0, 1.0));
  }
  #include <tonemapping_fragment>`);
  }, { order: 120, cacheKey: () => 'material-tag-matcap-v1' });
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
