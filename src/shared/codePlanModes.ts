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
  { key: 'hybrid', label: '混合 · 语法+场 Hybrid' },
  { key: 'program-anchor', label: 'E · 程序×锚点 Program-Anchors' }
] as const;

/**
 * Indoor dropdown uses the same mode keys (identical request plumbing) but
 * room-native labels: the indoor vocabularies are mental models drawn from
 * furniture-layout research, not the outdoor landform techniques.
 */
export const CODE_PLAN_INDOOR_MODE_OPTIONS = [
  { key: 'minimal', label: '默认 · 极简基线' },
  { key: 'grammar', label: 'A · 功能规划 Program' },
  { key: 'algebra', label: 'B · 锚点关系 Relate' },
  { key: 'fields', label: 'C · 场与动线 Fields' },
  { key: 'search', label: 'D · 生成-选择 Anneal' },
  { key: 'hybrid', label: '混合 · 语法+场（上一代）' },
  { key: 'program-anchor', label: 'E · 程序×锚点' }
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
  hybrid: 'Composition style — grammar-and-fields hybrid, in the lineage of Parish–Müller procedural cities (2001) and CGA shape grammars. Think in two languages that feed each other: a field is a smooth scalar question you can evaluate at any point (wetness, openness, prominence, noise), and a grammar is a family of rewrite rules applied to named regions. Three habits of mind. First, let the field shape the skeleton: subdivide the map with recursive rewrite rules into named regions, and place at least one cut where a field crosses a threshold rather than at an arbitrary constant — Parish–Müller let population density grow their streets this way. Second, let boundaries materialize: a cut only counts when the map shows it — a route in the gap, a wall or water edge along the seam — and every terminal region keeps its own field bias (density, species, height) so edges read as gradual transitions. Third, let evaluation choose, in the spirit of shape annealing: when two skeletons or anchor sites could both work, score them with your own declared criteria and keep the winner. Give vegetation a sampling budget proportional to each region\u0027s area. Final test: if deleting your skeleton would not change the map, the skeleton was decoration — reattach it to routes, walls, water and light.',
  'program-anchor': "Composition style — program-and-anchor, after Infinigen's constraint programs: state the scene as a small program of slots — role, count, minimum area, and the slots that must border it — subdivide the land into named regions serving that program with the route network reserved first, then anchor each region's hero (landmark, water body, grove, structure) and define its satellites as relations on that anchor with declared numeric ranges — beside, facing, at walking distance — chaining secondary relations off primaries. Fullness comes from complete constellations per region, never from scattered props; if a region serves no slot or a slot owns no region, repair the program, not the map."
};

/**
 * Indoor variants of the composition styles. Same keys, but each paragraph is
 * a mental model drawn from furniture-layout research — mental guidance only,
 * never concrete implementation — so the model invents its own code. The four
 * experiment routes are deliberately orthogonal:
 * - grammar: functional decomposition of SPACE (program → zones)   [Merrell 2010]
 * - algebra: relational composition of OBJECTS (anchors → pairs)   [Yu 2011, Holodeck]
 * - fields:  continuous scalar questions at every FLOOR POINT      [SDF / carve-then-fill]
 * - search:  whole-LAYOUT optimization (candidates → rubric)       [shape annealing]
 */
