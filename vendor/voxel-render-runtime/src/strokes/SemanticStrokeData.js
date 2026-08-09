export const SEMANTIC_STROKE_ROLES = Object.freeze([
  'expression',
  'fold',
  'structure',
  'accent',
]);

export const SEMANTIC_STROKE_STYLES = Object.freeze(['clean', 'ink', 'pencil']);

const ROLE_SET = new Set(SEMANTIC_STROKE_ROLES);
const STYLE_SET = new Set(SEMANTIC_STROKE_STYLES);

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePoint(point) {
  const values = Array.isArray(point)
    ? point
    : [point?.x, point?.y, point?.z];
  if (values.length < 3) return null;
  const result = values.slice(0, 3).map(Number);
  return result.every(Number.isFinite) ? result : null;
}

function normalizeColor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(0xffffff, Math.max(0, Math.round(value)));
  }
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '#1b1720';
}

export function normalizeSemanticStroke(value, index = 0, options = {}) {
  if (!value || typeof value !== 'object') return null;
  const parentPartId = typeof value.parentPartId === 'string'
    ? value.parentPartId.trim()
    : '';
  if (!parentPartId) return null;
  if (options.validPartIds && !options.validPartIds.has(parentPartId)) return null;

  const points = Array.isArray(value.points)
    ? value.points.map(normalizePoint).filter(Boolean).slice(0, 256)
    : [];
  if (points.length < 2) return null;

  const role = ROLE_SET.has(value.role) ? value.role : 'accent';
  const style = STYLE_SET.has(value.style) ? value.style : 'clean';
  return {
    id: typeof value.id === 'string' && value.id.trim()
      ? value.id.trim()
      : `stroke-${index + 1}`,
    parentPartId,
    role,
    style,
    points,
    color: normalizeColor(value.color),
    width: clamp(finite(value.width, 0.035), 0.005, 0.5),
    opacity: clamp(finite(value.opacity, 1), 0, 1),
    visible: value.visible !== false,
  };
}

export function normalizeSemanticStrokes(values, options = {}) {
  if (!Array.isArray(values)) return [];
  const ids = new Set();
  const result = [];
  for (let index = 0; index < values.length; index++) {
    const stroke = normalizeSemanticStroke(values[index], index, options);
    if (!stroke || ids.has(stroke.id)) continue;
    ids.add(stroke.id);
    result.push(stroke);
  }
  return result;
}
