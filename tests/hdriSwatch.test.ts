import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { panoramaSwatch } from '../src/client/hdriSwatch';
import { harmonizeHdriAtmosphere } from '../src/shared/hdriAtmosphere';

const WIDTH = 8;
const HEIGHT = 8;

function panorama(first: [number, number, number], second: [number, number, number]): Float32Array {
  const data = new Float32Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const color = y < HEIGHT / 2 ? first : second;
      const index = (y * WIDTH + x) * 4;
      data.set([color[0], color[1], color[2], 1], index);
    }
  }
  return data;
}

function swatch(data: ArrayLike<number>, flipY: boolean, halfFloat = false) {
  return panoramaSwatch({ data, width: WIDTH, height: HEIGHT, flipY, halfFloat });
}

describe('panoramaSwatch', () => {
  it('reads the sky half from the format-dependent row order', () => {
    const data = panorama([1, 0, 0], [0, 0, 1]);

    expect(swatch(data, true)).toEqual({ skyColor: '#ff0000', groundColor: '#0000ff' });
    expect(swatch(data, false)).toEqual({ skyColor: '#0000ff', groundColor: '#ff0000' });
  });

  it('keeps the hue of radiance brighter than 1 instead of clipping it to white', () => {
    const overRange = swatch(panorama([4, 2, 0], [0, 0, 0]), true);
    const normalized = swatch(panorama([1, 0.5, 0], [0, 0, 0]), true);

    expect(overRange?.skyColor).toBe(normalized?.skyColor);
    expect(overRange?.skyColor).not.toBe('#ffffff');
  });

  it('decodes half-float buffers, which is what three hands back for hdr and exr', () => {
    const source = panorama([1, 0, 0], [0, 0, 1]);
    const half = new Uint16Array(source.length);
    source.forEach((value, index) => { half[index] = THREE.DataUtils.toHalfFloat(value); });

    expect(swatch(half, true, true)).toEqual(swatch(source, true));
  });

  it('refuses buffers that are too small to hold the declared image', () => {
    expect(swatch(new Float32Array(4), true)).toBeNull();
  });
});

describe('harmonizeHdriAtmosphere', () => {
  it('uses the tinted panorama swatches for fog, environment and sunlight', () => {
    const result = harmonizeHdriAtmosphere({
      version: 2,
      baseSchemeId: 'render-natural-day',
      modules: [{
        id: 'environment.hdri',
        params: { texture: 'morning.exr', tint: '#ff8040', tintStrength: 0.5 }
      }]
    }, [{ file: 'morning.exr', skyColor: '#4080ff', groundColor: '#204020' }]);

    expect(result.modules.find((module) => module.id === 'environment.palette')?.params.fogColor)
      .toBe('#906030');
    expect(result.modules.find((module) => module.id === 'lighting.hemisphere')?.params)
      .toMatchObject({ skyColor: '#a080a0', groundColor: '#906030' });
    expect(result.modules.find((module) => module.id === 'lighting.sun')?.params.color)
      .toMatch(/^#[0-9a-f]{6}$/);
  });

  it('lets explicit controls win and blends visual direction over HDRI swatches', () => {
    const result = harmonizeHdriAtmosphere({
      version: 2,
      baseSchemeId: 'render-natural-day',
      visualDirection: {
        version: 1,
        contrastMode: 'bright-cartoon',
        timeOfDay: 'evening',
        temperature: 'warm',
        palette: {
          sky: '#6688aa', keyLight: '#ffcc88', fillLight: '#aaccdd', shadow: '#443344',
          fog: '#aa8877', waterBias: '#446688', accent: '#dd8844'
        },
        atmosphereFx: { masterStrength: 0.3, pollen: 0, vapor: 0, dust: 0 }
      },
      modules: [
        { id: 'environment.hdri', params: { texture: 'evening.exr' } },
        { id: 'lighting.sun', params: { color: '#123456' } }
      ]
    }, [{ file: 'evening.exr', skyColor: '#80a0c0', groundColor: '#705040' }]);

    expect(result.modules.find((module) => module.id === 'lighting.sun')?.params.color).toBe('#123456');
    expect(result.modules.find((module) => module.id === 'environment.palette')?.params.fogColor)
      .not.toBe('#705040');
  });
});
