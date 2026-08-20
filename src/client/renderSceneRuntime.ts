import * as THREE from 'three';
import { RenderStyleManager } from '@voxel-studio/render-runtime';
import { configureSunLight } from './lighting';
import { HDRI_DOME_RADIUS, HdriSkyController } from './hdriSky';
import { AtmosphereFxRuntime } from './atmosphereFxRuntime';
import { WeatherRuntime, type WeatherFrame } from './weatherRuntime';
import { RenderRuntimeAdapter } from './renderRuntimeAdapter';
import { configureRendererOutput } from './renderOutputPipeline';
import type { RenderedMap } from './mapRenderer';
import type { Vec3 } from '../shared/protocol';
import { DEFAULT_SUN_POSITION, type EditableMap } from '../shared/map';
import { isPointInsideWaterBody } from '../shared/mapWater';
import type { RenderScheme } from '../shared/renderScheme';
import type { VisualTimeOfDay } from '../shared/visualDirection';
import { mixHexColors } from '../shared/colorDirector';
import { compileAtmosphereFx } from '../shared/atmosphereFx';
import { compileRuntimeWeather } from '../shared/weather';
import {
  DEFAULT_RUNTIME_GRASS_STYLE,
  DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE,
  compileRenderPlan,
  compileRuntimeColorGrade,
  compileRuntimeEffectRecipes,
  compileRuntimeGrassStyle,
  compileRuntimeHdriSky,
  compileRuntimeLightRig,
  compileRuntimeMaterialThemes,
  compileRuntimeOutline,
  compileRuntimePostQuality,
  compileRuntimePresentation,
  compileRuntimeStyle,
  compileRuntimeTerrainMaterialStyle,
  compileRuntimeWaterStyles,
  type RuntimeLightRig
} from '../shared/renderPlan';

/** Background used when no render scheme is applied. */
const NEUTRAL_BACKGROUND = 0x111719;

/**
 * The slice of a `RenderSceneRuntime` that `applyRenderScheme` touches. Stated
 * structurally so the mapping can be tested without a WebGL context.
 */
export interface RenderSchemeTargets {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  sunLight: THREE.DirectionalLight;
  hemisphereLight: THREE.HemisphereLight;
  styleManager: Pick<RenderStyleManager, 'applyStyle' | 'setCartoonParams'>;
  adapter: Pick<
    RenderRuntimeAdapter,
    | 'resetScopedCapabilities'
    | 'applyOutline'
    | 'applyPresentation'
    | 'applyColorGrade'
    | 'applyPostQuality'
    | 'applyDistanceFog'
    | 'applyScopedCapabilities'
  >;
  hdriSky: Pick<HdriSkyController, 'apply' | 'clear'>;
  rendered: Pick<RenderedMap, 'setGrassStyle' | 'setLightingTimeOfDay'> | null;
  map?: EditableMap | null;
  updateLighting(): void;
}

export interface RenderSceneRuntimeOptions {
  /** Reuse an existing canvas; otherwise the renderer creates its own. */
  canvas?: HTMLCanvasElement;
  /** Resolves an HDRI file name from a render plan to a fetchable URL. */
  hdriUrl: (file: string) => string;
  pixelRatio?: number;
}

/**
 * Everything needed to show a WorldForge map exactly the way the editor does,
 * with no editor UI attached: scene, lights, the runtime style/post adapter,
 * fitted map shadows and the HDRI sky.
 *
 * The editor and `createMapViewer` both drive one of these, so a render
 * capability added for one can never be silently missing from the other.
 */
