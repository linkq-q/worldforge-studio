declare module '@voxel-studio/render-runtime' {
  export class RenderStyleManager {
    mode: 'pbr' | 'cel' | 'ink';
    constructor(options: {
      THREE: typeof import('three');
      renderer: import('three').WebGLRenderer;
      scene: import('three').Scene;
      meshRegistry: Map<string, import('three').Mesh>;
    });
    applyStyle(preset: { renderMode: 'pbr' | 'cel'; cartoon?: Record<string, number> }): void;
    setCartoonParams(params: Record<string, number>): void;
  }
  export interface PlanarReflectionSurface {
    mesh: import('three').Mesh;
    setPlanarReflectionTexture(texture: import('three').Texture | null): void;
    setPlanarReflectionMatrix(matrix: import('three').Matrix4): void;
  }
  export class PlanarReflectionPass {
    constructor(options: {
      renderer: import('three').WebGLRenderer;
      scene: import('three').Scene;
      camera: import('three').PerspectiveCamera;
      waterMesh?: import('three').Mesh | null;
    });
    setWaterSurfaces(surfaces: PlanarReflectionSurface[]): void;
    syncToRendererSize(): void;
    render(): void;
    dispose(): void;
  }
}

declare module '@voxel-studio/render-runtime/postprocess' {
  import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
  import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

  export const COMIC_LOOK_PRESETS: Record<'clean' | 'print', Record<string, string | number | boolean>>;
  export function createComicPrintPass(): ShaderPass;
  export function createPaperTexturePass(params?: {
    strength?: number;
    scale?: number;
    tint?: import('three').Vector3;
    texture?: import('three').Texture;
  }): ShaderPass;
  export function createSketchHatchPass(): ShaderPass;
  export function createToneMapPass(): ShaderPass;
  export function createExponentialFogPass(): ShaderPass;
  export class GlobalBloomPass extends Pass {
    strength: number;
    radius: number;
    threshold: number;
    constructor(
      resolution?: import('three').Vector2,
      strength?: number,
      radius?: number,
      threshold?: number
    );
  }
  export class SharedSSAOPass extends Pass {
    kernelRadius: number;
    minDistance: number;
    maxDistance: number;
    constructor(
      scene: import('three').Scene,
      camera: import('three').Camera,
      width?: number,
      height?: number,
      kernelSize?: number
    );
    setSharedNormalDepth(
      normalTexture: import('three').Texture,
      depthTexture: import('three').DepthTexture
    ): void;
  }
}

declare module '@voxel-studio/render-runtime/outline' {
  import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

  export const ARTISTIC_OUTLINE_PRESETS: Record<string, Record<string, unknown>>;
  export function createCurvatureEdgePass(renderer: import('three').WebGLRenderer): ShaderPass;
  export function createInkEdgePass(renderer: import('three').WebGLRenderer): ShaderPass;
  export function createBoundaryIdPass(): {
    render(
      renderer: import('three').WebGLRenderer,
      scene: import('three').Scene,
      camera: import('three').Camera,
      target: import('three').WebGLRenderTarget,
      modelRoot: import('three').Object3D
    ): boolean;
    dispose(): void;
  };
  export function createEdgeMaskPass(): {
    material: import('three').ShaderMaterial;
    render(
      renderer: import('three').WebGLRenderer,
      target: import('three').WebGLRenderTarget,
      normalTexture: import('three').Texture,
      depthTexture: import('three').DepthTexture | null,
      boundaryTexture: import('three').Texture | null,
      near: number,
      far: number
    ): void;
    setSize(width: number, height: number): void;
    dispose(): void;
  };
}

declare module '@voxel-studio/render-runtime/environment' {
  export const PANORAMA_EXTENSIONS: string[];
  export function loadPanoramaTexture(
    url: string,
    extension: string
  ): Promise<import('three').Texture>;
  export class HDRISkyDome {
    mesh: import('three').Mesh;
    material: import('three').ShaderMaterial;
    uniforms: Record<string, { value: unknown }>;
    constructor(radius?: number);
    setTexture(texture: import('three').Texture | null): void;
    getTexture(): import('three').Texture | null;
    setRotationY(radians: number): void;
    setIntensity(value: number): void;
    setExposure(value: number): void;
    setSaturation(value: number): void;
    setTint(enabled: boolean, color?: string | import('three').Color, strength?: number): void;
    setVisible(visible: boolean): void;
    isVisible(): boolean;
    addTo(parent: import('three').Object3D): void;
    removeFromParent(): void;
    dispose(disposeTexture?: boolean): void;
  }
  export class WaterSurface {
    mesh: import('three').Mesh;
    material: import('three').ShaderMaterial;
    constructor(
      scene: import('three').Scene,
      renderer: import('three').WebGLRenderer,
      environmentRoot?: import('three').Group | null,
      options?: Record<string, unknown>
    );
    update(
      deltaTime: number,
      camera: import('three').Camera,
      depthTexture: import('three').DepthTexture | null
    ): void;
    importState(state: Record<string, unknown>): void;
    setWaterMode(mode: 'cartoon' | 'realistic' | 'hybrid'): void;
    setWaterEnvMap(texture: import('three').Texture | null): void;
    setWaterReflectionParams(params: Record<string, unknown>): void;
    setPlanarReflectionTexture(texture: import('three').Texture | null): void;
    setPlanarReflectionMatrix(matrix: import('three').Matrix4): void;
    dispose(): void;
  }
  export class WaterfallSurface {
    mesh: import('three').Mesh;
    material: import('three').ShaderMaterial;
    splashGroup?: import('three').Group | null;
    constructor(
      scene: import('three').Scene,
      renderer: import('three').WebGLRenderer,
      environmentRoot?: import('three').Group | null,
      options?: Record<string, unknown>
    );
    update(
      deltaTime: number,
      camera: import('three').Camera,
      depthTexture?: import('three').DepthTexture | null
    ): void;
    dispose(): void;
  }
}

declare module '@voxel-studio/render-runtime/effects' {
  export class EffectSlotManager {
    constructor(options?: Record<string, unknown>);
    applyPackage(
      target: Record<string, unknown>,
      effectPackage: Record<string, unknown>,
      runtimeContext?: Record<string, unknown>
    ): unknown;
    clearEffects(target: import('three').Object3D, options?: Record<string, unknown>): unknown;
  }
  export function applyMaterialSurfaceBinding(
    target: import('three').Object3D,
    binding: Record<string, unknown>,
    environmentMap?: import('three').Texture | null
  ): number;
  export function compileModelMaterialTags(
    model: Record<string, unknown>,
    vocabulary: Record<string, unknown>
  ): {
    byPartId: Map<string, {
      part?: { mesh?: { type?: string } };
      effectiveTags: unknown[];
      effectPackage?: { materialLayers?: unknown[] };
      materialBindings?: {
        surface?: Record<string, unknown>;
        matcap?: Record<string, unknown>;
      };
    }>;
    diagnostics: unknown[];
  };
  export function createEffectRuntime(): {
    runtime: {
      applyToObject3D(root: import('three').Object3D, effectPackage: Record<string, unknown>): unknown;
      removeFromObject3D(root: import('three').Object3D): void;
      updateRuntimeUniforms(root: import('three').Object3D, values: Record<string, number>): number;
    };
  };
}

declare module '@voxel-studio/render-runtime/model/material-tags-v1.json' {
  const vocabulary: Record<string, unknown>;
  export default vocabulary;
}
