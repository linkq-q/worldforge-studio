/**
 * WaterMaskGenerator.js — 黑白 waterMask 生成工具
 *
 * waterMask 约定：白色(255,255,255) = 水域，黑色(0,0,0) = 陆地/非水域。
 * 生成结果可直接传给 ShoreDistanceGenerator.fromCanvas()。
 *
 * v2 phase 1 仅提供基础形状生成（圆形/多边形），用于快速测试或
 * 没有外部贴图时的占位水域。更复杂的笔刷/编辑工具留待后续版本（见 src/water/README.md）。
 *
 * v4 phase 1 新增 createMaskFromObject：对单个部件做正交俯视剪影快照，
 * 得到贴合其轮廓的 waterMask（任意形状水体通吃）。
 */

import * as THREE from 'three';

/**
 * 生成一张黑底白圆的 waterMask canvas。
 * @param {number} width
 * @param {number} height
 * @param {object} [options]
 * @param {number} [options.cx] - 圆心 x（默认 width/2）
 * @param {number} [options.cy] - 圆心 y（默认 height/2）
 * @param {number} [options.radius] - 半径（默认 min(width,height)*0.4）
 * @returns {HTMLCanvasElement}
 */
export function createCircleMask(width, height, options = {}) {
  const cx = options.cx ?? width / 2;
  const cy = options.cy ?? height / 2;
  const radius = options.radius ?? Math.min(width, height) * 0.4;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  return canvas;
}

/**
 * 生成一张黑底白多边形的 waterMask canvas。
 * @param {number} width
 * @param {number} height
 * @param {Array<[number, number]>} points - 多边形顶点（像素坐标）
 * @returns {HTMLCanvasElement}
 */
export function createPolygonMask(width, height, points) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  if (points && points.length >= 3) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i][0], points[i][1]);
    }
    ctx.closePath();
    ctx.fill();
  }

  return canvas;
}

/**
 * 对一个 Object3D 做正交俯视剪影快照，生成贴合其 XZ 轮廓的黑白 waterMask。
 *
 * 覆盖范围是以物体世界 AABB 中心为心、边长 = max(AABB.x, AABB.z) 的正方形——
 * 与 Phase 1 生成的正方形水面平面对齐，UV(0..1) 一一对应，故 mask 不会错位。
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Object3D} object3d - 要拍剪影的对象；不会改变其真实 parent
 * @param {number} [resolution=512]
 * @param {object} [options]
 * @param {number} [options.padding=1.02] - 正方形边长的放大系数，留一点边避免贴边裁切
 * @returns {{ canvas: HTMLCanvasElement, size: number, center: THREE.Vector3, top: number, bottom: number }}
 *   canvas: 黑底白剪影；size: 正方形世界边长；center: AABB 中心；top: AABB 顶面 Y；
 *   bottom: AABB 底面 Y（Phase F 静态水裙板用，判断容器是否举高于地面）
 */
export function createMaskFromObject(renderer, object3d, resolution = 512, options = {}) {
  const padding = options.padding ?? 1.02;

  object3d.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(object3d);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const sizeVec = new THREE.Vector3();
  box.getSize(sizeVec);
  const size = Math.max(sizeVec.x, sizeVec.z, 1e-4) * padding;
  const half = size / 2;
  const top = box.max.y;
  const bottom = box.min.y;

  // 顶视正交相机：从上往下看 (-Y)，+Z 朝图像上方
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, Math.max(sizeVec.y, 1) + 10);
  camera.up.set(0, 0, -1);
  camera.position.set(center.x, box.max.y + Math.max(sizeVec.y, 1) + 1, center.z);
  camera.lookAt(center.x, box.max.y, center.z);

  const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const rt = new THREE.WebGLRenderTarget(resolution, resolution, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });

  const prevMaterials = [];
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;

  const pixels = new Uint8Array(resolution * resolution * 4);
  try {
    object3d.traverse(o => {
      if (o.isMesh || o.isInstancedMesh) {
        prevMaterials.push([o, o.material]);
        o.material = whiteMat;
      }
    });

    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, true);
    renderer.autoClear = false;
    renderer.render(object3d, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, resolution, resolution, pixels);
  } finally {
    renderer.autoClear = prevAutoClear;
    for (const [o, mat] of prevMaterials) o.material = mat;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevClearAlpha);
    whiteMat.dispose();
    rt.dispose();
  }

  // 行序不翻转：RT 第 0 行 = 图像底部 = 世界 +Z（相机 up = -Z），DataTexture v=0 取数据第 0 行，
  // 恰好对齐 PlaneGeometry(rotateX -90°) 的 vUv（v=0 ↔ +Z）。此前按"图片习惯"翻转过一次，
  // 导致 mask 相对平面 Z 镜像——对称轮廓（椭圆池）看不出来，非对称场景会明显错位。
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(resolution, resolution);
  imageData.data.set(pixels);
  ctx.putImageData(imageData, 0, 0);

  return { canvas, size, center, top, bottom };
}