export class RenderSceneRuntime {
  readonly scene = new THREE.Scene();
  // The HDRI dome is a fixed-radius sphere centred on the origin, so the far
  // plane has to clear HDRI_DOME_RADIUS plus however far the camera moves out.
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, HDRI_DOME_RADIUS * 3);
  readonly renderer: THREE.WebGLRenderer;
  readonly sunLight = new THREE.DirectionalLight(0xfff0ce, 2.5);
  readonly hemisphereLight = new THREE.HemisphereLight(0xeaf6ff, 0x30382f, 1.6);
  readonly sunTarget = new THREE.Object3D();
  /** Meshes the runtime style manager is allowed to restyle. */
  readonly meshRegistry = new Map<string, THREE.Mesh>();
  readonly styleManager: RenderStyleManager;
  readonly adapter: RenderRuntimeAdapter;
  readonly hdriSky: HdriSkyController;
  readonly atmosphereFx: AtmosphereFxRuntime;
  readonly weather: WeatherRuntime;

  /** Source of truth for sun placement and shadow fit. */
  map: EditableMap | null = null;
  rendered: RenderedMap | null = null;
  private currentScheme: RenderScheme | null = null;
  private readonly basePixelRatio: number;
  private adaptiveQuality = 1;
  private width = 0;
  private height = 0;
  private pixelRatio = 0;
  private baseBackground = new THREE.Color(NEUTRAL_BACKGROUND);
  private baseSunColor = new THREE.Color(0xfff0ce);
  private baseHemisphereColor = new THREE.Color(0xeaf6ff);
  private baseHemisphereGroundColor = new THREE.Color(0x30382f);
  private baseSunIntensity = 2.5;
  private baseHemisphereIntensity = 1.6;
  private baseSunPosition = new THREE.Vector3(...DEFAULT_SUN_POSITION);
  private baseFogColor = '#111719';
  private baseFogDensity = 0;
  private rainRippleBudget = 0;
  private rainRippleSequence = 0;

  constructor(options: RenderSceneRuntimeOptions) {
    this.scene.background = new THREE.Color(NEUTRAL_BACKGROUND);
    this.camera.position.set(22, 18, 24);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, canvas: options.canvas });
    this.basePixelRatio = options.pixelRatio ?? Math.min(2, globalThis.devicePixelRatio ?? 1);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    configureRendererOutput(this.renderer);

    this.sunLight.position.set(...DEFAULT_SUN_POSITION);
    this.sunLight.target = this.sunTarget;
    this.sunLight.castShadow = true;
    this.scene.userData.directionalLight = this.sunLight;
    this.scene.add(this.hemisphereLight, this.sunLight, this.sunTarget);

    this.styleManager = new RenderStyleManager({
      THREE,
      renderer: this.renderer,
      scene: this.scene,
      meshRegistry: this.meshRegistry
    });
    // EffectBatchCoordinator creates regrouped tag batches after the base
    // primitive cache. Keep them in the same PBR/Cel refresh path as Scene Builder.
    this.styleManager.getBatchMeshes = () => this.rendered?.getRuntimeBatchMeshes() ?? [];
    this.adapter = new RenderRuntimeAdapter(this.renderer, this.scene, this.camera);
    this.hdriSky = new HdriSkyController(
      this.renderer,
      this.scene,
      options.hdriUrl,
      (environmentMap, waterEnvironmentMap) => this.adapter.syncEnvironment(environmentMap, waterEnvironmentMap)
    );
    this.atmosphereFx = new AtmosphereFxRuntime(this.scene);
    this.weather = new WeatherRuntime(this.scene, this.camera, this.renderer);
  }

  /** Re-fits the sun and its shadow camera to the current map. */
  updateLighting(): void {
    if (this.map) configureSunLight(this.sunLight, this.sunTarget, this.map);
  }

  /**
   * Wires a freshly built map into the runtime, or clears it with `null`.
   * Disposing the previous `RenderedMap` stays with the caller — the editor
   * needs to control that around undo.
   */
  attach(rendered: RenderedMap | null): void {
    this.meshRegistry.clear();
    this.adapter.setSceneRoots(
      rendered?.group ?? null,
      rendered?.modelsRoot ?? null,
      rendered ? {
        restore: rendered.restoreMaterialEffects,
        syncEnvironment: rendered.syncMaterialEnvironment
      } : undefined
    );
    this.rendered = rendered;
    this.syncAtmosphereFx();
    if (!rendered) return;
    rendered.modelsRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && object.userData.editorHelper !== true) this.meshRegistry.set(mesh.uuid, mesh);
    });
    this.applySurfaceCapabilities();
  }

  setSize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    const nextPixelRatio = this.renderer.getPixelRatio();
    const sizeChanged = nextWidth !== this.width || nextHeight !== this.height;
    if (!sizeChanged && nextPixelRatio === this.pixelRatio) return;
    if (sizeChanged) {
      this.camera.aspect = nextWidth / nextHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(nextWidth, nextHeight, false);
    }
    this.adapter.setSize(nextWidth, nextHeight);
    this.width = nextWidth;
    this.height = nextHeight;
    this.pixelRatio = nextPixelRatio;
  }

  /** Advances animated capabilities (grass, water, effects) and draws a frame. */
  renderFrame(deltaTime: number, elapsedSeconds: number): void {
    const weatherFrame = this.weather.update(deltaTime);
    this.applyWeatherFrame(weatherFrame);
    this.updateRainRipples(weatherFrame, deltaTime, elapsedSeconds);
    this.rendered?.update(deltaTime, this.camera, this.adapter.getContentVisibilityDistance());
    this.atmosphereFx.update(deltaTime, elapsedSeconds);
    this.adapter.tick(deltaTime, elapsedSeconds);
    this.adapter.render();
  }

  interact(position: Vec3, elapsedSeconds: number, waterBodyId: string | null): void {
    this.rendered?.interactGrass(position, elapsedSeconds);
    if (waterBodyId) this.adapter.addWaterInteraction(waterBodyId, position[0], position[2], elapsedSeconds);
  }

  clearInteraction(): void {
    this.rendered?.clearGrassInteraction();
  }

  /**
   * Applies one render scheme — or resets to the neutral editor look when the
   * scheme is `null`.
   */
  applyScheme(scheme: RenderScheme | null): void {
    this.currentScheme = scheme;
    applyRenderScheme(this, scheme);
    this.captureWeatherBase(scheme);
    this.weather.apply(compileRuntimeWeather(scheme?.renderPlan));
    this.applySurfaceCapabilities();
    this.syncAtmosphereFx();
  }

  getAtmosphereFxStats(): { particles: number; drawCalls: number; quality: number } {
    return this.atmosphereFx.getStats();
  }

  setAtmosphereFxQuality(quality: number): void {
    this.atmosphereFx.setQuality(quality);
    this.syncAtmosphereFx();
  }

  setAdaptiveQuality(quality: number): void {
    this.adaptiveQuality = THREE.MathUtils.clamp(quality, 0.4, 1);
    this.setAtmosphereFxQuality(this.adaptiveQuality);
    this.weather?.setQuality(this.adaptiveQuality);
    const ratioScale = 0.74 + this.adaptiveQuality * 0.26;
    this.renderer.setPixelRatio(Math.max(0.85, this.basePixelRatio * ratioScale));
    if (this.width > 0 && this.height > 0) this.setSize(this.width, this.height);
  }

  getAdaptiveQuality(): number {
    return this.adaptiveQuality;
  }

  getWeatherStats(): { particles: number; capacity: number; drawCalls: number; quality: number } {
    return this.weather.getStats();
  }

  dispose(): void {
    this.weather.dispose();
    this.atmosphereFx.dispose();
    this.hdriSky.dispose();
    this.renderer.dispose();
  }

  private syncAtmosphereFx(): void {
    if (!this.map) {
      this.rendered?.setSandFlowStrength(0);
      return;
    }
    const state = compileAtmosphereFx(this.map, this.currentScheme?.renderPlan);
    this.atmosphereFx.apply(this.map, state);
    this.rendered?.setSandFlowStrength(state.channels.sand);
  }

  private applySurfaceCapabilities(): void {
    const plan = this.currentScheme?.renderPlan;
    this.rendered?.setTerrainMaterialStyle(
      plan ? compileRuntimeTerrainMaterialStyle(plan) : DEFAULT_RUNTIME_TERRAIN_MATERIAL_STYLE
    );
    if (!plan?.modules.some((module) => module.id === 'runtime.weather')) {
      this.rendered?.setWeatherSurface(0, 0);
    }
  }

  private captureWeatherBase(scheme: RenderScheme | null): void {
    if (this.scene.background instanceof THREE.Color) this.baseBackground.copy(this.scene.background);
    this.baseSunColor.copy(this.sunLight.color);
    this.baseHemisphereColor.copy(this.hemisphereLight.color);
    this.baseHemisphereGroundColor.copy(this.hemisphereLight.groundColor);
    this.baseSunIntensity = this.sunLight.intensity;
    this.baseHemisphereIntensity = this.hemisphereLight.intensity;
    this.baseSunPosition.copy(this.sunLight.position);
    const settings = scheme
      ? { ...scheme.settings, ...(scheme.renderPlan ? compileRenderPlan(scheme.renderPlan) : {}) }
      : { fogColor: '#111719', fogDensity: 0 };
    this.baseFogColor = settings.fogColor;
    this.baseFogDensity = settings.fogDensity;
  }

  private applyWeatherFrame(frame: WeatherFrame): void {
    if (!frame.enabled) {
      if (this.scene.background instanceof THREE.Color) this.scene.background.copy(this.baseBackground);
      this.sunLight.color.copy(this.baseSunColor);
      this.hemisphereLight.color.copy(this.baseHemisphereColor);
      this.hemisphereLight.groundColor.copy(this.baseHemisphereGroundColor);
      this.sunLight.intensity = this.baseSunIntensity;
      this.hemisphereLight.intensity = this.baseHemisphereIntensity;
      this.sunLight.position.copy(this.baseSunPosition);
      this.adapter.applyDistanceFog(this.baseFogColor, this.baseFogDensity);
      this.rendered?.setWeatherSurface(0, 0);
      return;
    }

    const daylight = THREE.MathUtils.clamp(Math.sin((frame.timeOfDay - 6) / 12 * Math.PI), 0, 1);
    const dayFactor = 0.1 + daylight * 0.9;
    const coldSky = new THREE.Color('#9fb4c4');
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.baseBackground)
        .lerp(coldSky, (1 - frame.skyDim) * 0.34)
        .multiplyScalar(frame.skyDim * (0.3 + daylight * 0.7) + frame.lightningFlash * 0.5);
    }
    this.sunLight.color.copy(this.baseSunColor)
      .lerp(new THREE.Color(daylight > 0.22 ? '#dcecff' : '#8fa9d8'), 0.28 + (1 - daylight) * 0.4);
    this.hemisphereLight.color.copy(this.baseHemisphereColor).lerp(coldSky, (1 - frame.skyDim) * 0.4);
    this.hemisphereLight.groundColor.copy(this.baseHemisphereGroundColor).lerp(new THREE.Color('#3e4a50'), 0.22);
    this.sunLight.intensity = this.baseSunIntensity * frame.sunDim * dayFactor + frame.lightningFlash * 3.2;
    this.hemisphereLight.intensity = this.baseHemisphereIntensity * frame.ambientDim * (0.28 + daylight * 0.72)
      + frame.lightningFlash * 1.2;
    const orbit = Math.max(10, this.baseSunPosition.length());
    const solarAngle = (frame.timeOfDay - 6) / 24 * Math.PI * 2;
    this.sunLight.position.set(
      Math.cos(solarAngle) * orbit,
      Math.max(2, Math.sin(solarAngle) * orbit),
      Math.sin(solarAngle * 0.73) * orbit * 0.65
    );
    this.adapter.applyDistanceFog(this.baseFogColor, Math.max(this.baseFogDensity, frame.fogDensity));
    this.rendered?.setWeatherSurface(frame.wetness, frame.snowCover);
  }

  private updateRainRipples(frame: WeatherFrame, deltaTime: number, elapsedSeconds: number): void {
    if (!this.map || !frame.enabled || frame.precipitationKind !== 'rain' || frame.precipitation <= 0) {
      this.rainRippleBudget = 0;
      return;
    }
    this.rainRippleBudget += Math.max(0, deltaTime) * frame.precipitation * 5;
    let emitted = 0;
    while (this.rainRippleBudget >= 1 && emitted < 3) {
      this.rainRippleBudget -= 1;
      const impact = sampleRainRipplePoint(
        this.map,
        this.camera.position.x,
        this.camera.position.z,
        this.rainRippleSequence++
      );
      if (impact) {
        this.adapter.addRainRipple(impact.waterBodyId, impact.x, impact.z, elapsedSeconds);
      }
      emitted += 1;
    }
  }
}

