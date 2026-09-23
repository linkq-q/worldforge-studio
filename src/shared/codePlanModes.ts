/**
 * Composition-style routes for the raw scene Code planner. Each non-minimal
 * mode injects one technique paragraph into the raw system prompt — the
 * experiment branches (feat/raw-prompt-cga-grammar = A, sicp-combinators = B,
 * sdf-fields = C, generative-search = D, cga-sdf = hybrid) proved each
 * paragraph changes the shape of the generated plan, so they ship as a
 * per-request choice instead of one fixed vocabulary.
 */
export const CODE_PLAN_MODE_OPTIONS = [
  { key: 'minimal', label: '默认 · 极简基线' },
  { key: 'grammar', label: 'A · 形状语法 Shape Grammar' },
  { key: 'algebra', label: 'B · 图片代数 Combinators' },
  { key: 'fields', label: 'C · 连续场 SDF Fields' },
  { key: 'search', label: 'D · 生成-选择 Search' },
  { key: 'hybrid', label: '混合 · 语法+场 Hybrid' }
] as const;

export type CodePlanMode = typeof CODE_PLAN_MODE_OPTIONS[number]['key'];

export const DEFAULT_CODE_PLAN_MODE: CodePlanMode = 'minimal';

export function normalizeCodePlanMode(value: unknown): CodePlanMode {
  return CODE_PLAN_MODE_OPTIONS.some((option) => option.key === value)
    ? (value as CodePlanMode)
    : DEFAULT_CODE_PLAN_MODE;
}

/**
 * One paragraph per mode, inserted after the spatial-rhythm mandate. Keyed by
 * mode; `minimal` stays empty so the prompt remains the minimal baseline.
 */
export const CODE_PLAN_STYLE_PARAGRAPHS: Record<CodePlanMode, string> = {
  minimal: '',
  grammar: 'Composition style — shape grammar. Think like CGA rule systems: build the scene top-down with recursive subdivision. Write small split functions that take a region and return its parts (splits, margins, setbacks, hierarchy tiers), assign each part a role, and recurse until you reach placeable primitives. Express every repeated structure as a rewrite rule applied across many lots instead of placing objects by hand — one good rule can generate a whole street. Never enumerate coordinates when a rule expresses the intent.',
  algebra: "Composition style — picture algebra. Think like SICP's picture language: define a few meaningful layout fragments (an entrance sequence, a courtyard cluster, a street front, a landmark group) as reusable fragment functions, then build the whole scene by combining fragments with combinators you author yourself — beside, across, ring, mirror, quarter, echo. Fragments should close under composition: each returns coordinates that other fragments and combinators can consume. Reuse the same motif at two or three scales so the scene reads as one composed family rather than a pile of parts.",
  fields: 'Composition style — continuous fields. Think like an SDF shader: describe the scene as smooth scalar fields over (x, z) before placing anything. Write small field functions — distance falloffs, ridged or value noise, gradients, smoothstep blends — that return density, height preference, openness or wetness at any point. Orchestrate the whole map with at least one master field, then sample it: place dense where the field is high, leave empty where it is low, and let edges and transitions emerge from field thresholds rather than hand-drawn polygons.',
  search: 'Composition style — generate and select. Treat the plan as a parametric model plus your own fitness functions. Define what a good arrangement means for this scene as small scoring functions — rhythm score, contrast score, connectivity or focal-hierarchy score — then generate several candidate layouts with different seeds or parameters, evaluate each with your scores, and emit only the winner. The visible scene must be the one your scoring loop chose, not your first idea; keep the search bounded so it finishes in seconds.',
  hybrid: 'Composition style — grammar-then-fields. Work in two stages. Stage one, the skeleton: partition the map with recursive subdivision rules — write small split functions that cut the map into named regions with roles (entrance zone, main zone, service zone, wild zone…), each cut leaving circulation gaps; recurse until every region has one clear purpose. Stage two, the flesh: give each region (or the whole map) continuous fields — density, height preference, openness, wetness built from gaussians, noise and distance falloffs — and sample them to decide how strongly things appear inside each region. Structures follow the skeleton; softness follows the fields: the cut defines where things may go, the field decides how strongly they appear, and edges between regions should still feel gradual.'
};

/**
 * Indoor variants of the same five composition styles. Same keys, same intent,
 * but grounded in the room API (floor subdivision, wall/ceiling frames) instead
 * of terrain and landform, so a style switch reads natively indoors.
 */
export const CODE_PLAN_INDOOR_STYLE_PARAGRAPHS: Record<CodePlanMode, string> = {
  minimal: '',
  grammar: 'Composition style — shape grammar. Think like CGA rule systems: subdivide the floor plate top-down with recursive split functions — cut the room into named zones (entrance, primary activity, service, storage), each cut leaving circulation gaps for door swings and walking routes, then recurse until every zone holds one furniture group. Express repeated structures (a run of shelves, a row of chairs) as one rewrite rule instantiated across slots instead of placing each piece by hand.',
  algebra: "Composition style — picture algebra. Think like SICP's picture language: define a few meaningful furniture fragments (a desk cluster, a seating group, a dining set, a storage wall) as reusable fragment functions, then build the room by combining fragments with combinators you author yourself — beside, across, mirror, corner, echo. Fragments should close under composition: each returns placed objects and free coordinates that other fragments can consume. Reuse the same motif at two scales — a full wall and a single shelf — so the room reads as one composed family.",
  fields: 'Composition style — continuous fields. Think like an SDF shader: describe the room as smooth scalar fields over the floor before placing anything. Write small field functions — distance falloffs from doors and walls, a circulation-keepout field along walking routes, a coziness or display-density field — that return placement preference at any floor point. Sample the master field to decide how strongly furniture appears: dense along walls and in the activity core, empty on door clearance and route lines, with soft transitions instead of hard rectangles.',
  search: 'Composition style — generate and select. Treat the plan as a parametric model plus your own fitness functions. Define what a good room means for this request as small scoring functions — circulation score (door routes stay clear), pairing score (desk with chair, table with seats), focal score (one dominant relationship) — then generate several candidate layouts with different seeds or parameters, evaluate each, and emit only the winner. The visible room must be the one your scoring loop chose, not your first idea; keep the search bounded so it finishes in seconds.',
  hybrid: 'Composition style — grammar-then-fields. Work in two stages. Stage one, the skeleton: partition the floor with recursive split functions into named zones (entrance, primary activity, service, storage), each cut leaving circulation gaps for doors and routes. Stage two, the flesh: give each zone a continuous density field built from distance falloffs and noise, and sample it to decide how strongly pieces appear inside the zone. Structure follows the skeleton; softness follows the fields: the cut defines where furniture may go, the field decides how densely it appears, and zone edges should still feel gradual.'
};
