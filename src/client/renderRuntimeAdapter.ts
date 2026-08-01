import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import {
  ARTISTIC_OUTLINE_PRESETS,
  createBoundaryIdPass,
  createCurvatureEdgePass,
  createEdgeMaskPass,
  createInkEdgePass
} from '@voxel-studio/render-runtime/outline';
import {
  COMIC_LOOK_PRESETS,
  GlobalBloomPass,
  SharedSSAOPass,
  createComicPrintPass,
  createPaperTexturePass,
  createSketchHatchPass,
  createToneMapPass
} from '@voxel-studio/render-runtime/postprocess';
import { WaterSurface, WaterfallSurface } from '@voxel-studio/render-runtime/environment';
import { createEffectRuntime } from '@voxel-studio/render-runtime/effects';
import { applyDefaultWaterState, DEFAULT_WATER_STATE } from './defaultWaterState';
import { WorldForgeMaterialTagRuntime } from './materialTagRuntimeAdapter';
import { createComposerRenderTarget } from './renderOutputPipeline';
import type {
  RuntimeColorGrade,
  RuntimeEffectRecipe,
  RuntimeMaterialTheme,
  RuntimeOutlineStyle,
  RuntimePostQuality,
  RuntimeWaterStyle,
  RuntimePresentationStyle
} from '../shared/renderPlan';

const NORMAL_PREPASS_LAYER = 29;

interface MaterialBaseline {
  material: THREE.Material;
  color?: THREE.Color;
  roughness?: number;
  metalness?: number;
}

interface WaterBinding {
  mesh: THREE.Mesh;
  originalMaterial: THREE.Material | THREE.Material[];
  surface: WaterSurface | WaterfallSurface;
}

