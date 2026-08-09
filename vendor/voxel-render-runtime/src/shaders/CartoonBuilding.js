import * as THREE from 'three';

const vertexShader = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec2 vUv;

  void main() {
    vec3 transformedPosition = position;
    vec3 transformedNormal = normal;

    #ifdef USE_INSTANCING
      transformedPosition = (instanceMatrix * vec4(position, 1.0)).xyz;
      transformedNormal = (instanceMatrix * vec4(normal, 0.0)).xyz;
    #endif

    vNormal = normalize(mat3(transpose(inverse(modelMatrix))) * transformedNormal);
    vUv = uv;

    vec4 mvPosition = modelViewMatrix * vec4(transformedPosition, 1.0);
    vViewDir = normalize(-mvPosition.xyz);

    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */`
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uSteps;
  uniform float uShadowFactor;
  uniform float uHighlightFactor;
  uniform float uSilhouette;
  uniform vec3 uSilhouetteColor;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform float uLightIntensity;
  uniform vec3 uAmbientColor;
  uniform float uAmbientIntensity;
  uniform sampler2D uPaintMap;
  uniform float uPaintEnabled;
  uniform float uTerminatorEnabled;
  uniform vec3 uTerminatorColor;
  uniform float uTerminatorThreshold;
  uniform float uTerminatorWidth;
  uniform float uTerminatorStrength;

  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec2 vUv;

  void main() {
    vec3 normalDir = normalize(vNormal);
    vec3 lightDir = normalize(uLightDir);
    float NdotL = clamp(dot(normalDir, lightDir), 0.0, 1.0);

    float steps = max(uSteps, 1.0);
    float bandIndex = min(floor(NdotL * steps), steps - 1.0);
    float stepped = bandIndex / max(steps - 1.0, 1.0);

    float diffuse = mix(uShadowFactor, uHighlightFactor, stepped);
    diffuse = clamp(diffuse, 0.0, 1.0);

    vec3 ambient = uAmbientColor * uAmbientIntensity;
    vec3 lighting = uLightColor * uLightIntensity * diffuse + ambient;
    lighting = clamp(lighting, 0.0, 1.0);

    vec3 color = uColor * lighting * uIntensity;
    float fresnel = pow(1.0 - clamp(dot(normalDir, normalize(vViewDir)), 0.0, 1.0), 2.0);
    color = mix(color, uSilhouetteColor, fresnel * uSilhouette);

    vec4 painted = texture2D(uPaintMap, vUv);
    color = mix(color, painted.rgb, painted.a * uPaintEnabled);

    // Terminator line — warm colored boundary at light/shadow transition
    float termLine = 0.0;
    if (uTerminatorEnabled > 0.5) {
      float midThreshold = (1.0 / uSteps) * floor(uTerminatorThreshold * uSteps + 0.5);
      float termWidth = uTerminatorWidth / max(uSteps, 1.0);
      termLine = 1.0 - smoothstep(
        termWidth,
        termWidth * 1.5,
        abs(NdotL - midThreshold)
      );
    }
    color = mix(color, uTerminatorColor, termLine * uTerminatorStrength);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const outlineVertexShader = /* glsl */`
  uniform float uOutlineWidth;

  void main() {
    vec3 pos = position + normal * uOutlineWidth;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const outlineFragmentShader = /* glsl */`
  uniform vec3 uOutlineColor;

  void main() {
    gl_FragColor = vec4(uOutlineColor, 1.0);
  }
`;

function createEmptyPaintTexture() {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}

export function createCartoonBuildingMaterial({
  color = new THREE.Color(1, 1, 1),
  intensity = 1.0,
  steps = 4,
  shadowFactor = 0.8,
  highlightFactor = 1.1,
} = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uSteps: { value: steps },
      uShadowFactor: { value: shadowFactor },
      uHighlightFactor: { value: highlightFactor },
      uSilhouette: { value: 0 },
      uSilhouetteColor: { value: new THREE.Color('#0d1b2a') },
      uLightDir: { value: new THREE.Vector3(0.5, 1.0, 0.5).normalize() },
      uLightColor: { value: new THREE.Color(0xffffff) },
      uLightIntensity: { value: 1.17 },
      uAmbientColor: { value: new THREE.Color(0xffffff) },
      uAmbientIntensity: { value: 0.65 },
      uPaintMap: { value: createEmptyPaintTexture() },
      uPaintEnabled: { value: 0 },
      uTerminatorEnabled: { value: 0 },
      uTerminatorColor: { value: new THREE.Color('#c47a4a') },
      uTerminatorThreshold: { value: 0.5 },
      uTerminatorWidth: { value: 0.08 },
      uTerminatorStrength: { value: 0.6 },
    },
    vertexShader,
    fragmentShader,
    transparent: false,
    depthWrite: true,
    blending: THREE.NormalBlending,
    userData: {
      shaderMode: 'cel',
      shaderCategory: 'building',
      supportsInstancing: true,
      batchable: true,
    },
  });
}

export function createCartoonBuildingOutlineMaterial({
  outlineColor = new THREE.Color(0.08, 0.08, 0.15),
  outlineWidth = 0.0,
} = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uOutlineColor: { value: new THREE.Color(outlineColor) },
      uOutlineWidth: { value: outlineWidth },
    },
    vertexShader: outlineVertexShader,
    fragmentShader: outlineFragmentShader,
    side: THREE.BackSide,
  });
}
