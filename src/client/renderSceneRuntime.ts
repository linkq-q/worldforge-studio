import * as THREE from 'three';
import { RenderStyleManager } from '@voxel-studio/render-runtime';
import { configureSunLight } from './lighting';
import { HDRI_DOME_RADIUS, HdriSkyController } from './hdriSky';
import { MapShadowRuntime } from './mapShadowRuntime';
import { AtmosphereFxRuntime } from './atmosphereFxRuntime';
import { RenderRuntimeAdapter } from './renderRuntimeAdapter';
import { configureRendererOutput } from './renderOutputPipeline';
import type { RenderedMap } from './mapRenderer';
import type { Vec3 } from '../shared/protocol';
import { DEFAULT_SUN_POSITION, type EditableMap } from '../shared/map';
import type { RenderScheme } from '../shared/renderScheme';
import { compileAtmosphereFx } from '../shared/atmosphereFx';
import {
  DEFAULT_RUNTIME_GRASS_STYLE,
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
  rendered: Pick<RenderedMap, 'setGrassStyle'> | null;
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
 * cascaded shadows and the HDRI sky.
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
  readonly shadows: MapShadowRuntime;
  readonly hdriSky: HdriSkyController;
  readonly atmosphereFx: AtmosphereFxRuntime;

  /** Source of truth for sun placement and shadow fit. */
  map: EditableMap | null = null;
  rendered: RenderedMap | null = null;
  private currentScheme: RenderScheme | null = null;
  private readonly basePixelRatio: number;
  private adaptiveQuality = 1;

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
    this.shadows = new MapShadowRuntime(this.scene, this.camera, this.sunLight, () => this.updateLighting());
    this.hdriSky = new HdriSkyController(
      this.renderer,
      this.scene,
      options.hdriUrl,
      (environmentMap) => this.adapter.syncEnvironment(environmentMap)
    );
    this.atmosphereFx = new AtmosphereFxRuntime(this.scene);
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
    this.shadows.setSceneRoots(rendered?.group ?? null, rendered?.modelsRoot ?? null);
    this.rendered = rendered;
    this.syncAtmosphereFx();
    if (!rendered) return;
    rendered.modelsRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && object.userData.editorHelper !== true) this.meshRegistry.set(mesh.uuid, mesh);
    });
  }

  setSize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.adapter.setSize(width, height);
  }

  /** Advances animated capabilities (grass, water, effects) and draws a frame. */
  renderFrame(deltaTime: number, elapsedSeconds: number): void {
    this.rendered?.update(deltaTime, this.camera, this.adapter.getContentVisibilityDistance());
    this.atmosphereFx.update(deltaTime, elapsedSeconds);
    this.shadows.update();
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
    const ratioScale = 0.74 + this.adaptiveQuality * 0.26;
    this.renderer.setPixelRatio(Math.max(0.85, this.basePixelRatio * ratioScale));
  }

  getAdaptiveQuality(): number {
    return this.adaptiveQuality;
  }

  private syncAtmosphereFx(): void {
    if (!this.map) {
      this.adapter.applyAtmosphereFx(null);
      return;
    }
    const state = compileAtmosphereFx(this.map, this.currentScheme?.renderPlan);
    this.atmosphereFx.apply(this.map, state);
    this.adapter.applyAtmosphereFx(state);
  }
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
    configureRendererOutput(renderer);
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
  configureRendererOutput(renderer, settings.exposure);

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
  targets.rendered?.setGrassStyle(grassStyleWithSharedWind(
    plan ? compileRuntimeGrassStyle(plan) : DEFAULT_RUNTIME_GRASS_STYLE,
    targets.map,
    plan
  ));
  if (plan) applyLightRig(compileRuntimeLightRig(plan), sunLight, hemisphereLight, settings);
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
  plan?: RenderScheme['renderPlan']
): typeof DEFAULT_RUNTIME_GRASS_STYLE {
  if (!map) return style;
  const explicit = plan?.modules.find((module) => module.id === 'runtime.grass-style')?.params ?? {};
  return {
    ...style,
    windDirection: typeof explicit.windAngle === 'number' ? style.windDirection : map.visualSemantics.wind.direction,
    windStrength: typeof explicit.windStrength === 'number'
      ? style.windStrength
      : Math.min(0.65, 0.12 + map.visualSemantics.wind.speed * 0.35 + map.visualSemantics.wind.gustStrength * 0.2)
  };
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
    sunset: { key: 1.08, fill: 0.72, sun: '#ff9c5a', sky: '#c99691', ground: '#40373d', softness: 0.72 }
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
