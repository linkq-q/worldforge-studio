export interface MapMaterialTagPolicy {
  /** Canonical selectors such as `base:fur`, `base:wood`, or `vegetation`. */
  disabled: string[];
}

export const DEFAULT_DISABLED_MATERIAL_TAGS = ['base:fur'] as const;

export function normalizeMaterialTagPolicy(value: unknown): MapMaterialTagPolicy {
  if (!value || typeof value !== 'object') {
    return { disabled: [...DEFAULT_DISABLED_MATERIAL_TAGS] };
  }
  const disabled = Array.isArray((value as { disabled?: unknown }).disabled)
    ? (value as { disabled: unknown[] }).disabled
      .map(normalizeMaterialTagSelector)
      .filter((selector): selector is string => Boolean(selector))
    : [...DEFAULT_DISABLED_MATERIAL_TAGS];
  return { disabled: [...new Set(disabled)].sort() };
}

export function materialTagSelector(value: unknown): string | null {
  if (typeof value === 'string') return normalizeMaterialTagSelector(value);
  if (!value || typeof value !== 'object') return null;
  const input = value as { tag?: unknown; value?: unknown };
  const tag = normalizeMaterialTagSelector(input.tag);
  if (!tag) return null;
  const enumValue = typeof input.value === 'string'
    ? normalizeMaterialTagSelector(input.value)
    : null;
  return enumValue && (tag === 'base' || tag === 'water') ? `${tag}:${enumValue}` : tag;
}

export function isMaterialTagEnabled(value: unknown, policy: MapMaterialTagPolicy): boolean {
  const selector = materialTagSelector(value);
  return !selector || !policy.disabled.includes(selector);
}

export function filterMaterialTags(tags: unknown, policy: MapMaterialTagPolicy): unknown[] {
  return Array.isArray(tags) ? tags.filter((tag) => isMaterialTagEnabled(tag, policy)) : [];
}

function normalizeMaterialTagSelector(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const selector = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/.test(selector) ? selector : null;
}
