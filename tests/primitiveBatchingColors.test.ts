import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AIPrimitiveBatcher, RuntimeIndex } from '@voxel-studio/render-runtime';

interface TestPart {
  id: string;
  isGroup: false;
  tags: never[];
  offset: { x: number; y: number; z: number };
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  scale: { x: number; y: number; z: number };
  mesh: {
    type: 'box';
    geometry: { width: number; height: number; depth: number };
    material: { color: number; roughness: number; metalness: number; flatShading: boolean };
  };
  materialTagBaseRecipe?: { key: string };
}

function part(id: string, color: number, material: Partial<TestPart['mesh']['material']> = {}): TestPart {
  return {
    id,
    isGroup: false,
    tags: [],
    offset: { x: 0, y: 0, z: 0 },
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    mesh: {
      type: 'box',
      geometry: { width: 1, height: 1, depth: 1 },
      material: {
        color,
        roughness: 0.65,
        metalness: 0,
        flatShading: true,
        ...material
      }
    }
  };
}

function compile(parts: TestPart[]): AIPrimitiveBatcher {
  const batcher = new AIPrimitiveBatcher({ runtimeIndex: new RuntimeIndex() });
  batcher.resetScene(new THREE.Group());
  batcher.reset();
  for (const candidate of parts) {
    const assessment = batcher.canBatch(candidate, { modelId: 'model' });
    expect(assessment.eligible).toBe(true);
    batcher.stagePart(candidate, assessment, 'model');
  }
  batcher.compile('model', new THREE.Group());
  return batcher;
}

describe('AI primitive color batching', () => {
  it('shares one batch across colors and preserves each instance color', () => {
    const batcher = compile([part('red', 0xff0000), part('blue', 0x0000ff)]);

    expect(batcher.getSceneAudit().batchCount).toBe(1);
    const mesh = batcher.getInstancedMeshes()[0] as THREE.InstancedMesh;
    expect(mesh.instanceColor).not.toBeNull();
    const color = new THREE.Color();
    mesh.getColorAt(0, color);
    expect(color.getHex()).toBe(0xff0000);
    mesh.getColorAt(1, color);
    expect(color.getHex()).toBe(0x0000ff);

    batcher.dispose();
  });

  it('still separates incompatible material state and base recipes', () => {
    const tagged = part('tagged', 0xff0000);
    tagged.materialTagBaseRecipe = { key: 'stone' };
    const batcher = compile([
      part('base', 0xff0000),
      part('rough', 0xff0000, { roughness: 0.4 }),
      part('metal', 0xff0000, { metalness: 0.5 }),
      part('smooth', 0xff0000, { flatShading: false }),
      tagged
    ]);

    expect(batcher.getSceneAudit().batchCount).toBe(5);

    batcher.dispose();
  });
});
