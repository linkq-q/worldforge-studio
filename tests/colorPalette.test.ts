import { describe, expect, it } from 'vitest';
import {
  applyPaletteToModelJson,
  autoAssignPaletteRoles,
  createColorPalette,
  inferPaletteLevel,
  normalizeColorPalette,
  paletteGenerationBrief,
  parseHexPalette,
  pickPaletteColor
} from '../src/shared/colorPalette';
import { paletteEnvironment } from '../src/client/colorPaletteRuntime';
import { BUILTIN_RENDER_SCHEMES } from '../src/shared/renderScheme';

describe('color palettes', () => {
  it('preserves structured swatches and assigns semantic roles', () => {
    const palette = createColorPalette({
      name: '曼德鸭 65 色',
      colors: [
        { hex: '#FFFDF6', family: 'Cream', level: 'L1', token: 'Cream-100', usage: '天空高光、雾' },
        { hex: '#E7C393', family: 'Sand Beige', level: 'L3', token: 'Sand-Beige-300', usage: '道路、建筑墙体' },
        { hex: '#76D0F2', family: 'Sky Blue', level: 'L4', token: 'Sky-Blue-400', usage: '天空、水体' },
        { hex: '#DCDB22', family: 'Lime Green', level: 'L3', token: 'Lime-Green-300', usage: '草地、树叶' },
        { hex: '#52362E', family: 'Warm Brown', level: 'L5', token: 'Warm-Brown-500', usage: '屋顶、结构深色' }
      ]
    });

    expect(palette.colors[0]).toMatchObject({ level: 'L1', token: 'Cream-100' });
    expect(palette.roles.atmosphere).toContain('#76D0F2');
    expect(palette.roles.plant).toContain('#DCDB22');
    expect(palette.roles.secondary).toContain('#52362E');
  });

  it('accepts 2-256 unique colors, rejects smaller palettes and picks deterministically', () => {
    const palette = normalizeColorPalette({
      id: 'palette-test',
      name: 'Two colors',
      colors: ['#ffffff', '#000000']
    });
    expect(palette.colors.map((entry) => entry.hex)).toEqual(['#FFFFFF', '#000000']);
    expect(pickPaletteColor(palette, 'building.wall', 'building-a')).toBe(
      pickPaletteColor(palette, 'building.wall', 'building-a')
    );
    expect(() => normalizeColorPalette({ name: 'Invalid', colors: ['#ffffff'] })).toThrow(
      'palette_requires_2_to_256_colors'
    );
  });

  it('infers lightness levels for plain hex palettes', () => {
    expect(inferPaletteLevel('#FFFDF6')).toBe('L1');
    expect(inferPaletteLevel('#52362E')).toBe('L5');
  });

  it('keeps the visible blue sky from tinting ambient light blue', () => {
    const palette = createColorPalette({
      colors: ['#45BDF6', '#FFFDF6', '#F1D7B2', '#FCD75F'],
      roles: {
        'environment.sky': ['#45BDF6'],
        'environment.fog': ['#FFFDF6']
      }
    });
    const environment = paletteEnvironment(palette, BUILTIN_RENDER_SCHEMES[0].settings);

    expect(environment.background).toBe('#45BDF6');
    expect(environment.hemisphereSkyColor).toBe('#FFFDF6');
  });

  it('builds a bounded asset-generation brief with palette-role tags', () => {
    const palette = createColorPalette({
      name: 'Small',
      colors: ['#E7C393', '#52362E', '#76D0F2', '#DCDB22']
    });
    const brief = paletteGenerationBrief(palette);
    expect(brief).toContain('palette');
    expect(brief).toContain('primary=');
    expect(brief).toContain('#E7C393');
    expect(brief.length).toBeLessThan(4000);
  });

  it('accepts legacy role names but normalizes generation to the abstract protocol', () => {
    const palette = createColorPalette({
      colors: ['#F4E7D0', '#6E8F43', '#274C77'],
      roles: {
        'building.wall': ['#F4E7D0'],
        'vegetation.foliage': ['#6E8F43'],
        'environment.sky': ['#274C77']
      }
    });

    expect(palette.roles.primary).toEqual(['#F4E7D0']);
    expect(palette.roles.plant).toEqual(['#6E8F43']);
    expect(palette.roles.atmosphere).toEqual(['#274C77']);
  });

  it('snaps explicit color intent before source color and semantic fallback', () => {
    const palette = createColorPalette({
      colors: ['#183B66', '#F7F7F2', '#C56A22', '#6B4A2E'],
      roles: {
        primary: ['#6B4A2E'],
        secondary: ['#6B4A2E'],
        accent: ['#C56A22']
      }
    });
    const result = applyPaletteToModelJson({
      nodes: [
        { id: 'cap', name: '蓝色海军帽帽冠', mesh: { material: { color: '#6B4A2E' } } },
        { id: 'brim', name: '白色帽檐', parent: 'cap', tags: [{ tag: 'palette', value: 'secondary' }], color: '#6B4A2E' },
        { id: 'awning', name: '遮阳棚', tags: [{ tag: 'palette-color', value: '#F06B3E' }], color: '#6B4A2E' }
      ]
    }, palette);
    const nodes = result.nodes as Array<Record<string, any>>;

    expect(nodes[0].mesh.material.color).toBe('#183B66');
    expect(nodes[1].color).toBe('#F7F7F2');
    expect(nodes[2].color).toBe('#C56A22');
    expect((result._meta as any).colorPaletteReport.explicitIntentColors).toBe(3);
  });

  it('keeps warm architectural roles out of nearby green families', () => {
    const colors = parseHexPalette(`
      #FFFDF6 #FEF9EA #FDF2D7 #E9DABD #CDBA97 #F8E8CF #F1D7B2 #E7C393 #C9A06E #9E7A55
      #FFF7A8 #FCEF72 #F6E24B #D1B825 #9C8510 #FFF3B7 #FDE674 #FCD75F #FECD4D #D1900B
      #FFE2A0 #FFD170 #F8BC44 #E39F1A #A96F05 #FBE3BD #FDD8A3 #FDCC8F #F1AD69 #D99256
      #FFD2BA #FFB08A #FF8A5B #F06B3E #B84A27 #EAF9FF #DAF2F5 #95E5F9 #76D0F2 #45BDF6
      #D9F8FB #B2E9F2 #8ECCD6 #7BCFDF #4BAFCA #D8F7EF #B8ECDD #90DCC8 #74C4BB #499D92
      #F1F5AF #E4E77F #DCDB22 #BFC41A #809712 #DEE5BC #C6CC97 #AEAF6F #76904C #5F6F48
      #D4C2A5 #B89269 #8E664D #714D48 #52362E
    `);
    const roles = autoAssignPaletteRoles(colors);
    expect(roles.primary).not.toContain('#AEAF6F');
    expect(roles.secondary).not.toContain('#76904C');
    expect(roles.secondary).not.toContain('#5F6F48');
    expect(roles.primary.every((hex) => hslLightness(hex) >= 0.6)).toBe(true);
    expect(roles.earth.every((hex) => hslLightness(hex) >= 0.6)).toBe(true);
  });
});

function hslLightness(hex: string): number {
  const channels = hex.slice(1).match(/../g)?.map((value) => Number.parseInt(value, 16) / 255) ?? [0, 0, 0];
  return (Math.max(...channels) + Math.min(...channels)) / 2;
}