export class RenderRuntimeAdapter {
  private readonly composer: EffectComposer;
  private readonly normalTarget: THREE.WebGLRenderTarget;
  private readonly edgeTarget: THREE.WebGLRenderTarget;
  private readonly boundaryTarget: THREE.WebGLRenderTarget;
  private readonly normalMaterial = new THREE.MeshNormalMaterial();
  private readonly boundaryPass = createBoundaryIdPass();
  private readonly edgePass = createEdgeMaskPass();
  private readonly curvaturePass: ReturnType<typeof createCurvatureEdgePass>;
  private readonly inkPass: ReturnType<typeof createInkEdgePass>;
  private readonly paperPass = createPaperTexturePass({ strength: 0.12, scale: 2 });
  private readonly comicPass = createComicPrintPass();
  private readonly sketchPass = createSketchHatchPass();
  private readonly toneMapPass = createToneMapPass();
  private readonly ssaoPass: SharedSSAOPass;
  private readonly bloomPass = new GlobalBloomPass(new THREE.Vector2(1, 1), 0.4, 0.35, 0.82);
  private readonly effectRuntime = createEffectRuntime().runtime;
  private readonly materialTagRuntime: WorldForgeMaterialTagRuntime;
  private readonly materialBaselines = new Map<THREE.Material, MaterialBaseline>();
  private readonly waterBindings: WaterBinding[] = [];
  private contentRoot: THREE.Object3D | null = null;
  private modelsRoot: THREE.Object3D | null = null;
  private outlineMode: RuntimeOutlineStyle['mode'] = 'none';
  private presentationMode: RuntimePresentationStyle['mode'] = 'none';
  private width = 1;
  private height = 1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera
  ) {
    this.materialTagRuntime = new WorldForgeMaterialTagRuntime(scene, this.effectRuntime);
    this.curvaturePass = createCurvatureEdgePass(renderer);
    this.inkPass = createInkEdgePass(renderer);
    this.ssaoPass = new SharedSSAOPass(scene, camera, 1, 1, 16);
    this.normalTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1)
    });
    this.normalTarget.texture.colorSpace = THREE.NoColorSpace;
    this.edgeTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat
    });
    this.edgeTarget.texture.colorSpace = THREE.NoColorSpace;
    this.boundaryTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false
    });
    this.boundaryTarget.texture.colorSpace = THREE.NoColorSpace;
    this.boundaryTarget.texture.generateMipmaps = false;

    this.composer = new EffectComposer(renderer, createComposerRenderTarget());
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(this.ssaoPass);
    this.composer.addPass(this.toneMapPass);
    // Stylization stays last so bloom cannot soften finished ink/sketch lines.
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.curvaturePass);
    this.composer.addPass(this.inkPass);
    this.composer.addPass(this.paperPass);
    this.composer.addPass(this.comicPass);
    this.composer.addPass(this.sketchPass);
    this.composer.addPass(new OutputPass());

    this.ssaoPass.enabled = false;
    this.toneMapPass.enabled = false;
    this.bloomPass.enabled = false;
    this.curvaturePass.enabled = false;
    this.inkPass.enabled = false;
    this.paperPass.enabled = false;
    this.comicPass.enabled = false;
    this.sketchPass.enabled = false;
    this.setNumber(this.toneMapPass, 'uLUTStrength', 0);
    this.applyOutline({ mode: 'none', params: {} });
    this.applyPresentation({ mode: 'none', sketch: {}, paper: {}, comic: {} });
  }

  setSceneRoots(contentRoot: THREE.Object3D | null, modelsRoot: THREE.Object3D | null): void {
    if (this.modelsRoot && this.modelsRoot !== modelsRoot) this.resetScopedCapabilities();
    this.contentRoot = contentRoot;
    this.modelsRoot = modelsRoot;
  }

  applyColorGrade(grade: RuntimeColorGrade): void {
    const recipes: Record<RuntimeColorGrade['recipe'], {
      temperature: number;
      contrast: number;
      saturation: number;
      shadowLift: number;
      tint: string;
    }> = {
      neutral: { temperature: 0, contrast: 1, saturation: 1, shadowLift: 0, tint: '#ffffff' },
      warm: { temperature: 0.35, contrast: 1.04, saturation: 1.05, shadowLift: 0.02, tint: '#fff4e5' },
      cool: { temperature: -0.3, contrast: 1.02, saturation: 0.92, shadowLift: 0.025, tint: '#e9f3ff' },
      misty: { temperature: -0.12, contrast: 0.82, saturation: 0.72, shadowLift: 0.1, tint: '#f0f5f2' },
      cinematic: { temperature: 0.08, contrast: 1.22, saturation: 0.92, shadowLift: 0.015, tint: '#fff7ed' },
      pastel: { temperature: 0.1, contrast: 0.82, saturation: 0.78, shadowLift: 0.08, tint: '#fff8f3' }
    };
    const preset = recipes[grade.recipe];
    const temperature = grade.temperature ?? preset.temperature;
    const tint = new THREE.Color(grade.tint ?? preset.tint);
    tint.multiply(temperatureTint(temperature));
    const neutral = grade.recipe === 'neutral'
      && grade.temperature === undefined
      && grade.contrast === undefined
      && grade.saturation === undefined
      && grade.shadowLift === undefined
      && grade.tint === undefined;
    this.toneMapPass.enabled = !neutral;
    this.setNumber(this.toneMapPass, 'uLUTStrength', 0);
    this.setNumber(this.toneMapPass, 'uContrast', grade.contrast ?? preset.contrast);
    this.setNumber(this.toneMapPass, 'uSaturation', grade.saturation ?? preset.saturation);
    this.setNumber(this.toneMapPass, 'uBrightness', grade.shadowLift ?? preset.shadowLift);
    this.setVector3(this.toneMapPass, 'uTint', tint.r, tint.g, tint.b);
  }

  applyPostQuality(quality: RuntimePostQuality): void {
    this.ssaoPass.enabled = quality.ssao !== 'off';
    if (this.ssaoPass.enabled) {
      this.ssaoPass.kernelRadius = quality.ssao === 'strong' ? 7 : 4;
      this.ssaoPass.minDistance = 0.004;
      this.ssaoPass.maxDistance = quality.ssao === 'strong' ? 0.085 : 0.045;
    }
    this.bloomPass.enabled = quality.bloom !== 'off';
    this.bloomPass.strength = quality.bloomStrength
      ?? (quality.bloom === 'strong' ? 0.85 : quality.bloom === 'soft' ? 0.38 : 0);
    this.bloomPass.radius = quality.bloom === 'strong' ? 0.55 : 0.32;
    this.bloomPass.threshold = quality.bloom === 'strong' ? 0.72 : 0.86;
  }

  applyScopedCapabilities(
    materialThemes: RuntimeMaterialTheme[],
    waterStyles: RuntimeWaterStyle[],
    effects: RuntimeEffectRecipe[]
  ): void {
    this.resetScopedCapabilities();
    if (!this.modelsRoot) return;
    this.materialTagRuntime.apply(this.modelsRoot);
    for (const theme of materialThemes) this.applyMaterialTheme(theme);
    this.applyWaterStyles(waterStyles);
    this.applyEffectRecipes(effects);
  }

  resetScopedCapabilities(): void {
    for (const binding of this.waterBindings.splice(0)) {
      binding.mesh.material = binding.originalMaterial;
      binding.surface.dispose();
    }
    for (const baseline of this.materialBaselines.values()) {
      const material = baseline.material as THREE.MeshStandardMaterial;
      if (baseline.color && material.color) material.color.copy(baseline.color);
      if (baseline.roughness !== undefined && 'roughness' in material) material.roughness = baseline.roughness;
      if (baseline.metalness !== undefined && 'metalness' in material) material.metalness = baseline.metalness;
      material.needsUpdate = true;
    }
    this.materialBaselines.clear();
    if (this.modelsRoot) {
      this.materialTagRuntime.clear(this.modelsRoot);
      this.effectRuntime.removeFromObject3D(this.modelsRoot);
    }
  }

  tick(deltaTime: number, elapsedSeconds: number): void {
    for (const binding of this.waterBindings) binding.surface.update(deltaTime, this.camera, null);
    if (this.modelsRoot) {
      this.effectRuntime.updateRuntimeUniforms(this.modelsRoot, {
        uTime: elapsedSeconds,
        uChargeLevel: 1
      });
    }
  }

  applyOutline(style: RuntimeOutlineStyle): void {
    this.outlineMode = style.mode;
    const preset = {
      ...(ARTISTIC_OUTLINE_PRESETS[style.mode] ?? ARTISTIC_OUTLINE_PRESETS.none),
      ...outlineOverrides(style.params)
    };

    this.inkPass.enabled = style.mode === 'clean' || style.mode === 'ink' || style.mode === 'echo';
    this.curvaturePass.enabled = style.mode === 'curvature';
    this.setEdgeMaskValues(preset);
    this.setInkValues(preset);
    this.setCurvatureValues(preset);
  }

  applyPresentation(style: RuntimePresentationStyle): void {
    this.presentationMode = style.mode;
    const sketchEnabled = style.mode === 'sketch';
    const comicId = style.mode === 'comic-clean'
      ? 'clean'
      : style.mode === 'comic-print'
        ? 'print'
        : null;

    this.sketchPass.enabled = sketchEnabled;
    this.paperPass.enabled = sketchEnabled;
    this.comicPass.enabled = comicId !== null;

    if (sketchEnabled) {
      const params = style.sketch;
      this.setNumber(this.sketchPass, 'uHatchSpaceMode', params.coordinateSpace === 'screen' ? 0 : 1);
      this.setNumber(this.sketchPass, 'uWorldScale', params.worldScale);
      this.setNumber(this.sketchPass, 'uStrength', params.strength);
      this.setNumber(this.sketchPass, 'uHatchSpacing', params.hatchSpacing);
      this.setNumber(this.sketchPass, 'uHatchAngle', degrees(params.hatchAngle));
      this.setNumber(this.sketchPass, 'uLineWidth', params.lineWidth);
      this.setNumber(this.sketchPass, 'uJitter', params.jitter);
      this.setNumber(
        this.sketchPass,
        'uPreserveColor',
        params.preserveColor === undefined ? undefined : Number(params.preserveColor)
      );
      this.setNumber(this.sketchPass, 'uToneStrength', params.toneStrength);
      this.setNumber(this.sketchPass, 'uToneBias', params.toneBias);
      this.setNumber(this.sketchPass, 'uDenseSpacing', params.denseSpacing);
      this.setNumber(this.sketchPass, 'uDarkFill', params.darkFill);
      this.setNumber(this.sketchPass, 'uBreak', params.break);
      this.setNumber(this.sketchPass, 'uBoilSpeed', 0);
      this.setColor(this.sketchPass, 'uLineColor', params.lineColor);
      this.setColor(this.sketchPass, 'uPaperColor', params.paperColor);
      this.setNumber(this.paperPass, 'uPaperStrength', style.paper.strength ?? 0.12);
      this.setNumber(this.paperPass, 'uPaperScale', style.paper.scale ?? 2);
      this.setColor(this.paperPass, 'uPaperTint', style.paper.tint ?? params.paperColor);
    }

    if (comicId) {
      const recipe = COMIC_LOOK_PRESETS[comicId];
      const comic = style.comic;
      this.setNumber(this.comicPass, 'uHalftoneEnabled', Number(recipe.comicHalftoneEnabled));
      this.setNumber(
        this.comicPass,
        'uHalftoneStrength',
        comic.halftoneStrength ?? numberValue(recipe.comicHalftoneStrength, 0)
      );
      this.setNumber(
        this.comicPass,
        'uHalftoneCellSize',
        comic.cellSize ?? numberValue(recipe.comicHalftoneCellSize, 7)
      );
      this.setNumber(this.comicPass, 'uHalftoneOpacity', numberValue(recipe.comicHalftoneOpacity, 0.7));
      this.setNumber(
        this.comicPass,
        'uHalftoneAngle',
        degrees(numberValue(recipe.comicHalftoneAngle, 45))
      );
      this.setNumber(this.comicPass, 'uPrintOffsetEnabled', Number(recipe.comicPrintOffsetEnabled));
      this.setNumber(
        this.comicPass,
        'uPrintOffsetAmount',
        comic.printOffset ?? numberValue(recipe.comicPrintOffsetAmount, 0)
      );
      this.setNumber(
        this.comicPass,
        'uPrintOffsetAngle',
        degrees(numberValue(recipe.comicPrintOffsetAngle, 20))
      );
      this.setNumber(this.comicPass, 'uPosterizeEnabled', Number(recipe.comicPosterizeEnabled));
      this.setNumber(this.comicPass, 'uColorLevels', numberValue(recipe.comicColorLevels, 6));
      this.setNumber(
        this.comicPass,
        'uLineBoost',
        comic.lineBoost ?? numberValue(recipe.comicLineBoost, 0)
      );
      this.setNumber(
        this.comicPass,
        'uLineWidth',
        comic.lineWidth ?? numberValue(recipe.comicLineWidth, 1.5)
      );
      this.setNumber(this.comicPass, 'uLineThreshold', numberValue(recipe.comicLineThreshold, 0.05));
      this.setColor(
        this.comicPass,
        'uHalftoneInkColor',
        comic.inkColor ?? stringValue(recipe.comicHalftoneInkColor)
      );
      this.setColor(this.comicPass, 'uPrintOffsetColorA', stringValue(recipe.comicPrintOffsetColorA));
      this.setColor(this.comicPass, 'uPrintOffsetColorB', stringValue(recipe.comicPrintOffsetColorB));
      this.setColor(this.comicPass, 'uLineColor', comic.inkColor ?? stringValue(recipe.comicLineColor));
    }
  }

  private applyMaterialTheme(theme: RuntimeMaterialTheme): void {
    if (!this.modelsRoot) return;
    const targets = scopedTargets(this.modelsRoot, theme.scope);
    for (const target of targets) {
      target.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !matchesScope(mesh, theme.scope)) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const source of materials) {
          const material = source as THREE.MeshStandardMaterial;
          if (!material.color) continue;
          if (!this.materialBaselines.has(material)) {
            this.materialBaselines.set(material, {
              material,
              color: material.color.clone(),
              roughness: typeof material.roughness === 'number' ? material.roughness : undefined,
              metalness: typeof material.metalness === 'number' ? material.metalness : undefined
            });
          }
          const baseline = this.materialBaselines.get(material);
          const targetStyle = materialThemeStyle(theme.recipe, theme.scope.tag);
          const strength = theme.strength ?? 1;
          const color = new THREE.Color(theme.color ?? targetStyle.color);
          if (baseline?.color) material.color.copy(baseline.color).lerp(color, strength);
          if (typeof material.roughness === 'number') {
            const next = theme.roughness ?? targetStyle.roughness;
            material.roughness = THREE.MathUtils.lerp(baseline?.roughness ?? material.roughness, next, strength);
          }
          if (typeof material.metalness === 'number') {
            const next = theme.metalness ?? targetStyle.metalness;
            material.metalness = THREE.MathUtils.lerp(baseline?.metalness ?? material.metalness, next, strength);
          }
          material.needsUpdate = true;
        }
      });
    }
  }

  private applyWaterStyles(styles: RuntimeWaterStyle[]): void {
    if (!this.modelsRoot) return;
    const meshes = scopedMeshes(this.modelsRoot, { target: 'water', tag: 'water' });
    for (const mesh of meshes) {
      const style = styles.find((candidate) => matchesScope(mesh, candidate.scope));
      const recipe = waterRecipe(style?.recipe ?? defaultWaterStyle(mesh).recipe);
      const waterColor = new THREE.Color(style?.color ?? DEFAULT_WATER_STATE.uWaterColor);
      const shallowColor = style?.color
        ? waterColor.clone().lerp(new THREE.Color('#ffffff'), 0.22)
        : new THREE.Color(DEFAULT_WATER_STATE.uShallowColor);
      const depthColor = style?.color
        ? waterColor.clone().multiplyScalar(0.5)
        : new THREE.Color(DEFAULT_WATER_STATE.uDepthColor);
      const root = new THREE.Group();
      const surface = hasMaterialTag(mesh, 'water:fall') || hasMaterialTag(mesh, 'fall')
        ? new WaterfallSurface(this.scene, this.renderer, root, {
            width: 1,
            height: 1,
            segmentsX: 1,
            segmentsY: 1,
            topColor: shallowColor,
            bottomColor: depthColor,
            foamColor: new THREE.Color(DEFAULT_WATER_STATE.uFoamColor),
            opacity: style?.opacity ?? DEFAULT_WATER_STATE.uOpacity,
            flowSpeed: style ? recipe.waveSpeed : DEFAULT_WATER_STATE.uWaveSpeed,
            flowNoiseStrength: style?.waveStrength ?? DEFAULT_WATER_STATE.uWaveHeight,
            bottomFoamIntensity: style?.foamStrength ?? DEFAULT_WATER_STATE.uFoamStrength,
            splashEnabled: false
          })
        : new WaterSurface(this.scene, this.renderer, root, {
            size: 1,
            segments: 1
          });
      root.remove(surface.mesh);
      surface.mesh.geometry.dispose();
      if (surface instanceof WaterSurface) {
        applyDefaultWaterState(surface);
        if (style) {
          surface.importState({
            waterMode: recipe.mode,
            uWaterColor: `#${waterColor.getHexString()}`,
            uShallowColor: `#${shallowColor.getHexString()}`,
            uDepthColor: `#${depthColor.getHexString()}`,
            uWaveHeight: (style.waveStrength ?? recipe.waveStrength) * 0.12,
            uWaveSpeed: recipe.waveSpeed,
            uFoamStrength: style.foamStrength ?? recipe.foamStrength,
            uOpacity: style.opacity ?? recipe.opacity
          });
          surface.setWaterReflectionParams({
            strength: style.reflectionStrength ?? recipe.reflectionStrength
          });
        }
      }
      const uniforms = surface.material.uniforms;
      if (style && uniforms.uOpacity) uniforms.uOpacity.value = style.opacity ?? recipe.opacity;
      if (style && uniforms.uFoamStrength) uniforms.uFoamStrength.value = style.foamStrength ?? recipe.foamStrength;
      const originalMaterial = mesh.material;
      mesh.material = surface.material;
      mesh.renderOrder = Math.max(mesh.renderOrder, 8);
      mesh.userData.skipShaderApply = true;
      mesh.userData.isWater = true;
      this.waterBindings.push({ mesh, originalMaterial, surface });
    }
  }

  private applyEffectRecipes(recipes: RuntimeEffectRecipe[]): void {
    if (!this.modelsRoot) return;
    const byTarget = new Map<THREE.Object3D, RuntimeEffectRecipe[]>();
    for (const recipe of recipes) {
      for (const target of scopedTargets(this.modelsRoot, recipe.scope)) {
        const list = byTarget.get(target) ?? [];
        list.push(recipe);
        byTarget.set(target, list);
      }
    }
    for (const [target, targetRecipes] of byTarget) {
      const materialLayers: Array<{ type: string; params: Record<string, unknown> }> = [];
      for (const recipe of targetRecipes) materialLayers.push(...effectLayers(recipe));
      if (materialLayers.length) {
        this.effectRuntime.applyToObject3D(target, {
          schemaVersion: 2,
          target: { shadingModel: 'pbr' },
          materialLayers
        });
      }
    }
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.composer.setSize(this.width, this.height);
    const drawingSize = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const drawWidth = Math.max(1, drawingSize.x);
    const drawHeight = Math.max(1, drawingSize.y);
    this.normalTarget.setSize(drawWidth, drawHeight);
    this.edgeTarget.setSize(drawWidth, drawHeight);
    this.boundaryTarget.setSize(drawWidth, drawHeight);
    this.edgePass.setSize(drawWidth, drawHeight);
    this.setVector2(this.inkPass, 'uResolution', drawWidth, drawHeight);
    this.setVector2(this.comicPass, 'uResolution', drawWidth, drawHeight);
    this.setVector2(this.sketchPass, 'uResolution', drawWidth, drawHeight);
    this.setVector2(this.curvaturePass, 'uTexelSize', 1 / drawWidth, 1 / drawHeight);
  }

  render(): void {
    if (!this.hasActiveEffect()) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.renderPrePass();
    this.composer.render();
  }

  private hasActiveEffect(): boolean {
    return this.outlineMode !== 'none'
      || this.presentationMode !== 'none'
      || this.toneMapPass.enabled
      || this.ssaoPass.enabled
      || this.bloomPass.enabled;
  }

  private renderPrePass(): void {
    const needsSketchWorld = this.sketchPass.enabled
      && Number(this.sketchPass.uniforms.uHatchSpaceMode?.value ?? 1) > 0.5;
    const needsComicEdge = this.comicPass.enabled
      && Number(this.comicPass.uniforms.uLineBoost?.value ?? 0) > 0;
    const needsEdgeMask = this.inkPass.enabled || needsComicEdge;
    const needsNormalDepth = needsEdgeMask || this.curvaturePass.enabled || needsSketchWorld || this.ssaoPass.enabled;
    if (!needsNormalDepth || !this.contentRoot) return;

    this.renderNormalDepth(this.contentRoot);
    const normalTexture = this.normalTarget.texture;
    const depthTexture = this.normalTarget.depthTexture;

    if (this.ssaoPass.enabled && depthTexture) {
      this.ssaoPass.setSharedNormalDepth(normalTexture, depthTexture);
    }

    if (this.curvaturePass.enabled) {
      this.curvaturePass.uniforms.tNormal.value = normalTexture;
      this.curvaturePass.uniforms.tDepth.value = depthTexture;
      this.curvaturePass.uniforms.uCameraNear.value = this.camera.near;
      this.curvaturePass.uniforms.uCameraFar.value = this.camera.far;
    }
    if (needsSketchWorld) {
      this.sketchPass.uniforms.tNormal.value = normalTexture;
      this.sketchPass.uniforms.tDepth.value = depthTexture;
      this.sketchPass.uniforms.uProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse);
      this.sketchPass.uniforms.uCameraMatrixWorld.value.copy(this.camera.matrixWorld);
    }
    if (!needsEdgeMask) return;

    const edgeUniforms = this.edgePass.material.uniforms;
    const needsBoundaryIds = Number(edgeUniforms.uObjectWeight.value) > 0
      || Number(edgeUniforms.uMaterialWeight.value) > 0;
    let boundaryTexture: THREE.Texture | null = null;
    if (needsBoundaryIds) {
      this.clearTarget(this.boundaryTarget);
      if (this.modelsRoot) {
        this.boundaryPass.render(
          this.renderer,
          this.scene,
          this.camera,
          this.boundaryTarget,
          this.modelsRoot
        );
      }
      boundaryTexture = this.boundaryTarget.texture;
    }
    this.edgePass.render(
      this.renderer,
      this.edgeTarget,
      normalTexture,
      depthTexture,
      boundaryTexture,
      this.camera.near,
      this.camera.far
    );

    if (this.inkPass.enabled) {
      this.inkPass.uniforms.tNormal.value = normalTexture;
      this.inkPass.uniforms.tDepth.value = depthTexture;
      this.inkPass.uniforms.tEdgeMask.value = this.edgeTarget.texture;
      this.inkPass.uniforms.uCameraNear.value = this.camera.near;
      this.inkPass.uniforms.uCameraFar.value = this.camera.far;
      this.inkPass.uniforms.uProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse);
      this.inkPass.uniforms.uCameraMatrixWorld.value.copy(this.camera.matrixWorld);
      this.inkPass.uniforms.uTime.value = performance.now() / 1000;
    }
    if (needsComicEdge) this.comicPass.uniforms.tEdgeMask.value = this.edgeTarget.texture;
  }

  private renderNormalDepth(root: THREE.Object3D): void {
    const meshes: THREE.Mesh[] = [];
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !isPrePassMesh(mesh)) return;
      meshes.push(mesh);
    });
    if (!meshes.length) {
      this.clearTarget(this.normalTarget);
      return;
    }

    const previousTarget = this.renderer.getRenderTarget();
    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    const previousCameraMask = this.camera.layers.mask;
    const previousClearColor = this.renderer.getClearColor(new THREE.Color());
    const previousClearAlpha = this.renderer.getClearAlpha();
    const previousShadowAutoUpdate = this.renderer.shadowMap.autoUpdate;
    const layerMasks = meshes.map((mesh) => mesh.layers.mask);

    try {
      meshes.forEach((mesh) => mesh.layers.enable(NORMAL_PREPASS_LAYER));
      this.camera.layers.set(NORMAL_PREPASS_LAYER);
      this.renderer.shadowMap.autoUpdate = false;
      this.scene.overrideMaterial = this.normalMaterial;
      this.scene.background = null;
      this.renderer.setRenderTarget(this.normalTarget);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, this.camera);
    } finally {
      meshes.forEach((mesh, index) => { mesh.layers.mask = layerMasks[index]; });
      this.renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setClearColor(previousClearColor, previousClearAlpha);
      this.scene.background = previousBackground;
      this.scene.overrideMaterial = previousOverride;
      this.camera.layers.mask = previousCameraMask;
    }
  }

  private clearTarget(target: THREE.WebGLRenderTarget): void {
    const previousTarget = this.renderer.getRenderTarget();
    const previousClearColor = this.renderer.getClearColor(new THREE.Color());
    const previousClearAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, true);
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearColor(previousClearColor, previousClearAlpha);
  }

  private setEdgeMaskValues(values: Record<string, unknown>): void {
    const uniforms = this.edgePass.material.uniforms;
    uniforms.uEdgeThreshold.value = numberValue(values.inkEdgeThreshold, 0.1);
    uniforms.uDepthWeight.value = numberValue(values.edgeDepthWeight, 1);
    uniforms.uNormalWeight.value = numberValue(values.edgeNormalWeight, 1);
    uniforms.uObjectWeight.value = numberValue(values.edgeObjectWeight, 0);
    uniforms.uMaterialWeight.value = numberValue(values.edgeMaterialWeight, 0);
  }

  private setInkValues(values: Record<string, unknown>): void {
    this.setNumber(this.inkPass, 'uEdgeStrength', numberValue(values.inkEdgeStrength, 1));
    this.setNumber(this.inkPass, 'uEdgeThreshold', numberValue(values.inkEdgeThreshold, 0.1));
    this.setNumber(this.inkPass, 'uEdgeWidth', numberValue(values.inkEdgeWidth, 1.25));
    this.setNumber(this.inkPass, 'uMaxEdgeWidth', numberValue(values.inkEdgeWidth, 1.25));
    this.setNumber(this.inkPass, 'uBlurRadius', numberValue(values.inkBleedRadius, 0));
    this.setNumber(this.inkPass, 'uBleedFalloff', numberValue(values.inkBleedFalloff, 2));
    this.setNumber(this.inkPass, 'uQuality', numberValue(values.inkQuality, 2));
    this.setNumber(this.inkPass, 'uNoiseEnabled', Number(values.inkNoiseEnabled === true));
    this.setNumber(this.inkPass, 'uNoiseScale', numberValue(values.inkNoiseScale, 3.5));
    this.setNumber(this.inkPass, 'uNoiseStrength', numberValue(values.inkNoiseStrength, 0));
    this.setNumber(this.inkPass, 'uNoiseContrast', numberValue(values.inkNoiseContrast, 1.35));
    this.setNumber(this.inkPass, 'uStrokeVariation', numberValue(values.inkStrokeVariation, 0));
    this.setNumber(this.inkPass, 'uStrokeScale', numberValue(values.inkStrokeScale, 3.2));
    this.setNumber(this.inkPass, 'uStrokePunch', numberValue(values.inkStrokePunch, 0));
    this.setNumber(this.inkPass, 'uEchoCount', numberValue(values.inkEchoCount, 0));
    this.setNumber(this.inkPass, 'uEchoSpacing', numberValue(values.inkEchoSpacing, 2.5));
    this.setNumber(this.inkPass, 'uEchoStrength', numberValue(values.inkEchoStrength, 0.55));
    this.setNumber(this.inkPass, 'uCurvatureEnabled', Number(values.inkCurvatureEnabled === true));
    this.setNumber(this.inkPass, 'uCurvatureScale', numberValue(values.inkCurvatureScale, 1.6));
    this.setNumber(this.inkPass, 'uCurvatureMin', numberValue(values.inkCurvatureMin, 0.75));
    this.setNumber(this.inkPass, 'uCurvatureMax', numberValue(values.inkCurvatureMax, 1.5));
    this.setNumber(this.inkPass, 'uFlyWhiteEnabled', Number(values.flyWhiteEnabled === true));
    this.setNumber(this.inkPass, 'uFlyWhiteCutoff', numberValue(values.flyWhiteCutoff, 0.46));
    this.setNumber(this.inkPass, 'uFlyWhiteFeather', numberValue(values.flyWhiteFeather, 0.1));
    this.setNumber(this.inkPass, 'uFlyWhiteNoiseScale', numberValue(values.flyWhiteNoiseScale, 4));
    this.setColor(this.inkPass, 'uInkColor', stringValue(values.inkColor));
    this.setColor(this.inkPass, 'uEchoColor', stringValue(values.inkEchoColor));
    const angle = degrees(numberValue(values.inkEchoAngle, -18)) ?? 0;
    this.setVector2(this.inkPass, 'uEchoDirection', Math.cos(angle), Math.sin(angle));
  }

  private setCurvatureValues(values: Record<string, unknown>): void {
    this.setNumber(this.curvaturePass, 'uStrength', numberValue(values.curvatureStrength, 1.35));
    this.setNumber(this.curvaturePass, 'uWidth', numberValue(values.curvatureWidth, 1));
    this.setNumber(this.curvaturePass, 'uPower', numberValue(values.curvaturePower, 2));
    this.setNumber(this.curvaturePass, 'uThreshold', numberValue(values.curvatureThreshold, 0.1));
  }

  private setNumber(
    pass: { uniforms: Record<string, { value: unknown }> },
    name: string,
    value: number | undefined
  ): void {
    if (value === undefined || !pass.uniforms[name]) return;
    pass.uniforms[name].value = value;
  }

  private setColor(
    pass: { uniforms: Record<string, { value: unknown }> },
    name: string,
    value: string | undefined
  ): void {
    if (!value || !pass.uniforms[name]) return;
    const color = new THREE.Color(value);
    const target = pass.uniforms[name].value as THREE.Vector3;
    target.set(color.r, color.g, color.b);
  }

  private setVector2(
    pass: { uniforms: Record<string, { value: unknown }> },
    name: string,
    x: number,
    y: number
  ): void {
    const target = pass.uniforms[name]?.value as THREE.Vector2 | undefined;
    target?.set(x, y);
  }

  private setVector3(
    pass: { uniforms: Record<string, { value: unknown }> },
    name: string,
    x: number,
    y: number,
    z: number
  ): void {
    const target = pass.uniforms[name]?.value as THREE.Vector3 | undefined;
    target?.set(x, y, z);
  }
}

