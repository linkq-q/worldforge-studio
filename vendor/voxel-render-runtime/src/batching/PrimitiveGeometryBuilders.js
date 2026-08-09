function vec3(value, fallback = [0, 0, 0]) {
  const source = Array.isArray(value) ? value : fallback;
  return [
    Number(source[0]) || 0,
    Number(source[1]) || 0,
    Number(source[2]) || 0,
  ];
}

function makeGeometryFromPositions(THREE, positions) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function buildTriangleGeometry(THREE, params = {}) {
  const a = vec3(params.a);
  const b = vec3(params.b, [1, 0, 0]);
  const c = vec3(params.c, [0, 1, 0]);
  const thickness = Math.max(0, Number(params.d) || 0);

  if (thickness > 0) {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const vc = new THREE.Vector3(...c);
    const normal = new THREE.Vector3()
      .subVectors(vb, va)
      .cross(new THREE.Vector3().subVectors(vc, va))
      .normalize();
    const offset = normal.multiplyScalar(thickness / 2);
    const fa = va.clone().add(offset);
    const fb = vb.clone().add(offset);
    const fc = vc.clone().add(offset);
    const ba = va.clone().sub(offset);
    const bb = vb.clone().sub(offset);
    const bc = vc.clone().sub(offset);
    return makeGeometryFromPositions(THREE, [
      fa.x, fa.y, fa.z, fb.x, fb.y, fb.z, fc.x, fc.y, fc.z,
      ba.x, ba.y, ba.z, bc.x, bc.y, bc.z, bb.x, bb.y, bb.z,
      fa.x, fa.y, fa.z, ba.x, ba.y, ba.z, fb.x, fb.y, fb.z,
      fb.x, fb.y, fb.z, ba.x, ba.y, ba.z, bb.x, bb.y, bb.z,
      fb.x, fb.y, fb.z, bb.x, bb.y, bb.z, fc.x, fc.y, fc.z,
      fc.x, fc.y, fc.z, bb.x, bb.y, bb.z, bc.x, bc.y, bc.z,
      fc.x, fc.y, fc.z, bc.x, bc.y, bc.z, fa.x, fa.y, fa.z,
      fa.x, fa.y, fa.z, bc.x, bc.y, bc.z, ba.x, ba.y, ba.z,
    ]);
  }

  const geometry = makeGeometryFromPositions(THREE, [...a, ...b, ...c]);
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

export function buildPatchGeometry(THREE, params = {}) {
  const vertices = Array.isArray(params.vertices) ? params.vertices.map(Number) : [];
  const usableLength = Math.floor(vertices.length / 9) * 9;
  if (usableLength < 9) {
    return new THREE.PlaneGeometry(1, 1);
  }
  return makeGeometryFromPositions(THREE, vertices.slice(0, usableLength));
}
