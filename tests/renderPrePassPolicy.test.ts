import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { isNormalDepthPrePassMesh } from '../src/client/renderPrePassPolicy';

describe('normal/depth pre-pass policy', () => {
  it('keeps opaque scene meshes but excludes water so it can consume terrain depth', () => {
    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    const water = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    water.userData.isWater = true;

    expect(isNormalDepthPrePassMesh(terrain)).toBe(true);
    expect(isNormalDepthPrePassMesh(water)).toBe(false);
  });

  it('inherits exclusion flags from editor and environment ancestors', () => {
    const helperRoot = new THREE.Group();
    helperRoot.userData.isEditorObject = true;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    helperRoot.add(mesh);

    expect(isNormalDepthPrePassMesh(mesh)).toBe(false);
  });

  it('lets explicitly participating grass write depth without entering general shader scope', () => {
    const grassRoot = new THREE.Group();
    grassRoot.userData.isEnvironmentObject = true;
    grassRoot.userData.skipShaderApply = true;
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    grass.userData.forceNormalDepthPrePass = true;
    grassRoot.add(grass);

    expect(isNormalDepthPrePassMesh(grass)).toBe(true);
    grassRoot.userData.isWater = true;
    expect(isNormalDepthPrePassMesh(grass)).toBe(false);
  });
});