function scopedTargets(root: THREE.Object3D, scope: { target: string; tag?: string }): THREE.Object3D[] {
  if (scope.target === 'scene') return [root];
  const targets: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (scope.target === 'asset-tag') {
      if (Array.isArray(object.userData.assetTags) && object.userData.assetTags.includes(scope.tag)) {
        targets.push(object);
      }
      return;
    }
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && matchesScope(mesh, scope)) targets.push(mesh);
  });
  return targets;
}

function scopedMeshes(root: THREE.Object3D, scope: { target: string; tag?: string }): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (const target of scopedTargets(root, scope)) {
    target.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && matchesScope(mesh, scope) && !meshes.includes(mesh)) meshes.push(mesh);
    });
  }
  return meshes;
}

function matchesScope(object: THREE.Object3D, scope: { target: string; tag?: string }): boolean {
  if (scope.target === 'scene') return true;
  if (scope.target === 'water') return hasMaterialTag(object, scope.tag ?? 'water');
  if (scope.target === 'material-tag') return hasMaterialTag(object, scope.tag ?? '');
  if (scope.target === 'asset-tag') {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (Array.isArray(current.userData.assetTags) && current.userData.assetTags.includes(scope.tag)) return true;
      current = current.parent;
    }
  }
  return false;
}

