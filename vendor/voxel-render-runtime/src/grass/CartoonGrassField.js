import * as THREE from 'three';
import { collectGrassPlacements } from './GrassPlacement.js';

const DEFAULT_STYLE = Object.freeze({
  cellSize: 0.8,
  bladeWidth: 0.18,
  bladeHeight: 0.95,
  rootColor: '#72ad49',
  tipColor: '#c4f07f',
  flowerColors: ['#ffe58a', '#f3a4bd', '#b7c9ff'],
  paletteVariation: 0.14,
  bands: 3,
  normalFlatten: 0.8,
  rootDarken: 0.8,
  gradientBias: 0.7,
  windStrength: 0.22,
  windDirection: [1, 0.25],
  windSpeed: 1,
  waveFrequency: 0.2,
  fadeStart: 48,
  fadeEnd: 84,
  maxInstances: 15000,
});

const GRASS_PRESETS = Object.freeze({
  meadow: { rootColor: '#72ad49', tipColor: '#c4f07f', width: 1, flowerScale: 1 },
  sand: { rootColor: '#81713f', tipColor: '#d8c878', width: 0.62, flowerScale: 0.8 },
  wetland: { rootColor: '#376f52', tipColor: '#8fcb75', width: 0.78, flowerScale: 0.9 },
  farm: { rootColor: '#6f8138', tipColor: '#dfc568', width: 0.72, flowerScale: 0.82 },
  magic: { rootColor: '#4430bd', tipColor: '#59ffe4', width: 1.2, flowerScale: 1.35 },
  'alpine-moss': { rootColor: '#3f5f3e', tipColor: '#9cbd72', width: 1.75, flowerScale: 0.65 },
});

/**
 * Runtime-only cartoon grass renderer. The host owns editable density fields and
 * terrain data; this class only turns generic layer samples into reusable batches.
 */
export class CartoonGrassField {
  constructor(options = {}) {
    this.group = new THREE.Group();
    this.group.name = 'CartoonGrassField';
    this.group.userData.isGrassRoot = true;
    this.group.userData.isEnvironmentObject = true;
    this.group.userData.skipShaderApply = true;
    this._layers = Array.isArray(options.layers) ? options.layers : [];
    this._width = positive(options.width, 1);
    this._depth = positive(options.depth, 1);
    this._sampleHeight = typeof options.sampleHeight === 'function' ? options.sampleHeight : () => 0;
    this._sampleNormal = typeof options.sampleNormal === 'function' ? options.sampleNormal : () => [0, 1, 0];
    this._style = normalizeStyle(options.style);
    this._materials = [];
    this._geometries = [];
    this._meshes = [];
    this._time = 0;
    this._build();
  }

  get style() {
    return cloneStyle(this._style);
  }

  getStats() {
    return {
      layerCount: this._layers.filter((layer) => layer?.visible !== false).length,
      bladeCount: this._meshes.reduce((total, mesh) => total + (mesh.userData.grassBladeCount || 0), 0),
      flowerCount: this._meshes.reduce((total, mesh) => total + (mesh.userData.grassFlowerCount || 0), 0),
      drawCalls: this._meshes.length,
    };
  }

  update(deltaTime) {
    this._time += Math.max(0, Number(deltaTime) || 0);
    for (const material of this._materials) {
      if (material.userData.grassUniforms) material.userData.grassUniforms.uGrassTime.value = this._time;
    }
  }

  setStyle(partial = {}) {
    const next = normalizeStyle({ ...this._style, ...partial });
    const rebuild = next.cellSize !== this._style.cellSize
      || next.maxInstances !== this._style.maxInstances
      || next.bladeHeight !== this._style.bladeHeight
      || next.bladeWidth !== this._style.bladeWidth
      || next.rootColor !== this._style.rootColor
      || next.tipColor !== this._style.tipColor
      || next.rootDarken !== this._style.rootDarken
      || next.gradientBias !== this._style.gradientBias
      || next.bands !== this._style.bands
      || next.paletteVariation !== this._style.paletteVariation
      || next.flowerColors.join('|') !== this._style.flowerColors.join('|');
    this._style = next;
    if (rebuild) this._build();
    else this._syncUniforms();
    return this.style;
  }

