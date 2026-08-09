import * as THREE from 'three';
import { HDRISkyDome, loadPanoramaTexture } from '@voxel-studio/render-runtime/environment';
import { hdriExtensionOf } from '../shared/hdri';
import { panoramaSwatch, type HdriSwatch } from './hdriSwatch';
import type { RuntimeHdriSky } from '../shared/renderPlan';

/**
 * The dome's shader derives the view direction from the world position, so the
 * mesh has to stay centred on the origin. Its radius therefore has to sit well
 * inside the camera far plane for every camera position the editor allows.
 */
export const HDRI_DOME_RADIUS = 500;

const HDRI_ENVIRONMENT_RADIUS = 10;

export function createRotatedHdriEnvironmentScene(
  texture: THREE.Texture,
  rotationDegrees: number
): { scene: THREE.Scene; dispose(): void } {
  const scene = new THREE.Scene();
  const dome = new HDRISkyDome(HDRI_ENVIRONMENT_RADIUS);
  dome.setTexture(texture);
  dome.setRotationY(THREE.MathUtils.degToRad(rotationDegrees));
  dome.addTo(scene);
  return { scene, dispose: () => dome.dispose() };
}

/**
 * Binds one panorama to both the background dome and `scene.environment`.
 * Textures are cached per file so switching schemes back and forth does not
 * re-download a 30 MB HDR.
 */
export class HdriSkyController {
  private readonly dome = new HDRISkyDome(HDRI_DOME_RADIUS);
  private readonly textures = new Map<string, Promise<THREE.Texture>>();
  private pmrem: THREE.PMREMGenerator | null = null;
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private environmentKey: string | null = null;
  /** Guards against an out-of-order apply when a slow load resolves late. */
  private generation = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly fileUrl: (file: string) => string,
    private readonly onEnvironmentChange: (texture: THREE.Texture | null) => void = () => {}
  ) {
    this.dome.setVisible(false);
    this.dome.addTo(scene);
  }

  async apply(style: RuntimeHdriSky): Promise<void> {
    const generation = (this.generation += 1);
    if (!style.texture) {
      this.clear();
      return;
    }

    const texture = await this.loadTexture(style.texture).catch((error) => {
      console.warn('[HdriSky] failed to load panorama', style.texture, error);
      return null;
    });
    if (generation !== this.generation) return;
    if (!texture) {
      this.clear();
      return;
    }

    this.dome.setTexture(texture);
    this.dome.setRotationY(style.rotation * Math.PI / 180);
    this.dome.setExposure(style.exposure);
    this.dome.setSaturation(style.saturation);
    this.dome.setIntensity(style.intensity);
    this.dome.setTint(style.tintStrength > 0, style.tint ?? '#ffffff', style.tintStrength);
    this.dome.setVisible(true);

    if (style.useAsEnvironment) this.applyEnvironment(texture, style.texture, style.rotation);
    else this.clearEnvironment();
  }

  /**
   * Sky/ground swatches of a panorama, sampled from the texture the dome
   * already loaded. Returns null for formats that decode to an image element
   * instead of a pixel buffer (jpg/png), which have no readable data here.
   */
  async swatch(file: string): Promise<HdriSwatch | null> {
    const texture = await this.loadTexture(file).catch(() => null);
    const image = texture?.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
    if (!texture || !image?.data || !image.width || !image.height) return null;
    return panoramaSwatch({
      data: image.data,
      width: image.width,
      height: image.height,
      flipY: texture.flipY,
      halfFloat: texture.type === THREE.HalfFloatType
    });
  }

  clear(): void {
    this.generation += 1;
    this.dome.setVisible(false);
    this.dome.setTexture(null);
    this.clearEnvironment();
  }

  dispose(): void {
    this.clear();
    this.dome.dispose();
    for (const pending of this.textures.values()) {
      pending.then((texture) => texture.dispose()).catch(() => {});
    }
    this.textures.clear();
    this.pmrem?.dispose();
    this.pmrem = null;
  }

  private applyEnvironment(texture: THREE.Texture, file: string, rotationDegrees: number): void {
    const rotation = THREE.MathUtils.euclideanModulo(rotationDegrees, 360);
    const key = `${file}:${rotation.toFixed(4)}`;
    if (this.environmentTarget && this.environmentKey === key
      && this.scene.environment === this.environmentTarget.texture) return;
    this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
    const prepared = createRotatedHdriEnvironmentScene(texture, rotation);
    let generated: THREE.WebGLRenderTarget;
    try {
      generated = this.pmrem.fromScene(prepared.scene, 0, 0.1, HDRI_ENVIRONMENT_RADIUS * 2);
    } finally {
      prepared.dispose();
    }
    this.environmentTarget?.dispose();
    this.environmentTarget = generated;
    this.environmentKey = key;
    this.scene.environment = generated.texture;
    this.onEnvironmentChange(generated.texture);
  }

  private clearEnvironment(): void {
    if (this.scene.environment === this.environmentTarget?.texture) this.scene.environment = null;
    this.environmentTarget?.dispose();
    this.environmentTarget = null;
    this.environmentKey = null;
    this.onEnvironmentChange(null);
  }

  private loadTexture(file: string): Promise<THREE.Texture> {
    const cached = this.textures.get(file);
    if (cached) return cached;
    const extension = hdriExtensionOf(file);
    const pending = extension
      ? loadPanoramaTexture(this.fileUrl(file), extension)
      : Promise.reject(new Error(`unsupported_hdri_format:${file}`));
    // A failed load must not poison the cache — the file may appear later.
    pending.catch(() => this.textures.delete(file));
    this.textures.set(file, pending);
    return pending;
  }
}
