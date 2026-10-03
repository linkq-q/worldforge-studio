# Terrain program experiment

Scope approved: integrate into the application's map AI; compare one automatic first response per representation, natural terrain only. Preserve existing renderer changes. No new dependencies, assets, automatic aesthetic repair, or render scheme.

1. Persist a compiled height field and the original program in the shared world recipe. Verify validation, interpolation, serialization, and unchanged legacy sampling.
2. Add a bounded program compiler with deterministic numerical composition, ridge/channel helpers, sampling/inspection and existing erosion. Verify custom functions, connected relief, downstream profiles, failures and execution limits.
3. Add terrain-only recipe/program generation through the existing HTTP endpoint and editor preview/transaction workflow. Verify exactly one model call and empty ecology/settlements.
4. Generate matched 500 m examples using the same prompt/seed. Archive untouched first responses, import each atomically, inspect original-editor overview/oblique/close views. Record visual limitations without retrying the model.
5. Run all tests and production build. Deliver map links, comparison images, source and evidence. A passing test is not visual acceptance.
