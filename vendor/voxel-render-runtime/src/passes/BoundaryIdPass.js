import * as THREE from 'three';

const BOUNDARY_LAYER = 30;
const MAX_ID = 65534;

export function encodeBoundaryId(id) {
  const value = Math.max(1, Math.min(MAX_ID, Math.trunc(id)));
  return [(value & 255) / 255, ((value >> 8) & 255) / 255];
}

function isBoundaryMesh(object) {
  if (!object?.isMesh || object.visible === false) return false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  if (materials.some(material => material?.transparent || Number(material?.opacity ?? 1) < 1)) return false;
  return !(
    object.userData?.skipShaderApply
    || object.userData?.skipNormalDepthPrePass
    || object.userData?.noNormalDepth
    || object.userData?.isEnvironmentObject
    || object.userData?.isEditorObject
    || object.userData?.shaderOutline
    || object.userData?.isOutline
    || object.name === '__outlineMesh__'
  );
}

/**
 * Renders user-model draw IDs into RG (object) and BA (material).
 * The pass temporarily enables a private camera layer only on modelRoot meshes,
 * so sky, water and editor helpers never enter the ID buffer.
 */
export function createBoundaryIdPass() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uObjectId: { value: new THREE.Vector2() },
      uMaterialId: { value: new THREE.Vector2() },
    },
    vertexShader: /* glsl */ `
      void main() {
        vec4 localPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          localPosition = instanceMatrix * localPosition;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * localPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec2 uObjectId;
      uniform vec2 uMaterialId;
      void main() {
        gl_FragColor = vec4(uObjectId, uMaterialId);
      }
    `,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  });

  const materialIds = new WeakMap();
  let nextMaterialId = 1;

  function getMaterialId(sourceMaterial) {
    if (!sourceMaterial || typeof sourceMaterial !== 'object') return 1;
    let id = materialIds.get(sourceMaterial);
    if (!id) {
      id = nextMaterialId++;
      if (nextMaterialId > MAX_ID) nextMaterialId = 1;
      materialIds.set(sourceMaterial, id);
    }
    return id;
  }

  return {
    material,
    render(renderer, scene, camera, target, modelRoot) {
      if (!renderer || !scene || !camera || !target || !modelRoot?.traverse) return false;

      const meshes = [];
      modelRoot.traverse(object => {
        if (isBoundaryMesh(object)) meshes.push(object);
      });
      if (!meshes.length) return false;

      const previousTarget = renderer.getRenderTarget();
      const previousOverride = scene.overrideMaterial;
      const previousBackground = scene.background;
      const previousCameraMask = camera.layers.mask;
      const previousClearColor = new THREE.Color();
      renderer.getClearColor(previousClearColor);
      const previousClearAlpha = renderer.getClearAlpha();
      const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;
      const restores = [];

      try {
        meshes.forEach((mesh, index) => {
          const sourceMaterial = mesh.material;
          const previousLayerMask = mesh.layers.mask;
          const previousOnBeforeRender = mesh.onBeforeRender;
          const objectId = encodeBoundaryId(index + 1);

          mesh.layers.enable(BOUNDARY_LAYER);
          mesh.onBeforeRender = function boundaryIdBeforeRender(...args) {
            previousOnBeforeRender?.apply(this, args);
            const group = args[5];
            const source = Array.isArray(sourceMaterial)
              ? sourceMaterial[group?.materialIndex ?? 0]
              : sourceMaterial;
            const encodedMaterial = encodeBoundaryId(getMaterialId(source));
            material.uniforms.uObjectId.value.set(objectId[0], objectId[1]);
            material.uniforms.uMaterialId.value.set(encodedMaterial[0], encodedMaterial[1]);
            material.uniformsNeedUpdate = true;
          };
          restores.push(() => {
            mesh.layers.mask = previousLayerMask;
            mesh.onBeforeRender = previousOnBeforeRender;
          });
        });

        renderer.shadowMap.autoUpdate = false;
        camera.layers.set(BOUNDARY_LAYER);
        scene.overrideMaterial = material;
        scene.background = null;
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
        return true;
      } finally {
        restores.forEach(restore => restore());
        renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
        renderer.setRenderTarget(previousTarget);
        renderer.setClearColor(previousClearColor, previousClearAlpha);
        scene.background = previousBackground;
        scene.overrideMaterial = previousOverride;
        camera.layers.mask = previousCameraMask;
      }
    },
    dispose() {
      material.dispose();
    },
  };
}