function hasMaterialTag(object: THREE.Object3D, requested: string): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    const tags = Array.isArray(current.userData.materialTags) ? current.userData.materialTags : [];
    if (tags.some((entry: unknown) => {
      if (typeof entry === 'string') return entry === requested;
      if (!entry || typeof entry !== 'object') return false;
      const tag = String((entry as Record<string, unknown>).tag ?? '');
      const value = String((entry as Record<string, unknown>).value ?? '');
      return tag === requested || value === requested || `${tag}:${value}` === requested;
    })) return true;
    current = current.parent;
  }
  return false;
}

function materialThemeStyle(
  recipe: RuntimeMaterialTheme['recipe'],
  tag = ''
): { color: string; roughness: number; metalness: number } {
  const styles: Record<RuntimeMaterialTheme['recipe'], { color: string; roughness: number; metalness: number }> = {
    natural: { color: tag.includes('stone') ? '#8b8b83' : tag.includes('metal') ? '#9aa2a8' : '#6d8c4d', roughness: 0.76, metalness: tag.includes('metal') ? 0.72 : 0.04 },
    autumn: { color: tag.includes('bark') || tag.includes('wood') ? '#6f4528' : '#bd6b32', roughness: 0.82, metalness: 0.02 },
    winter: { color: tag.includes('stone') ? '#aab5b8' : '#b8c7c3', roughness: 0.88, metalness: 0.02 },
    weathered: { color: '#77766f', roughness: 0.94, metalness: tag.includes('metal') ? 0.38 : 0.01 },
    polished: { color: tag.includes('metal') ? '#b7c0c8' : '#9c9991', roughness: 0.24, metalness: tag.includes('metal') ? 0.86 : 0.08 },
    pastel: { color: '#c7b9d5', roughness: 0.72, metalness: 0.01 }
  };
  return styles[recipe];
}

