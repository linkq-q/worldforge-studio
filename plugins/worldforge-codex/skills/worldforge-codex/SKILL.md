---
name: worldforge-codex
description: Create, refine, visually review, and export WorldForge Studio scenes using the current Codex task model for every planning and inspection step, while keeping 3D asset generation on the selected non-GPT backend.
---

# WorldForge in Codex

Use this skill when the user asks Codex to generate, refine, inspect, or export a WorldForge scene. The current Codex task model supplies every text or image response requested by WorldForge. Do not call OpenAI through an API key, the legacy `/api/chat` proxy, a nested Codex SDK, or another model for those steps. WorldForge's Codex run bridge enforces this boundary. Asset generation uses the separate model backend; default to `deepseek` and never select `gpt` as an asset provider in a Codex run.

## Local setup

Work in the WorldForge Studio repository. Check `GET http://127.0.0.1:8797/api/health` before starting anything. Reuse an active local server; if none is running, start the project's normal server. Set `WORLDFORGE_API` only when the user is using another local port. The bridge client is `plugins/worldforge-codex/scripts/bridge.mjs`; it requires only Node.js.

Read `docs/scene-agent.md`, `docs/map-transactions.md`, and the relevant editor API contract before changing a map. Confirm the target map ID and keep map generation separate from rendering. Never write `data/` directly.

## Run a Codex-backed editor operation

1. Write the exact editor request JSON to a temporary file. For scene generation or refinement, use the existing `/api/editor/maps/:mapId/generate` or `/refine` route with `sceneAgent:true`, `assetProvider:"deepseek"`, and the user's prompt. Other editor routes that ask GPT, including visual review, render generation/refinement, layout planning, and asset-library analysis, use the same bridge.
2. Run `node plugins/worldforge-codex/scripts/bridge.mjs start POST /api/editor/... <body.json>`. Keep the returned `stateFile` path.
3. Run `node plugins/worldforge-codex/scripts/bridge.mjs next <stateFile>`. Each returned request contains the original WorldForge system/user messages and a `stage`. Respond as the **current Codex task model**, following those messages and the user's intent. A `localImage` path must be opened with the available image-viewing tool before answering. Do not claim visual inspection if the image cannot be opened.
4. Write only the requested code or JSON response to a UTF-8 text file. Run `node plugins/worldforge-codex/scripts/bridge.mjs respond <stateFile> <requestId> <response.txt>`. Repeat `next` and `respond` until `next` reports `complete`.
5. Run `node plugins/worldforge-codex/scripts/bridge.mjs result <stateFile>` and inspect the returned `resultFile` (including its HTTP status and response body). Run `close <stateFile>` after completion or cancellation. If a stage fails, report the failure; never retry it through `/api/chat`.

The request may remain open while Codex works through several stages. The bridge client runs that HTTP request in a hidden background Node process and exposes each pending model call as a separate step. Preserve its temporary files until the run finishes.

## Scene acceptance

Use the returned suggestion as a preview. Inspect the actual scene from useful camera angles, capture screenshots, and feed the contact sheet to WorldForge's existing visual-review route through a Codex run. Refine only problems supported by the screenshots or deterministic diagnostics. Ask the user to confirm the map before committing the proposed `MapOperation[]` through the transaction API; render scheme generation follows that map confirmation. Export through the existing project-export API when requested. Report the map ID, assets and provider used, Codex stages answered, visual evidence, and any unresolved issue.
