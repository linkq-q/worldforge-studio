export const ARTISTIC_OUTLINE_MODES = Object.freeze(['none', 'clean', 'ink', 'echo', 'curvature']);

export const SEMANTIC_STROKE_OUTLINE_DEFAULTS = Object.freeze({
  semanticStrokeEnabled: true,
  semanticStrokeWidthScale: 1,
  semanticStrokeOpacity: 1,
});

export const ARTISTIC_OUTLINE_POST_KEYS = Object.freeze([
  'inkEdgeEnabled',
  'inkEdgeStrength',
  'inkEdgeThreshold',
  'inkEdgeWidth',
  'edgeDepthWeight',
  'edgeNormalWeight',
  'edgeObjectWeight',
  'edgeMaterialWeight',
  'inkBleedRadius',
  'inkBleedFalloff',
  'inkColor',
  'inkQuality',
  'inkNoiseEnabled',
  'inkNoiseScale',
  'inkNoiseStrength',
  'inkNoiseContrast',
  'inkNoiseAnimSpeed',
  'inkCurvatureEnabled',
  'inkCurvatureScale',
  'inkCurvatureMin',
  'inkCurvatureMax',
  'inkStrokeVariation',
  'inkStrokeScale',
  'inkStrokePunch',
  'inkEchoCount',
  'inkEchoSpacing',
  'inkEchoAngle',
  'inkEchoStrength',
  'inkEchoColor',
  'flyWhiteEnabled',
  'flyWhiteCutoff',
  'flyWhiteFeather',
  'flyWhiteNoiseScale',
  'inkDepthFadeEnabled',
  'inkDepthFadeStart',
  'inkDepthFadeEnd',
  'inkMinEdgeStrength',
  'inkWidthDepthFadeEnabled',
  'inkMinEdgeWidth',
  'inkWidthFadeStart',
  'inkWidthFadeEnd',
  'inkLodFadeEnabled',
  'inkLodFadeStart',
  'inkLodFadeEnd',
  'curvatureEnabled',
  'curvatureStrength',
  'curvatureWidth',
  'curvaturePower',
  'curvatureThreshold',
  'curvatureAdaptive',
  'curvatureNearDist',
  'curvatureFarDist',
  'curvatureNearThreshold',
  'curvatureFarThreshold',
]);

export const ARTISTIC_OUTLINE_PRESETS = Object.freeze({
  none: Object.freeze({
    inkEdgeEnabled: false,
    curvatureEnabled: false,
  }),
  clean: Object.freeze({
    inkEdgeEnabled: true,
    curvatureEnabled: false,
    inkEdgeStrength: 1,
    inkEdgeThreshold: 0.1,
    inkEdgeWidth: 1.25,
    inkBleedRadius: 0,
    inkQuality: 2,
    inkNoiseEnabled: false,
    inkNoiseStrength: 0,
    inkCurvatureEnabled: false,
    inkStrokeVariation: 0,
    inkStrokePunch: 0,
    inkEchoCount: 0,
    edgeObjectWeight: 0.8,
    edgeMaterialWeight: 0.25,
    flyWhiteEnabled: false,
  }),
  ink: Object.freeze({
    inkEdgeEnabled: true,
    curvatureEnabled: false,
    inkEdgeStrength: 1.1,
    inkEdgeThreshold: 0.08,
    inkEdgeWidth: 1.9,
    inkBleedRadius: 1.4,
    inkQuality: 2,
    inkNoiseEnabled: true,
    inkNoiseScale: 3.5,
    inkNoiseStrength: 0.24,
    inkNoiseContrast: 1.35,
    inkCurvatureEnabled: true,
    inkCurvatureScale: 1.6,
    inkCurvatureMin: 0.75,
    inkCurvatureMax: 1.5,
    inkStrokeVariation: 0.62,
    inkStrokeScale: 3.2,
    inkStrokePunch: 0.65,
    inkEchoCount: 0,
    edgeObjectWeight: 0.55,
    edgeMaterialWeight: 0.15,
    flyWhiteEnabled: true,
    flyWhiteCutoff: 0.46,
    flyWhiteFeather: 0.1,
    flyWhiteNoiseScale: 4,
  }),
  echo: Object.freeze({
    inkEdgeEnabled: true,
    curvatureEnabled: false,
    inkEdgeStrength: 1,
    inkEdgeThreshold: 0.1,
    inkEdgeWidth: 1.25,
    inkBleedRadius: 0,
    inkQuality: 2,
    inkNoiseEnabled: false,
    inkNoiseStrength: 0,
    inkCurvatureEnabled: false,
    inkStrokeVariation: 0,
    inkStrokePunch: 0,
    inkEchoCount: 2,
    inkEchoSpacing: 2.5,
    inkEchoAngle: -18,
    inkEchoStrength: 0.55,
    inkEchoColor: '#d64562',
    edgeObjectWeight: 0.8,
    edgeMaterialWeight: 0.25,
    flyWhiteEnabled: false,
  }),
  curvature: Object.freeze({
    inkEdgeEnabled: false,
    curvatureEnabled: true,
    inkEchoCount: 0,
    curvatureStrength: 1.35,
    curvatureWidth: 1,
    curvaturePower: 2,
    curvatureAdaptive: true,
  }),
});