/**
 * 对一组场景对象做正交俯视剪影快照，生成「场景岸线」waterMask：
 * 对象 = 陆地(黑)，空白 = 水域(白)。用于让整块海面在场景物体周围生成岸线浪。
 *
 * 与 createMaskFromObject 的区别：
 *   - 覆盖区域由调用方显式给定（通常 = 场景内容 AABB + padding），不按单个物体推导；
 *   - 颜色反转（物体黑、背景白），直接作为 shoreDistance 输入，无需额外 invert；
 *   - 跳过水面自身（userData.isWater / isModelWater），避免把水面平面也当成陆地。
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Object3D[]} objects - 要拍剪影的场景对象（通常各模型根组）
 * @param {{ centerX:number, centerZ:number, size:number }} region - 世界 XZ 覆盖区域
 * @param {number} [resolution=1024]
 * @returns {{ canvas: HTMLCanvasElement }} canvas：白底黑剪影（白=水，黑=陆）
 */
export function createSceneShoreMask(renderer, objects, region, resolution = 1024) {
  const { centerX, centerZ, size } = region;
  const half = size / 2;

  // 临时隐藏水面网格，避免把它们当成陆地拍进剪影
  const hidden = [];
  for (const obj of objects) {
    obj.traverse(o => {
      if (o.visible && (o.userData?.isWater || o.userData?.isModelWater)) {
        o.visible = false;
        hidden.push(o);
      }
    });
  }

  // 顶视正交相机：与 createMaskFromObject 同向（看 -Y，+Z 朝图像上方 → 与平面 vUv 对齐）
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, 10000);
  camera.up.set(0, 0, -1);
  camera.position.set(centerX, 5000, centerZ);
  camera.lookAt(centerX, 0, centerZ);

  const rt = new THREE.WebGLRenderTarget(resolution, resolution, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });

  const blackMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const prevOverride = [];
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = renderer.getClearAlpha();

  renderer.setRenderTarget(rt);
  renderer.setClearColor(0xffffff, 1); // 白底 = 水域
  renderer.clear(true, true, true);
  // 逐对象用黑色 override 材质渲染（不移动对象出原场景，避免破坏父子/矩阵）
  for (const obj of objects) {
    obj.traverse(o => {
      if (o.isMesh || o.isInstancedMesh) {
        prevOverride.push([o, o.material]);
        o.material = blackMat;
      }
    });
  }
  // autoClear off：多次 render 叠加到同一 RT（否则每次 render 都会清空前一个对象）
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  for (const obj of objects) renderer.render(obj, camera);
  renderer.autoClear = prevAutoClear;
  for (const [o, mat] of prevOverride) o.material = mat;

  const pixels = new Uint8Array(resolution * resolution * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, resolution, resolution, pixels);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevClearAlpha);

  // 行序不翻转（同 createMaskFromObject 的约定）：RT 第 0 行 = 世界 +Z = 纹理 v=0，
  // 与 shader 世界坐标映射 vec2(rel.x, -rel.y)+0.5 对齐。
  const canvas = document.createElement('canvas');
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(resolution, resolution);
  imageData.data.set(pixels);
  ctx.putImageData(imageData, 0, 0);

  for (const o of hidden) o.visible = true;
  blackMat.dispose();
  rt.dispose();

  return { canvas };
}

// TODO(v2.1+): 笔刷式手绘 mask 编辑器、从地形高度图自动推导 waterMask、
// mask 持久化到 IndexedDB（见 src/water/README.md「后续规划」）。