function waterRecipe(recipe: RuntimeWaterStyle['recipe']): {
  mode: 'cartoon' | 'realistic' | 'hybrid';
  color: string;
  shallowColor: string;
  depthColor: string;
  opacity: number;
  waveStrength: number;
  waveSpeed: number;
  foamStrength: number;
  reflectionStrength: number;
} {
  const recipes: Record<RuntimeWaterStyle['recipe'], {
    mode: 'cartoon' | 'realistic' | 'hybrid';
    color: string;
    shallowColor: string;
    depthColor: string;
    opacity: number;
    waveStrength: number;
    waveSpeed: number;
    foamStrength: number;
    reflectionStrength: number;
  }> = {
    'calm-lake': { mode: 'realistic', color: '#3f7f91', shallowColor: '#71b8bd', depthColor: '#173b50', opacity: 0.86, waveStrength: 0.2, waveSpeed: 0.3, foamStrength: 0.18, reflectionStrength: 0.65 },
    'clear-river': { mode: 'hybrid', color: '#4b9caf', shallowColor: '#84ced0', depthColor: '#1e5265', opacity: 0.78, waveStrength: 0.42, waveSpeed: 0.75, foamStrength: 0.38, reflectionStrength: 0.48 },
    stylized: { mode: 'cartoon', color: '#3c9bb4', shallowColor: '#78d2cc', depthColor: '#19506d', opacity: 0.92, waveStrength: 0.32, waveSpeed: 0.48, foamStrength: 0.72, reflectionStrength: 0.38 },
    stormy: { mode: 'hybrid', color: '#344d5d', shallowColor: '#567784', depthColor: '#152735', opacity: 0.96, waveStrength: 1.05, waveSpeed: 1.15, foamStrength: 1.1, reflectionStrength: 0.25 }
  };
  return recipes[recipe];
}