function isMode(value) {
  return ARTISTIC_OUTLINE_MODES.includes(value);
}

function copyKnownPostValues(source = {}) {
  const values = {};
  for (const key of ARTISTIC_OUTLINE_POST_KEYS) {
    if (key in source) values[key] = source[key];
  }
  return values;
}

function copySemanticStrokeValues(source = {}) {
  const values = {};
  for (const key of Object.keys(SEMANTIC_STROKE_OUTLINE_DEFAULTS)) {
    if (key in source) values[key] = source[key];
  }
  return values;
}

function toSemanticStrokeStyle(state) {
  return {
    enabled: state.semanticStrokeEnabled,
    widthScale: state.semanticStrokeWidthScale,
    opacity: state.semanticStrokeOpacity,
  };
}

export function migrateLegacyCartoonOutline(cartoon = {}) {
  const color = cartoon.silhouetteColor ?? cartoon.outlineColor;
  const strength = cartoon.silhouetteStrength ?? cartoon.outlineStrength;
  const width = cartoon.outlineWidth;
  if (color === undefined && strength === undefined && width === undefined) return null;

  const numericStrength = Number(strength);
  const numericWidth = Number(width);
  const enabled = Number.isFinite(numericStrength)
    && numericStrength > 0
    && (!Number.isFinite(numericWidth) || numericWidth > 0);
  const state = { mode: enabled ? 'clean' : 'none' };
  if (color !== undefined) state.inkColor = color;
  if (Number.isFinite(numericStrength)) state.inkEdgeStrength = numericStrength;
  if (Number.isFinite(numericWidth) && numericWidth > 0) {
    state.inkEdgeWidth = Math.min(5, Math.max(0.5, numericWidth * 100));
  }
  return state;
}

export class ArtisticOutlineController {
  constructor(postProcessPanel, semanticStrokeTarget = null) {
    this.postProcessPanel = postProcessPanel;
    this.semanticStrokeTarget = semanticStrokeTarget;
    this.semanticStrokeState = { ...SEMANTIC_STROKE_OUTLINE_DEFAULTS };
    this.mode = this._deriveMode();
    this.listeners = new Set();
    this.semanticStrokeTarget?.setSemanticStrokeStyle?.(toSemanticStrokeStyle(this.semanticStrokeState));
  }

  _deriveMode() {
    const values = this.postProcessPanel?.values || {};
    if (values.curvatureEnabled && !values.inkEdgeEnabled) return 'curvature';
    if (!values.inkEdgeEnabled) return 'none';
    if (Number(values.inkEchoCount || 0) > 0) return 'echo';
    if (
      this.mode === 'clean'
      || (
        !values.inkNoiseEnabled
        && Number(values.inkStrokeVariation || 0) <= 0
        && Number(values.inkBleedRadius || 0) <= 0
      )
    ) return 'clean';
    return 'ink';
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit() {
    const state = this.exportState();
    for (const listener of this.listeners) listener(state);
  }

  applyMode(mode) {
    if (!isMode(mode)) return false;
    this.mode = mode;
    this.postProcessPanel?.applyValuesBatch?.(ARTISTIC_OUTLINE_PRESETS[mode]);
    this._emit();
    return true;
  }

  update(values = {}) {
    if (!values || typeof values !== 'object') return false;
    const mode = isMode(values.mode) ? values.mode : null;
    if (mode && mode !== this.mode) {
      this.mode = mode;
      this.postProcessPanel?.applyValuesBatch?.(ARTISTIC_OUTLINE_PRESETS[mode]);
    }
    const patch = copyKnownPostValues(values);
    if (Object.keys(patch).length) this.postProcessPanel?.applyValuesBatch?.(patch);
    const semanticPatch = copySemanticStrokeValues(values);
    if (Object.keys(semanticPatch).length) {
      Object.assign(this.semanticStrokeState, semanticPatch);
      this.semanticStrokeTarget?.setSemanticStrokeStyle?.(toSemanticStrokeStyle(this.semanticStrokeState));
    }
    this.mode = mode || this._deriveMode();
    this._emit();
    return true;
  }

  importState(state = {}) {
    return this.update(state);
  }

  adoptLegacyPost(post = {}) {
    const values = this.postProcessPanel?.values || post;
    if (post.curvatureEnabled && !post.inkEdgeEnabled) this.mode = 'curvature';
    else if (post.inkEdgeEnabled) {
      if (Number(post.inkEchoCount || 0) > 0) this.mode = 'echo';
      else {
        this.mode = (
          !post.inkNoiseEnabled
          && Number(post.inkStrokeVariation || 0) <= 0
          && Number(post.inkBleedRadius || 0) <= 0
        ) ? 'clean' : 'ink';
      }
    } else {
      this.mode = this._deriveMode();
    }
    if (values !== post) Object.assign(values, copyKnownPostValues(post));
    this._emit();
  }

  exportState() {
    this.mode = this._deriveMode();
    return {
      mode: this.mode,
      ...copyKnownPostValues(this.postProcessPanel?.values),
      ...this.semanticStrokeState,
    };
  }
}

export function stripArtisticOutlineFromPost(post = {}) {
  const cleaned = { ...post };
  for (const key of ARTISTIC_OUTLINE_POST_KEYS) delete cleaned[key];
  return cleaned;
}