  dispose() {
    this._clear();
    this.group.removeFromParent();
  }

  _build() {
    this._clear();
    const visibleLayers = this._layers.filter((layer) => layer?.visible !== false);
    if (visibleLayers.length === 0) return;
    const weights = visibleLayers.map((layer) => grassLayerBudgetWeight(normalizePreset(layer?.preset)));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    for (const [index, layer] of visibleLayers.entries()) {
      const budget = Math.max(1, Math.floor(this._style.maxInstances * weights[index] / totalWeight));
      this._buildLayer(layer, budget);
    }
  }

  _buildLayer(layer, budget) {
    const preset = normalizePreset(layer?.preset);
    const layerHeight = clamp(positive(layer?.height, 1), 0.2, 2.5);
    const layerStyle = resolveLayerStyle(this._style, preset, layer?.seed);
    const placements = collectGrassPlacements({
      layer,
      width: this._width,
      depth: this._depth,
      cellSize: this._style.cellSize,
      paletteVariation: this._style.paletteVariation,
      maxInstances: budget,
      sampleHeight: this._sampleHeight,
      sampleNormal: this._sampleNormal,
    });
    if (placements.length === 0) return;

    const bladeGeometry = createBladeGeometry(layerStyle, preset, layer?.seed);
    const bladeMaterial = createGrassMaterial(layerStyle);
    const blades = new THREE.InstancedMesh(bladeGeometry, bladeMaterial, placements.length);
    blades.name = `grass:${layer.id || 'layer'}`;
    blades.castShadow = false;
    blades.receiveShadow = true;
    blades.frustumCulled = false;
    blades.userData.isGrass = true;
    blades.userData.skipShaderApply = true;
    blades.userData.materialTags = ['vegetation', 'grass'];
    blades.userData.grassBladeCount = placements.length;
    blades.userData.grassPreset = preset;
    blades.userData.grassHeight = layerHeight;
    blades.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const groundNormals = new Float32Array(placements.length * 3);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    const baseColor = new THREE.Color(1, 1, 1);
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index];
      rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, placement.yaw);
      scale.set(
        placement.widthScale * layerStyle.bladeWidth,
        placement.heightScale * layerStyle.bladeHeight * layerHeight,
        1
      );
      matrix.compose(new THREE.Vector3(placement.x, placement.y + 0.015, placement.z), rotation, scale);
      blades.setMatrixAt(index, matrix);
      color.copy(baseColor).multiplyScalar(placement.paletteScale);
      blades.setColorAt(index, color);
      groundNormals.set(placement.normal, index * 3);
    }
    bladeGeometry.setAttribute('instanceGroundNormal', new THREE.InstancedBufferAttribute(groundNormals, 3));
    blades.instanceMatrix.needsUpdate = true;
    if (blades.instanceColor) blades.instanceColor.needsUpdate = true;
    this.group.add(blades);
    this._track(blades, bladeGeometry, bladeMaterial);

    const flowers = placements.filter((placement) => placement.variant === 'flowers');
    if (flowers.length > 0) this._buildFlowers(layer, flowers, layerStyle, preset, layerHeight);
  }

  _buildFlowers(layer, placements, layerStyle, preset, layerHeight) {
    const geometry = new THREE.OctahedronGeometry(0.11, 0);
    // `vertexColors` is what makes the fragment shader read vColor at all, and
    // vColor is `color * instanceColor`. Without a geometry colour attribute the
    // `color` attribute falls back to the WebGL default (0,0,0) and every flower
    // renders as a black speck, whatever the per-instance palette says.
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(
      new Float32Array(geometry.getAttribute('position').count * 3).fill(1),
      3
    ));
    // Flowers are stylized accents, not small PBR objects. Keeping them on an
    // unlit vertex-colour material prevents the environment light chain from
    // turning their tiny octahedra into black specks.
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, fog: true });
    material.userData.skipShaderApply = true;
    const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
    mesh.name = `grass-flowers:${layer.id || 'layer'}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.userData.isGrass = true;
    mesh.userData.skipShaderApply = true;
    mesh.userData.materialTags = ['vegetation', 'grass', 'flower'];
    mesh.userData.grassFlowerCount = placements.length;
    mesh.userData.grassPreset = preset;
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index];
      matrix.makeTranslation(
        placement.x,
        placement.y + 0.015 + layerStyle.bladeHeight * layerHeight * placement.heightScale * bladeTipHeight(preset),
        placement.z
      );
      matrix.scale(new THREE.Vector3(GRASS_PRESETS[preset].flowerScale, GRASS_PRESETS[preset].flowerScale, GRASS_PRESETS[preset].flowerScale));
      mesh.setMatrixAt(index, matrix);
      color.set(layerStyle.flowerColors[placement.flowerPalette % layerStyle.flowerColors.length]);
      mesh.setColorAt(index, color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    this._track(mesh, geometry, material);
  }

  _track(mesh, geometry, material) {
    this._meshes.push(mesh);
    this._geometries.push(geometry);
    this._materials.push(material);
  }

  _syncUniforms() {
    for (const material of this._materials) {
      syncGrassUniformValues(material.userData.grassUniforms, this._style);
      if (material.emissive && material.userData.grassUniforms) {
        material.emissive.set(this._style.tipColor);
      }
    }
  }

  _clear() {
    this.group.clear();
    for (const geometry of this._geometries) geometry.dispose();
    for (const material of this._materials) material.dispose();
    this._geometries.length = 0;
    this._materials.length = 0;
    this._meshes.length = 0;
  }
}

export function createGrassMaterial(style = {}) {
  const normalized = normalizeStyle(style);
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    vertexColors: true,
    fog: true,
  });
  const uniforms = createGrassUniforms(normalized);
  material.userData.skipShaderApply = true;
  material.userData.grassUniforms = uniforms;
  material.customProgramCacheKey = () => 'cartoon-grass-v2';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 instanceGroundNormal;
varying float vGrassBladeT;
varying float vGrassFade;
uniform float uGrassTime;
uniform float uGrassWindStrength;
uniform float uGrassWindSpeed;
uniform float uGrassWaveFrequency;
uniform vec2 uGrassWindDirection;
uniform float uGrassFadeStart;
uniform float uGrassFadeEnd;
uniform float uGrassNormalFlatten;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vGrassBladeT = clamp(position.y, 0.0, 1.0);
vec3 grassRootWorld = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
float grassWave = sin(dot(grassRootWorld.xz, normalize(uGrassWindDirection)) * uGrassWaveFrequency - uGrassTime * uGrassWindSpeed);
grassWave = sign(grassWave) * pow(abs(grassWave), 0.6);
vec3 grassWorldWind = normalize(vec3(uGrassWindDirection.x, 0.0, uGrassWindDirection.y));
vec3 grassLocalWind = normalize(vec3(dot(instanceMatrix[0].xyz, grassWorldWind), 0.0, dot(instanceMatrix[2].xyz, grassWorldWind)));
transformed += grassLocalWind * (grassWave * uGrassWindStrength * vGrassBladeT * vGrassBladeT);
float grassDistance = distance(cameraPosition, grassRootWorld);
float grassFade = 1.0 - smoothstep(uGrassFadeStart, uGrassFadeEnd, grassDistance);
vGrassFade = grassFade;
transformed.x *= grassFade;
transformed.y *= grassFade;`)
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
vec3 grassGroundViewNormal = normalize(normalMatrix * instanceGroundNormal);
transformedNormal = normalize(mix(transformedNormal, grassGroundViewNormal, uGrassNormalFlatten));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vGrassFade;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
// At the very end of the height fade, discard the collapsed blade instead of
// leaving a degenerate ground-plane fragment behind.
if (vGrassFade < 0.015) discard;`);
  };
  return material;
}

function createBladeGeometry(style, preset, seed = 1) {
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const root = new THREE.Color(style.rootColor);
  const tip = new THREE.Color(style.tipColor);

  const appendStrip = (levels, yaw = 0, widthScale = 1) => {
    const base = positions.length / 3;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (const level of levels) {
      const centerX = level.x || 0;
      const centerZ = level.z || 0;
      for (const side of [-1, 1]) {
        const localX = centerX + side * level.width * widthScale;
        positions.push(localX * cos - centerZ * sin, level.y, localX * sin + centerZ * cos);
        normals.push(-sin, 0, cos);
        uvs.push(side < 0 ? 0 : 1, level.t ?? level.y);
      }
      let gradient = Math.pow(level.t ?? level.y, style.gradientBias);
      gradient = Math.round(gradient * (style.bands - 1)) / Math.max(1, style.bands - 1);
      const shade = new THREE.Color().copy(root).lerp(tip, gradient)
        .multiplyScalar(mix(style.rootDarken, 1, smoothstep(0, 0.35, level.t ?? level.y)));
      colors.push(shade.r, shade.g, shade.b, shade.r, shade.g, shade.b);
    }
    for (let index = 0; index < levels.length - 1; index += 1) {
      const a = base + index * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  };

  const meadow = [
    { y: 0, width: 0.5, x: 0 },
    { y: 0.5, width: 0.47, x: 0.02 },
    { y: 0.82, width: 0.3, x: 0.08 },
    { y: 1, width: 0, x: 0.16 }
  ];
  if (preset === 'sand') {
    appendStrip([
      { y: 0, width: 0.28 }, { y: 0.58, width: 0.22 }, { y: 0.88, width: 0.13, x: 0.03 }, { y: 1, width: 0, x: 0.08 }
    ]);
  } else if (preset === 'wetland') {
    appendStrip([
      { y: 0, width: 0.34 }, { y: 0.58, width: 0.31, x: 0.03 }, { y: 0.9, width: 0.16, x: 0.1 }, { y: 1, width: 0, x: 0.16 }
    ], -0.18);
    appendStrip([
      { y: 0, width: 0.25 }, { y: 0.46, width: 0.23, x: -0.02 }, { y: 0.72, width: 0.1, x: -0.08 }, { y: 0.8, width: 0, x: -0.12, t: 1 }
    ], 0.58, 0.82);
  } else if (preset === 'farm') {
    appendStrip([
      { y: 0, width: 0.18 }, { y: 0.62, width: 0.16 }, { y: 0.82, width: 0.1 }, { y: 1, width: 0.04 }
    ]);
    for (const side of [-1, 1]) {
      appendStrip([
        { y: 0.58, width: 0.08, x: side * 0.05, t: 0.58 },
        { y: 0.76, width: 0.12, x: side * 0.13, t: 0.76 },
        { y: 0.94, width: 0.04, x: side * 0.08, t: 0.94 }
      ], side * 0.08, 0.72);
    }
  } else if (preset === 'magic') {
    const forkSpread = 0.26 + seededUnit(seed, 11) * 0.18;
    const leftLean = -0.24 - seededUnit(seed, 17) * 0.22;
    const rightLean = 0.3 + seededUnit(seed, 23) * 0.28;
    const crownTwist = -0.55 + seededUnit(seed, 29) * 1.1;
    appendStrip([
      { y: 0, width: 0.52 }, { y: 0.42, width: 0.46, x: -0.02 }, { y: 0.72, width: 0.28, x: leftLean * 0.45 }, { y: 1, width: 0, x: leftLean }
    ], crownTwist - 0.22);
    appendStrip([
      { y: 0, width: 0.4 }, { y: 0.4, width: 0.34, x: 0.03 }, { y: 0.68, width: 0.22, x: rightLean * 0.42 }, { y: 0.94, width: 0, x: rightLean, t: 1 }
    ], crownTwist + 0.48, 0.88);
    appendStrip([
      { y: 0.32, width: 0.18, x: 0, t: 0.32 },
      { y: 0.58, width: 0.2, x: forkSpread * 0.35, t: 0.58 },
      { y: 0.8, width: 0.1, x: forkSpread * 0.72, t: 0.8 },
      { y: 0.9, width: 0, x: forkSpread, t: 1 }
    ], crownTwist - 0.9, 0.68);
  } else if (preset === 'alpine-moss') {
    const cushion = [
      { y: 0, width: 0.72, t: 0 },
      { y: 0.2, width: 0.68, x: 0.04, t: 0.45 },
      { y: 0.38, width: 0.34, x: 0.08, t: 0.78 },
      { y: 0.46, width: 0, x: 0.12, t: 1 }
    ];
    appendStrip(cushion, 0);
    appendStrip(cushion, Math.PI * 2 / 3, 0.86);
    appendStrip(cushion, Math.PI * 4 / 3, 0.74);
  } else {
    appendStrip(meadow);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.grassPreset = preset;
  return geometry;
}

function createGrassUniforms(style) {
  return {
    uGrassTime: { value: 0 },
    uGrassWindStrength: { value: style.windStrength },
    uGrassWindSpeed: { value: style.windSpeed },
    uGrassWaveFrequency: { value: style.waveFrequency },
    uGrassWindDirection: { value: new THREE.Vector2(...style.windDirection) },
    uGrassFadeStart: { value: style.fadeStart },
    uGrassFadeEnd: { value: style.fadeEnd },
    uGrassNormalFlatten: { value: style.normalFlatten },
    uGrassRootColor: { value: new THREE.Color(style.rootColor) },
    uGrassTipColor: { value: new THREE.Color(style.tipColor) },
    uGrassRootDarken: { value: style.rootDarken },
    uGrassGradientBias: { value: style.gradientBias },
    uGrassBands: { value: style.bands },
  };
}

function syncGrassUniformValues(uniforms, style) {
  if (!uniforms) return;
  uniforms.uGrassWindStrength.value = style.windStrength;
  uniforms.uGrassWindSpeed.value = style.windSpeed;
  uniforms.uGrassWaveFrequency.value = style.waveFrequency;
  uniforms.uGrassWindDirection.value.set(...style.windDirection);
  uniforms.uGrassFadeStart.value = style.fadeStart;
  uniforms.uGrassFadeEnd.value = style.fadeEnd;
  uniforms.uGrassNormalFlatten.value = style.normalFlatten;
  uniforms.uGrassRootColor.value.set(style.rootColor);
  uniforms.uGrassTipColor.value.set(style.tipColor);
  uniforms.uGrassRootDarken.value = style.rootDarken;
  uniforms.uGrassGradientBias.value = style.gradientBias;
  uniforms.uGrassBands.value = style.bands;
}

function resolveLayerStyle(style, preset, seed = 1) {
  const profile = GRASS_PRESETS[preset];
  const magicHueShift = preset === 'magic' ? (seededUnit(seed, 41) - 0.5) * 0.18 : 0;
  const rootColor = new THREE.Color(profile.rootColor).offsetHSL(magicHueShift, 0, 0);
  const tipColor = new THREE.Color(profile.tipColor).offsetHSL(-magicHueShift * 0.65, 0, 0);
  const hostMix = preset === 'magic' ? 0.12 : 0.28;
  return {
    ...style,
    bladeWidth: style.bladeWidth * profile.width,
    rootColor: mixColor(`#${rootColor.getHexString()}`, style.rootColor, hostMix),
    tipColor: mixColor(`#${tipColor.getHexString()}`, style.tipColor, hostMix),
  };
}

