import * as THREE from 'three';

export interface PanoramaPixels {
  data: ArrayLike<number>;
  width: number;
  height: number;
  /**
   * three loads `.hdr` with flipY=true and `.exr` with flipY=false, so the data
   * row that carries the zenith differs per format. This flag is the only
   * reliable signal for which half of the buffer is sky and which is ground.
   */
  flipY: boolean;
  halfFloat: boolean;
}

export interface HdriSwatch {
  skyColor: string;
  groundColor: string;
}

/** Roughly how many texels to average per half. A 4K panorama has ~8M. */
const TARGET_SAMPLES = 20000;

/**
 * Averages the sky-facing and ground-facing halves of an equirectangular
 * panorama into two `#rrggbb` swatches, so fog and hemisphere light can follow
 * the actual image instead of a hand-written catalog entry.
 */
export function panoramaSwatch(pixels: PanoramaPixels): HdriSwatch | null {
  const { data, width, height, flipY, halfFloat } = pixels;
  if (!(width > 1) || !(height > 1) || data.length < width * height * 4) return null;
  const middle = height >> 1;
  const step = Math.max(1, Math.round(Math.sqrt((width * middle) / TARGET_SAMPLES)));
  const first = averageHalf(data, width, 0, middle, step, halfFloat);
  const second = averageHalf(data, width, middle, height, step, halfFloat);
  if (!first || !second) return null;
  // flipY=true means data row 0 ends up at v=1, which equirectangular sampling
  // maps to +Y — so the first half is the sky. flipY=false inverts that.
  return flipY
    ? { skyColor: first, groundColor: second }
    : { skyColor: second, groundColor: first };
}

function averageHalf(
  data: ArrayLike<number>,
  width: number,
  fromRow: number,
  toRow: number,
  step: number,
  halfFloat: boolean
): string | null {
  const channels = [0, 0, 0];
  let count = 0;
  for (let y = fromRow; y < toRow; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        channels[channel] += read(data, index + channel, halfFloat);
      }
      count += 1;
    }
  }
  if (count === 0) return null;
  // HDR radiance runs well past 1. Scaling by the brightest channel keeps the
  // hue that fog and ambient light care about instead of clipping it to white.
  const averaged = channels.map((total) => Math.max(0, total / count));
  const peak = Math.max(...averaged, 1);
  return `#${new THREE.Color()
    .setRGB(averaged[0] / peak, averaged[1] / peak, averaged[2] / peak, THREE.LinearSRGBColorSpace)
    .getHexString(THREE.SRGBColorSpace)}`;
}

function read(data: ArrayLike<number>, index: number, halfFloat: boolean): number {
  const value = data[index];
  return halfFloat ? THREE.DataUtils.fromHalfFloat(value) : value;
}