export function sampleRainRipplePoint(
  map: EditableMap,
  cameraX: number,
  cameraZ: number,
  sequence: number
): { waterBodyId: string; x: number; z: number } | null {
  const radius = 7;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const x = cameraX + (rainUnit(sequence, attempt * 2) * 2 - 1) * radius;
    const z = cameraZ + (rainUnit(sequence, attempt * 2 + 1) * 2 - 1) * radius;
    const water = map.waterBodies.find((candidate) => isPointInsideWaterBody(candidate, x, z, map));
    if (water) return { waterBodyId: water.id, x, z };
  }
  return null;
}

function rainUnit(sequence: number, salt: number): number {
  let value = (Math.trunc(sequence) ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967295;
}

/**
 * The single place that maps a `RenderPlan` onto live three.js state. Both the
 * editor and `createMapViewer` reach it through `RenderSceneRuntime.applyScheme`;
 * adding a capability here is what keeps the two looking identical.
 */
export function applyRenderScheme(targets: RenderSchemeTargets, scheme: RenderScheme | null): void {
  const { scene, renderer, sunLight, hemisphereLight, styleManager, adapter, hdriSky } = targets;
  adapter.resetScopedCapabilities();

  if (!scheme) {
    styleManager.applyStyle({ renderMode: 'pbr' });
    adapter.applyOutline({ mode: 'none', params: {} });
    adapter.applyPresentation({ mode: 'none', sketch: {}, paper: {}, comic: {} });
    scene.background = new THREE.Color(NEUTRAL_BACKGROUND);
    scene.fog = null;
    hemisphereLight.color.set(0xeaf6ff);
    hemisphereLight.groundColor.set(0x30382f);
    hemisphereLight.intensity = 1.6;
    sunLight.color.set(0xfff0ce);
    sunLight.intensity = 2.5;
    configureRendererOutput(renderer, applySceneLightingContext(targets, 'noon', 1));
    adapter.applyColorGrade({ recipe: 'neutral' });
    adapter.applyPostQuality({ bloom: 'off', ssao: 'off', depthOfField: 'off' });
    adapter.applyDistanceFog('#111719', 0);
    adapter.applyScopedCapabilities([], [], []);
    targets.rendered?.setGrassStyle(grassStyleWithSharedWind(DEFAULT_RUNTIME_GRASS_STYLE, targets.map));
    hdriSky.clear();
    targets.updateLighting();
    return;
  }

  const plan = scheme.renderPlan;
  // The persisted settings remain the legacy fallback. A V2 plan is compiled
  // on every apply so developer sliders and visual direction stay live.
  const settings = { ...scheme.settings, ...(plan ? compileRenderPlan(plan) : {}) };
  scene.background = new THREE.Color(settings.background);
  // One depth-based fog pass also covers custom ShaderMaterials such as water.
  scene.fog = null;
  adapter.applyDistanceFog(settings.fogColor, settings.fogDensity);
  hemisphereLight.color.set(settings.hemisphereSkyColor);
  hemisphereLight.groundColor.set(settings.hemisphereGroundColor);
  hemisphereLight.intensity = settings.hemisphereIntensity;
  sunLight.color.set(settings.sunColor);
  sunLight.intensity = settings.sunIntensity;

  const runtimeStyle = plan ? compileRuntimeStyle(plan) : { mode: 'pbr' as const, cartoon: {} };
  styleManager.applyStyle({ renderMode: runtimeStyle.mode, cartoon: runtimeStyle.cartoon });
  if (runtimeStyle.mode === 'cel') styleManager.setCartoonParams(runtimeStyle.cartoon);
  adapter.applyOutline(plan ? compileRuntimeOutline(plan) : { mode: 'none', params: {} });
  adapter.applyPresentation(
    plan ? compileRuntimePresentation(plan) : { mode: 'none', sketch: {}, paper: {}, comic: {} }
  );
  adapter.applyColorGrade(plan ? compileRuntimeColorGrade(plan) : { recipe: 'neutral' });
  adapter.applyPostQuality(
    plan ? compileRuntimePostQuality(plan) : { bloom: 'off', ssao: 'off', depthOfField: 'off' }
  );
  if (plan) applyLightRig(compileRuntimeLightRig(plan), sunLight, hemisphereLight, settings);
  const timeOfDay = renderTimeOfDay(plan);
  configureRendererOutput(renderer, applySceneLightingContext(targets, timeOfDay, settings.exposure));
  targets.rendered?.setGrassStyle(grassStyleWithSharedWind(
    plan ? compileRuntimeGrassStyle(plan) : DEFAULT_RUNTIME_GRASS_STYLE,
    targets.map,
    plan,
    {
      fogColor: settings.fogColor,
      hemisphereSkyColor: `#${hemisphereLight.color.getHexString()}`,
      hemisphereGroundColor: `#${hemisphereLight.groundColor.getHexString()}`,
      sunColor: `#${sunLight.color.getHexString()}`,
      exposure: settings.exposure
    }
  ));
  adapter.applyScopedCapabilities(
    plan ? compileRuntimeMaterialThemes(plan) : [],
    waterStylesWithSharedWind(plan ? compileRuntimeWaterStyles(plan) : [], targets.map, plan),
    plan ? compileRuntimeEffectRecipes(plan) : []
  );
  if (plan) void hdriSky.apply(compileRuntimeHdriSky(plan));
  else hdriSky.clear();
}

function grassStyleWithSharedWind(
  style: typeof DEFAULT_RUNTIME_GRASS_STYLE,
  map?: EditableMap | null,
  plan?: RenderScheme['renderPlan'],
  environment?: Pick<RenderScheme['settings'], 'fogColor' | 'hemisphereSkyColor' | 'hemisphereGroundColor' | 'sunColor' | 'exposure'>
): typeof DEFAULT_RUNTIME_GRASS_STYLE {
  const explicit = plan?.modules.find((module) => module.id === 'runtime.grass-style')?.params ?? {};
  const environmentStyle: Partial<Pick<typeof DEFAULT_RUNTIME_GRASS_STYLE, 'rootColor' | 'tipColor' | 'groundColor'>> = environment
    ? deriveEnvironmentGrassColors(environment)
    : {};
  return {
    ...style,
    ...environmentStyle,
    rootColor: typeof explicit.rootColor === 'string' ? style.rootColor : environmentStyle.rootColor ?? style.rootColor,
    tipColor: typeof explicit.tipColor === 'string' ? style.tipColor : environmentStyle.tipColor ?? style.tipColor,
    groundColor: typeof explicit.groundColor === 'string' ? style.groundColor : environmentStyle.groundColor ?? style.groundColor,
    windDirection: typeof explicit.windAngle === 'number' || !map ? style.windDirection : map.visualSemantics.wind.direction,
    windStrength: typeof explicit.windStrength === 'number' || !map
      ? style.windStrength
      : Math.min(0.65, 0.12 + map.visualSemantics.wind.speed * 0.35 + map.visualSemantics.wind.gustStrength * 0.2)
  };
}

function deriveEnvironmentGrassColors(
  environment: Pick<RenderScheme['settings'], 'fogColor' | 'hemisphereSkyColor' | 'hemisphereGroundColor' | 'sunColor' | 'exposure'>
): Pick<typeof DEFAULT_RUNTIME_GRASS_STYLE, 'rootColor' | 'tipColor' | 'groundColor'> {
  const exposureMix = Math.min(0.16, Math.max(0, (environment.exposure - 0.75) * 0.12));
  const groundColor = mixHexColors(DEFAULT_RUNTIME_GRASS_STYLE.groundColor, environment.hemisphereGroundColor, 0.38);
  const rootColor = mixHexColors(
    mixHexColors(DEFAULT_RUNTIME_GRASS_STYLE.rootColor, environment.hemisphereGroundColor, 0.3),
    environment.fogColor,
    0.08 + exposureMix
  );
  const tipColor = mixHexColors(
    mixHexColors(DEFAULT_RUNTIME_GRASS_STYLE.tipColor, environment.hemisphereSkyColor, 0.16),
    environment.sunColor,
    0.18 + exposureMix
  );
  return { rootColor, tipColor, groundColor };
}

function waterStylesWithSharedWind(
  styles: ReturnType<typeof compileRuntimeWaterStyles>,
  map?: EditableMap | null,
  plan?: RenderScheme['renderPlan']
): ReturnType<typeof compileRuntimeWaterStyles> {
  if (!map) return styles;
  const modules = plan?.modules.filter((module) => module.id === 'runtime.water-style') ?? [];
  return styles.map((style, index) => ({
    ...style,
    waveStrength: typeof modules[index]?.params.waveStrength === 'number'
      ? style.waveStrength
      : Math.min(1.5, 0.12 + map.visualSemantics.wind.speed * 0.25 + map.visualSemantics.wind.gustStrength * 0.2),
    waveSpeed: typeof modules[index]?.params.waveSpeed === 'number'
      ? style.waveSpeed
      : Math.min(2, 0.2 + map.visualSemantics.wind.speed * 0.7)
  }));
}

function applyLightRig(
  rig: RuntimeLightRig,
  sun: THREE.DirectionalLight,
  hemisphere: THREE.HemisphereLight,
  base: RenderScheme['settings']
): void {
  const recipes: Record<RuntimeLightRig['recipe'], {
    key: number;
    fill: number;
    sun: string;
    sky: string;
    ground: string;
    softness: number;
  }> = {
    neutral: { key: 1, fill: 1, sun: base.sunColor, sky: base.hemisphereSkyColor, ground: base.hemisphereGroundColor, softness: 0.55 },
    'soft-morning': { key: 0.72, fill: 1.08, sun: '#ffe5bd', sky: '#e7f2f2', ground: '#46554d', softness: 0.92 },
    'hard-day': { key: 1.18, fill: 0.92, sun: '#fff0cf', sky: '#d9efff', ground: '#657266', softness: 0.3 },
    backlit: { key: 1.18, fill: 0.76, sun: '#ffd5a1', sky: '#dbe9f1', ground: '#3d4347', softness: 0.42 },
    overcast: { key: 0.36, fill: 1.28, sun: '#e8eef0', sky: '#d9e2e4', ground: '#59605d', softness: 1 },
    sunset: { key: 1.08, fill: 0.72, sun: '#ff9c5a', sky: '#c99691', ground: '#40373d', softness: 0.72 },
    night: { key: 0.035, fill: 0.1, sun: '#9bb8e8', sky: '#52678f', ground: '#161b29', softness: 0.88 }
  };
  const recipe = recipes[rig.recipe];
  const strength = rig.strength ?? 1;
  const warmth = THREE.MathUtils.clamp(rig.warmth ?? 0, -1, 1);
  sun.intensity = base.sunIntensity * recipe.key * strength;
  hemisphere.intensity = base.hemisphereIntensity * recipe.fill * Math.sqrt(strength);
  sun.color.set(recipe.sun).lerp(
    new THREE.Color(warmth >= 0 ? '#ffb56b' : '#9fc9ff'),
    Math.abs(warmth) * 0.28
  );
  hemisphere.color.set(recipe.sky);
  hemisphere.groundColor.set(recipe.ground);
  sun.shadow.radius = 1 + (rig.shadowSoftness ?? recipe.softness) * 4;
  sun.shadow.needsUpdate = true;
}

function renderTimeOfDay(plan: RenderScheme['renderPlan']): VisualTimeOfDay {
  if (plan && compileRuntimeLightRig(plan).recipe === 'night') return 'night';
  if (plan?.visualDirection) return plan.visualDirection.timeOfDay;
  return 'noon';
}

function applySceneLightingContext(
  targets: RenderSchemeTargets,
  timeOfDay: VisualTimeOfDay,
  exposure: number
): number {
  targets.rendered?.setLightingTimeOfDay(timeOfDay);
  if (targets.map?.sceneMode !== 'indoor') return exposure;
  targets.hemisphereLight.intensity *= timeOfDay === 'night' ? 0.28 : timeOfDay === 'evening' ? 0.34 : 0.42;
  const exposureScale = timeOfDay === 'night' ? 1.35 : timeOfDay === 'evening' ? 1.18 : 1.08;
  return THREE.MathUtils.clamp(exposure * exposureScale, 0.05, 3);
}
