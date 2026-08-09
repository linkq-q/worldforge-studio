import * as THREE from 'three';
import { normalizeSemanticStrokes } from './SemanticStrokeData.js';

export const DEFAULT_SEMANTIC_STROKE_STYLE = Object.freeze({
  enabled: true,
  widthScale: 1,
  opacity: 1,
});

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function createStrokeMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */ `
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
      }
    `,
    transparent: opacity < 1,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
}

export function normalizeSemanticStrokeStyle(value = {}) {
  return {
    enabled: value.enabled !== false,
    widthScale: clamp(value.widthScale, 0.25, 4, 1),
    opacity: clamp(value.opacity, 0, 1, 1),
  };
}

export class SemanticStrokeRenderer {
  constructor(style = {}) {
    this.style = normalizeSemanticStrokeStyle({ ...DEFAULT_SEMANTIC_STROKE_STYLE, ...style });
    this.lines = [];
  }

  clear() {
    for (const line of this.lines) {
      line.parent?.remove(line);
      line.geometry?.dispose();
      line.material?.dispose();
    }
    this.lines.length = 0;
  }

  build(strokes, partGroups) {
    this.clear();
    const validPartIds = new Set(partGroups?.keys?.() || []);
    for (const stroke of normalizeSemanticStrokes(strokes, { validPartIds })) {
      const parent = partGroups.get(stroke.parentPartId);
      if (!parent) continue;
      const points = stroke.points.map(point => new THREE.Vector3(...point));
      const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
      const geometry = new THREE.TubeGeometry(
        curve,
        Math.max(8, (points.length - 1) * 8),
        stroke.width * this.style.widthScale * 0.5,
        6,
        false,
      );
      const material = createStrokeMaterial(stroke.color, stroke.opacity * this.style.opacity);
      material.userData.skipShaderApply = true;
      material.userData.skipEffectLayer = true;
      const line = new THREE.Mesh(geometry, material);
      line.name = `semantic-stroke:${stroke.id}`;
      line.visible = this.style.enabled && stroke.visible;
      line.renderOrder = 4;
      line.userData = {
        ...line.userData,
        semanticStrokeId: stroke.id,
        semanticStrokeRole: stroke.role,
        semanticStrokeStyle: stroke.style,
        semanticStrokeBaseWidth: stroke.width,
        semanticStrokeBaseOpacity: stroke.opacity,
        semanticStrokeVisible: stroke.visible,
        semanticStrokePoints: stroke.points.map(point => [...point]),
        semanticStrokePrimitive: 'tube-ribbon',
        skipBatching: true,
        skipSelection: true,
        skipShaderApply: true,
        skipNormalDepthPrePass: true,
      };
      parent.add(line);
      this.lines.push(line);
    }
    return this.lines.length;
  }

  setStyle(style = {}) {
    const previousWidthScale = this.style.widthScale;
    this.style = normalizeSemanticStrokeStyle({ ...this.style, ...style });
    for (const line of this.lines) {
      const opacity = line.userData.semanticStrokeBaseOpacity * this.style.opacity;
      line.visible = this.style.enabled && line.userData.semanticStrokeVisible;
      line.material.opacity = opacity;
      line.material.uniforms.uOpacity.value = opacity;
      line.material.transparent = opacity < 1;
      line.material.needsUpdate = true;
      if (previousWidthScale !== this.style.widthScale) {
        const points = line.userData.semanticStrokePoints.map(point => new THREE.Vector3(...point));
        const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
        line.geometry.dispose();
        line.geometry = new THREE.TubeGeometry(
          curve,
          Math.max(8, (points.length - 1) * 8),
          line.userData.semanticStrokeBaseWidth * this.style.widthScale * 0.5,
          6,
          false,
        );
      }
    }
    return { ...this.style };
  }

  dispose() {
    this.clear();
  }
}
