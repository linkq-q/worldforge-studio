import * as THREE from 'three';
import { RuntimeIndex } from '@voxel-studio/render-runtime';
import { describe, expect, it } from 'vitest';
import { createColorPalette } from '../src/shared/colorPalette';
import { PaletteMaterialRuntime } from '../src/client/paletteMaterialRuntime';

describe('PaletteMaterialRuntime', () => {
  it('recolors repeated instanced parts deterministically and restores authored colors', () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
      2
    );
    mesh.setColorAt(0, new THREE.Color('#aa0000'));
    mesh.setColorAt(1, new THREE.Color('#00aa00'));
    const index = new RuntimeIndex();
    index.registerInstancedBatch('walls', mesh, ['house-a:wall', 'house-b:wall']);
    const palette = createColorPalette({
      name: 'Buildings',
      colors: ['#F1D7B2', '#E7C393', '#714D48', '#52362E'],
      roles: { 'building.wall': ['#F1D7B2', '#E7C393'] }
    });
    const runtime = new PaletteMaterialRuntime(index, (partId) => ({
      role: 'building.wall',
      variantKey: partId.split(':')[0]
    }));

    const report = runtime.apply(palette);
    const first = new THREE.Color();
    const second = new THREE.Color();
    mesh.getColorAt(0, first);
    mesh.getColorAt(1, second);
    expect(palette.colors.map((entry) => entry.hex)).toContain(`#${first.getHexString()}`.toUpperCase());
    expect(palette.colors.map((entry) => entry.hex)).toContain(`#${second.getHexString()}`.toUpperCase());
    expect(report.strictMaterials).toBe(2);

    runtime.clear();
    mesh.getColorAt(0, first);
    mesh.getColorAt(1, second);
    expect(`#${first.getHexString()}`).toBe('#aa0000');
    expect(`#${second.getHexString()}`).toBe('#00aa00');
  });

  it('preserves authored detail color groups when semantic node names are generic', () => {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
      2
    );
    const index = new RuntimeIndex();
    index.registerInstancedBatch('details', mesh, ['house-a:m0', 'house-a:m1']);
    const palette = createColorPalette({
      name: 'Detail groups',
      colors: ['#F8E8CF', '#C9A06E', '#714D48', '#52362E'],
      roles: { 'building.wall': ['#F8E8CF', '#C9A06E', '#714D48', '#52362E'] }
    });
    const runtime = new PaletteMaterialRuntime(index, (partId) => ({
      role: 'building.wall',
      variantKey: 'house-a:v0',
      sourceColor: partId.endsWith(':m0') ? '#F4E6D0' : '#3A211A'
    }));

    runtime.apply(palette);
    const base = new THREE.Color();
    const detail = new THREE.Color();
    mesh.getColorAt(0, base);
    mesh.getColorAt(1, detail);
    expect(base.getHex()).not.toBe(detail.getHex());
  });
});
