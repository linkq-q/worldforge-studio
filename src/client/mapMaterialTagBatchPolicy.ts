/**
 * Base material recipes are installed on the shared instanced material. Only
 * layers that still need the live effect runtime must keep a part standalone.
 */
export function requiresRuntimeStandaloneMaterialTag(entry: {
  effectPackage?: unknown;
  runtimeEffectPackage?: unknown;
}): boolean {
  return Boolean(entry.runtimeEffectPackage);
}
