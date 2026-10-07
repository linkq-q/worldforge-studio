import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { describe, expect, it } from 'vitest';
import { buildOutdoorLightingGeometry, sampleOutdoorIrradiance } from '../src/client/outdoorSpatialLighting';

describe('outdoor lighting geometry', () => {
  it('expands r160 batch transforms and excludes hidden, deleted and reserved geometry', () => {
    const source = new THREE.BoxGeometry(2, 4, 6);
    const batch = new THREE.BatchedMesh(3, 120, 180, new THREE.MeshStandardMaterial());
    const visible = batch.addGeometry(source, 30, 42);
    const hidden = batch.addGeometry(source, 30, 42);
    const deleted = batch.addGeometry(source, 30, 42);
    const transform = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(10, 0, 0);
    batch.setMatrixAt(visible, transform);
    batch.setVisibleAt(hidden, false);
    batch.deleteGeometry(deleted);
    batch.position.y = 5;
    batch.castShadow = true;
    const before = Array.from(batch.geometry.getAttribute('position').array);
    const geometry = buildOutdoorLightingGeometry(new THREE.Group().add(batch))!;
    geometry.computeBoundingBox();
    expect(geometry.getAttribute('position').count).toBe(36);
    expect(geometry.boundingBox!.min.toArray()).toEqual([7, 3, -1]);
    expect(geometry.boundingBox!.max.toArray()).toEqual([13, 7, 1]);
    expect(Array.from(batch.geometry.getAttribute('position').array)).toEqual(before);
    const actualTransform = new THREE.Matrix4();
    batch.getMatrixAt(visible, actualTransform);
    actualTransform.elements.forEach((value, index) => expect(value).toBeCloseTo(transform.elements[index]));
    geometry.dispose(); batch.dispose(); source.dispose();
  });

  it('multiplies linear material, per-instance and enabled vertex colors', () => {
    const source = new THREE.BufferGeometry()
      .setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
      .setAttribute('color', new THREE.Float32BufferAttribute([0.5, 0.25, 0.8, 1, 0, 0, 0, 1, 0], 3));
    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.8, 0.25), vertexColors: true });
    const instances = new THREE.InstancedMesh(source, material, 2);
    instances.castShadow = true;
    instances.setColorAt(0, new THREE.Color(0.2, 0.5, 1));
    instances.setColorAt(1, new THREE.Color(1, 0.25, 0.5));
    const geometry = buildOutdoorLightingGeometry(new THREE.Group().add(instances))!;
    const color = geometry.getAttribute('color');
    const expected = [[0.05, 0.1, 0.2], [0.1, 0, 0], [0, 0.4, 0], [0.25, 0.05, 0.1]];
    expected.forEach((rgb, index) => {
      expect(color.getX(index)).toBeCloseTo(rgb[0]);
      expect(color.getY(index)).toBeCloseTo(rgb[1]);
      expect(color.getZ(index)).toBeCloseTo(rgb[2]);
    });
    expect(material.color.toArray()).toEqual([0.5, 0.8, 0.25]);
    geometry.dispose(); source.dispose(); material.dispose();
  });

  it('uses only rendered ranges and ignores vertex colors when disabled', () => {
    const source = new THREE.BufferGeometry()
      .setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 20, 0, 0, 21, 0, 0, 20, 1, 0], 3))
      .setAttribute('color', new THREE.Float32BufferAttribute(new Array(18).fill(0), 3));
    source.setDrawRange(3, 3);
    const mesh = new THREE.Mesh(source, new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.4, 0.3) }));
    mesh.castShadow = true;
    const geometry = buildOutdoorLightingGeometry(new THREE.Group().add(mesh))!;
    expect(geometry.getAttribute('position').count).toBe(3);
    expect(geometry.getAttribute('position').getX(0)).toBe(20);
    expect(geometry.getAttribute('color').getX(0)).toBeCloseTo(0.5);
    geometry.dispose(); source.dispose(); mesh.material.dispose();
  });

  it.each([0, 0.4, 1])('weights diffuse albedo by the nonmetal fraction at metalness %s', metalness => {
    const source = new THREE.BoxGeometry(4, 0.2, 4);
    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.5, 0.2), metalness });
    const mesh = new THREE.Mesh(source, material); mesh.castShadow = true;
    const geometry = buildOutdoorLightingGeometry(new THREE.Group().add(mesh))!;
    expect(geometry.getAttribute('position').count).toBe(36);
    const color = geometry.getAttribute('color');
    expect(color.getX(0)).toBeCloseTo(0.8 * (1 - metalness));
    expect(color.getY(0)).toBeCloseTo(0.5 * (1 - metalness));
    expect(color.getZ(0)).toBeCloseTo(0.2 * (1 - metalness));
    expect(material.color.toArray()).toEqual([0.8, 0.5, 0.2]);
    expect(material.metalness).toBe(metalness);
    geometry.dispose(); source.dispose(); material.dispose();
  });

  it.each(['mesh', 'instance', 'batch'] as const)('keeps outward winding after mirrored %s transforms', kind => {
    const source = new THREE.BoxGeometry(40, 0.5, 40);
    const material = new THREE.MeshStandardMaterial({ color: '#dfc5a1' });
    const mirror = new THREE.Matrix4().makeScale(-1, 1, 1);
    let mesh: THREE.Mesh;
    if (kind === 'instance') {
      const instance = new THREE.InstancedMesh(source, material, 1);
      instance.setMatrixAt(0, mirror); mesh = instance;
    } else if (kind === 'batch') {
      const batch = new THREE.BatchedMesh(1, 24, 36, material);
      batch.setMatrixAt(batch.addGeometry(source), mirror); mesh = batch;
    } else { mesh = new THREE.Mesh(source, material); mesh.scale.x = -1; }
    mesh.castShadow = true;
    const geometry = buildOutdoorLightingGeometry(new THREE.Group().add(mesh))!;
    const sample = sampleOutdoorIrradiance(new MeshBVH(geometry), geometry,
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0), new THREE.Color(4, 3, 2));
    expect(sample.bounce.x).toBeGreaterThan(1);
    expect(sample.bounce.x).toBeGreaterThan(sample.bounce.z);
    geometry.dispose(); source.dispose(); material.dispose();
    if (kind === 'batch') (mesh as THREE.BatchedMesh).dispose();
  });
});
