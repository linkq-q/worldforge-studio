import * as THREE from 'three';
import { HDRISkyDome, loadPanoramaTexture } from '@voxel-studio/render-runtime/environment';
import { hdriExtensionOf } from '../shared/hdri';
import type { RuntimeHdriSky } from '../shared/renderPlan';

/**
 * The dome's shader derives the view direction from the world position, so the
 * mesh has to stay centred on the origin. Its radius therefore has to sit well
 * inside the camera far plane for every camera position the editor allows.
 */
export const HDRI_DOME_RADIUS = 500;

/**
 * Binds one panorama to both the background dome and `scene.environment`.
 * Textures are cached per file so switching schemes back and forth does not
 * re-download a 30 MB HDR.
 */
export class HdriSkyController {
  private readonly dome = new HDRISkyDome(HDRI_DOME_RADIUS);
  private readonly textures = new Map<string, Promise<THREE.Texture>>();
  private pmrem: THREE.PMREMGenerator | null = null;
  private environmentMap: THREE.Texture | null = null;
  private appliedFile: string | null = null;
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

    if (style.useAsEnvironment) this.applyEnvironment(texture, style.texture);
    else this.clearEnvironment();
    this.appliedFile = style.texture;
  }

  clear(): void {
    this.generation += 1;
    this.dome.setVisible(false);
    this.dome.setTexture(null);
    this.clearEnvironment();
    this.appliedFile = null;
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

  private applyEnvironment(texture: THREE.Texture, file: string): void {
    if (this.environmentMap && this.appliedFile === file && this.scene.environment === this.environmentMap) return;
    this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
    const generated = this.pmrem.fromEquirectangular(texture).texture;
    this.environmentMap?.dispose();
    this.environmentMap = generated;
    this.scene.environment = generated;
    this.onEnvironmentChange(generated);
  }

  private clearEnvironment(): void {
    if (this.scene.environment === this.environmentMap) this.scene.environment = null;
    this.environmentMap?.dispose();
    this.environmentMap = null;
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
