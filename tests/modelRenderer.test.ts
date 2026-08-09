import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildModelGroup, setRevealHighlight } from '../src/client/modelRenderer';

describe('reveal model highlight', () => {
  it('keeps legacy dark foliage readable while preserving non-foliage source colors', async () => {
    const group = await buildModelGroup({ nodes: [
      { id: 'crown', tags: [{ tag: 'foliage', value: 'leaf' }] },
      { id: 'leaf', parent: 'crown', mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0x27483a } },
      { id: 'trunk', mesh: { type: 'box', params: { width: 1, height: 1, depth: 1 }, color: 0x4e4942 } }
    ] });
    const leaf = group.getObjectByName('leaf') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    const trunk = group.getObjectByName('trunk') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

    expect(leaf.material.color.getHex()).toBeGreaterThan(0x27483a);
    expect(trunk.material.color.getHex()).toBe(0x4e4942);
  });

  it('breathes a red overlay from fully transparent to half transparent without changing the model', () => {
    const material = new THREE.MeshStandardMaterial({
      color: 0x336699,
      emissive: 0x112233,
      emissiveIntensity: 0.2,
      depthTest: true,
      depthWrite: true
    });
    const originalColor = material.color.getHex();
    const originalEmissive = material.emissive.getHex();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);

    setRevealHighlight(mesh, true, 0);
    const overlay = mesh.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(overlay.name).toBe('__reveal-highlight-overlay__');
    expect(overlay.material.color.getHex()).toBe(0xff2020);
    expect(overlay.material.opacity).toBe(0);
    expect(overlay.material.transparent).toBe(true);
    expect(overlay.material.depthTest).toBe(false);
    expect(overlay.material.depthWrite).toBe(false);
    expect(overlay.renderOrder).toBe(9_000);
    expect(material.color.getHex()).toBe(originalColor);
    expect(material.emissive.getHex()).toBe(originalEmissive);
    expect(material.emissiveIntensity).toBe(0.2);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(true);

    setRevealHighlight(mesh, true, 1);
    expect(overlay.material.opacity).toBe(0.5);
    expect(material.color.getHex()).toBe(originalColor);

    setRevealHighlight(mesh, false);
    expect(mesh.children).toHaveLength(0);
    expect(material.color.getHex()).toBe(originalColor);
    expect(material.emissive.getHex()).toBe(originalEmissive);
    expect(material.emissiveIntensity).toBe(0.2);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(true);

    mesh.geometry.dispose();
    material.dispose();
  });
});