function defaultWaterStyle(mesh: THREE.Mesh): RuntimeWaterStyle {
  const flowing = hasMaterialTag(mesh, 'river')
    || hasMaterialTag(mesh, 'water:fall')
    || hasMaterialTag(mesh, 'fall');
  return {
    scope: { target: 'water', tag: 'water' },
    recipe: flowing ? 'clear-river' : 'calm-lake'
  };
}

function effectLayers(recipe: RuntimeEffectRecipe): Array<{ type: string; params: Record<string, unknown> }> {
  const color = new THREE.Color(recipe.color ?? '#88bbff');
  const colorArray = [color.r, color.g, color.b];
  const intensity = recipe.intensity ?? 1;
  const speed = recipe.speed ?? 1;
  if (recipe.recipe === 'fresnel') {
    return [{ type: 'FresnelRim', params: { color: colorArray, intensity, power: 2.5 } }];
  }
  if (recipe.recipe === 'flame') {
    return [{ type: 'Flame', params: { color: colorArray, intensity, speed } }];
  }
  if (recipe.recipe === 'magic') {
    return [
      { type: 'FresnelRim', params: { color: colorArray, intensity: intensity * 0.8, power: 2.2 } },
      { type: 'EmissivePulse', params: { color: colorArray, intensity, speed } }
    ];
  }
  return [{ type: 'EmissivePulse', params: { color: colorArray, intensity, speed } }];
}

