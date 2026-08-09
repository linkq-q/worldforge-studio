export const glassVertexShader = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec4 vScreenPos;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vec4 clipPos = projectionMatrix * viewMatrix * worldPos;

    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    vScreenPos = clipPos;

    gl_Position = clipPos;
  }
`;

export const glassFragmentShader = /* glsl */`
  uniform sampler2D uEnvTex;
  uniform vec2 uResolution;
  uniform float uRefractStrength;
  uniform float uFresnelPower;
  uniform vec3 uGlassColor;
  uniform float uColorStrength;
  uniform float uOpacity;

  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec4 vScreenPos;

  void main() {
    vec2 screenUV = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
    vec2 refractUV = clamp(screenUV + vNormal.xy * uRefractStrength, 0.001, 0.999);
    vec3 bgColor = texture2D(uEnvTex, refractUV).rgb;

    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), uFresnelPower);
    vec3 tintedBg = mix(bgColor, uGlassColor, uColorStrength);
    vec3 color = tintedBg + vec3(1.0) * fresnel * 0.6;

    gl_FragColor = vec4(color, uOpacity + fresnel * 0.3);
  }
`;
