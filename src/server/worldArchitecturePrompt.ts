export const WORLD_ARCHITECTURE_PROMPT_MAX_CHARS = 8_000;

export function buildWorldArchitecturePrompt(
  prompt: string,
  dimensions: readonly [number, number, number] = [32, 16, 32]
): string {
  const [width, height, depth] = dimensions;
  const result = `World architecture assembly contract:
Build ONLY the ${width}m by ${depth}m footprint architecture, height ${height}m, centered on origin. Use connected reusable components and actual clear openings at least 2m wide. Preserve a walkable ground floor from the local +Z entrance through the structure and any courtyard. Do not fill the footprint with a solid slab or a closed complete-building asset. Do not add an external town, water, trees or terrain.
Translate the building program below into a causal spatial plan before choosing modules. Identify its users and activities, public arrival and service or logistics flows, necessary adjacencies or separations, entrance thresholds, courtyards or other purposeful open areas, and roof or massing responses to function, climate and era. These are design causes, not a checklist of rooms. Do not enclose every activity or invent unrelated civic services.

Building program from the world plan:
${prompt.trim()}`;
  if (result.length > WORLD_ARCHITECTURE_PROMPT_MAX_CHARS) throw new Error('world_architecture_prompt_too_long');
  return result;
}