export const CODE_PLAN_INDOOR_STYLE_PARAGRAPHS: Record<CodePlanMode, string> = {
  minimal: '',
  grammar: 'Composition style — program and partition, in the lineage of Merrell\u0027s computer-generated residential layouts (SIGGRAPH Asia 2010) and the architect\u0027s bubble diagram. Start from the brief, not the furniture: state the room as a program — a small data table of functional slots, each with a role, a count, a minimum footprint and the slots it must sit beside — and treat the floor plate as material your rules subdivide. Partition the floor recursively into named zones until every slot owns a zone and every zone serves a slot: cut so daylight-hungry slots land by windows, service slots pool near the entrance, storage takes the leftover slices, and adjacency wishes become shared boundaries. A right partition makes most placements obvious afterwards; if a slot has no zone or a zone has no slot, repair the partition, not the furniture.',
  algebra: 'Composition style — anchor and relate: interior design as pairwise relations, the room-scale reading of Yu et al.\u0027s Make It Home (SIGGRAPH 2011) and of Holodeck\u0027s relational constraints (CVPR 2024) — against-wall, near, far, facing, in-front-of. Think in objects and the bonds between them, not floor regions. Anchor every hero piece first — bed, sofa, desk, dining table — on the wall or focal point that justifies it, then define each remaining piece as a relation function on an anchor with a declared numeric range: the nightstand at arm\u0027s reach of the bed, the screen facing the sofa at seating distance, the rug binding the seating group, the pendant centered over the table, the reading chair angled toward the window. Secondary relations chain off primary ones, so the room reads as a few strong pairs plus their satellites — never a scatter of placed props.',
  fields: 'Composition style — fields and flow. Think like a signed-distance-field shader over the floor: before anything exists, the room is a set of smooth scalar questions you can evaluate at any floor point — daylight falloff from each window, walking distance from the entrance, a circulation keepout along the routes the doors demand, quietness versus social energy. Carve before you fill: the walking network is negative space, reserved the way carve-rooms-then-corridors generators do it, and nothing may sample inside it. Then compose by thresholds: dense where your fields say belong — the desk where daylight is strong, the cushion pile where coziness peaks — empty where they forbid, and let zone boundaries emerge where a field crosses a value rather than from hand-drawn rectangles, so transitions read gradual.',
  search: 'Composition style — generate and select by shape annealing, after Cagan\u0027s shape annealing (1998), the simulated-annealing furniture layouts of Yu et al. (SIGGRAPH 2011), and Infinigen Indoors\u0027 staged greedy solver (CVPR 2024). Your first arrangement is only a candidate. Declare what a good room means as a few small fitness functions — clearance kept, every pair distance honored, one dominant focal view, nothing colliding — then settle the layout in stages the way annealing solvers do: large pieces first, small decor last, and between stages run bounded repair passes that push overlapping pieces apart, snap backs to walls, turn faces toward their focus, and drop-and-replace whatever scores worst. Emit only the layout your scoring kept; if two candidates both pass, keep the one with the stronger focal hierarchy. Keep the whole search within seconds.',
  hybrid: 'Composition style — grammar-and-fields hybrid, in the lineage of Parish–Müller procedural cities and CGA shape grammars, adapted to a room. Think in two languages that feed each other: a field is a smooth scalar question you can evaluate at any floor point (distance to doors and windows, circulation keepout, coziness, display density), and a grammar is a family of rewrite rules applied to named zones. Three habits of mind. First, let the field shape the skeleton: subdivide the floor with recursive rewrite rules into named zones, and place at least one cut where a field crosses a threshold — where daylight or walking distance falls off — instead of at an arbitrary constant. Second, let boundaries materialize: a cut only counts when the room shows it — a rug edge, a lighting change, a low cabinet or runner along the seam — and every terminal zone keeps its own field bias (density, height, warmth) so transitions stay gradual. Third, let evaluation choose, in the spirit of shape annealing: when two layouts could both work, score them with your own declared criteria — door clearance, pairing, focal view — and keep the winner. Give furniture a sampling budget proportional to each zone\u0027s area. Final test: if deleting your skeleton would not change the room, the skeleton was decoration — reattach it to routes, rugs, lighting and furniture clusters.',
  'program-anchor': "Composition style — program-and-anchor, after Infinigen Indoors (CVPR 2024): a room is stated as a program of constraints, then furnished by relationships that hang off anchors — large pieces settle first, small pieces attach to them. First write the brief as a small data table of functional slots — role, count, minimum footprint, and the slots that must sit beside it — then subdivide the floor into named zones so every slot owns a zone, cuts following adjacency, and the walking route from every door is reserved before any furniture exists. Then give each zone its hero — bed, sofa, dining table, counter run — anchored to the wall or focal point that justifies it, and define every remaining piece as a relation on that anchor with a declared numeric range: at arm's reach, facing at seating distance, beside with clearance, centered over, back coplanar with the wall; secondary relations chain off primaries — the nightstand to the bed, the lamp to the nightstand. Make fullness a consequence of completeness, never of cramming: a zone is finished only when its constellation is complete — a reading corner is chair, lamp, side table, rug and a stack of books, not a lone chair — and every horizontal surface and long wall span claims its layer of tabletop items, shelf rows or hanging pieces; in a small room the richness climbs — tables, shelves, walls, ceiling — while the floor stays honest for walking. Final test: walk from every door through every zone without crossing furniture, each zone holds exactly one dominant focal pair, and no named surface is left anonymous — repair the partition or the relation, never a hand-nudged coordinate."
};
