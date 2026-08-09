const MIN_FOLIAGE_LUMINANCE = 96;
const MIN_FOLIAGE_CHROMA = 48;

interface ModelNode {
  id?: unknown;
  parent?: unknown;
  tags?: unknown;
  mesh?: {
    color?: unknown;
    material?: { color?: unknown; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Keeps generated leaf base colors readable before normal lighting and self-shadowing are applied. */
export function enforceReadableFoliageColors(modelJson: unknown): unknown {
  if (!modelJson || typeof modelJson !== 'object') return modelJson;
  const source = modelJson as { nodes?: unknown; [key: string]: unknown };
  if (!Array.isArray(source.nodes)) return modelJson;
  const nodes = source.nodes.filter((node): node is ModelNode => Boolean(node && typeof node === 'object'));
  const byId = new Map(nodes
    .filter((node): node is ModelNode & { id: string } => typeof node.id === 'string')
    .map((node) => [node.id, node]));
  const foliage = new Map<ModelNode, boolean>();
  const isFoliage = (node: ModelNode, seen = new Set<ModelNode>()): boolean => {
    const cached = foliage.get(node);
    if (cached !== undefined) return cached;
    if (seen.has(node)) return false;
    seen.add(node);
    const own = Array.isArray(node.tags) && node.tags.some((tag) => {
      if (!tag || typeof tag !== 'object') return false;
      const entry = tag as { tag?: unknown; value?: unknown };
      return entry.tag === 'foliage' || entry.value === 'foliage';
    });
    const parent = typeof node.parent === 'string' ? byId.get(node.parent) : undefined;
    const result = own || Boolean(parent && isFoliage(parent, seen));
    foliage.set(node, result);
    return result;
  };

  let changed = false;
  const adjustedNodes = source.nodes.map((value) => {
    if (!value || typeof value !== 'object') return value;
    const node = value as ModelNode;
    if (!node.mesh || !isFoliage(node)) return value;
    const sourceColor = typeof node.mesh.material?.color === 'number'
      ? node.mesh.material.color
      : typeof node.mesh.color === 'number' ? node.mesh.color : null;
    if (sourceColor === null) return value;
    const color = makeFoliageColorReadable(sourceColor);
    if (color === sourceColor) return value;
    changed = true;
    return {
      ...node,
      mesh: node.mesh.material?.color === sourceColor
        ? { ...node.mesh, material: { ...node.mesh.material, color } }
        : { ...node.mesh, color }
    };
  });
  return changed ? { ...source, nodes: adjustedNodes } : modelJson;
}

function makeFoliageColorReadable(color: number): number {
  const value = Math.max(0, Math.min(0xffffff, Math.round(color)));
  let red = value >> 16 & 0xff;
  let green = value >> 8 & 0xff;
  let blue = value & 0xff;
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  if (luminance > 0 && luminance < MIN_FOLIAGE_LUMINANCE) {
    const scale = MIN_FOLIAGE_LUMINANCE / luminance;
    red = Math.min(255, Math.round(red * scale));
    green = Math.min(255, Math.round(green * scale));
    blue = Math.min(255, Math.round(blue * scale));
  }
  const adjustedLuminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  if (chroma > 0 && chroma < MIN_FOLIAGE_CHROMA) {
    const scale = MIN_FOLIAGE_CHROMA / chroma;
    red = clampByte(adjustedLuminance + (red - adjustedLuminance) * scale);
    green = clampByte(adjustedLuminance + (green - adjustedLuminance) * scale);
    blue = clampByte(adjustedLuminance + (blue - adjustedLuminance) * scale);
  }
  return red << 16 | green << 8 | blue;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
