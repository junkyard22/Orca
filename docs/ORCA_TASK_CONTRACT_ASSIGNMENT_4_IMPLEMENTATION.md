# Assignment 4 implementation review

Baseline: merged `main` at `3cc27eb`; approved security preflight: `6c04ba3`, `docs/ORCA_TASK_CONTRACT_ASSIGNMENT_4_SECURITY_PREFLIGHT.md`. The owner authorized implementation with the binding clarification recorded in the [handoff](ORCA_TASK_CONTRACT_CODEX_HANDOFF.md#approved-security-clarification-2026-11-17). This branch implements Assignment 4 only and must not be merged without review.

## Authorization composition

The application callback reached from Claire's Benson classification moves only known inferred permissions into a separate runtime option. Structured runtime callers keep their explicit `TaskSpec.permissions`; they cannot select provenance through task text, arrays or context. Explicit restrictions remain conjunctive even when trusted inference is separately supplied. Missing/invalid trusted inferred input fails before dispatch.

The runtime keeps the full gate for legacy/fallback use and exposes a retained chain containing workspace authority, original host gates and explicit caller restrictions. Before each Brain worker starts, the desktop constructs Miranda's replacement task/allowed-tool gate and composes the retained chain plus that gate and the existing AHP gate. Only positively identified Benson/Brain requests replace the inferred stage. Host lifecycle, budgets, approval binding and per-task refusal tracking remain unchanged.

The immutable contract narrows the current role/task tool ceiling. Local writes require modify, a positive write need, available authority and no prohibition; shell/process tools require a positive shell need and available authority. Caller flags narrow both exposure and dispatch. Empty role/task allowlists deny all tools. Canonical alias resolution cannot recover a tool excluded from the final list. Direct, decomposed and repair workers use the same selection and gate construction.

## Deliberate unavailable functionality

No independent resource-specific connector authorization source exists in the application. Consequently Brain-contract workers cannot use web/GitHub/mail/other external or unknown tools, even with a declared need, credentials, loaded tools, attachments or forged grant metadata. Broad classification disagreements cannot relabel those tools as local authority. Process/session metadata operations outside the known local read/write/process categories are also withheld.

Automatic attached-URL resolution is disabled for Brain contracts for the same reason. Cargo still records attached-resource metadata and warnings; attaching a resource never grants access. Resolution now occurs after the contract/workspace precheck, at most once per task. Explicit network false survives enrichment and blocks URL resolution; explicit file-read false blocks previous-run reads. Fallback Cargo resolution and legacy connector dispatch retain their existing behavior.

There is no successful Brain connector test because introducing a grant source would exceed the approved scope. Preflight rows N2/N7's authorized positive connector cases are unavailable by design; N3/N4/N8 instead prove fail-closed behavior. This restriction permits the local migration without inventing authority. Restoring Brain connector access requires a separately reviewed trusted resource authorization source.

An approved process remains host access: it can write or use the network outside the ordinary tool flags. The tests prove denial before unapproved dispatch, preservation of confined-read policy, and exact-call approval. They do not claim OS isolation.

## Regression evidence and matrix coverage

New executor tests use real runtime/Maestro/worker dispatch, real Miranda and execution authorization, temporary files, the real core tool registry, a real approved Node process and scripted model output. Electron startup alone is mocked. Connector executors have observable counters and make no live requests.

| Preflight rows | Evidence |
|---|---|
| P/F, L1 | Trusted inferred read-only is replaced for an eligible real write; explicit object/array/caller denials survive; forged context cannot select provenance; fallback retains inferred denial and legacy connector execution. Runtime guards retain every original host hook. |
| F1–F3, C1 | Missing/prohibited write need, inspect core/MCP writes, explicit caller limits and empty role/task allowlists leave the file unchanged and never invoke the executor. An eligible write changes the real file. |
| S1–S5, N10 | Absent/prohibited/out-of-ceiling shell need and shell aliases never start a process. A real approved command creates a sentinel; denied/missing approval leaves none. A confined reader still runs without prompting. Eligible MCP start-process retains exact-call approval and the refusal record. |
| N1, N3–N6, N8–N9, C2–C3 | Web/mail/GitHub calls have zero executor/approval calls despite needs, loading, attachments and forged metadata. Explicit network false survives Cargo. Brain and explicitly denied fallback URL reads never call fetch. Existing tool-authorization/schema/path suites remain unchanged. |
| C4, H2–H3 | Invalid workspace stops before worker and preparation. Decomposed children receive narrowed tools. Real Pappy repairs reuse the contract; attempted write/shell/connector escalation stays denied and Cargo preparation is not repeated. |
| H1, H4–H5, S6 | Six retained host-hook guards plus unchanged budget, lifecycle, cancellation, approval broker, refusal, worker integrity, conversation call-count/delivery and D8 suites. |

Observed red phases before the corresponding implementation: inspect MCP write changed the real file; positive trusted write was still blocked by inference; an empty role list allowed a write; explicit network false was replaced during enrichment; Brain/explicit-denial URL fetches ran; preparation timing violated fixed-contract/workspace ordering; and separate caller/inferred plus fallback regressions failed 2/36 before the provenance API correction. No existing security assertion was weakened.

## Validation

Local Windows results are recorded in `PROJECT_STATE.md`; the separate PR records exact-head CI. Known unchanged symlink tests require Windows privileges unavailable here and fail with EPERM during setup. They remain enabled, with Linux CI responsible for their assertions. No lockfile, Benson, runner, Pappy, Miranda, command-policy or permission UI change is included. No Assignment 5, merge, deployment or release is authorized by this work.