function temperatureTint(value: number): THREE.Color {
  const t = THREE.MathUtils.clamp(value, -1, 1);
  return t >= 0
    ? new THREE.Color(1, 1 - t * 0.08, 1 - t * 0.18)
    : new THREE.Color(1 + t * 0.16, 1 + t * 0.05, 1);
}

function outlineOverrides(params: RuntimeOutlineStyle['params']): Record<string, unknown> {
  return {
    ...(params.strength === undefined ? {} : {
      inkEdgeStrength: params.strength,
      curvatureStrength: params.strength
    }),
    ...(params.threshold === undefined ? {} : {
      inkEdgeThreshold: params.threshold,
      curvatureThreshold: params.threshold
    }),
    ...(params.width === undefined ? {} : {
      inkEdgeWidth: params.width,
      curvatureWidth: params.width
    }),
    ...(params.color === undefined ? {} : { inkColor: params.color }),
    ...(params.depthWeight === undefined ? {} : { edgeDepthWeight: params.depthWeight }),
    ...(params.normalWeight === undefined ? {} : { edgeNormalWeight: params.normalWeight }),
    ...(params.objectWeight === undefined ? {} : { edgeObjectWeight: params.objectWeight }),
    ...(params.materialWeight === undefined ? {} : { edgeMaterialWeight: params.materialWeight }),
    ...(params.noiseStrength === undefined ? {} : { inkNoiseStrength: params.noiseStrength }),
    ...(params.strokeVariation === undefined ? {} : { inkStrokeVariation: params.strokeVariation }),
    ...(params.echoCount === undefined ? {} : { inkEchoCount: params.echoCount }),
    ...(params.echoSpacing === undefined ? {} : { inkEchoSpacing: params.echoSpacing }),
    ...(params.echoAngle === undefined ? {} : { inkEchoAngle: params.echoAngle }),
    ...(params.echoStrength === undefined ? {} : { inkEchoStrength: params.echoStrength }),
    ...(params.echoColor === undefined ? {} : { inkEchoColor: params.echoColor })
  };
}

function isPrePassMesh(mesh: THREE.Mesh): boolean {
  if (!mesh.visible) return false;
  let current: THREE.Object3D | null = mesh;
  while (current) {
    if (
      current.userData.skipShaderApply
      || current.userData.skipNormalDepthPrePass
      || current.userData.noNormalDepth
      || current.userData.isEditorObject
      || current.userData.isEnvironmentObject
      || current.userData.isHelper
      || current.userData.shaderOutline
      || current.userData.isOutline
      || current.name === '__outlineMesh__'
    ) return false;
    current = current.parent;
  }
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return !materials.some((material) => material?.transparent || Number(material?.opacity ?? 1) < 1);
}

function numberValue(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function degrees(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * Math.PI / 180;
}