function seededUnit(seed, salt) {
  let value = (Math.round(finite(seed, 1)) ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value / 0xffffffff;
}

function mixColor(a, b, amount) {
  return `#${new THREE.Color(a).lerp(new THREE.Color(b), amount).getHexString()}`;
}

function normalizePreset(value) {
  return Object.prototype.hasOwnProperty.call(GRASS_PRESETS, value) ? value : 'meadow';
}

function grassLayerBudgetWeight(preset) {
  if (preset === 'farm') return 2.5;
  if (preset === 'wetland' || preset === 'magic') return 1.2;
  if (preset === 'sand') return 0.8;
  return 1;
}

function bladeTipHeight(preset) {
  return preset === 'alpine-moss' ? 0.46 : 1;
}

function normalizeStyle(value = {}) {
  const direction = Array.isArray(value.windDirection) ? value.windDirection : DEFAULT_STYLE.windDirection;
  const start = nonNegative(value.fadeStart, DEFAULT_STYLE.fadeStart);
  const end = Math.max(start + 1, nonNegative(value.fadeEnd, DEFAULT_STYLE.fadeEnd));
  return {
    cellSize: clamp(positive(value.cellSize, DEFAULT_STYLE.cellSize), 0.35, 2),
    bladeWidth: clamp(positive(value.bladeWidth, DEFAULT_STYLE.bladeWidth), 0.05, 0.5),
    bladeHeight: clamp(positive(value.bladeHeight, DEFAULT_STYLE.bladeHeight), 0.25, 2.5),
    rootColor: colorString(value.rootColor, DEFAULT_STYLE.rootColor),
    tipColor: colorString(value.tipColor, DEFAULT_STYLE.tipColor),
    flowerColors: normalizeColors(value.flowerColors),
    paletteVariation: clamp(finite(value.paletteVariation, DEFAULT_STYLE.paletteVariation), 0, 0.5),
    bands: clamp(Math.round(finite(value.bands, DEFAULT_STYLE.bands)), 2, 3),
    normalFlatten: clamp(finite(value.normalFlatten, DEFAULT_STYLE.normalFlatten), 0, 1),
    rootDarken: clamp(finite(value.rootDarken, DEFAULT_STYLE.rootDarken), 0.15, 1),
    gradientBias: clamp(positive(value.gradientBias, DEFAULT_STYLE.gradientBias), 0.2, 2),
    windStrength: clamp(finite(value.windStrength, DEFAULT_STYLE.windStrength), 0, 1),
    windDirection: normalizeDirection(direction),
    windSpeed: clamp(positive(value.windSpeed, DEFAULT_STYLE.windSpeed), 0.05, 4),
    waveFrequency: clamp(positive(value.waveFrequency, DEFAULT_STYLE.waveFrequency), 0.02, 2),
    fadeStart: start,
    fadeEnd: end,
    maxInstances: clamp(Math.round(finite(value.maxInstances, DEFAULT_STYLE.maxInstances)), 100, 50000),
  };
}

function normalizeDirection(value) {
  const x = finite(value[0], 1);
  const y = finite(value[1], 0);
  const length = Math.hypot(x, y);
  return length < 0.0001 ? [1, 0] : [x / length, y / length];
}

function normalizeColors(value) {
  const source = Array.isArray(value) ? value : DEFAULT_STYLE.flowerColors;
  const colors = source.filter((color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)).slice(0, 6);
  return colors.length > 0 ? colors : [...DEFAULT_STYLE.flowerColors];
}

function cloneStyle(style) {
  return { ...style, windDirection: [...style.windDirection], flowerColors: [...style.flowerColors] };
}

function colorString(value, fallback) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function finite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback) {
  const parsed = finite(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function nonNegative(value, fallback) {
  return Math.max(0, finite(value, fallback));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
