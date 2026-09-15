# Local generation records

Editor generation, refinement, visual review, code replay and transaction requests write local records under:

`data/map-editor/logs/generation-YYYY-MM-DD/<trace-id>.jsonl`

Dates use UTC, as with the existing `model-reasoning-YYYY-MM-DD.jsonl` files. A custom `WORLDFORGE_DATA_DIR`/MapStore data root also relocates these records. No external telemetry service is used.

## What is recorded

- Request input and starting map snapshot; available asset IDs, names and versions.
- Every planning/repair/adaptation chat request, including full message bodies and actual thinking/token-budget settings.
- Timestamped response-header arrival, stream chunk sizes, raw SSE blocks (including unknown events), unparsed tails on errors, parsed reasoning and final content. Provider model/usage fields remain available in the raw response when the backend supplies them.
- Every executed Scene Code version, execution errors and source location, elapsed time, asset bindings and returned operations.
- Placement operations before semantic relations, relation edits, pruning and clearance operations, so final position changes can be traced.
- Asset generation requests, raw model response events, attempts/retries/errors and saved asset results.
- Visual-review input images and returned findings; final generated suggestion; saved transaction input.
- Completion, failure and cancellation outcomes. Already-received stream data is retained after a stream fails.

Each JSONL line has `traceId`, `sequence`, UTC `at`, `type` and `data`. Requests for visual review and refinement carry `parentTraceId`; saved AI transaction metadata carries `generationTraceId`. Use these links, rather than timing alone, to associate requests. HTTP responses also include `X-WorldForge-Trace-Id`.

Images sent to the visual inspector are stored beside the JSONL file and referenced by filename, byte size and SHA-256. They are not repeatedly embedded as base64 in log entries. Existing asset files are referenced by ID; new model responses are also recorded.

## Reading a run

Start with `run.start` and `request.input`, then follow `chat.request`/`chat.response` by `requestId` and `attempt`. Compare `code.execution.start`, `code.execution.error` and `code.repair.required` to identify why another round was requested. Compare `layout.before-relations` and later layout events to find local position changes. Check `review.result` separately from the layout pass.

`run.end` includes the outcome and total elapsed milliseconds. A recovered chat/asset attempt may have an error event even when the entire run completes successfully. If the process was forcibly terminated, the file may have no terminal event; this is not a successful run.

## Boundaries and privacy

- These files contain full user prompts, generated code, map details and review images. Treat them as private local diagnostics; do not commit or upload them without reviewing their contents.
- HTTP request/response headers and configured API credentials are not logged. Sensitive structured credential fields, bearer credentials and recognizable API keys are redacted. This is not a general personal-data anonymizer for arbitrary prompt/model text.
- Only reasoning returned by the backend can be recorded. Empty reasoning does not mean the model did not reason, and logs cannot recover undisclosed internal reasoning or previously unrecorded history.
- The older reasoning JSONL remains a compact summary. The new files supply the complete observable process without requiring the preview to be applied or saved first.
- Writes are batched at 250 ms or 64 KiB of queued text and flushed on normal completion/error/cancellation. A hard process kill can lose the final in-memory batch. Write failures warn and disable that run's logger, not the generation itself.
- Records are not automatically deleted or rotated away. They can grow with repeated runs; removal is a user-managed action.
