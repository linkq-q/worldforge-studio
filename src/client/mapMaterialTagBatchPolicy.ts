/**
 * Base material recipes are installed on the shared instanced material. Only
 * layers that still need the live effect runtime must keep a part standalone.
 */
export function requiresRuntimeStandaloneMaterialTag(entry: {
  effectPackage?: unknown;
  runtimeEffectPackage?: unknown;
  effectiveTags?: unknown[];
}): boolean {
  return Boolean(entry.runtimeEffectPackage)
    || entry.effectiveTags?.some((tag) => (
      tag !== null
      && typeof tag === 'object'
      && (tag as { tag?: unknown }).tag === 'water'
    )) === true;
}
