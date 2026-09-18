/** Outer minimum, preferred minimum, preferred maximum, outer maximum. */
export type HabitatBand = [number, number, number, number];

export function normalizeHabitatBand(value: unknown): HabitatBand | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const numbers = value.map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return undefined;
  if (numbers.some((number, index) => index > 0 && number < numbers[index - 1])) return undefined;
  return numbers as HabitatBand;
}

export function habitatBandSuitability(value: number, band: HabitatBand | undefined): number {
  if (!band) return 1;
  const [outerMin, preferredMin, preferredMax, outerMax] = band;
  if (value < outerMin || value > outerMax) return 0;
  if (value >= preferredMin && value <= preferredMax) return 1;
  const amount = value < preferredMin
    ? (value - outerMin) / Math.max(0.0001, preferredMin - outerMin)
    : (outerMax - value) / Math.max(0.0001, outerMax - preferredMax);
  const t = Math.max(0, Math.min(1, amount));
  return t * t * (3 - 2 * t);
}
