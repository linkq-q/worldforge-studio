/** The editor's smooth basin/bank profile, also used by continuous world tiles. */
export function waterShoreProfile(from: number, to: number, distance: number, width: number): number {
  const t = Math.max(0, Math.min(1, distance / Math.max(0.000001, width)));
  return from + (to - from) * t * t * (3 - 2 * t);
}
